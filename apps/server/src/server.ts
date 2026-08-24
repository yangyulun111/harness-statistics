/**
 * @hs/server —— 本地仪表盘服务（默认 127.0.0.1:8766）：
 *   /api/*  查询 TS 侧 collector.sqlite（口径与 Python queries.py 一致）
 *   /*      静态托管 apps/web/dist（React 仪表盘），history 路由回退 index.html
 * 采集循环跑在 Worker 线程（ingest-worker.ts），主线程只读。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { dayDetail, dailySeries, daySummary, failuresOverview, projectRows, statusInfo, taskDetail, taskRows, threadTurns, trend } from "@hs/ledger-core";
import { reconcile } from "@hs/ledger-core";
import { loadMergedCatalog, loadCatalogFile, resolvePrice, syncPrices } from "@hs/ledger-core";

export interface ServeOptions {
  db: string;
  envCodexHome?: string | null;
  port?: number;
  intervalSec?: number;
  /** 用户价格目录路径（默认 <cwd>/model_prices.json；同步产物在其旁 model_prices.synced.json） */
  pricesPath?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function localDateNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读请求体（上限 256KB；价格条目编辑用）。 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("body 超过 256KB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function serve(opts: ServeOptions): Promise<void> {
  const port = opts.port ?? 8766;
  const intervalSec = opts.intervalSec ?? 5;
  const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const pricesPath = opts.pricesPath ?? path.join(process.cwd(), "model_prices.json");
  const syncedPricesPath = path.join(path.dirname(pricesPath), "model_prices.synced.json");
  const mergedCatalog = () => loadMergedCatalog(pricesPath, syncedPricesPath);

  let lastIngest: {
    at: number;
    elapsedMs: number;
    stats: unknown;
    error: string | null;
  } | null = null;

  const worker = new Worker(fileURLToPath(new URL("./ingest-worker.ts", import.meta.url)), {
    workerData: { db: opts.db, envCodexHome: opts.envCodexHome ?? null, intervalSec },
  });
  worker.on("message", (m: any) => {
    if (m?.type === "ingest") {
      lastIngest = { at: m.at, elapsedMs: m.elapsedMs, stats: m.stats, error: m.error ?? null };
      if (m.error) console.error(`[daemon] ingest 失败：${m.error}`);
      else if (m.stats && (m.stats as any).events > 0) {
        console.log(`[daemon] +${(m.stats as any).events} events（${(m.stats as any).files} files，${m.elapsedMs}ms）`);
      }
    }
  });
  worker.on("error", (e) => console.error(`[daemon] worker 异常：${e}`));

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e) }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://local");
    const p = decodeURIComponent(u.pathname);

    if (p.startsWith("/api/")) {
      const body = await api(p, u.searchParams, req);
      res.writeHead(body === undefined ? 404 : 200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body ?? { error: "not found" }));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(p, res);
  }

  async function api(p: string, q: URLSearchParams, req: http.IncomingMessage): Promise<unknown> {
    const dbPath = opts.db;
    if (p === "/api/summary") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
      const day = daySummary(conn, q.get("date"), mergedCatalog());
      return {
        date: day.date,
        totals: day.totals,
        consumption: day.consumption,
        tasks: (day.tasks as any[]).slice(0, 8),
        status: statusInfo(conn),
        daemon: { running: true, interval_sec: intervalSec, ...lastIngest },
      };
      } finally {
        conn.close();
      }
    }
    if (p === "/api/tasks") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const daysParam = Number(q.get("days"));
        const since = q.has("days") && daysParam > 0 ? Date.now() - daysParam * 86_400_000 : null;
        return taskRows(conn, since, Number(q.get("limit") ?? 300));
      } finally {
        conn.close();
      }
    }
    if (p === "/api/projects") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const daysParam = Number(q.get("days"));
        const since = q.has("days") && daysParam > 0 ? Date.now() - daysParam * 86_400_000 : null;
        return projectRows(conn, since);
      } finally {
        conn.close();
      }
    }
    if (p === "/api/trend") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        return trend(conn, Number(q.get("days") ?? 14));
      } finally {
        conn.close();
      }
    }
    if (p === "/api/daily") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        return dailySeries(conn, Number(q.get("days") ?? 30));
      } finally {
        conn.close();
      }
    }
    if (p === "/api/day") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const date = q.get("date") ?? localDateNow();
        return dayDetail(conn, date);
      } finally {
        conn.close();
      }
    }
    if (p.startsWith("/api/task/")) {
      const id = p.slice("/api/task/".length);
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        // v1.4 ?day=YYYY-MM-DD → 当日切片（无参数/非法格式 = 总计口径）
        return taskDetail(conn, id, mergedCatalog(), q.get("day"));
      } finally {
        conn.close();
      }
    }
    if (p === "/api/turns") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const tid = q.get("thread_id") ?? "";
        const day = q.get("day");
        return tid ? { thread_id: tid, turns: threadTurns(conn, tid, 500, day) ?? [] } : { thread_id: "", turns: [] };
      } finally {
        conn.close();
      }
    }
    if (p === "/api/failures") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        return failuresOverview(conn, Number(q.get("limit") ?? 100));
      } finally {
        conn.close();
      }
    }
    if (p === "/api/status") {
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const merged = mergedCatalog();
        let prices: unknown;
        if (merged) {
          const models = (conn.prepare(
            "SELECT DISTINCT model FROM threads WHERE model IS NOT NULL AND model != ''",
          ).all() as Array<Record<string, unknown>>).map((r) => String(r["model"]));
          prices = {
            loaded: true,
            path: pricesPath,
            user_entries: merged.entries.filter((e) => e.origin === "user").length,
            synced_entries: merged.entries.filter((e) => e.origin === "synced").length,
            updated_ms: merged.updated_ms,
            uncovered_models: models.filter((m) => !resolvePrice(merged, m, Date.now())),
          };
        } else {
          prices = { loaded: false, path: pricesPath };
        }
        return { ...statusInfo(conn), prices, daemon: { running: true, interval_sec: intervalSec, ...lastIngest } };
      } finally {
        conn.close();
      }
    }
    if (p === "/api/prices") {
      const merged = mergedCatalog();
      if (!merged) return { user_path: pricesPath, synced_path: syncedPricesPath, entries: [], uncovered_models: [], loaded: false };
      const { openRo } = await import("@hs/ledger-core");
      const conn = openRo(dbPath);
      try {
        const models = (conn.prepare(
          "SELECT DISTINCT model FROM threads WHERE model IS NOT NULL AND model != ''",
        ).all() as Array<Record<string, unknown>>).map((r) => String(r["model"]));
        return {
          loaded: true,
          user_path: pricesPath,
          synced_path: syncedPricesPath,
          entries: merged.entries,
          uncovered_models: models.filter((m) => !resolvePrice(merged, m, Date.now())),
        };
      } finally {
        conn.close();
      }
    }
    if (p === "/api/prices/sync" && req.method === "POST") {
      const srcParam = q.get("source");
      const source = srcParam === "openai" || srcParam === "litellm" ? srcParam : "auto";
      return await syncPrices({ syncedPath: syncedPricesPath, source, dryRun: q.get("dry_run") === "1" });
    }
    if (p === "/api/prices/entry" && (req.method === "PUT" || req.method === "DELETE")) {
      const body = await readBody(req);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        return { error: "body 不是合法 JSON" };
      }
      const userCat = loadCatalogFile(pricesPath);
      const raw: { version: number; updated: unknown; notes: string; entries: Array<Record<string, unknown>> } = userCat
        ? { version: userCat.version, updated: userCat.updated_ms ?? new Date().toISOString(), notes: userCat.notes, entries: userCat.entries.map((e) => ({
            model: e.model,
            effective_from: new Date(e.effective_from_ms).toISOString(),
            effective_to: e.effective_to_ms === null ? null : new Date(e.effective_to_ms).toISOString(),
            currency: e.currency,
            input_per_mtok: e.input_per_mtok,
            cached_input_per_mtok: e.cached_input_per_mtok,
            output_per_mtok: e.output_per_mtok,
            ...(e.cache_write_per_mtok !== undefined ? { cache_write_per_mtok: e.cache_write_per_mtok } : {}),
            ...(e.promo ? { promo: true } : {}),
            ...(e.source ? { source: e.source } : {}),
            ...(e.note ? { note: e.note } : {}),
          })) as Array<Record<string, unknown>> }
        : { version: 1, updated: new Date().toISOString(), notes: "用户价格目录（手工/编辑保存；同步不触碰本文件，优先级高于同步条目）", entries: [] };
      if (req.method === "DELETE") {
        const model = String(parsed["model"] ?? "");
        const from = Number(parsed["effective_from_ms"]);
        if (!model || !Number.isFinite(from)) return { error: "需要 model 与 effective_from_ms" };
        const before = raw.entries.length;
        raw.entries = (raw.entries as Array<Record<string, unknown>>).filter(
          (e) => !(String(e["model"]) === model && Date.parse(String(e["effective_from"])) === from),
        );
        fs.writeFileSync(pricesPath, JSON.stringify(raw, null, 2), "utf8");
        return { ok: true, removed: before - raw.entries.length };
      }
      // PUT：upsert 用户条目（model + effective_from 唯一定位）
      const model = String(parsed["model"] ?? "").trim();
      const fromRaw = parsed["effective_from"];
      const fromMs = typeof fromRaw === "number" ? fromRaw : Date.parse(String(fromRaw ?? ""));
      const numf = (k: string): number | undefined => {
        const n = Number(parsed[k]);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      if (!model || !Number.isFinite(fromMs)) return { error: "需要 model 与 effective_from（ISO 或 ms）" };
      const entry: Record<string, unknown> = {
        model,
        effective_from: new Date(fromMs).toISOString(),
        effective_to: parsed["effective_to"] == null || parsed["effective_to"] === "" ? null : new Date(typeof parsed["effective_to"] === "number" ? Number(parsed["effective_to"]) : Date.parse(String(parsed["effective_to"]))).toISOString(),
        currency: String(parsed["currency"] ?? "USD"),
        input_per_mtok: numf("input_per_mtok") ?? 0,
        cached_input_per_mtok: numf("cached_input_per_mtok") ?? 0,
        output_per_mtok: numf("output_per_mtok") ?? 0,
        ...(numf("cache_write_per_mtok") !== undefined ? { cache_write_per_mtok: numf("cache_write_per_mtok") } : {}),
        ...(parsed["promo"] === true ? { promo: true } : {}),
        source: parsed["source"] == null ? "用户手工条目" : String(parsed["source"]),
        ...(parsed["note"] != null && parsed["note"] !== "" ? { note: String(parsed["note"]) } : {}),
      };
      if ((entry["input_per_mtok"] as number) <= 0) return { error: "input_per_mtok 必须 > 0" };
      const list = raw.entries as Array<Record<string, unknown>>;
      const idx = list.findIndex((e) => String(e["model"]) === model && Date.parse(String(e["effective_from"])) === fromMs);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      list.sort((a, b) => String(a["model"]).localeCompare(String(b["model"])) || Date.parse(String(a["effective_from"])) - Date.parse(String(b["effective_from"])));
      fs.mkdirSync(path.dirname(pricesPath), { recursive: true });
      fs.writeFileSync(pricesPath, JSON.stringify(raw, null, 2), "utf8");
      return { ok: true, total: list.length, upserted: 1 };
    }
    if (p === "/api/reconcile") {
      return reconcile(dbPath);
    }
    return undefined;
  }

  function serveStatic(p: string, res: http.ServerResponse): void {
    let rel = p === "/" ? "index.html" : p.slice(1);
    let file = path.normalize(path.join(webDist, rel));
    if (!file.startsWith(path.normalize(webDist))) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // history 路由回退
      if (path.extname(rel) === "") {
        file = path.join(webDist, "index.html");
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    fs.createReadStream(file).pipe(res);
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`[serve] http://127.0.0.1:${port}/  （db=${opts.db}，采集间隔 ${intervalSec}s）`);
  console.log(`[serve] web dist: ${webDist}${fs.existsSync(path.join(webDist, "index.html")) ? "" : "（未构建，先 npm run build:web）"}`);

  const shutdown = () => {
    void worker.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

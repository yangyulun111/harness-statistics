/**
 * 共享查询层 —— Python oracle ledger/queries.py 的 TS 移植（CLI / Web / 报告共用口径）。
 *   - v1.1 三层指标：L0 raw = final_*（观测累计，含继承前缀）；
 *     L1 native = 毛差分 − replay（组件级：input/cached/output）；任务 Token = root native + Σ子代理 native；
 *     L2 经济层（credits 估算）另做。消耗口径 = daily 毛差分 − replay，与官方每日用量同语义。
 *   - 采样/wait/压缩等诊断量按任务域（root+子代理）求和；
 *   - 项目 = 按 cwd 归一化分组。
 * 追加：trend()（按日聚合，供前端趋势图）；taskDetail 附带 name/project 与 fork 归因。
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { localDate, DEFAULT_TS_DB, WAIT_ACTIONS } from "@hs/shared";
import { readSessionIndex } from "@hs/codex-discovery";
import { costAggregate, type CostEst, type PriceCatalog } from "./cost.ts";

type Row = Record<string, any>;

export function openRo(dbPath?: string): DatabaseSync {
  const p = dbPath ?? DEFAULT_TS_DB();
  if (!fs.existsSync(p)) {
    throw new Error(`collector.sqlite 不存在：${p}（先运行 npm run update）`);
  }
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 8000");
  } catch { /* ignore */ }
  return db;
}

export function normCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  let s = cwd;
  const UNC = String.fromCharCode(92, 92) + "?\\" + "UNC\\"; // \\?\UNC\
  const LONG = String.fromCharCode(92, 92) + "?\\"; // \\?\
  if (s.startsWith(UNC)) s = String.fromCharCode(92, 92) + s.slice(UNC.length);
  else if (s.startsWith(LONG)) s = s.slice(LONG.length);
  return s;
}

export function projectKey(cwd: string | null | undefined): string {
  const s = normCwd(cwd);
  if (!s) return "（未知）";
  const name = s.replace(/[\\/]+$/, "").replace(/\//g, "\\").split("\\").pop()!;
  return name || s;
}

export function taskName(r: Row): string {
  // 优先级：session_index 云端摘要标题 → name（用户命名）→ title（state DB，
  // 活跃线程会被覆盖回首条消息原文）→ preview/first_user_message，最终 cleanTitle 保护
  if (r["cloud_title"]) return cleanTitle(String(r["cloud_title"]));
  const raw = r["name"] || r["title"] || r["preview"] || r["first_user_message"] || "";
  return cleanTitle(String(raw));
}

/**
 * 标题清洗：state DB 的 title 字段只有在 ChatGPT 云端摘要标题同步回来后才是短标题，
 * 其余时候是首条消息原文（含超长路径/附件头）。这里做展示层派生：
 *   1) 附件前缀（# Files mentioned by the user: … ## My request:）只取真实请求；
 *   2) 抹掉 Windows/UNC/POSIX 路径与 URL（替换为 …）；
 *   3) 取第一句（。？！!? 或换行），40 个 code point 截断。
 * 已同步的云端摘要标题（如“识别模型”）天然短，会原样保留。
 */
export function cleanTitle(raw: string): string {
  let s = raw.trim();
  if (!s) return "（未命名）";
  const req = /## My request:\s*\n([\s\S]+)/.exec(s);
  if (req) s = req[1]!.trim();
  // 注意：真实字符串里是单反斜杠 \wsl.localhost\…（JSON 输出中的 \\ 是转义）
  const PATH_RE = /(?:[A-Za-z]:\\+|\\\\[\w.$-]+\\+|\\[\w.$-]+\\+|\/(?:home|Users|mnt|workspace|opt|var|tmp)\/)[^\s"'，。；、）)】>]*/g;
  s = s.replace(PATH_RE, "…").replace(/https?:\/\/\S+/g, "…");
  s = s.replace(/[#*`>]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^["“‘']+|["”’']+$/g, "").trim();
  const first = s.split(/[。！？!?\n]/)[0]!.trim();
  if (first) s = first;
  const cps = Array.from(s);
  return cps.length > 40 ? cps.slice(0, 40).join("") + "…" : cps.join("");
}

function snapshot(conn: DatabaseSync): Map<string, Row> {
  // 云端摘要标题源：~/.codex/session_index.jsonl（桌面端 app-server 维护，含活跃线程）。
  // 从 meta.codex_home 定位，每次查询重读（文件极小）→ 标题自动跟随桌面端更新。
  let cloudTitles = new Map<string, string>();
  try {
    const homeRow = conn.prepare("SELECT value FROM meta WHERE key='codex_home'").get() as Row | undefined;
    if (homeRow && typeof homeRow["value"] === "string" && homeRow["value"]) {
      cloudTitles = readSessionIndex(homeRow["value"]);
    }
  } catch { /* ignore */ }
  // v1.1 组件级 native（= daily 毛差分 − replay，按线程聚合）
  const nativeByThread = new Map<string, Row>();
  for (const r of conn.prepare(
    `SELECT thread_id, SUM(input_tokens - COALESCE(replay_input_tokens,0)) ni,
            SUM(cached_input_tokens - COALESCE(replay_cached_tokens,0)) nc,
            SUM(output_tokens - COALESCE(replay_output_tokens,0)) no
     FROM daily_usage GROUP BY thread_id`,
  ).all() as Row[]) {
    nativeByThread.set(String(r["thread_id"]), r);
  }
  const out = new Map<string, Row>();
  const q = `SELECT t.*, d.usage_bearing_samples s, d.wait_status_model_calls w,
                  d.rebroadcast_events rb, d.peak_context pc, d.compactions comp,
                  d.model_context_window mcw,
                  d.final_input fi, d.final_cached fc, d.final_cache_write fcw,
                  d.final_output fo, d.final_reasoning fr, d.final_total ft,
                  d.native_total nt, d.replay_input_tokens ri, d.replay_cached_tokens rc,
                  d.replay_output_tokens ro, d.replay_total_tokens rr, d.replay_events rev,
                  d.baseline_prefix_events bpe, d.baseline_parent_digest bpd,
                  d.schema_compat sc, d.file_usage_epochs ep, d.token_count_events tce,
                  d.tool_calls, d.tool_output_bytes, d.patches, d.web_searches,
                  d.mcp_calls, d.mcp_failures, d.shell_failures,
                  d.first_patch_ms, d.first_event_ms, d.schema_issues si
           FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id`;
  for (const d of conn.prepare(q).all() as Row[]) {
    const base = d["inherited_baseline"] || 0;
    d["raw_total"] = d["ft"] || 0;
    d["excl_total"] = d["nt"] ?? Math.max(0, (d["ft"] || 0) - base); // canonical = native_total
    const nb = nativeByThread.get(String(d["thread_id"]));
    d["n_input"] = nb ? Number(nb["ni"]) || 0 : 0;
    d["n_cached"] = nb ? Number(nb["nc"]) || 0 : 0;
    d["n_output"] = nb ? Number(nb["no"]) || 0 : 0;
    d["excl_uncached"] = Math.max(0, d["n_input"] - d["n_cached"]);
    d["activity_ms"] = d["last_event_ms"] || d["updated_ms"] || d["created_ms"];
    const ct = cloudTitles.get(d["thread_id"]);
    if (ct) d["cloud_title"] = ct;
    out.set(d["thread_id"], d);
  }
  return out;
}

function turnStats(conn: DatabaseSync): Map<string, Row> {
  const per = new Map<string, Row>();
  const rows = conn.prepare(
    "SELECT thread_id, turn_index, status FROM turns WHERE turn_index>=0 ORDER BY thread_id, turn_index",
  ).all() as any[];
  for (const r of rows) {
    const tid: string = r["thread_id"];
    let s = per.get(tid);
    if (!s) {
      s = { turns: 0, status: "idle" };
      per.set(tid, s);
    }
    s["turns"] += 1;
    s["status"] = r["status"];
  }
  return per;
}

const STATUS_MAP: Record<string, string> = {
  completed: "completed",
  aborted: "interrupted",
  active: "possibly_active",
  unknown: "unknown",
  idle: "idle",
};

/** 子代理 token 按模型聚合（tokens 降序）。 */
export function subModelSplit(subs: Row[]): SubModelSplit[] {
  const by = new Map<string, SubModelSplit>();
  for (const s of subs) {
    const model = String(s["model"] || "-");
    let e = by.get(model);
    if (!e) {
      e = { model, tokens: 0, threads: 0 };
      by.set(model, e);
    }
    e.tokens += s["excl_total"] || 0;
    e.threads += 1;
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens);
}

export interface SubModelSplit {
  model: string;
  tokens: number;
  threads: number;
}

/** wait/status Token 与成本估算所需的轮级轻量行（含归属根线程/模型/时点，供按时点取价）。 */
interface TurnLite {
  root: string;
  model: string;
  ts_ms: number | null;
  input: number;
  cached: number;
  cache_write: number;
  output: number;
  total: number;
  samples: number;
  wait: number;
}

function loadTurnsLite(conn: DatabaseSync): TurnLite[] {
  return (conn.prepare(
    `SELECT COALESCE(th.root_thread_id, th.thread_id) AS root, th.model AS model,
            t.started_ms AS st, t.completed_ms AS cp,
            t.input_tokens AS i, t.cached_input_tokens AS c, t.cache_write_tokens AS cw,
            t.output_tokens AS o, t.total_tokens AS tt,
            t.usage_bearing_samples AS s, t.wait_status_model_calls AS w
     FROM turns t JOIN threads th ON th.thread_id = t.thread_id`,
  ).all() as Row[]).map((r) => ({
    root: String(r["root"]),
    model: String(r["model"] ?? ""),
    ts_ms: Number(r["st"] ?? r["cp"]) || null,
    input: Number(r["i"]) || 0,
    cached: Number(r["c"]) || 0,
    cache_write: Number(r["cw"]) || 0,
    output: Number(r["o"]) || 0,
    total: Number(r["tt"]) || 0,
    samples: Number(r["s"]) || 0,
    wait: Number(r["w"]) || 0,
  }));
}

/** wait/status Token 估算（estimated：采样占比≈消耗占比）：Σ(轮分量 × wait采样/采样)，仅统计有 wait 采样的轮。 */
function waitTokensOf(items: TurnLite[]): { total: number; input: number; cached: number; output: number } {
  let total = 0, input = 0, cached = 0, output = 0;
  for (const t of items) {
    if (t.samples <= 0 || t.wait <= 0) continue;
    const r = Math.min(1, t.wait / t.samples);
    total += Math.round(t.total * r);
    input += Math.round(t.input * r);
    cached += Math.round(t.cached * r);
    output += Math.round(t.output * r);
  }
  return { total, input, cached, output };
}

export interface TaskRowApi {
  thread_id: string;
  name: string;
  project: string;
  cwd: string;
  model: string;
  effort: string | null;
  turns: number;
  status: string;
  root_tokens: number;
  subagent_tokens: number;
  sub_models: SubModelSplit[];
  day_tokens?: number;
  day_root?: number;
  day_sub?: number;
  total_tokens: number;
  uncached_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  samples: number;
  wait: number;
  wait_tokens_est: number;
  rebroadcast: number;
  subagents: number;
  compactions: number;
  peak_context: number;
  patches: number;
  shell_failures: number;
  mcp_failures: number;
  activity_ms: number | null;
  schema_ok: boolean;
}

export function taskRows(conn: DatabaseSync, sinceMs: number | null = null, limit = 300): TaskRowApi[] {
  const snap = snapshot(conn);
  const turns = turnStats(conn);
  const waitByRoot = new Map<string, number>();
  for (const t of loadTurnsLite(conn)) {
    if (t.samples <= 0 || t.wait <= 0) continue;
    waitByRoot.set(t.root, (waitByRoot.get(t.root) ?? 0) + Math.round(t.total * Math.min(1, t.wait / t.samples)));
  }
  const subsByRoot = new Map<string, Row[]>();
  for (const t of snap.values()) {
    if (t["thread_type"] === "subagent" && t["root_thread_id"]) {
      let arr = subsByRoot.get(t["root_thread_id"]);
      if (!arr) {
        arr = [];
        subsByRoot.set(t["root_thread_id"], arr);
      }
      arr.push(t);
    }
  }

  const rows: TaskRowApi[] = [];
  for (const t of snap.values()) {
    if (t["thread_type"] !== "root") continue;
    const act = t["activity_ms"] ?? null;
    if (sinceMs !== null && (act ?? 0) < sinceMs) continue;
    const subs = subsByRoot.get(t["thread_id"]) ?? [];
    const ts = turns.get(t["thread_id"]) ?? { turns: 0, status: "idle" };
    const agg = (f: string): number => (t[f] || 0) + subs.reduce((a, s) => a + (s[f] || 0), 0);
    const uncachedSum = Math.max(0, t["n_input"] - t["n_cached"]) +
      subs.reduce((a, s) => a + Math.max(0, s["n_input"] - s["n_cached"]), 0);
    rows.push({
      thread_id: t["thread_id"],
      name: taskName(t),
      project: projectKey(t["cwd"]),
      cwd: normCwd(t["cwd"]),
      model: t["model"] || "-",
      effort: t["effort"] ?? null,
      turns: ts["turns"],
      status: STATUS_MAP[ts["status"]] ?? ts["status"],
      root_tokens: t["excl_total"],
      subagent_tokens: subs.reduce((a, s) => a + s["excl_total"], 0),
      sub_models: subModelSplit(subs),
      total_tokens: t["excl_total"] + subs.reduce((a, s) => a + s["excl_total"], 0),
      uncached_tokens: uncachedSum,
      cached_tokens: agg("n_cached"),
      output_tokens: agg("n_output"),
      samples: agg("s"),
      wait: agg("w"),
      wait_tokens_est: waitByRoot.get(t["thread_id"]) ?? 0,
      rebroadcast: agg("rb"),
      subagents: subs.length,
      compactions: agg("comp"),
      peak_context: Math.max(t["pc"] || 0, ...subs.map((s) => s["pc"] || 0)),
      patches: (t["patches"] || 0) + subs.reduce((a, s) => a + (s["patches"] || 0), 0),
      shell_failures: agg("shell_failures"),
      mcp_failures: agg("mcp_failures"),
      activity_ms: act,
      schema_ok: [t, ...subs].every((x) => (x["sc"] || "ok") === "ok"),
    });
  }
  rows.sort((a, b) => (b.activity_ms ?? 0) - (a.activity_ms ?? 0));
  return rows.slice(0, limit);
}

export function daySummary(conn: DatabaseSync, date?: string | null, catalog?: PriceCatalog | null): Row {
  const day = date || localDate(Date.now()) || "";
  const rows = taskRows(conn).filter((r) => localDate(r.activity_ms) === day);
  // 当日实际消耗（daily_usage 口径，与 Codex 官方每日用量同语义）+ 每任务当日量
  const agg = aggregateDaily(conn).get(day);
  // 当日 wait Token 与成本（estimated；轮按完成时点归日，成本按时点取价、促销期自动分段）
  const dayLite = loadTurnsLite(conn).filter((t) => t.ts_ms != null && localDate(t.ts_ms) === day);
  const dayWaitTok = waitTokensOf(dayLite);
  const consumption = {
    ...(agg
      ? toPoint(day, agg)
      : { date: day, root: 0, sub: 0, total: 0, uncached: 0, output: 0, samples: 0, wait: 0, tasks: 0, by_model: [] }),
    wait_tokens_est: dayWaitTok.total,
    cost_est: catalog ? costAggregate(catalog, dayLite) : null,
  };
  for (const r of rows) {
    const e = agg?.byTask.get(r.thread_id);
    r.day_tokens = e ? e.root + e.sub : 0;
    r.day_root = e?.root ?? 0;
    r.day_sub = e?.sub ?? 0;
  }
  const tot = {
    tasks: rows.length,
    root: rows.reduce((a, r) => a + r.root_tokens, 0),
    sub: rows.reduce((a, r) => a + r.subagent_tokens, 0),
    total: rows.reduce((a, r) => a + r.total_tokens, 0),
    uncached: rows.reduce((a, r) => a + r.uncached_tokens, 0),
    output: rows.reduce((a, r) => a + r.output_tokens, 0),
    samples: rows.reduce((a, r) => a + r.samples, 0),
    wait: rows.reduce((a, r) => a + r.wait, 0),
    wait_tokens_est: rows.reduce((a, r) => a + (r.wait_tokens_est ?? 0), 0),
  };
  return { date: day, tasks: rows, totals: tot, consumption };
}

export interface ProjectRowApi {
  project: string;
  cwd: string;
  cwds: string[];
  tasks: number;
  root_tokens: number;
  subagent_tokens: number;
  total_tokens: number;
  uncached_tokens: number;
  output_tokens: number;
  samples: number;
  wait: number;
  subagents: number;
  compactions: number;
  models: string[];
  last_active_ms: number;
  schema_ok: boolean;
}

export function projectRows(conn: DatabaseSync, sinceMs: number | null = null): ProjectRowApi[] {
  const rows = taskRows(conn, sinceMs, 100000);
  const by = new Map<string, ProjectRowApi>();
  for (const r of rows) {
    const k = r.project;
    let p = by.get(k);
    if (!p) {
      p = {
        project: k, cwd: r.cwd, cwds: [], tasks: 0, root_tokens: 0, subagent_tokens: 0,
        total_tokens: 0, uncached_tokens: 0, output_tokens: 0, samples: 0,
        wait: 0, subagents: 0, compactions: 0, models: [], last_active_ms: 0, schema_ok: true,
      };
      by.set(k, p);
    }
    p.tasks += 1;
    for (const f of ["root_tokens", "subagent_tokens", "total_tokens", "uncached_tokens",
      "output_tokens", "samples", "wait", "subagents", "compactions"] as const) {
      p[f] += r[f];
    }
    if (!p.models.includes(r.model)) p.models.push(r.model);
    for (const sm of r.sub_models) {
      if (!p.models.includes(sm.model)) p.models.push(sm.model);
    }
    p.last_active_ms = Math.max(p.last_active_ms, r.activity_ms ?? 0);
    p.schema_ok = p.schema_ok && r.schema_ok;
    if (k.length > 3 && k !== r.cwd && !p.cwds.includes(r.cwd)) p.cwds.push(r.cwd);
  }
  const out = [...by.values()];
  out.sort((a, b) => b.last_active_ms - a.last_active_ms);
  return out;
}

/** schema_issues 列（JSON：{"字段名": 次数}）→ 对象；空/畸形 → null。 */
function parseSchemaIssues(raw: unknown): Record<string, number> | null {
  if (raw == null || raw === "") return null;
  try {
    const o = JSON.parse(String(raw));
    if (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length > 0) {
      return o as Record<string, number>;
    }
  } catch { /* ignore */ }
  return null;
}

/** 任意线程的 turn 明细（active 轮补 usage 差分五项）。 */
function loadTurns(conn: DatabaseSync, threadId: string): Row[] {
  const turns: Row[] = [];
  for (const d of conn
    .prepare("SELECT * FROM turns WHERE thread_id=? AND turn_index>=0 ORDER BY turn_index")
    .all(threadId) as Row[]) {
    if (typeof d["patch_files"] === "string") {
      try {
        const pf = JSON.parse(d["patch_files"]);
        d["patch_files"] = Array.isArray(pf) ? pf.map(String) : [];
      } catch {
        d["patch_files"] = [];
      }
    }
    if (d["status"] === "active" && d["usage_start_json"]) {
      try {
        const s = JSON.parse(d["usage_start_json"]);
        const e = JSON.parse(d["usage_end_json"] || "{}");
        const g = (x: Row, k: string): number => Math.max(0, Number(x?.[k] ?? 0) || 0);
        d["input_tokens"] = g(e, "input_tokens") - g(s, "input_tokens");
        d["cached_input_tokens"] = g(e, "cached_input_tokens") - g(s, "cached_input_tokens");
        d["output_tokens"] = g(e, "output_tokens") - g(s, "output_tokens");
        d["reasoning_tokens"] = g(e, "reasoning_output_tokens") - g(s, "reasoning_output_tokens");
        d["total_tokens"] = g(e, "total_tokens") - g(s, "total_tokens");
      } catch { /* ignore */ }
    }
    turns.push(d);
  }
  return turns;
}

/** 子代理 turn 下钻：按线程 ID（或唯一前缀）取 turn 明细；day 时仅返回该日开始的轮。 */
export function threadTurns(conn: DatabaseSync, idOrPrefix: string, limit = 500, day?: string | null): Row[] | null {
  const snap = snapshot(conn);
  let tid: string | null = null;
  if (snap.has(idOrPrefix)) tid = idOrPrefix;
  else {
    const hits = [...snap.keys()].filter((k) => k.startsWith(idOrPrefix));
    if (hits.length === 1) tid = hits[0]!;
  }
  if (tid === null) return null;
  let turns = loadTurns(conn, tid);
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const s = new Date(`${day}T00:00:00`).getTime();
    const e = s + 86_400_000;
    turns = turns.filter((r) => {
      const ms = Number(r["started_ms"] ?? r["completed_ms"]) || 0;
      return ms >= s && ms < e;
    });
  }
  return turns.slice(0, limit);
}

export function taskDetail(
  conn: DatabaseSync, idOrPrefix: string, catalog?: PriceCatalog | null, dayParam?: string | null,
): Row | null {
  const snap = snapshot(conn);
  let tid: string | null = null;
  if (snap.has(idOrPrefix)) tid = idOrPrefix;
  else {
    const hits = [...snap.keys()].filter((k) => k.startsWith(idOrPrefix));
    if (hits.length === 1) tid = hits[0]!;
  }
  if (tid === null) return null;
  const t = snap.get(tid)!;
  const rootId = t["root_thread_id"] || tid;
  const root = snap.get(rootId) ?? t;
  const subs = [...snap.values()]
    .filter((s) => s["root_thread_id"] === rootId && s["thread_type"] === "subagent")
    .sort((a, b) => (a["created_ms"] ?? 0) - (b["created_ms"] ?? 0));

  // v1.4 当日切片（scope=day）：任务详情页「总计/当日」切换。
  //   消耗/采样用 daily_usage（与今日视图同源）；工具行为/失败用 tool_events/tool_failures 时戳过滤；轮按 started 归日。
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : null;
  const dayStart = day ? new Date(`${day}T00:00:00`).getTime() : null;
  const dayArgs = day && dayStart != null ? [dayStart, dayStart + 86_400_000] : [];
  const dayFrag = day ? "AND ts_ms IS NOT NULL AND ts_ms>=? AND ts_ms<?" : "";
  const inDay = (ms: unknown): boolean => {
    if (dayStart == null) return true;
    const n = Number(ms);
    return Number.isFinite(n) && n >= dayStart && n < dayStart + 86_400_000;
  };
  const domainIds = [rootId, ...subs.map((s) => String(s["thread_id"]))];
  // 当日 per-thread 消耗（native = 毛差分 − replay；PRIMARY KEY(thread_id,day) → 单行）
  let dayRootTok = 0;
  let daySubTok = 0;
  const daySubByThread = new Map<string, number>();
  const dayRootParts = { input: 0, cached: 0, output: 0, samples: 0, wait: 0 };
  let daySubSamples = 0, daySubWait = 0;
  if (day) {
    const wanted = new Set(domainIds);
    for (const r of conn.prepare(
      `SELECT thread_id tid, MAX(0, tokens - COALESCE(replay_total_tokens,0)) t,
              MAX(0, input_tokens - COALESCE(replay_input_tokens,0)) i,
              MAX(0, cached_input_tokens - COALESCE(replay_cached_tokens,0)) c,
              MAX(0, output_tokens - COALESCE(replay_output_tokens,0)) o,
              samples s, wait w
       FROM daily_usage WHERE day=?`,
    ).all(day) as Row[]) {
      const id = String(r["tid"]);
      if (!wanted.has(id)) continue;
      if (id === rootId) {
        dayRootTok = Number(r["t"]) || 0;
        dayRootParts.input = Number(r["i"]) || 0;
        dayRootParts.cached = Number(r["c"]) || 0;
        dayRootParts.output = Number(r["o"]) || 0;
        dayRootParts.samples = Number(r["s"]) || 0;
        dayRootParts.wait = Number(r["w"]) || 0;
      } else {
        const v = Number(r["t"]) || 0;
        daySubByThread.set(id, v);
        daySubTok += v;
        daySubSamples += Number(r["s"]) || 0;
        daySubWait += Number(r["w"]) || 0;
      }
    }
  }

  const header = (x: Row): Row => ({
    thread_id: x["thread_id"],
    thread_type: x["thread_type"] ?? null,
    agent_nickname: x["agent_nickname"] ?? null,
    depth: x["depth"] ?? null,
    forked_from_id: x["forked_from_id"] ?? null,
    inherited_baseline: x["inherited_baseline"] ?? null,
    baseline_verified: x["baseline_verified"] ?? null,
    baseline_method: x["baseline_method"] ?? null,
    verification_status: x["verification_status"] ?? null,
    fork: x["forked_from_id"]
      ? {
          forked_from_id: x["forked_from_id"],
          method: x["baseline_method"] ?? null,
          status: x["verification_status"] ?? null,
          baseline: x["inherited_baseline"] ?? null,
          prefix_events: x["bpe"] ?? null,
          parent_digest: x["bpd"] ?? null,
          replay: {
            input: x["ri"] || 0,
            cached: x["rc"] || 0,
            output: x["ro"] || 0,
            total: x["rr"] || 0,
            events: x["rev"] || 0,
          },
          native_total: x["excl_total"],
        }
      : null,
    model: x["model"] ?? null,
    effort: x["effort"] ?? null,
    cli_version: x["cli_version"] ?? null,
    cwd: normCwd(x["cwd"]),
    git_origin_url: x["git_origin_url"] ?? null,
    git_branch: x["git_branch"] ?? null,
    created_ms: x["created_ms"] ?? null,
    updated_ms: x["updated_ms"] ?? x["last_event_ms"],
    tokens_used_state: x["tokens_used_state"] ?? null, // state DB 口径：lifetime 累计（含继承），勿当 context
    originator: x["originator"] ?? null,
    sandbox_policy: x["sandbox_policy"] ?? null,
    approval_mode: x["approval_mode"] ?? null,
    // v1.2 派生（查询层计算，不落盘防漂移）
    wall_ms: x["first_event_ms"] != null && x["last_event_ms"] != null
      ? Math.max(0, Number(x["last_event_ms"]) - Number(x["first_event_ms"]))
      : null,
    ttfm_ms: x["first_patch_ms"] != null && x["first_event_ms"] != null
      ? Math.max(0, Number(x["first_patch_ms"]) - Number(x["first_event_ms"]))
      : null, // TTFM = 首个有效文件修改 − 任务首事件
  });

  const tokens = (x: Row): Row => ({
    input: x["n_input"] || 0,
    cached: x["n_cached"] || 0,
    uncached: Math.max(0, (x["n_input"] || 0) - (x["n_cached"] || 0)),
    cache_write: x["fcw"] || 0, // raw 累计快照（cache write 无 replay 列）
    output: x["n_output"] || 0,
    reasoning: x["fr"] || 0, // raw 累计快照（无 replay 列）
    total: x["excl_total"],
    raw_total: x["raw_total"] || 0, // L0 观测累计（含继承前缀）
  });

  const diag = (x: Row): Row => ({
    samples: x["s"] || 0,
    wait: x["w"] || 0,
    rebroadcast: x["rb"] || 0,
    tool_calls: x["tool_calls"] || 0,
    tool_output_bytes: x["tool_output_bytes"] || 0,
    patches: x["patches"] || 0,
    compactions: x["comp"] || 0,
    peak_context: x["pc"] ?? null,
    model_context_window: x["mcw"] ?? null,
    schema_compat: x["sc"] || "ok",
    schema_issues: parseSchemaIssues(x["si"]),
    // v1.2：web/MCP/shell（shell_failures 为 estimated 启发式，低估方向）
    web_searches: x["web_searches"] || 0,
    mcp_calls: x["mcp_calls"] || 0,
    mcp_failures: x["mcp_failures"] || 0,
    shell_failures: x["shell_failures"] || 0,
  });

  const turnsAll = loadTurns(conn, rootId);
  const turns: Row[] = day ? turnsAll.filter((r) => inDay(r["started_ms"] ?? r["completed_ms"])) : turnsAll;

  const warnings: string[] = [];
  for (const x of [root, ...subs]) {
    const when = x["first_event_ms"]
      ? `（首事件 ${new Date(Number(x["first_event_ms"])).toLocaleString("zh-CN", { hour12: false })}）`
      : "";
    if ((x["sc"] || "ok") !== "ok") {
      warnings.push(`线程 ${String(x["thread_id"]).slice(0, 8)} schema_incompatible → Token 非 authoritative${when}`);
    }
    try {
      const eps = JSON.parse(x["ep"] || "[]");
      if (Array.isArray(eps) && eps.length > 1) {
        const sums = eps.reduce((a: number, p: any) => a + (p[1] - p[0]), 0);
        warnings.push(
          `线程 ${String(x["thread_id"]).slice(0, 8)} 跨 ${eps.length} 个独立计数会话，Σ区间 ${sums.toLocaleString("en-US")}（高水位口径可能少计）${when}`,
        );
      }
    } catch { /* ignore */ }
    if (x["forked_from_id"] && x["verification_status"] !== "verified") {
      warnings.push(
        `线程 ${String(x["thread_id"]).slice(0, 8)} fork 归因 ${String(x["baseline_method"] ?? "unresolved")}（${String(x["verification_status"] ?? "pending")}）：replay 扣减未经父验证，数值仅供参考${when}`,
      );
    }
  }

  const ts = turnStats(conn).get(rootId) ?? { turns: 0, status: "idle" };

  // —— v1.2 分析层派生（查询层计算，标注 estimated/heuristic，不落盘） ——
  // wait 时长估算：Σ(完成轮 duration × 该轮 wait 采样占比)（estimated：采样占比≈时间占比）
  let waitMsEst = 0;
  for (const t of turns) {
    const s = Number(t["usage_bearing_samples"]) || 0;
    const w = Number(t["wait_status_model_calls"]) || 0;
    const dur = Number(t["duration_ms"]) || 0;
    if (s > 0 && w > 0 && dur > 0) waitMsEst += Math.round(dur * (w / s));
  }
  // wait/status Token 估算（任务域 = root + 子代理）与成本（estimated：采样占比≈消耗占比；成本按时点取价）
  const lite = loadTurnsLite(conn).filter((t) => t.root === rootId && (!day || (t.ts_ms != null && localDate(t.ts_ms) === day)));
  const waitTok = waitTokensOf(lite);
  const waitCost: CostEst | null = catalog
    ? costAggregate(catalog, lite.flatMap((t) => {
        if (t.samples <= 0 || t.wait <= 0) return [];
        const r = Math.min(1, t.wait / t.samples);
        return [{ model: t.model, ts_ms: t.ts_ms, input: t.input * r, cached: t.cached * r, cache_write: t.cache_write * r, output: t.output * r }];
      }))
    : null;
  const costEst: CostEst | null = catalog ? costAggregate(catalog, lite) : null;
  // v1.4 wait 调用实测时长（tool_events：name∈WAIT_ACTIONS 的 call↔output 时戳差；无回填/无配对 → null 不猜）
  let waitCallMs: number | null = null;
  let waitCallN = 0;
  {
    const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_events'").get();
    if (has && domainIds.length) {
      const ph = domainIds.map(() => "?").join(",");
      const names = [...WAIT_ACTIONS];
      const nph = names.map(() => "?").join(",");
      const r = conn.prepare(
        `SELECT COALESCE(SUM(duration_ms),0) ms, SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) n
         FROM tool_events WHERE thread_id IN (${ph}) AND name IN (${nph}) ${dayFrag}`,
      ).get(...domainIds, ...names, ...dayArgs) as Row;
      waitCallN = Number(r["n"]) || 0;
      waitCallMs = waitCallN > 0 ? Number(r["ms"]) || 0 : null;
    }
  }
  // 子代理并发峰值：活跃区间 [max(created, first_event), last_event] 的最大重叠数（estimated：区间为线程粒度）
  const intervals: Array<[number, number]> = [];
  for (const s of subs) {
    const st = Number(s["first_event_ms"] ?? s["created_ms"]) || 0;
    const en = Number(s["last_event_ms"] ?? s["updated_ms"]) || 0;
    if (st && en && en >= st) intervals.push([st, en]);
  }
  let concurrencyPeak = 0;
  if (intervals.length > 1) {
    const events: Array<[number, number]> = [];
    for (const [st, en] of intervals) {
      events.push([st, 1], [en, -1]);
    }
    events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cur = 0;
    for (const [, d] of events) {
      cur += d;
      concurrencyPeak = Math.max(concurrencyPeak, cur);
    }
  } else {
    concurrencyPeak = intervals.length;
  }
  // no-progress/runaway 预警（heuristic）：整轮采样全部 wait/status 且无 patch/MCP，
  // 连续 ≥2 轮（或单轮采样 ≥5）→ 疑似无效等待（参考 openai/codex#35259/#38495 的 wait 轮询形态）
  const noProgressTurns = turns
    .filter((t) => {
      const s = Number(t["usage_bearing_samples"]) || 0;
      const w = Number(t["wait_status_model_calls"]) || 0;
      return s >= 3 && w === s &&
        !(Number(t["patches"]) > 0) && !(Number(t["mcp_calls"]) > 0);
    })
    .map((t) => Number(t["turn_index"]));
  if (noProgressTurns.length >= 1) {
    let streakStart = noProgressTurns[0]!;
    let prev = noProgressTurns[0]!;
    const streaks: Array<[number, number]> = [];
    for (const idx of noProgressTurns.slice(1)) {
      if (idx === prev + 1) {
        prev = idx;
      } else {
        streaks.push([streakStart, prev]);
        streakStart = idx;
        prev = idx;
      }
    }
    streaks.push([streakStart, prev]);
    for (const [a, b] of streaks) {
      if (b - a >= 1) {
        warnings.push(`疑似无效等待轮：turn #${a}–#${b} 连续 ${b - a + 1} 轮采样全部 wait/status 且无产出（heuristic，estimated）`);
      }
    }
    const bigSingle = turns.find((t) => {
      const s = Number(t["usage_bearing_samples"]) || 0;
      const w = Number(t["wait_status_model_calls"]) || 0;
      return s >= 5 && w === s && !(Number(t["patches"]) > 0) && !(Number(t["mcp_calls"]) > 0);
    });
    if (bigSingle) {
      warnings.push(`turn #${bigSingle["turn_index"]} 单轮 ${bigSingle["usage_bearing_samples"]} 次采样全部 wait/status（heuristic，estimated）`);
    }
  }

  const tstats = turnStats(conn);
  // v1.3：任务域工具行为（分桶/时长/成败/文件行为，来自 TS-only tool_events 表；老库无表 → 空结果）
  const toolBehaviorOf = (ids: string[]): Row => {
    const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_events'").get();
    if (!has || !ids.length) return { buckets: [], file_behavior: null };
    const ph = ids.map(() => "?").join(",");
    const buckets = (conn.prepare(
      `SELECT bucket, COUNT(*) AS calls,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures,
              SUM(CASE WHEN ok IS NOT NULL THEN 1 ELSE 0 END) AS ok_known,
              COALESCE(SUM(duration_ms),0) AS duration_ms,
              SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS duration_n,
              COALESCE(SUM(reads),0) AS reads,
              COALESCE(SUM(files_touched),0) AS files_touched,
              COALESCE(SUM(lines_plus),0) AS lines_plus,
              COALESCE(SUM(lines_minus),0) AS lines_minus
       FROM tool_events WHERE thread_id IN (${ph}) ${dayFrag} GROUP BY bucket ORDER BY calls DESC`,
    ).all(...ids, ...dayArgs) as Row[]).map((r) => ({
      bucket: String(r["bucket"]),
      calls: Number(r["calls"]) || 0,
      failures: Number(r["failures"]) || 0,
      ok_known: Number(r["ok_known"]) || 0,
      // 全 NULL 时置 null（UI 显示 "–"），不误报 0.0s
      duration_ms: Number(r["duration_n"]) > 0 ? Number(r["duration_ms"]) || 0 : null,
      duration_n: Number(r["duration_n"]) || 0,
      reads: Number(r["reads"]) || 0,
      files_touched: Number(r["files_touched"]) || 0,
      lines_plus: Number(r["lines_plus"]) || 0,
      lines_minus: Number(r["lines_minus"]) || 0,
    }));
    // repeated reads（estimated）：同一路径在 ≥2 次读命令中出现
    const readRows = conn.prepare(
      `SELECT read_files FROM tool_events WHERE bucket='shell' AND read_files IS NOT NULL AND thread_id IN (${ph}) ${dayFrag}`,
    ).all(...ids, ...dayArgs) as Row[];
    const readCount = new Map<string, number>();
    let readsTotal = 0;
    for (const rr of readRows) {
      try {
        const arr = JSON.parse(String(rr["read_files"]));
        if (!Array.isArray(arr)) continue;
        for (const f of new Set(arr.map(String))) readCount.set(f, (readCount.get(f) ?? 0) + 1);
      } catch { /* 忽略畸形 JSON */
      }
    }
    for (const b of buckets) if (b.bucket === "shell") readsTotal = b.reads;
    const repeated = [...readCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const fileBucket = buckets.find((b) => b.bucket === "file");
    const fileBehavior = readsTotal > 0 || readCount.size > 0 || fileBucket
      ? {
          reads: readsTotal,
          distinct_files: readCount.size,
          repeated_reads: repeated.map(([file, n]) => ({ file, n })),
          files_touched: fileBucket?.files_touched ?? 0,
          lines_plus: fileBucket?.lines_plus ?? 0,
          lines_minus: fileBucket?.lines_minus ?? 0,
        }
      : null;
    return { buckets, file_behavior: fileBehavior };
  };
  // v1.2：任务域失败明细（root + 子代理，事件级 drill-down；v1.4 day 切片按时戳过滤）
  const subIds = subs.map((s) => String(s["thread_id"]));
  const failRows = (conn.prepare(
    `SELECT thread_id, ts_ms, turn_index, kind, exit_code, server, tool, command, detail
     FROM tool_failures WHERE (thread_id=? ${subIds.length ? `OR thread_id IN (${subIds.map(() => "?").join(",")})` : ""}) ${dayFrag}
     ORDER BY ts_ms DESC LIMIT 200`,
  ).all(rootId, ...subIds, ...dayArgs) as Row[]).map((r) => ({
    thread_id: String(r["thread_id"]),
    thread_type: r["thread_id"] === rootId ? "root" : "subagent",
    ts_ms: r["ts_ms"] ?? null,
    turn_index: r["turn_index"] ?? null,
    kind: String(r["kind"] ?? ""),
    exit_code: r["exit_code"] ?? null,
    server: r["server"] ?? null,
    tool: r["tool"] ?? null,
    command: r["command"] ?? null,
    detail: r["detail"] ?? null,
  }));
  // —— v1.4 scope=day 输出改写（总计口径之外的当日版本；不影响总计路径）——
  const headerOut = header(root);
  let tokensOut = tokens(root);
  let diagOut: Row = diag(root);
  if (day) {
    headerOut["ttfm_ms"] = null; // 当日切片无 TTFM 语义（任务首事件在历史日，切回「总计」查看）
    let mn: number | null = null, mx: number | null = null;
    for (const r of turns) {
      const st = Number(r["started_ms"]) || null;
      const en = Number(r["completed_ms"] ?? r["started_ms"]) || null;
      if (st != null) mn = mn == null ? st : Math.min(mn, st);
      if (en != null) mx = mx == null ? en : Math.max(mx, en);
    }
    headerOut["wall_ms"] = mn != null && mx != null ? Math.max(0, mx - mn) : null; // 当日活跃跨度（派生）
    // 主线程 Token 构成（当日）：input/cached/output 用 daily_usage（native），cache_write/推理 用当日轮 Σ
    let cw = 0, rea = 0;
    for (const r of turns) { cw += Number(r["cache_write_tokens"]) || 0; rea += Number(r["reasoning_tokens"]) || 0; }
    tokensOut = {
      input: dayRootParts.input, cached: dayRootParts.cached,
      uncached: Math.max(0, dayRootParts.input - dayRootParts.cached),
      cache_write: cw, output: dayRootParts.output, reasoning: rea,
      total: dayRootTok, raw_total: 0,
    };
    // 主线程 diag（当日）：samples/wait 用 daily_usage；工具/补丁/MCP/web 用 tool_events 当日切片；
    // rebroadcast/输出量当日不入账 → null（UI 显示 "–"）；峰值/窗口/schema 保持 lifetime（高水位语义）
    let toolCallsDay = 0, patchesDay = 0, webDay = 0, mcpDay = 0, mcpFailDay = 0;
    const hasTE = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_events'").get();
    if (hasTE) {
      for (const r of conn.prepare(
        `SELECT bucket, COUNT(*) c, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok1
         FROM tool_events WHERE thread_id=? ${dayFrag} GROUP BY bucket`,
      ).all(rootId, ...dayArgs) as Row[]) {
        const c = Number(r["c"]) || 0;
        toolCallsDay += c;
        if (r["bucket"] === "file") patchesDay = Number(r["ok1"]) || 0;
        if (r["bucket"] === "web") webDay = c;
        if (r["bucket"] === "mcp") { mcpDay = c; mcpFailDay = c - (Number(r["ok1"]) || 0); }
      }
    }
    const shellFailDay = Number((conn.prepare(
      `SELECT COUNT(*) c FROM tool_failures WHERE thread_id=? AND kind='shell_exit' ${dayFrag}`,
    ).get(rootId, ...dayArgs) as Row)["c"]) || 0;
    let compDay = 0;
    for (const r of turns) compDay += Number(r["compactions"]) || 0;
    diagOut = {
      ...diag(root),
      samples: dayRootParts.samples + daySubSamples,
      wait: dayRootParts.wait + daySubWait,
      rebroadcast: null,
      tool_calls: toolCallsDay,
      tool_output_bytes: null,
      patches: patchesDay,
      compactions: compDay,
      mcp_calls: mcpDay,
      mcp_failures: mcpFailDay,
      web_searches: webDay,
      shell_failures: shellFailDay,
    };
  }
  // 当日子代理模型拆分（daily_usage 口径，与任务 Token 卡同源）
  const subModels = day
    ? (conn.prepare(
        `SELECT th.model m, SUM(du.tokens - COALESCE(du.replay_total_tokens,0)) t, COUNT(DISTINCT du.thread_id) n
         FROM daily_usage du JOIN threads th ON th.thread_id=du.thread_id
         WHERE du.day=? AND th.thread_type='subagent' AND th.root_thread_id=?
         GROUP BY th.model ORDER BY t DESC`,
      ).all(day, rootId) as Row[]).map((r) => ({
        model: String(r["m"] ?? "–"), tokens: Number(r["t"]) || 0, threads: Number(r["n"]) || 0,
      }))
    : subModelSplit(subs);
  return {
    name: taskName(root),
    project: projectKey(root["cwd"]),
    scope: { day }, // v1.4：null=总计；"YYYY-MM-DD"=当日切片
    header: headerOut,
    tokens: tokensOut,
    diag: diagOut,
    status: STATUS_MAP[ts["status"]] ?? ts["status"],
    subagents: subs.map((s) => ({
      header: header(s),
      tokens: tokens(s),
      diag: diag(s),
      day_tokens: day ? (daySubByThread.get(String(s["thread_id"])) ?? 0) : null, // v1.4 当日切片
      status: STATUS_MAP[tstats.get(String(s["thread_id"]))?.["status"] ?? "idle"]
        ?? tstats.get(String(s["thread_id"]))?.["status"] ?? "idle",
    })),
    sub_model_breakdown: subModels,
    turns: turns.slice(0, 500),
    warnings,
    orchestration: {
      subagents: subs.length,
      concurrency_peak: concurrencyPeak, // estimated（区间为线程粒度）
      wait_ms_est: waitMsEst, // estimated
      wait_call_ms: waitCallMs, // v1.4 实测：wait/status 调用 call↔output 差（无配对数据 → null）
      wait_call_n: waitCallN,
      wait_tokens_est: waitTok.total, // estimated（任务域）
      wait_tokens_split: { input: waitTok.input, cached: waitTok.cached, output: waitTok.output }, // estimated
      wait_cost_est: waitCost ? waitCost.total : null, // estimated · 按时点价（目录缺失/未配置 → null）
    },
    cost_est: costEst,
    tool_failures: failRows,
    tool_behavior: toolBehaviorOf([rootId, ...subIds]),
    task_totals: day
      ? { root_tokens: dayRootTok, subagent_tokens: daySubTok, total_tokens: dayRootTok + daySubTok }
      : {
          root_tokens: root["excl_total"],
          subagent_tokens: subs.reduce((a, s) => a + s["excl_total"], 0),
          total_tokens: root["excl_total"] + subs.reduce((a, s) => a + s["excl_total"], 0),
        },
  };
}

export interface DailyModelSplit {
  model: string;
  tokens: number;
}

export interface DayTaskEntry {
  thread_id: string;
  name: string;
  project: string;
  model: string;
  day_tokens: number;
  day_root: number;
  day_sub: number;
  task_total: number;
  status: string;
  activity_ms: number | null;
  shell_failures: number;
  mcp_failures: number;
}

export interface DailyPoint {
  date: string;
  root: number;
  sub: number;
  total: number;
  uncached: number;
  output: number;
  samples: number;
  wait: number;
  tasks: number;
  by_model: DailyModelSplit[];
}

interface DayAggInternal {
  root: number;
  sub: number;
  unc: number;
  out: number;
  samples: number;
  wait: number;
  byModel: Map<string, number>;
  byTask: Map<string, { root: number; sub: number }>;
}

/** daily_usage 聚合：按日 × (root/sub, 模型, 任务域)。v1.1：消耗 = 毛差分 − replay（组件级）。 */
function aggregateDaily(conn: DatabaseSync): Map<string, DayAggInternal> {
  const out = new Map<string, DayAggInternal>();
  const rows = conn.prepare(`SELECT du.day day, th.thread_type ty, th.model m,
    CASE WHEN th.thread_type='subagent' THEN th.root_thread_id ELSE th.thread_id END task,
    SUM(du.tokens - COALESCE(du.replay_total_tokens,0)) t,
    SUM(du.input_tokens - COALESCE(du.replay_input_tokens,0)) i,
    SUM(du.cached_input_tokens - COALESCE(du.replay_cached_tokens,0)) c,
    SUM(du.output_tokens - COALESCE(du.replay_output_tokens,0)) o,
    SUM(du.samples) s, SUM(du.wait) w
    FROM daily_usage du JOIN threads th ON th.thread_id = du.thread_id
    GROUP BY du.day, ty, m, task`).all() as Row[];
  for (const r of rows) {
    const day = String(r["day"]);
    let d = out.get(day);
    if (!d) {
      d = { root: 0, sub: 0, unc: 0, out: 0, samples: 0, wait: 0, byModel: new Map(), byTask: new Map() };
      out.set(day, d);
    }
    const t = Number(r["t"]) || 0;
    const isSub = r["ty"] === "subagent";
    if (isSub) d.sub += t;
    else d.root += t;
    const model = String(r["m"] || "-");
    d.byModel.set(model, (d.byModel.get(model) || 0) + t);
    d.unc += Math.max(0, (Number(r["i"]) || 0) - (Number(r["c"]) || 0));
    d.out += Number(r["o"]) || 0;
    d.samples += Number(r["s"]) || 0;
    d.wait += Number(r["w"]) || 0;
    const task = String(r["task"] ?? "");
    if (task) {
      const e = d.byTask.get(task) ?? { root: 0, sub: 0 };
      if (isSub) e.sub += t;
      else e.root += t;
      d.byTask.set(task, e);
    }
  }
  return out;
}

function toPoint(day: string, d: DayAggInternal): DailyPoint {
  return {
    date: day,
    root: d.root,
    sub: d.sub,
    total: d.root + d.sub,
    uncached: d.unc,
    output: d.out,
    samples: d.samples,
    wait: d.wait,
    tasks: d.byTask.size,
    by_model: [...d.byModel.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens),
  };
}

/** 近 N 天连续序列（空日补零）。 */
export function dailySeries(conn: DatabaseSync, days = 30): DailyPoint[] {
  const agg = aggregateDaily(conn);
  const out: DailyPoint[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const day = localDate(now - i * 86_400_000)!;
    const d = agg.get(day);
    out.push(d ? toPoint(day, d) : {
      date: day, root: 0, sub: 0, total: 0, uncached: 0, output: 0, samples: 0, wait: 0, tasks: 0, by_model: [],
    });
  }
  return out;
}

export interface DayDetailApi extends DailyPoint {
  tasks_detail: DayTaskEntry[];
}

export function dayDetail(conn: DatabaseSync, date: string): DayDetailApi | null {
  const agg = aggregateDaily(conn).get(date);
  if (!agg) {
    return {
      ...toPoint(date, { root: 0, sub: 0, unc: 0, out: 0, samples: 0, wait: 0, byModel: new Map(), byTask: new Map() }),
      tasks_detail: [],
    };
  }
  const meta = new Map(taskRows(conn, null, 1000000).map((r) => [r.thread_id, r]));
  const tasksDetail: DayTaskEntry[] = [...agg.byTask.entries()]
    .map(([tid, e]) => {
      const m = meta.get(tid);
      return {
        thread_id: tid,
        name: m?.name ?? tid.slice(0, 8),
        project: m?.project ?? "（未知）",
        model: m?.model ?? "-",
        day_tokens: e.root + e.sub,
        day_root: e.root,
        day_sub: e.sub,
        task_total: m?.total_tokens ?? e.root + e.sub,
        status: m?.status ?? "unknown",
        activity_ms: m?.activity_ms ?? null,
        shell_failures: m?.shell_failures ?? 0,
        mcp_failures: m?.mcp_failures ?? 0,
      };
    })
    .sort((a, b) => b.day_tokens - a.day_tokens);
  return { ...toPoint(date, agg), tasks_detail: tasksDetail };
}

export interface TrendPoint {
  date: string;
  root: number;
  sub: number;
  total: number;
  tasks: number;
  samples: number;
  wait: number;
  output: number;
}

/** 按日聚合（近 N 天，含空日填充），供趋势图。 */
export function trend(conn: DatabaseSync, days = 14): TrendPoint[] {
  const now = Date.now();
  const since = now - days * 86_400_000;
  const rows = taskRows(conn, since, 1000000);
  const byDate = new Map<string, TrendPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(now - i * 86_400_000)!;
    byDate.set(d, { date: d, root: 0, sub: 0, total: 0, tasks: 0, samples: 0, wait: 0, output: 0 });
  }
  for (const r of rows) {
    const d = localDate(r.activity_ms);
    if (!d) continue;
    let p = byDate.get(d);
    if (!p) {
      p = { date: d, root: 0, sub: 0, total: 0, tasks: 0, samples: 0, wait: 0, output: 0 };
      byDate.set(d, p);
    }
    p.root += r.root_tokens;
    p.sub += r.subagent_tokens;
    p.total += r.total_tokens;
    p.tasks += 1;
    p.samples += r.samples;
    p.wait += r.wait;
    p.output += r.output_tokens;
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface FailureOverviewRow {
  thread_id: string;
  name: string;
  root_thread_id: string | null;
  ts_ms: number | null;
  turn_index: number | null;
  kind: string;
  exit_code: number | null;
  server: string | null;
  tool: string | null;
  command: string | null;
  detail: string | null;
}

/** 全库失败总览（tool_failures 事件明细，最新在前；状态页下钻用）。 */
export function failuresOverview(conn: DatabaseSync, limit = 100): { total: number; rows: FailureOverviewRow[] } {
  const names = new Map<string, { name: string; root: string | null }>();
  for (const t of conn.prepare(
    "SELECT thread_id, thread_type, root_thread_id, name, agent_nickname FROM threads",
  ).all() as Row[]) {
    names.set(String(t["thread_id"]), {
      name: t["thread_type"] === "subagent"
        ? `${t["agent_nickname"] ?? "subagent"} · ${cleanTitle(String(t["name"] ?? ""))}`
        : cleanTitle(String(t["name"] ?? "")),
      root: t["root_thread_id"] ? String(t["root_thread_id"]) : null,
    });
  }
  const total = (conn.prepare("SELECT COUNT(*) c FROM tool_failures").get() as Row)["c"] as number;
  const rows = (conn.prepare(
    `SELECT thread_id, ts_ms, turn_index, kind, exit_code, server, tool, command, detail
     FROM tool_failures ORDER BY ts_ms DESC LIMIT ?`,
  ).all(limit) as Row[]).map((r) => {
    const meta = names.get(String(r["thread_id"]));
    return {
      thread_id: String(r["thread_id"]),
      name: meta?.name ?? String(r["thread_id"]).slice(0, 8),
      root_thread_id: meta?.root ?? null,
      ts_ms: r["ts_ms"] ?? null,
      turn_index: r["turn_index"] ?? null,
      kind: String(r["kind"] ?? ""),
      exit_code: r["exit_code"] ?? null,
      server: r["server"] ?? null,
      tool: r["tool"] ?? null,
      command: r["command"] ?? null,
      detail: r["detail"] ?? null,
    };
  });
  return { total, rows };
}

export function statusInfo(conn: DatabaseSync): Row {
  const meta: Row = {};
  for (const r of conn.prepare("SELECT key, value FROM meta").all() as Row[]) meta[r["key"]] = r["value"];
  const counts: Row = {};
  for (const r of conn
    .prepare("SELECT COALESCE(thread_type,'unknown') ty, COUNT(*) n FROM threads GROUP BY ty")
    .all() as Row[]) {
    counts[r["ty"]] = r["n"];
  }
  const tot = conn.prepare(`SELECT COALESCE(SUM(usage_bearing_samples),0) s,
                                 COALESCE(SUM(wait_status_model_calls),0) w,
                                 COALESCE(SUM(rebroadcast_events),0) rb,
                                 COALESCE(SUM(mcp_calls),0) mc,
                                 COALESCE(SUM(mcp_failures),0) mf,
                                 COALESCE(SUM(shell_failures),0) sf,
                                 COALESCE(SUM(web_searches),0) ws
                          FROM threads_diag`).get() as Row;
  const schemaIssues = (conn
    .prepare("SELECT COUNT(*) AS c FROM threads_diag WHERE schema_compat!='ok'")
    .get() as Row)["c"] as number;
  // schema 异常明细：schema_issues JSON（字段名×次数）逐线程列出，含未达 fail-closed 阈值的零星异常
  const schemaDetails = (conn.prepare(
    `SELECT d.thread_id tid, d.schema_compat sc, d.schema_issues si,
            t.thread_type ty, t.name nm, t.agent_nickname nick
     FROM threads_diag d JOIN threads t ON t.thread_id = d.thread_id
     WHERE d.schema_issues IS NOT NULL AND d.schema_issues != '' AND d.schema_issues != '{}'
     ORDER BY (d.schema_compat != 'ok') DESC, d.thread_id LIMIT 50`,
  ).all() as Row[])
    .map((r) => ({
      thread_id: String(r["tid"]),
      name: r["ty"] === "subagent" ? `${r["nick"] ?? "subagent"}（子代理）` : cleanTitle(String(r["nm"] ?? "")),
      compat: r["sc"] || "ok",
      issues: parseSchemaIssues(r["si"]),
    }))
    .filter((x) => x.issues);
  const files = conn.prepare("SELECT COUNT(*) AS c, SUM(status='active') AS a FROM rollout_files").get() as Row;
  // v1.1 fork 归因覆盖表（G0-B v2）+ 全局 replay 规模
  const forkCoverage = conn.prepare(
    `SELECT COALESCE(t.baseline_method,'(未分类)') method, COALESCE(t.verification_status,'(未判定)') status,
            COUNT(*) n, COALESCE(SUM(d.replay_total_tokens),0) replay
     FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id
     WHERE t.forked_from_id IS NOT NULL GROUP BY method, status ORDER BY n DESC`,
  ).all() as Row[];
  const replayTot = conn.prepare(
    "SELECT COALESCE(SUM(replay_total_tokens),0) rr, COALESCE(SUM(replay_events),0) re FROM threads_diag",
  ).get() as Row;
  return {
    last_update_ms: Number(meta["last_update_ms"] || 0),
    schema_version: meta["schema_version"] || "?",
    codex_version: meta["codex_version"] || "?",
    model: meta["model"] || "?",
    state_db: meta["state_db"] || "?",
    codex_home: meta["codex_home"] || "?",
    counts,
    totals: {
      samples: tot["s"], wait: tot["w"], rebroadcast: tot["rb"],
      mcp_calls: tot["mc"], mcp_failures: tot["mf"],
      shell_failures: tot["sf"], web_searches: tot["ws"],
    },
    replay: { total_tokens: replayTot["rr"] || 0, events: replayTot["re"] || 0 },
    fork_coverage: forkCoverage,
    schema_issues: schemaIssues,
    schema_details: schemaDetails,
    rollout_files: { total: files["c"] || 0, active: files["a"] || 0 },
  };
}

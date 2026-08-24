/**
 * Ingest 主流程 —— Python oracle collector.py ingest() 的 TS 移植。
 * 编排：发现 → state 只读快照 → rollout 增量 tail → 事件解析 → token 差分账目 → collector.sqlite。
 * envCodexHome 显式指定时跳过 codex doctor（fixture / Golden 测试专用）。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discover, sessionFiles } from "@hs/codex-discovery";
import { readSpawnEdges, readThreads, parentFromSource, type ThreadRow } from "@hs/codex-state";
import { readNewLines } from "@hs/rollout-parser";
import { normcase, uuidFromName, toMs, SCHEMA, SCHEMA_VERSION, DEFAULT_TS_DB, TOOL_EVENTS_SCHEMA } from "@hs/shared";
import { resolveRoots } from "@hs/task-graph";
import { LedgerStore } from "@hs/usage-accounting";
import { closeEpoch, lookupParentFiles, markFileStart, processLine } from "@hs/usage-accounting";
import type { ThreadCtx } from "@hs/usage-accounting";

export interface IngestOptions {
  dbPath?: string;
  recentDays?: number | null;
  verbose?: boolean;
  envCodexHome?: string | null;
}

export interface IngestStats {
  files: number;
  events: number;
  threads: number;
  roots: number;
  elapsedS: number;
}

type Row = Record<string, unknown>;
const N = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function connect(dbPath?: string): DatabaseSync {
  const p = dbPath ?? DEFAULT_TS_DB();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(SCHEMA);
  return db;
}

function fileDate(f: string): string | null {
  const segs = f.split(/[\\/]+/).filter(Boolean);
  const last4 = segs.slice(-4);
  if (last4.length >= 4 && /^\d{4}$/.test(last4[0]!)) return last4.slice(0, 3).join("-");
  return null;
}

function tryParse(line: string): Row | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
  } catch {
    return null;
  }
}

/**
 * fork 延迟复核（v1.1）：父文件后来才出现的 fork 线程，清空其派生态后用同一分类器
 * 从全部 rollout 文件重折叠（不触碰 rollout_files.last_offset——折叠态与增量态等价）。
 */
function refoldThread(store: LedgerStore, threadId: string): void {
  const files = (store
    .prepare("SELECT path FROM rollout_files WHERE thread_id=? AND status!='unreadable' ORDER BY path")
    .all(threadId) as Row[])
    .map((r) => String(r["path"] ?? ""))
    .filter(Boolean);
  if (!files.length) return;
  store.prepare("DELETE FROM threads_diag WHERE thread_id=?").run(threadId);
  store.prepare("DELETE FROM daily_usage WHERE thread_id=?").run(threadId);
  store.prepare("DELETE FROM turns WHERE thread_id=?").run(threadId);
  store.prepare("DELETE FROM tool_failures WHERE thread_id=?").run(threadId);
  store.prepare("DELETE FROM tool_events WHERE thread_id=?").run(threadId); // v1.3 TS-only 扩展表同步清理
  store.prepare(
    "UPDATE threads SET inherited_baseline=NULL, baseline_verified=0, baseline_method=NULL, verification_status=NULL WHERE thread_id=?",
  ).run(threadId);
  const ctx = store.loadThreadCtx(threadId); // diag 已清 → 全新折叠；forked_from_id 取自 threads 行
  for (const f of files) {
    let offset = 0;
    for (let round = 0; round < 2000; round++) {
      const { lines, newOffset } = readNewLines(f, offset);
      if (!lines.length) break;
      for (const line of lines) {
        if (!line.trim()) continue;
        markFileStart(ctx, f, offset);
        processLine(store, ctx, line);
      }
      offset = newOffset;
    }
    closeEpoch(ctx, store);
  }
  store.flushThread(ctx);
}

/**
 * v1.3 工具事件全量回填（--refold-tools）：在临时内存库上用完整 processLine 管线重放全部
 * rollout 文件（契约表结果直接丢弃），只把 tool_events 拷回真库——与增量采集口径必然一致。
 * 不触碰真库契约表与 rollout_files.last_offset，幂等可重跑。
 */
export function refoldToolEvents(dbPath?: string): { files: number; events: number } {
  const real = connect(dbPath);
  real.exec(TOOL_EVENTS_SCHEMA); // 确保真库已有 tool_events 表（老库升级）
  const tmp = new DatabaseSync(":memory:");
  tmp.exec(SCHEMA);
  const tstore = new LedgerStore(tmp); // 构造时 apply TOOL_EVENTS_SCHEMA
  try {
    const files = (real
      .prepare("SELECT path, thread_id FROM rollout_files WHERE status!='unreadable' AND thread_id IS NOT NULL ORDER BY path")
      .all() as Row[])
      .map((r) => ({ path: String(r["path"] ?? ""), tid: String(r["thread_id"] ?? "") }))
      .filter((f) => f.path && f.tid);
    const ctxs = new Map<string, ThreadCtx>();
    function loadCtxFor(tid: string): ThreadCtx {
      let c = ctxs.get(tid);
      if (!c) {
        c = tstore.loadThreadCtx(tid);
        ctxs.set(tid, c);
      }
      return c;
    }
    tmp.exec("BEGIN");
    try {
      for (const f of files) {
        const ctx = loadCtxFor(f.tid);
        let offset = 0;
        for (let round = 0; round < 10000; round++) {
          const { lines, newOffset } = readNewLines(f.path, offset);
          if (!lines.length) break;
          for (const line of lines) {
            if (!line.trim()) continue;
            markFileStart(ctx, f.path, offset);
            processLine(tstore, ctx, line);
          }
          offset = newOffset;
        }
        closeEpoch(ctx, tstore);
        tstore.flushThread(ctx);
      }
      tmp.exec("COMMIT");
    } catch (e) {
      tmp.exec("ROLLBACK");
      throw e;
    }
    const rows = tstore.prepare("SELECT * FROM tool_events").all() as Row[];
    real.exec("BEGIN");
    try {
      real.prepare("DELETE FROM tool_events").run();
      const ins = real.prepare(
        "INSERT OR REPLACE INTO tool_events (thread_id, seq, ts_ms, turn_index, bucket, name, call_id, duration_ms, ok, exit_code, files_touched, lines_plus, lines_minus, reads, read_files, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const r of rows) {
        ins.run(
          String(r["thread_id"]), Number(r["seq"]),
          r["ts_ms"] === null ? null : Number(r["ts_ms"]),
          r["turn_index"] === null ? null : Number(r["turn_index"]),
          String(r["bucket"]), r["name"] === null ? null : String(r["name"]), r["call_id"] === null ? null : String(r["call_id"]),
          r["duration_ms"] === null ? null : Number(r["duration_ms"]),
          r["ok"] === null ? null : Number(r["ok"]),
          r["exit_code"] === null ? null : Number(r["exit_code"]),
          r["files_touched"] === null ? null : Number(r["files_touched"]),
          r["lines_plus"] === null ? null : Number(r["lines_plus"]),
          r["lines_minus"] === null ? null : Number(r["lines_minus"]),
          r["reads"] === null ? null : Number(r["reads"]),
          r["read_files"] === null ? null : String(r["read_files"]),
          r["detail"] === null ? null : String(r["detail"]),
        );
      }
      real.exec("COMMIT");
    } catch (e) {
      real.exec("ROLLBACK");
      throw e;
    }
    return { files: files.length, events: rows.length };
  } finally {
    tmp.close();
    real.close();
  }
}

export async function ingest(opts: IngestOptions = {}): Promise<IngestStats> {
  const t0 = Date.now();
  const verbose = opts.verbose ?? true;
  const db = connect(opts.dbPath);
  const store = new LedgerStore(db);
  try {
    const paths = await discover(opts.envCodexHome ?? null);
    if (verbose) {
      console.log(`[discovery] CODEX_HOME=${paths.codexHome} sqlite_home=${paths.sqliteHome}`);
      console.log(`[discovery] state_db=${paths.stateDb} sessions=${paths.sessionsRoot} codex=${paths.codexVersion}`);
    }

    // 1) state DB → threads 快照（权威）
    const stateThreads = new Map<string, ThreadRow>();
    const edges = new Map<string, string>();
    if (paths.stateDb && fs.existsSync(paths.stateDb)) {
      try {
        for (const t of readThreads(paths.stateDb)) stateThreads.set(t.id, t);
        for (const [parent, child] of readSpawnEdges(paths.stateDb)) edges.set(child, parent);
      } catch (e) {
        console.error(`[warn] state DB 读取失败（跳过任务目录）：${e}`);
      }
    }
    if (verbose) console.log(`[state] threads=${stateThreads.size} spawn_edges=${edges.size}`);

    const updState = store.prepare(`UPDATE threads SET rollout_path=?, source=?, thread_source=?, model=?,
            model_provider=?, effort=?, cwd=?, cli_version=?, sandbox_policy=?, approval_mode=?,
            title=?, name=?, preview=?,
            first_user_message=?, tokens_used_state=?, git_branch=?, git_sha=?, git_origin_url=?,
            agent_nickname=?, agent_role=?, agent_path=?, archived=?, created_ms=?, updated_ms=?
            WHERE thread_id=?`);
    for (const t of stateThreads.values()) {
      store.prepare("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)").run(t.id);
      updState.run(
        t.rolloutPath, t.source, t.threadSource, t.model,
        t.modelProvider, t.reasoningEffort, t.cwd, t.cliVersion, t.sandboxPolicy, t.approvalMode,
        t.title, t.name, t.preview,
        t.firstUserMessage, t.tokensUsed, t.gitBranch, t.gitSha, t.gitOriginUrl,
        t.agentNickname, t.agentRole, t.agentPath, t.archived,
        t.createdMs, t.updatedMs, t.id,
      );
    }

    // 2) rollout 文件清单：state 引用 + sessions 全量
    //   （parent 映射的构建挪到文件处理之后：运行中写入的 session_meta parent 才能参与归因）
    const files = sessionFiles(paths.sessionsRoot);
    const norm = new Map<string, string>();
    for (const t of stateThreads.values()) {
      const k = normcase(t.rolloutPath);
      if (k) norm.set(k, t.id);
    }
    const nowMs = Date.now();
    const cutoffMs = opts.recentDays ? nowMs - opts.recentDays * 86_400_000 : null;
    const todo: Array<[string, string | null]> = [];
    const selFile = store.prepare("SELECT * FROM rollout_files WHERE path=?");
    for (const f of files) {
      const key = normcase(f) as string;
      const bound = norm.get(key) ?? null;
      let row = selFile.get(key) as Row | undefined;
      if (row === undefined || row === null) {
        store
          .prepare("INSERT INTO rollout_files (path, thread_id, first_seen_ms) VALUES (?,?,?)")
          .run(key, bound, nowMs);
        row = selFile.get(key) as Row;
      }
      if (bound && row["thread_id"] !== bound) {
        store.prepare("UPDATE rollout_files SET thread_id=? WHERE path=?").run(bound, key);
      }
      if (opts.recentDays != null) {
        const fdate = fileDate(f);
        const fMs = fdate ? toMs(fdate + "T00:00:00Z") : null;
        if (fMs !== null && cutoffMs !== null && fMs < cutoffMs && (N(row["last_offset"]) ?? 0) === 0) {
          store.prepare("UPDATE rollout_files SET status='skipped' WHERE path=?").run(key);
          continue;
        }
      }
      store.prepare("UPDATE rollout_files SET status='active' WHERE path=?").run(key);
      todo.push([f, bound ?? ((row["thread_id"] as string | null) ?? null)]);
    }
    if (verbose) console.log(`[rollout] 文件总数=${files.length} 本轮处理=${todo.length}`);

    // 4) 逐文件增量处理（巨文件分批循环直到无进展）
    let nEvents = 0;
    const ctxs = new Map<string, ThreadCtx>();
    const updOffset = store.prepare("UPDATE rollout_files SET size=?, last_offset=?, updated_ms=? WHERE path=?");
    for (let idx = 0; idx < todo.length; idx++) {
      const [f, threadId] = todo[idx]!;
      const key = normcase(f)!;
      const rf = selFile.get(key) as Row;
      let offset = N(rf["last_offset"]) ?? 0;
      let totalLines = 0;
      let tid = threadId;
      let fileCtx: ThreadCtx | null = null;
      for (let round = 0; round < 1000; round++) {
        // 1000 × 64MB/2万行，足够覆盖最大文件
        const { lines, newOffset, truncated } = readNewLines(f, offset);
        if (truncated) console.error(`[warn] 文件被截断/轮转，从头重读：${path.basename(f)}`);
        if (!lines.length) break;
        let ctx: ThreadCtx | null = null;
        db.exec("BEGIN");
        try {
          for (const line of lines) {
            if (!line.trim()) continue;
            if (tid === null) {
              // 未绑定线程：第一行必须是 session_meta。
              // 绑定只用 payload.id；缺失时回退文件名 uuid。
              // 绝不回退 session_id——子代理文件的 session_id 存的是父线程 id。
              const head = tryParse(line);
              if (!head || head["type"] !== "session_meta") continue;
              const pl = head["payload"];
              const pid = pl && typeof pl === "object" && !Array.isArray(pl) ? (pl as Row)["id"] : null;
              tid = typeof pid === "string" && pid ? pid : uuidFromName(path.basename(f));
              if (!tid) {
                store.prepare("UPDATE rollout_files SET status='unreadable' WHERE path=?").run(key);
                break;
              }
              store.prepare("UPDATE rollout_files SET thread_id=? WHERE path=?").run(tid, key);
              store.prepare("INSERT OR IGNORE INTO threads (thread_id, rollout_path) VALUES (?,?)").run(tid, f);
              store
                .prepare("UPDATE threads SET rollout_path=COALESCE(rollout_path, ?) WHERE thread_id=?")
                .run(f, tid);
            }
            if (!ctxs.has(tid)) ctxs.set(tid, store.loadThreadCtx(tid));
            ctx = ctxs.get(tid)!;
            markFileStart(ctx, f, offset); // v2 文件边界 epoch 规则（重复调用内部短路）
            processLine(store, ctx, line);
            nEvents += 1;
          }
          fileCtx = ctx;
          totalLines += lines.length;
          offset = newOffset;
          updOffset.run(fs.statSync(f).size, offset, nowMs, key);
          if (ctx !== null) store.flushThread(ctx); // v1.1：分类器/账目状态与 offset 同事务提交
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
      if (fileCtx !== null) {
        // 文件边界：封存本文件计数区间（与最终 offset 更新同事务）；v1.3 顺带落孤儿工具调用
        db.exec("BEGIN");
        try {
          closeEpoch(fileCtx, store);
          store.flushThread(fileCtx);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
      const size = fs.statSync(f).size;
      updOffset.run(size, offset, nowMs, key);
      if (verbose && ((idx + 1) % 25 === 0 || idx + 1 === todo.length)) {
        console.log(`[rollout] ${idx + 1}/${todo.length}  ${path.basename(f)}  +${totalLines} 行 -> offset ${offset}`);
      }
    }

    for (const ctx of ctxs.values()) {
      if (ctx.dirty) store.flushThread(ctx);
    }

    // 5) 建立 parent 映射并解析任务图（在文件处理之后，session_meta 已入库）
    //    v3 优先级：① session_meta 自声明 > ② thread_spawn_edges > ③ source JSON
    const parentMap = new Map<string, [string | null, string]>();
    const selParents = store.prepare("SELECT thread_id, parent_thread_id, parent_source FROM threads");
    for (const row of selParents.all() as Row[]) {
      const p = row["parent_thread_id"];
      if (typeof p === "string" && p && (row["parent_source"] ?? "") === "session_meta") {
        parentMap.set(String(row["thread_id"]), [p, "session_meta"]);
      }
    }
    for (const [child, parent] of edges.entries()) {
      if (!parentMap.has(child)) parentMap.set(child, [parent, "edges"]);
    }
    for (const t of stateThreads.values()) {
      const p = parentFromSource(t);
      if (p && !parentMap.has(t.id)) parentMap.set(t.id, [p, "source_json"]);
    }
    for (const row of selParents.all() as Row[]) {
      const tid = String(row["thread_id"]);
      const p = row["parent_thread_id"];
      if (!parentMap.has(tid) && typeof p === "string" && p) {
        parentMap.set(tid, [p, String(row["parent_source"] ?? "unknown") || "unknown"]);
      }
    }

    const allIds = new Set<string>(
      (store.prepare("SELECT thread_id FROM threads").all() as Row[]).map((r) => String(r["thread_id"])),
    );
    for (const tid of allIds) {
      if (!parentMap.has(tid)) parentMap.set(tid, [null, "none"]);
    }
    const onlyWithParent = new Map<string, [string, string]>();
    for (const [k, v] of parentMap.entries()) {
      if (v[0] !== null) onlyWithParent.set(k, [v[0]!, v[1]]);
    }
    const resolved = resolveRoots(onlyWithParent);
    const updRoot = store.prepare(`UPDATE threads SET parent_thread_id=?, parent_source=?, root_thread_id=?,
                depth=?, thread_type=? WHERE thread_id=?`);
    const updNoParent = store.prepare(`UPDATE threads SET parent_thread_id=NULL, parent_source=?, root_thread_id=NULL,
                depth=0, thread_type='root' WHERE thread_id=?`);
    for (const tid of allIds) {
      const [p, src] = parentMap.get(tid) ?? [null, "none"];
      if (p === null) {
        updNoParent.run(src, tid);
      } else {
        const r = resolved.get(tid) ?? { root: tid, depth: -1, type: "root" as const };
        updRoot.run(p, src, r.root, r.depth, r.type, tid);
      }
    }

    // 5.5) fork 延迟复核（v1.1）：首轮 parent_missing 的 fork，若父文件本轮已入库，
    //      用同一分类器对该线程整体重折叠（结构化匹配取代 legacy 降级）
    for (const r of store
      .prepare(
        "SELECT thread_id, forked_from_id FROM threads WHERE forked_from_id IS NOT NULL AND verification_status='parent_missing'",
      )
      .all() as Row[]) {
      const tid = String(r["thread_id"]);
      const pid = String(r["forked_from_id"] ?? "");
      if (tid !== pid && lookupParentFiles(store, pid).length > 0) {
        refoldThread(store, tid);
        ctxs.delete(tid); // 折叠已落盘；旧 ctx 不再使用
      }
    }

    // 6) meta
    const metaPairs: Array<[string, string]> = [
      ["last_update_ms", String(nowMs)],
      ["schema_version", String(SCHEMA_VERSION)],
      ["codex_version", paths.codexVersion ?? ""],
      ["codex_home", paths.codexHome],
      ["state_db", paths.stateDb ?? ""],
      ["model", paths.model ?? ""],
    ];
    for (const [k, v] of metaPairs) {
      store
        .prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(k, v);
    }

    const roots = [...allIds].filter((tid) => (parentMap.get(tid)?.[0] ?? null) === null).length;
    const stats: IngestStats = {
      files: todo.length,
      events: nEvents,
      threads: allIds.size,
      roots,
      elapsedS: Math.round((Date.now() - t0) / 100) / 10,
    };
    if (verbose) console.log(`[done] ${JSON.stringify(stats)}`);
    return stats;
  } finally {
    db.close();
  }
}

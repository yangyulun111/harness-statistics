/**
 * 只读解析 Codex state_5.sqlite —— Python oracle ledger/state_reader.py 的 TS 移植。
 * threads（任务目录，权威）+ thread_spawn_edges（父子图）。
 * 始终 readOnly 打开，绝不写入 ~/.codex。
 */
import { DatabaseSync } from "node:sqlite";
import type { Json } from "@hs/shared";
import { isPlainObject } from "@hs/shared";

export interface ThreadRow {
  id: string;
  rolloutPath: string | null;
  source: string | null; // 用户线程为普通字符串；子代理为 JSON blob
  threadSource: string | null; // user / subagent
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  cwd: string | null;
  cliVersion: string | null;
  sandboxPolicy: string | null; // v1.2：JSON 字符串（state DB 原文）
  approvalMode: string | null; // v1.2
  title: string | null;
  name: string | null;
  preview: string | null;
  firstUserMessage: string | null;
  tokensUsed: number | null; // 线程生命周期累计（total_token_usage.total_tokens）
  gitSha: string | null;
  gitBranch: string | null;
  gitOriginUrl: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  agentPath: string | null;
  archived: number;
  createdMs: number | null; // *_ms 优先，缺失时由 *_at(秒) 换算
  updatedMs: number | null;
}

function openRo(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 8000");
  } catch {
    /* readOnly 连接上的 pragma 失败可忽略 */
  }
  return db;
}

export function readThreads(dbPath: string): ThreadRow[] {
  const db = openRo(dbPath);
  try {
    const rows = db.prepare("SELECT * FROM threads").all() as Record<string, unknown>[];
    const out: ThreadRow[] = [];
    for (const r of rows) {
      const g = (col: string): unknown => (col in r ? r[col] : null);
      const msFrom = (msCol: string, atCol: string): number | null => {
        const msRaw = g(msCol); // not ms → 0 也视为缺失（Python: if not created_ms）
        if (typeof msRaw === "number" && msRaw) return msRaw;
        const atRaw = g(atCol);
        if (typeof atRaw === "number" && atRaw) return Math.trunc(atRaw * 1000);
        return null;
      };
      const createdMs = msFrom("created_at_ms", "created_at");
      const updatedMs = msFrom("updated_at_ms", "updated_at");
      const s = (col: string): string | null => {
        const v = g(col);
        return typeof v === "string" ? v : null;
      };
      const n = (col: string): number | null => {
        const v = g(col);
        return typeof v === "number" ? v : null;
      };
      out.push({
        id: s("id") ?? "",
        rolloutPath: s("rollout_path"),
        source: s("source"),
        threadSource: s("thread_source"),
        model: s("model"),
        modelProvider: s("model_provider"),
        reasoningEffort: s("reasoning_effort"),
        cwd: s("cwd"),
        cliVersion: s("cli_version"),
        sandboxPolicy: s("sandbox_policy"),
        approvalMode: s("approval_mode"),
        title: s("title"),
        name: s("name"),
        preview: s("preview"),
        firstUserMessage: s("first_user_message"),
        tokensUsed: n("tokens_used"),
        gitSha: s("git_sha"),
        gitBranch: s("git_branch"),
        gitOriginUrl: s("git_origin_url"),
        agentNickname: s("agent_nickname"),
        agentRole: s("agent_role"),
        agentPath: s("agent_path"),
        archived: Number(g("archived") ?? 0) || 0,
        createdMs,
        updatedMs,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export function readSpawnEdges(dbPath: string): Array<[string, string, string | null]> {
  const db = openRo(dbPath);
  try {
    const rows = db
      .prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges")
      .all() as Record<string, unknown>[];
    return rows.map((r) => [String(r["parent_thread_id"]), String(r["child_thread_id"]),
      r["status"] === null || r["status"] === undefined ? null : String(r["status"])]);
  } catch {
    return []; // 表缺失等 → 空（Python 侧由 ingest 的 try/except 兜底）
  } finally {
    db.close();
  }
}

/** source 列若为子代理 JSON blob 则解析；普通字符串返回 null。 */
export function sourceDict(row: ThreadRow): Json | null {
  if (!row.source) return null;
  const s = row.source.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function parentFromSource(row: ThreadRow): string | null {
  const d = sourceDict(row);
  if (!d) return null;
  const sub = d["subagent"];
  const spawn = (isPlainObject(sub) ? sub["thread_spawn"] : null) ?? {};
  const p = isPlainObject(spawn) ? spawn["parent_thread_id"] : null;
  return typeof p === "string" && p ? p : null;
}

/**
 * LedgerStore —— collector.sqlite 写侧封装（node:sqlite）。
 * 与 Python oracle collector.py 的 _load_thread_ctx/_flush_thread/_flush_turn/
 * _thread_setdefault/_set_parent/_set_parent_fallback 逐条对应。
 */
import type { DatabaseSync } from "node:sqlite";
import { isPlainObject } from "@hs/shared";
import { CLASSIFICATION_VERSION, TOOL_EVENTS_SCHEMA } from "@hs/shared";
import { forkStateToJson, parseForkState } from "./fork.ts";
import { newDailyAgg, newThreadCtx, newTurn, type DailyAgg, type ThreadCtx, type TurnState } from "./types.ts";

type Row = Record<string, unknown>;

const num = (v: unknown, dft = 0): number => (typeof v === "number" && v !== null ? v : dft);

export class LedgerStore {
  readonly db: DatabaseSync;
  private stmtCache = new Map<string, any>();

  constructor(db: DatabaseSync) {
    this.db = db;
    // v1.3 TS-only 扩展表（不在 golden 六表名单内；CREATE IF NOT EXISTS 幂等）
    db.exec(TOOL_EVENTS_SCHEMA);
  }

  prepare(sql: string): any {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  /** 只在线程行对应字段为空时填充（state DB 是权威，rollout 只补缺）。 */
  threadSetdefault(threadId: string, cols: Record<string, unknown>): void {
    const keys = Object.keys(cols);
    if (!keys.length) return;
    const colList = keys.join(",");
    let row = this.prepare(`SELECT ${colList} FROM threads WHERE thread_id=?`).get(threadId) as Row | undefined;
    if (row === undefined || row === null) {
      this.prepare("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)").run(threadId);
      row = this.prepare(`SELECT ${colList} FROM threads WHERE thread_id=?`).get(threadId) as Row | undefined;
    }
    const updates: Record<string, unknown> = {};
    for (const k of keys) {
      const v = cols[k]!;
      if (v !== null && v !== undefined && !row![k]) updates[k] = v; // Python: v is not None and not row[k]
    }
    const uk = Object.keys(updates);
    if (uk.length) {
      this.prepare(`UPDATE threads SET ${uk.map((k) => `${k}=?`).join(",")} WHERE thread_id=?`).run(
        ...uk.map((k) => updates[k]),
        threadId,
      );
    }
  }

  /** session_meta 自声明 parent：最高归属证据优先级，无条件覆盖。 */
  setParent(tid: string, parent: string, source: string): void {
    this.prepare("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)").run(tid);
    this.prepare("UPDATE threads SET parent_thread_id=?, parent_source=? WHERE thread_id=?").run(parent, source, tid);
  }

  /** edges / source JSON：仅在线程尚无 parent 时填充。 */
  setParentFallback(tid: string, parent: string, source: string): void {
    const row = this.prepare("SELECT parent_thread_id FROM threads WHERE thread_id=?").get(tid) as Row | undefined;
    if (row === undefined || row === null) {
      this.prepare("INSERT OR IGNORE INTO threads (thread_id, parent_thread_id, parent_source) VALUES (?,?,?)").run(
        tid,
        parent,
        source,
      );
    } else if (!row["parent_thread_id"]) {
      this.prepare("UPDATE threads SET parent_thread_id=?, parent_source=? WHERE thread_id=?").run(parent, source, tid);
    }
  }

  loadThreadCtx(threadId: string): ThreadCtx {
    const ctx = newThreadCtx(threadId);
    const d = this.prepare("SELECT * FROM threads_diag WHERE thread_id=?").get(threadId) as Row | undefined;
    if (d !== undefined && d !== null) {
      for (const k of [
        "usage_bearing_samples", "rebroadcast_events", "wait_status_model_calls",
        "token_count_events", "tool_calls", "tool_output_bytes", "patches",
        "compactions", "web_searches", "user_messages", "agent_messages",
        "mcp_calls", "mcp_failures", "shell_failures",
        "native_total", "replay_input_tokens", "replay_cached_tokens",
        "replay_output_tokens", "replay_total_tokens", "replay_events",
      ] as const) {
        (ctx as any)[k] = num(d[k], 0) || 0;
      }
      ctx.first_patch_ms = d["first_patch_ms"] as number | null ?? null;
      ctx.peak_context = d["peak_context"] as number | null ?? null;
      ctx.model_context_window = d["model_context_window"] as number | null ?? null;
      ctx.first_event_ms = d["first_event_ms"] as number | null ?? null;
      ctx.last_event_ms = d["last_event_ms"] as number | null ?? null;
      if (typeof d["schema_issues"] === "string" && d["schema_issues"]) {
        try {
          const v = JSON.parse(d["schema_issues"]);
          if (isPlainObject(v)) {
            for (const [k2, v2] of Object.entries(v)) ctx.schema_issues[k2] = Number(v2) || 0;
          }
        } catch { /* ignore */ }
      }
      if (typeof d["last_total_json"] === "string" && d["last_total_json"]) {
        try {
          const v = JSON.parse(d["last_total_json"]);
          if (isPlainObject(v)) ctx.last_total = v;
        } catch { /* ignore */ }
      }
      if (typeof d["file_usage_epochs"] === "string" && d["file_usage_epochs"]) {
        try {
          const v = JSON.parse(d["file_usage_epochs"]);
          if (Array.isArray(v)) ctx.epochs = v.map((p: unknown) => [Number((p as any[])[0]), Number((p as any[])[1])]);
        } catch {
          ctx.epochs = [];
        }
      }
      if (typeof d["fork_replay_json"] === "string" && d["fork_replay_json"]) {
        parseForkState(d["fork_replay_json"], ctx);
      }
    }
    for (const r of this.prepare(
      `SELECT day, tokens, input_tokens, cached_input_tokens, output_tokens, samples, wait,
              replay_input_tokens, replay_cached_tokens, replay_output_tokens, replay_total_tokens, replay_events
       FROM daily_usage WHERE thread_id=?`,
    ).all(threadId) as Row[]) {
      const agg: DailyAgg = {
        tokens: num(r["tokens"], 0) || 0,
        input_tokens: num(r["input_tokens"], 0) || 0,
        cached_input_tokens: num(r["cached_input_tokens"], 0) || 0,
        output_tokens: num(r["output_tokens"], 0) || 0,
        samples: num(r["samples"], 0) || 0,
        wait: num(r["wait"], 0) || 0,
        replay_input_tokens: num(r["replay_input_tokens"], 0) || 0,
        replay_cached_tokens: num(r["replay_cached_tokens"], 0) || 0,
        replay_output_tokens: num(r["replay_output_tokens"], 0) || 0,
        replay_total_tokens: num(r["replay_total_tokens"], 0) || 0,
        replay_events: num(r["replay_events"], 0) || 0,
      };
      ctx.daily.set(String(r["day"]), agg);
    }
    const frow = this.prepare("SELECT forked_from_id FROM threads WHERE thread_id=?").get(threadId) as Row | undefined;
    if (frow !== undefined && frow !== null && typeof frow["forked_from_id"] === "string" && frow["forked_from_id"]) {
      ctx.forked_from_id = frow["forked_from_id"];
    }
    const maxRow = this.prepare("SELECT MAX(turn_index) AS m FROM turns WHERE thread_id=?").get(threadId) as Row | undefined;
    const maxIdx = maxRow !== undefined && maxRow !== null ? maxRow["m"] : null;
    ctx.next_turn_index = typeof maxIdx === "number" ? maxIdx + 1 : 0;
    // v1.2：tool_failures 序号续接（与 turns 同一恢复模式）
    const maxFail = this.prepare("SELECT MAX(seq) AS m FROM tool_failures WHERE thread_id=?").get(threadId) as Row | undefined;
    const maxSeq = maxFail !== undefined && maxFail !== null ? maxFail["m"] : null;
    ctx.tool_failure_seq = typeof maxSeq === "number" ? maxSeq + 1 : 0;
    // v1.3：tool_events（TS-only）序号续接
    const maxEv = this.prepare("SELECT MAX(seq) AS m FROM tool_events WHERE thread_id=?").get(threadId) as Row | undefined;
    const maxESeq = maxEv !== undefined && maxEv !== null ? maxEv["m"] : null;
    ctx.tool_event_seq = typeof maxESeq === "number" ? maxESeq + 1 : 0;
    const active = this.prepare(
      "SELECT * FROM turns WHERE thread_id=? AND status='active' ORDER BY turn_index DESC LIMIT 1",
    ).get(threadId) as Row | undefined;
    if (active !== undefined && active !== null) {
      const t = newTurn(ctx.thread_id, Number(active["turn_index"]));
      t.turn_id = (active["turn_id"] as string | null) ?? null;
      t.started_ms = (active["started_ms"] as number | null) ?? null;
      t.completed_ms = (active["completed_ms"] as number | null) ?? null;
      t.duration_ms = (active["duration_ms"] as number | null) ?? null;
      t.ttft_ms = (active["ttft_ms"] as number | null) ?? null;
      t.status = String(active["status"] ?? "active");
      t.abort_reason = (active["abort_reason"] as string | null) ?? null;
      t.had_error = num(active["had_error"], 0) || 0;
      t.user_preview = (active["user_preview"] as string | null) ?? null;
      t.usage_bearing_samples = num(active["usage_bearing_samples"], 0) || 0;
      t.rebroadcast_events = num(active["rebroadcast_events"], 0) || 0;
      t.wait_status_model_calls = num(active["wait_status_model_calls"], 0) || 0;
      t.tool_calls = num(active["tool_calls"], 0) || 0;
      t.tool_output_bytes = num(active["tool_output_bytes"], 0) || 0;
      t.patches = num(active["patches"], 0) || 0;
      t.first_patch_ms = (active["first_patch_ms"] as number | null) ?? null;
      t.compactions = num(active["compactions"], 0) || 0;
      t.mcp_calls = num(active["mcp_calls"], 0) || 0;
      t.mcp_failures = num(active["mcp_failures"], 0) || 0;
      t.shell_failures = num(active["shell_failures"], 0) || 0;
      try {
        const pf = JSON.parse((active["patch_files"] as string) || "[]");
        t.patch_files = Array.isArray(pf) ? pf.map(String) : [];
      } catch {
        t.patch_files = [];
      }
      t.usage_start_json = (active["usage_start_json"] as string | null) ?? null;
      t.usage_end_json = (active["usage_end_json"] as string | null) ?? null;
      ctx.open_turn = t;
      ctx.turns_touched.set(t.turn_index, t);
    }
    return ctx;
  }

  flushTurn(t: TurnState): void {
    let diff: Record<string, number> | null = null;
    if (t.status !== "active") diff = usageDiff(t.usage_start_json, t.usage_end_json);
    const cols: Record<string, unknown> = {
      turn_id: t.turn_id,
      started_ms: t.started_ms,
      completed_ms: t.completed_ms,
      duration_ms: t.duration_ms,
      ttft_ms: t.ttft_ms,
      status: t.status,
      abort_reason: t.abort_reason,
      had_error: t.had_error,
      user_preview: t.user_preview,
      usage_bearing_samples: t.usage_bearing_samples,
      rebroadcast_events: t.rebroadcast_events,
      wait_status_model_calls: t.wait_status_model_calls,
      usage_start_json: t.usage_start_json,
      usage_end_json: t.usage_end_json,
      tool_calls: t.tool_calls,
      tool_output_bytes: t.tool_output_bytes,
      patches: t.patches,
      first_patch_ms: t.first_patch_ms,
      patch_files: JSON.stringify(t.patch_files.slice(0, 100)),
      compactions: t.compactions,
      mcp_calls: t.mcp_calls,
      mcp_failures: t.mcp_failures,
      shell_failures: t.shell_failures,
    };
    if (diff) {
      cols["input_tokens"] = diff["input_tokens"];
      cols["cached_input_tokens"] = diff["cached_input_tokens"];
      cols["cache_write_tokens"] = diff["cache_write_input_tokens"];
      cols["output_tokens"] = diff["output_tokens"];
      cols["reasoning_tokens"] = diff["reasoning_output_tokens"];
      cols["total_tokens"] = diff["total_tokens"];
    }
    const ks = Object.keys(cols);
    this.prepare("INSERT OR IGNORE INTO turns (thread_id, turn_index) VALUES (?,?)").run(t.thread_id, t.turn_index);
    this.prepare(`UPDATE turns SET ${ks.map((k) => `${k}=?`).join(",")} WHERE thread_id=? AND turn_index=?`).run(
      ...ks.map((k) => cols[k]),
      t.thread_id,
      t.turn_index,
    );
  }

  flushThread(ctx: ThreadCtx): void {
    const lt = ctx.last_total ?? {};
    this.prepare("INSERT OR IGNORE INTO threads_diag (thread_id) VALUES (?)").run(ctx.thread_id);
    // fail-closed 阈值（protocol §4）：身份字段缺失，或畸形 token_count 超过
    // max(3, 20% of token_count_events) 才判 incompatible；零星畸形事件跳过并记录。
    const malformedTc = ctx.schema_issues["token_count.info.total_token_usage"] ?? 0;
    const identityBad = ctx.schema_issues["session_meta.id"] ?? 0;
    const hard = identityBad > 0 || malformedTc > Math.max(3, Math.trunc(ctx.token_count_events * 0.2));
    const pyInt = (v: unknown): number => {
      if (v === null || v === undefined || v === false || v === "") return 0;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    };
    this.prepare(`UPDATE threads_diag SET
        usage_bearing_samples=?, rebroadcast_events=?, wait_status_model_calls=?,
        token_count_events=?, tool_calls=?, tool_output_bytes=?,
        patches=?, first_patch_ms=?, compactions=?, peak_context=?, model_context_window=?,
        web_searches=?, user_messages=?, agent_messages=?,
        mcp_calls=?, mcp_failures=?, shell_failures=?,
        final_input=?, final_cached=?, final_cache_write=?, final_output=?, final_reasoning=?,
        final_total=?, native_total=?, replay_input_tokens=?, replay_cached_tokens=?,
        replay_output_tokens=?, replay_total_tokens=?, replay_events=?,
        baseline_prefix_events=?, baseline_parent_digest=?, fork_replay_json=?,
        last_total_json=?, first_event_ms=?, last_event_ms=?, file_usage_epochs=?,
        schema_compat=?, schema_issues=?, classification_version=?
        WHERE thread_id=?`).run(
      ctx.usage_bearing_samples, ctx.rebroadcast_events, ctx.wait_status_model_calls,
      ctx.token_count_events, ctx.tool_calls, ctx.tool_output_bytes,
      ctx.patches, ctx.first_patch_ms, ctx.compactions,
      ctx.peak_context, ctx.model_context_window, ctx.web_searches, ctx.user_messages,
      ctx.agent_messages,
      ctx.mcp_calls, ctx.mcp_failures, ctx.shell_failures,
      pyInt(lt["input_tokens"]), pyInt(lt["cached_input_tokens"]),
      pyInt(lt["cache_write_input_tokens"]), pyInt(lt["output_tokens"]),
      pyInt(lt["reasoning_output_tokens"]), pyInt(lt["total_tokens"]),
      ctx.native_total, ctx.replay_input_tokens, ctx.replay_cached_tokens,
      ctx.replay_output_tokens, ctx.replay_total_tokens, ctx.replay_events,
      ctx.fork.prefix_events, ctx.fork.digest, forkStateToJson(ctx),
      Object.keys(lt).length ? JSON.stringify(lt) : null, ctx.first_event_ms, ctx.last_event_ms,
      ctx.epochs.length ? JSON.stringify(ctx.epochs) : null,
      hard ? "incompatible" : "ok",
      Object.keys(ctx.schema_issues).length ? JSON.stringify(ctx.schema_issues) : null,
      CLASSIFICATION_VERSION, ctx.thread_id,
    );
    this.prepare("UPDATE threads SET last_event_ms=? WHERE thread_id=?").run(ctx.last_event_ms, ctx.thread_id);
    // v1.1 fork 归因：基线/方法/验证状态由分类器给出（不再做最早日扣减——replay 列已组件级拆分）
    if (ctx.forked_from_id !== null && ctx.fork.pos > 0) {
      this.prepare(
        "UPDATE threads SET inherited_baseline=?, baseline_verified=?, baseline_method=?, verification_status=? WHERE thread_id=?",
      ).run(
        ctx.fork.baseline,
        ctx.fork.status === "verified" ? 1 : 0,
        ctx.fork.method,
        ctx.fork.status,
        ctx.thread_id,
      );
    }
    // 按日归集落盘（毛增长差分 + 组件级 replay；消耗口径 = raw − replay 由查询层派生）
    if (ctx.daily.size > 0) {
      const ins = this.prepare(`INSERT OR REPLACE INTO daily_usage (thread_id, day, tokens, input_tokens,
          cached_input_tokens, output_tokens, samples, wait,
          replay_input_tokens, replay_cached_tokens, replay_output_tokens, replay_total_tokens, replay_events)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [day, d] of ctx.daily) {
        ins.run(
          ctx.thread_id, day, d.tokens, d.input_tokens, d.cached_input_tokens, d.output_tokens, d.samples, d.wait,
          d.replay_input_tokens, d.replay_cached_tokens, d.replay_output_tokens, d.replay_total_tokens, d.replay_events,
        );
      }
    }
    for (const t of ctx.turns_touched.values()) {
      if (t.dirty) {
        this.flushTurn(t);
        t.dirty = false;
      }
    }
  }
}

/** Turn 用量 = 结束快照 − 开始前快照（累计计数器差分）。 */
export function usageDiff(startJson: string | null, endJson: string | null): Record<string, number> {
  let s: Record<string, unknown> = {};
  let e: Record<string, unknown> = {};
  try {
    if (startJson) s = JSON.parse(startJson);
    if (endJson) e = JSON.parse(endJson);
  } catch {
    return {
      input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
    };
  }
  const pyInt = (v: unknown): number => {
    if (v === null || v === undefined || v === false || v === "") return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };
  const out: Record<string, number> = {};
  for (const f of [
    "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens", "total_tokens",
  ]) {
    out[f] = Math.max(0, pyInt(e[f]) - pyInt(s[f]));
  }
  return out;
}

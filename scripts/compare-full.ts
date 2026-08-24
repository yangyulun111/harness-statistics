/**
 * 全库对照（G1 全量证据）：TS collector.sqlite vs Python collector.sqlite。
 * 逐线程比对 diag 计数器 / 任务图字段 / turns 聚合；输出差异明细。
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const py = process.argv[2] ?? path.resolve("data/collector.sqlite");
const ts = process.argv[3] ?? path.resolve("data/ts/collector.sqlite");

const DIAG_COLS = [
  "usage_bearing_samples", "rebroadcast_events", "wait_status_model_calls", "token_count_events",
  "tool_calls", "tool_output_bytes", "patches", "compactions", "peak_context",
  "model_context_window", "web_searches", "user_messages", "agent_messages",
  "final_input", "final_cached", "final_cache_write", "final_output", "final_reasoning",
  "final_total", "first_event_ms", "last_event_ms", "schema_compat",
  "native_total", "replay_input_tokens", "replay_cached_tokens", "replay_output_tokens",
  "replay_total_tokens", "replay_events", "baseline_prefix_events",
  "mcp_calls", "mcp_failures", "shell_failures",
] as const;
const THREAD_COLS = [
  "parent_thread_id", "parent_source", "root_thread_id", "depth", "thread_type",
  "forked_from_id", "inherited_baseline", "baseline_verified", "baseline_method",
  "verification_status", "cwd", "model", "title", "name",
  "thread_source", "tokens_used_state", "sandbox_policy", "approval_mode",
] as const;
const DAILY_COLS = [
  "tokens", "input_tokens", "cached_input_tokens", "output_tokens", "samples", "wait",
  "replay_input_tokens", "replay_cached_tokens", "replay_output_tokens",
  "replay_total_tokens", "replay_events",
] as const;

type Row = Record<string, any>;
const eq = (a: unknown, b: unknown) =>
  (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");

const db1 = new DatabaseSync(py, { readOnly: true });
const db2 = new DatabaseSync(ts, { readOnly: true });

const load = (db: DatabaseSync, sql: string): Row[] => db.prepare(sql).all() as Row[];
const byId = (rows: Row[]): Map<string, Row> => new Map(rows.map((r) => [r["thread_id"], r]));

const diagPy = byId(load(db1, `SELECT thread_id, ${DIAG_COLS.join(",")} FROM threads_diag`));
const diagTs = byId(load(db2, `SELECT thread_id, ${DIAG_COLS.join(",")} FROM threads_diag`));
const thPy = byId(load(db1, `SELECT thread_id, ${THREAD_COLS.join(",")} FROM threads`));
const thTs = byId(load(db2, `SELECT thread_id, ${THREAD_COLS.join(",")} FROM threads`));

const turnsAgg = (db: DatabaseSync): Map<string, Row> => {
  const m = new Map<string, Row>();
  for (const r of load(db, `SELECT thread_id, COUNT(*) n, SUM(input_tokens) i, SUM(cached_input_tokens) c,
      SUM(cache_write_tokens) cw, SUM(output_tokens) o, SUM(reasoning_tokens) rt, SUM(total_tokens) t,
      SUM(usage_bearing_samples) s, SUM(rebroadcast_events) rb, SUM(wait_status_model_calls) w,
      SUM(tool_calls) tc, SUM(tool_output_bytes) tob, SUM(patches) p, SUM(compactions) comp,
      SUM(turns.had_error) he, COUNT(*) - SUM(status='active') closed
      FROM turns GROUP BY thread_id`)) {
    m.set(r["thread_id"], r);
  }
  return m;
};
const turnPy = turnsAgg(db1);
const turnTs = turnsAgg(db2);

const dailyAgg = (db: DatabaseSync): Map<string, Row> => {
  const m = new Map<string, Row>();
  for (const r of load(db, `SELECT thread_id, ${DAILY_COLS.map((c) => `SUM(${c}) ${c}`).join(",")}
      FROM daily_usage GROUP BY thread_id`)) {
    m.set(r["thread_id"], r);
  }
  return m;
};
const dayPy = dailyAgg(db1);
const dayTs = dailyAgg(db2);

let issues = 0;
const ids = new Set([...diagPy.keys(), ...diagTs.keys(), ...thPy.keys(), ...thTs.keys()]);
const report: string[] = [];
for (const id of ids) {
  const a = diagPy.get(id);
  const b = diagTs.get(id);
  const ta = thPy.get(id);
  const tb = thTs.get(id);
  if (!a !== !b || !ta !== !tb) {
    report.push(`[missing] ${id.slice(0, 8)} py_diag=${!!a} ts_diag=${!!b} py_th=${!!ta} ts_th=${!!tb}`);
    issues++;
    continue;
  }
  if (!a || !b || !ta || !tb) continue; // 两侧一致地缺失（state-only 线程）→ 无差异
  for (const c of DIAG_COLS) {
    if (!eq(a[c], b[c])) {
      report.push(`[diag] ${id.slice(0, 8)} ${c}: py=${JSON.stringify(a[c])} ts=${JSON.stringify(b[c])}`);
      issues++;
    }
  }
  for (const c of THREAD_COLS) {
    if (!eq(ta[c], tb[c])) {
      report.push(`[thread] ${id.slice(0, 8)} ${c}: py=${JSON.stringify(ta[c])} ts=${JSON.stringify(tb[c])}`);
      issues++;
    }
  }
  const ua = turnPy.get(id);
  const ub = turnTs.get(id);
  if (!ua !== !ub) {
    report.push(`[turns] ${id.slice(0, 8)} presence py=${!!ua} ts=${!!ub}`);
    issues++;
  } else if (ua && ub) {
    for (const k of Object.keys(ua)) {
      if (k === "thread_id") continue;
      if ((Number(ua[k]) || 0) !== (Number(ub[k]) || 0)) {
        report.push(`[turns] ${id.slice(0, 8)} ${k}: py=${ua[k]} ts=${ub[k]}`);
        issues++;
      }
    }
  }
  const da = dayPy.get(id);
  const db2r = dayTs.get(id);
  if (!da !== !db2r) {
    report.push(`[daily] ${id.slice(0, 8)} presence py=${!!da} ts=${!!db2r}`);
    issues++;
  } else if (da && db2r) {
    for (const c of DAILY_COLS) {
      if ((Number(da[c]) || 0) !== (Number(db2r[c]) || 0)) {
        report.push(`[daily] ${id.slice(0, 8)} ${c}: py=${da[c]} ts=${db2r[c]}`);
        issues++;
      }
    }
  }
}

const sum = (m: Map<string, Row>, k: string): number =>
  [...m.values()].reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
console.log(`threads: py=${diagPy.size} ts=${diagTs.size}`);
console.log(`Σ final_total: py=${sum(diagPy, "final_total").toLocaleString("en-US")} ts=${sum(diagTs, "final_total").toLocaleString("en-US")}`);
console.log(`Σ samples: py=${sum(diagPy, "usage_bearing_samples").toLocaleString("en-US")} ts=${sum(diagTs, "usage_bearing_samples").toLocaleString("en-US")}`);
console.log(`Σ wait: py=${sum(diagPy, "wait_status_model_calls")} ts=${sum(diagTs, "wait_status_model_calls")}`);
console.log(`Σ rebroadcast: py=${sum(diagPy, "rebroadcast_events")} ts=${sum(diagTs, "rebroadcast_events")}`);
console.log(`Σ replay_total: py=${sum(diagPy, "replay_total_tokens").toLocaleString("en-US")} ts=${sum(diagTs, "replay_total_tokens").toLocaleString("en-US")}`);
console.log(`Σ native_total: py=${sum(diagPy, "native_total").toLocaleString("en-US")} ts=${sum(diagTs, "native_total").toLocaleString("en-US")}`);
// v1.2 tool_failures：事件级失败明细全表对比（键 = thread_id + seq）
{
  const cols = "thread_id, seq, ts_ms, turn_index, kind, exit_code, server, tool, command, detail";
  const failPy = load(db1, `SELECT ${cols} FROM tool_failures ORDER BY thread_id, seq`);
  const failTs = load(db2, `SELECT ${cols} FROM tool_failures ORDER BY thread_id, seq`);
  const same = JSON.stringify(failPy) === JSON.stringify(failTs);
  if (!same) issues += 1;
  console.log(`tool_failures: py=${failPy.length} ts=${failTs.length}${same ? "" : " 差异存在"}`);
}
console.log(issues === 0 ? "RESULT: PASS —— 逐线程逐字段完全一致" : `RESULT: FAIL —— ${issues} 处差异`);
for (const line of report.slice(0, 40)) console.log("  " + line);
db1.close();
db2.close();
process.exitCode = issues === 0 ? 0 : 1;

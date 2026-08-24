/**
 * Ledger Contract v1.2 —— collector.sqlite schema（与 Python oracle ledger/collector.py SCHEMA 逐字一致）。
 * TS 轨产物必须落同一 schema，Golden 测试（G1）据此逐字段对齐。
 * 修改本文件前必须同步 Python 侧并升级 schema_version。
 * v1.2：threads +sandbox_policy/approval_mode；threads_diag/turns +mcp_calls/mcp_failures/shell_failures
 * （shell_failures 为 estimated 启发式：工具输出内嵌 JSON 的 exit_code≠0，缺退出码不计，低估方向）。
 */

export const SCHEMA_VERSION = 2;

export const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

export const TOOL_CALL_TYPES = new Set([
  "custom_tool_call",
  "function_call",
  "local_shell_call",
  "web_search_call",
]);

export const TOOL_OUTPUT_TYPES = new Set([
  "custom_tool_call_output",
  "function_call_output",
  "local_shell_call_output",
]);

export const SKIP_TOP_TYPES = new Set(["world_state", "compacted"]); // 大体积/无账目价值

/** v1.1（fork-v2）：fork replay 结构化分类（父前缀位置匹配）+ 组件级 replay 账本。 */
export const CLASSIFICATION_VERSION = "fork-v2";
export const WAIT_ACTIONS = new Set([
  "wait_agent",
  "functions.wait",
  "wait",
  "status",
  "list_agents",
  "thread_status",
]);

export const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS rollout_files(
  path TEXT PRIMARY KEY, thread_id TEXT, size INTEGER, last_offset INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', first_seen_ms INTEGER, updated_ms INTEGER);
CREATE TABLE IF NOT EXISTS threads(
  thread_id TEXT PRIMARY KEY, rollout_path TEXT,
  parent_thread_id TEXT, parent_source TEXT, root_thread_id TEXT, depth INTEGER, thread_type TEXT,
  forked_from_id TEXT, inherited_baseline INTEGER, baseline_verified INTEGER DEFAULT 0,
  baseline_method TEXT, verification_status TEXT,
  agent_nickname TEXT, agent_role TEXT, agent_path TEXT,
  model TEXT, model_provider TEXT, effort TEXT, cwd TEXT, cli_version TEXT, originator TEXT,
  sandbox_policy TEXT, approval_mode TEXT,
  title TEXT, name TEXT, preview TEXT, first_user_message TEXT,
  tokens_used_state INTEGER, git_branch TEXT, git_sha TEXT, git_origin_url TEXT,
  source TEXT, thread_source TEXT, archived INTEGER DEFAULT 0,
  created_ms INTEGER, updated_ms INTEGER, last_event_ms INTEGER);
CREATE TABLE IF NOT EXISTS turns(
  thread_id TEXT, turn_index INTEGER, turn_id TEXT,
  started_ms INTEGER, completed_ms INTEGER, duration_ms INTEGER, ttft_ms INTEGER,
  status TEXT, abort_reason TEXT, had_error INTEGER DEFAULT 0, user_preview TEXT,
  usage_bearing_samples INTEGER DEFAULT 0, rebroadcast_events INTEGER DEFAULT 0,
  wait_status_model_calls INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, cached_input_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
  usage_start_json TEXT, usage_end_json TEXT,
  tool_calls INTEGER DEFAULT 0, tool_output_bytes INTEGER DEFAULT 0,
  patches INTEGER DEFAULT 0, first_patch_ms INTEGER, patch_files TEXT,
  compactions INTEGER DEFAULT 0,
  mcp_calls INTEGER DEFAULT 0, mcp_failures INTEGER DEFAULT 0, shell_failures INTEGER DEFAULT 0,
  PRIMARY KEY(thread_id, turn_index));
CREATE TABLE IF NOT EXISTS daily_usage(
  thread_id TEXT, day TEXT,
  tokens INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
  cached_input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  samples INTEGER DEFAULT 0, wait INTEGER DEFAULT 0,
  replay_input_tokens INTEGER DEFAULT 0, replay_cached_tokens INTEGER DEFAULT 0,
  replay_output_tokens INTEGER DEFAULT 0, replay_total_tokens INTEGER DEFAULT 0,
  replay_events INTEGER DEFAULT 0,
  PRIMARY KEY(thread_id, day));
CREATE TABLE IF NOT EXISTS threads_diag(
  thread_id TEXT PRIMARY KEY,
  usage_bearing_samples INTEGER DEFAULT 0, rebroadcast_events INTEGER DEFAULT 0,
  wait_status_model_calls INTEGER DEFAULT 0, token_count_events INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0, tool_output_bytes INTEGER DEFAULT 0,
  patches INTEGER DEFAULT 0, first_patch_ms INTEGER,
  compactions INTEGER DEFAULT 0, peak_context INTEGER, model_context_window INTEGER,
  web_searches INTEGER DEFAULT 0, user_messages INTEGER DEFAULT 0, agent_messages INTEGER DEFAULT 0,
  mcp_calls INTEGER DEFAULT 0, mcp_failures INTEGER DEFAULT 0, shell_failures INTEGER DEFAULT 0,
  final_input INTEGER DEFAULT 0, final_cached INTEGER DEFAULT 0, final_cache_write INTEGER DEFAULT 0,
  final_output INTEGER DEFAULT 0, final_reasoning INTEGER DEFAULT 0, final_total INTEGER DEFAULT 0,
  native_total INTEGER DEFAULT 0,
  replay_input_tokens INTEGER DEFAULT 0, replay_cached_tokens INTEGER DEFAULT 0,
  replay_output_tokens INTEGER DEFAULT 0, replay_total_tokens INTEGER DEFAULT 0,
  replay_events INTEGER DEFAULT 0,
  baseline_prefix_events INTEGER, baseline_parent_digest TEXT, fork_replay_json TEXT,
  last_total_json TEXT, first_event_ms INTEGER, last_event_ms INTEGER,
  file_usage_epochs TEXT,
  schema_compat TEXT DEFAULT 'ok', schema_issues TEXT, classification_version TEXT);
CREATE VIEW IF NOT EXISTS task_usage AS
SELECT r.thread_id AS root_thread_id,
       COALESCE(rd.native_total, COALESCE(rd.final_total, 0) - COALESCE(r.inherited_baseline, 0)) AS root_tokens,
       COALESCE(s.sub_count, 0) AS subagent_count,
       COALESCE(s.sub_tokens, 0) AS subagent_tokens,
       COALESCE(rd.native_total, COALESCE(rd.final_total, 0) - COALESCE(r.inherited_baseline, 0))
         + COALESCE(s.sub_tokens, 0) AS total_tokens
FROM threads r
LEFT JOIN threads_diag rd ON rd.thread_id = r.thread_id
LEFT JOIN (
  SELECT th.root_thread_id AS rid, COUNT(*) AS sub_count,
         SUM(COALESCE(d.native_total, COALESCE(d.final_total, 0) - COALESCE(th.inherited_baseline, 0))) AS sub_tokens
  FROM threads th LEFT JOIN threads_diag d ON d.thread_id = th.thread_id
  WHERE th.thread_type = 'subagent' AND th.root_thread_id IS NOT NULL
  GROUP BY th.root_thread_id
) s ON s.rid = r.thread_id
WHERE r.thread_type = 'root';
CREATE TABLE IF NOT EXISTS tool_failures(
  thread_id TEXT, seq INTEGER, ts_ms INTEGER, turn_index INTEGER,
  kind TEXT, exit_code INTEGER, server TEXT, tool TEXT,
  command TEXT, detail TEXT,
  PRIMARY KEY(thread_id, seq));
CREATE TABLE IF NOT EXISTS benchmark_runs(
  run_id TEXT PRIMARY KEY, task_id TEXT, repeat INTEGER, created_ms,
  thread_id TEXT, root_thread_id TEXT, workspace TEXT, base_commit TEXT,
  t0_ms INTEGER, t_end_ms INTEGER, status TEXT, grader_json TEXT, metrics_file TEXT);
`;

/**
 * v1.3 TS-only 扩展表：工具事件明细（分桶 shell/file/mcp/web/collab、配对时长、成败、
 * 文件行为 lines±/读检测 estimated）。
 * - 不属于 Ledger Contract：不在 golden dump 六表名单（golden.ts Dump）内，Python 冻结轨无此表，G1 不可见；
 * - SCHEMA 常量保持与 Python 逐字一致不动，本表由 LedgerStore 构造时单独 apply；
 * - 历史回填：`npm run update -- --refold-tools`（refoldToolEvents，全量重读 rollout 只重建本表）。
 */
export const TOOL_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_events(
  thread_id TEXT, seq INTEGER,
  ts_ms INTEGER, turn_index INTEGER,
  bucket TEXT, name TEXT, call_id TEXT,
  duration_ms INTEGER, ok INTEGER, exit_code INTEGER,
  files_touched INTEGER, lines_plus INTEGER, lines_minus INTEGER,
  reads INTEGER, read_files TEXT, detail TEXT,
  PRIMARY KEY(thread_id, seq));
`;

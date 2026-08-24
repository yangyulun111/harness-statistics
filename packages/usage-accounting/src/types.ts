/**
 * 内存态 —— Python oracle collector.py TurnState/ThreadCtx dataclass 的 TS 对应。
 * 字段与语义逐一对齐（Golden G1 守护）。
 */
import type { Json } from "@hs/shared";

export interface TurnState {
  thread_id: string;
  turn_index: number;
  turn_id: string | null;
  started_ms: number | null;
  completed_ms: number | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  status: string;
  abort_reason: string | null;
  had_error: number;
  user_preview: string | null;
  usage_bearing_samples: number;
  rebroadcast_events: number;
  wait_status_model_calls: number;
  tool_calls: number;
  tool_output_bytes: number;
  patches: number;
  first_patch_ms: number | null;
  patch_files: string[];
  compactions: number;
  // v1.2：MCP 一等计数（mcp_tool_call_end 自包含 server/tool/Ok|Err）；
  // shell_failures 为 estimated 启发式（工具输出内嵌 JSON 的 exit_code≠0，低估方向）
  mcp_calls: number;
  mcp_failures: number;
  shell_failures: number;
  usage_start_json: string | null;
  usage_end_json: string | null;
  dirty: boolean;
}

export function newTurn(threadId: string, turnIndex: number): TurnState {
  return {
    thread_id: threadId,
    turn_index: turnIndex,
    turn_id: null,
    started_ms: null,
    completed_ms: null,
    duration_ms: null,
    ttft_ms: null,
    status: "active",
    abort_reason: null,
    had_error: 0,
    user_preview: null,
    usage_bearing_samples: 0,
    rebroadcast_events: 0,
    wait_status_model_calls: 0,
    tool_calls: 0,
    tool_output_bytes: 0,
    patches: 0,
    first_patch_ms: null,
    patch_files: [],
    compactions: 0,
    mcp_calls: 0,
    mcp_failures: 0,
    shell_failures: 0,
    usage_start_json: null,
    usage_end_json: null,
    dirty: true,
  };
}

export interface DailyAgg {
  tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  samples: number;
  wait: number;
  // v1.1 组件级 replay 账本（L1）：native = raw − replay（查询层派生）
  replay_input_tokens: number;
  replay_cached_tokens: number;
  replay_output_tokens: number;
  replay_total_tokens: number;
  replay_events: number;
}

export function newDailyAgg(): DailyAgg {
  return {
    tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, samples: 0, wait: 0,
    replay_input_tokens: 0, replay_cached_tokens: 0, replay_output_tokens: 0,
    replay_total_tokens: 0, replay_events: 0,
  };
}

/** 父序列游标：buf 仅内存态（持久化时换算成逻辑 offset）。 */
export interface ParentCursorState {
  files: string[];
  file_idx: number;
  offset: number; // 已读字节（不含 buf 中未消费部分即为逻辑位置）
  pos: number; // 已产出的增长快照数
  last: number[] | null; // 最后一个增长元组（六字段）
  at_start: boolean; // 当前文件尚未见过有效快照（文件边界 epoch 规则用）
  buf?: Buffer; // 未消费的半行/整行缓冲（不持久化）
}

export interface ForkLegacyBuf {
  day: string | null;
  delta: number[];
  tuple: number[];
}

/** fork replay 分类器状态（持久化为 threads_diag.fork_replay_json）。 */
export interface ForkReplayState {
  state: "unknown" | "matching" | "native";
  method: string | null; // parent_prefix | legacy_time | none | unresolved
  status: string | null; // verified | parent_missing | pending
  pos: number; // 子线程已见增长快照数
  baseline: number; // 继承基线（最后匹配元组的 total）
  prefix_events: number;
  digest: string | null;
  legacy_mode: boolean;
  cursor: ParentCursorState | null;
  legacy: { last_ts: number | null; buf: ForkLegacyBuf | null };
}

export function newForkState(): ForkReplayState {
  return {
    state: "unknown",
    method: null,
    status: null,
    pos: 0,
    baseline: 0,
    prefix_events: 0,
    digest: null,
    legacy_mode: false,
    cursor: null,
    legacy: { last_ts: null, buf: null },
  };
}

export interface ThreadCtx {
  thread_id: string;
  // diag 累计计数（从 DB 恢复 + 本轮增量）
  usage_bearing_samples: number;
  rebroadcast_events: number;
  wait_status_model_calls: number;
  token_count_events: number;
  tool_calls: number;
  tool_output_bytes: number;
  patches: number;
  first_patch_ms: number | null;
  compactions: number;
  peak_context: number | null;
  model_context_window: number | null;
  web_searches: number;
  user_messages: number;
  agent_messages: number;
  // v1.2：MCP 调用/失败与 shell 失败（estimated）计数
  mcp_calls: number;
  mcp_failures: number;
  shell_failures: number;
  tool_failure_seq: number; // tool_failures 表的下一个序号（跨 run 从 MAX(seq)+1 续接）
  tool_event_seq: number; // tool_events（TS-only v1.3）的下一个序号（跨 run 从 MAX(seq)+1 续接）
  // 暂存近期工具调用的元数据（call_id → 命令/时间/分桶），供输出配对与 tool_events 落行；跨 run 不持久化
  pending_calls: Map<string, import("./toolEvents.ts").PendingToolCall>;
  last_total: Json | null; // 最后有效 total_token_usage 快照
  epoch_first: number | null; // 当前文件内首个增长 total（跨文件独立计数诊断）
  epochs: Array<[number, number]>; // [(file_first, file_last), ...]
  first_event_ms: number | null;
  last_event_ms: number | null;
  // v1.1 fork 分类器：native_total = Σ 跨 epoch 正增量；replay_* 为继承前缀的组件级账本
  forked_from_id: string | null;
  current_file: string | null;
  at_file_start: boolean; // 当前文件尚未消费首个有效快照（文件边界 epoch 规则）
  epoch_soft_closed: boolean; // run 末软封存的本文件 epoch（同文件续读时重开）
  native_total: number;
  replay_input_tokens: number;
  replay_cached_tokens: number;
  replay_output_tokens: number;
  replay_total_tokens: number;
  replay_events: number;
  fork: ForkReplayState;
  // wait/status 语义分类的当前完成段状态（自上一个 usage-bearing sample 起）
  segment_tools: Set<string>;
  segment_patches: number;
  // 按日归集（与 Codex 官方日用量同语义：增长事件按事件时间戳归日）
  daily: Map<string, DailyAgg>;
  // fail-closed：关键字段缺失/变型记录
  schema_issues: Record<string, number>;
  open_turn: TurnState | null;
  next_turn_index: number;
  turns_touched: Map<number, TurnState>;
  dirty: boolean;
}

export function newThreadCtx(threadId: string): ThreadCtx {
  return {
    thread_id: threadId,
    usage_bearing_samples: 0,
    rebroadcast_events: 0,
    wait_status_model_calls: 0,
    token_count_events: 0,
    tool_calls: 0,
    tool_output_bytes: 0,
    patches: 0,
    first_patch_ms: null,
    compactions: 0,
    peak_context: null,
    model_context_window: null,
    web_searches: 0,
    user_messages: 0,
    agent_messages: 0,
    mcp_calls: 0,
    mcp_failures: 0,
    shell_failures: 0,
    tool_failure_seq: 0,
    tool_event_seq: 0,
    pending_calls: new Map(),
    last_total: null,
    epoch_first: null,
    epochs: [],
    first_event_ms: null,
    last_event_ms: null,
    forked_from_id: null,
    current_file: null,
    at_file_start: false,
    epoch_soft_closed: false,
    native_total: 0,
    replay_input_tokens: 0,
    replay_cached_tokens: 0,
    replay_output_tokens: 0,
    replay_total_tokens: 0,
    replay_events: 0,
    fork: newForkState(),
    segment_tools: new Set(),
    segment_patches: 0,
    daily: new Map(),
    schema_issues: {},
    open_turn: null,
    next_turn_index: 0,
    turns_touched: new Map(),
    dirty: true,
  };
}

export function touch(ctx: ThreadCtx, tsMs: number | null): void {
  if (tsMs !== null) {
    if (ctx.first_event_ms === null || tsMs < ctx.first_event_ms) ctx.first_event_ms = tsMs;
    if (ctx.last_event_ms === null || tsMs > ctx.last_event_ms) ctx.last_event_ms = tsMs;
  }
  ctx.dirty = true;
}

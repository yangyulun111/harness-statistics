import { useEffect, useRef, useState } from "react";

export interface SubModelSplit {
  model: string;
  tokens: number;
  threads: number;
}

export interface CostEst {
  currency: string;
  input: number;
  cached: number;
  cache_write: number;
  output: number;
  total: number;
  missing_models: string[];
  sources: string[];
}

export interface TaskRow {
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

export interface Summary {
  date: string;
  totals: {
    tasks: number;
    root: number;
    sub: number;
    total: number;
    uncached: number;
    output: number;
    samples: number;
    wait: number;
    wait_tokens_est: number;
  };
  consumption: DailyPoint;
  tasks: TaskRow[];
  status: StatusInfo;
  daemon: { running: boolean; interval_sec: number; at: number; elapsedMs: number; error: string | null };
}

export interface StatusInfo {
  last_update_ms: number;
  schema_version: string;
  codex_version: string;
  model: string;
  state_db: string;
  codex_home: string;
  counts: Record<string, number>;
  totals: {
    samples: number;
    wait: number;
    rebroadcast: number;
    mcp_calls: number;
    mcp_failures: number;
    shell_failures: number;
    web_searches: number;
  };
  replay: { total_tokens: number; events: number };
  fork_coverage: Array<{ method: string; status: string; n: number; replay: number }>;
  schema_issues: number;
  schema_details?: SchemaDetailEntry[];
  rollout_files: { total: number; active: number };
  prices?: {
    loaded: boolean;
    path?: string;
    user_entries?: number;
    synced_entries?: number;
    updated_ms?: number | null;
    uncovered_models?: string[];
  };
}

export interface PriceEntryView {
  model: string;
  effective_from_ms: number;
  effective_to_ms: number | null;
  currency: string;
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
  promo?: boolean;
  source?: string;
  note?: string;
  origin?: "user" | "synced";
}

export interface PricesView {
  loaded: boolean;
  user_path?: string;
  synced_path?: string;
  entries: PriceEntryView[];
  uncovered_models?: string[];
}

export interface ProjectRow {
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

export interface TurnRow {
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
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  tool_calls: number;
  tool_output_bytes: number;
  patches: number;
  compactions: number;
  patch_files: string[];
  mcp_calls: number;
  mcp_failures: number;
  shell_failures: number;
}

export interface ForkAttribution {
  forked_from_id: string;
  method: string | null;
  status: string | null;
  baseline: number | null;
  prefix_events: number | null;
  parent_digest: string | null;
  replay: { input: number; cached: number; output: number; total: number; events: number };
  native_total: number;
}

export interface ToolFailure {
  thread_id: string;
  thread_type: string;
  ts_ms: number | null;
  turn_index: number | null;
  kind: string;
  exit_code: number | null;
  server: string | null;
  tool: string | null;
  command: string | null;
  detail: string | null;
}

export interface TaskDetail {
  name: string;
  project: string;
  /** v1.4 视图口径：day=null 总计；"YYYY-MM-DD" 当日切片 */
  scope: { day: string | null };
  header: {
    thread_id: string;
    thread_type: string | null;
    agent_nickname: string | null;
    depth: number | null;
    forked_from_id: string | null;
    inherited_baseline: number | null;
    baseline_verified: number | null;
    baseline_method: string | null;
    verification_status: string | null;
    fork: ForkAttribution | null;
    model: string | null;
    effort: string | null;
    cli_version: string | null;
    cwd: string;
    git_origin_url: string | null;
    git_branch: string | null;
    created_ms: number | null;
    updated_ms: number | null;
    tokens_used_state: number | null;
    originator: string | null;
    sandbox_policy: string | null;
    approval_mode: string | null;
    wall_ms: number | null;
    ttfm_ms: number | null;
  };
  tokens: {
    input: number;
    cached: number;
    uncached: number;
    cache_write: number;
    output: number;
    reasoning: number;
    total: number;
    raw_total: number;
  };
  diag: {
    samples: number;
    wait: number;
    /** 当日切片无此账 → null（显示 "–"） */
    rebroadcast: number | null;
    tool_calls: number;
    tool_output_bytes: number | null;
    patches: number;
    compactions: number;
    peak_context: number | null;
    model_context_window: number | null;
    schema_compat: string;
    schema_issues: Record<string, number> | null;
    web_searches: number;
    mcp_calls: number;
    mcp_failures: number;
    shell_failures: number;
  };
  status: string;
  subagents: Array<{
    header: TaskDetail["header"];
    tokens: TaskDetail["tokens"];
    diag: TaskDetail["diag"];
    /** v1.4 当日切片：该子代理当日 native Token（总计口径为 null） */
    day_tokens: number | null;
    status: string;
  }>;
  sub_model_breakdown: Array<{ model: string; tokens: number; threads: number }>;
  turns: TurnRow[];
  warnings: string[];
  orchestration: {
    subagents: number;
    concurrency_peak: number;
    wait_ms_est: number;
    /** v1.4 实测：wait/status 调用 call↔output 差之和（无配对数据 → null） */
    wait_call_ms: number | null;
    wait_call_n: number;
    wait_tokens_est: number;
    wait_tokens_split: { input: number; cached: number; output: number };
    wait_cost_est: number | null;
  };
  tool_failures: ToolFailure[];
  tool_behavior?: {
    buckets: Array<{
      bucket: string;
      calls: number;
      failures: number;
      ok_known: number;
      /** 全 NULL（无配对）→ null，UI 显示 "–" */
      duration_ms: number | null;
      duration_n: number;
      reads: number;
      files_touched: number;
      lines_plus: number;
      lines_minus: number;
    }>;
    file_behavior: {
      reads: number;
      distinct_files: number;
      repeated_reads: Array<{ file: string; n: number }>;
      files_touched: number;
      lines_plus: number;
      lines_minus: number;
    } | null;
  };
  task_totals: { root_tokens: number; subagent_tokens: number; total_tokens: number };
  cost_est: CostEst | null;
}

export interface ReconcileReport {
  threads: number;
  matched: number;
  mismatched: number;
  sum_state: number;
  sum_ledger: number;
  ratio: number;
  diffs: Array<{ thread_id: string; name: string; state: number; ledger: number; diff: number }>;
}

export interface FailureOverview {
  total: number;
  rows: Array<{
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
  }>;
}

export interface SchemaDetailEntry {
  thread_id: string;
  name: string;
  compat: string;
  issues: Record<string, number> | null;
}

export interface DailyModelSplit {
  model: string;
  tokens: number;
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
  wait_tokens_est?: number;
  cost_est?: CostEst | null;
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

export interface DayDetail extends DailyPoint {
  tasks_detail: DayTaskEntry[];
}

export function usePoll<T>(url: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!url) return;
    let stopped = false;
    const load = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (!stopped) {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (!stopped) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    timer.current = setInterval(load, ms);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [url, ms]);

  return { data, err };
}

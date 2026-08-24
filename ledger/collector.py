"""Collector：编排 发现 → state 只读 → rollout 增量 tail → 事件解析 → token 差分账目 → collector.sqlite。

Token 计算规则（docs/protocol.md）：
  - 线程累计 = 最后一个有效 total_token_usage 快照（只接受增长，防 #14489 stale 重复计费）；
  - Turn 用量 = Turn 结束快照 − Turn 开始前快照（累计计数器差分）；
  - model_call = total_token_usage 较上一有效快照增长的 token_count 事件；
  - wait/status = total 未增长的 token_count 事件；
  - peak_context = max(last_token_usage.total_tokens)，绝不与累计混同。
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import discovery as _disc
from . import state_reader as _sr
from . import rollout_tail as _rt
from . import task_graph as _tg
from . import fork as _fk
from .timeutil import to_ms, local_date

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = PROJECT_ROOT / "data" / "collector.sqlite"

TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
                "output_tokens", "reasoning_output_tokens", "total_tokens")
TOOL_CALL_TYPES = {"custom_tool_call", "function_call", "local_shell_call", "web_search_call"}
TOOL_OUTPUT_TYPES = {"custom_tool_call_output", "function_call_output", "local_shell_call_output"}
SKIP_TOP_TYPES = {"world_state", "compacted"}  # 大体积/无账目价值

SCHEMA_VERSION = 2  # v1.2：threads +sandbox/approval；diag/turns +mcp/shell 失败计数

# v1.1（fork-v2）：fork replay 结构化分类（父前缀位置匹配）+ 组件级 replay 账本。
# wait 语义分类沿用 v3：完成段 action set ⊆ WAIT_ACTIONS 且无 patch。
CLASSIFICATION_VERSION = "fork-v2"
WAIT_ACTIONS = {"wait_agent", "functions.wait", "wait", "status", "list_agents", "thread_status"}

SCHEMA = """
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
"""


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    db = Path(db_path or DEFAULT_DB)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db), timeout=30.0)
    conn.executescript(SCHEMA)
    conn.row_factory = sqlite3.Row
    return conn


def _uuid_from_name(name: str) -> Optional[str]:
    """rollout-2026-07-15T23-29-05-<uuid>.jsonl -> <uuid>（session_meta.id 缺失时的兜底）。"""
    m = re.search(r"rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$", name)
    return m.group(1) if m else None


def normcase(p: Optional[str]) -> Optional[str]:
    if not p:
        return None
    s = str(p)
    if s.startswith("\\\\?\\"):
        s = s[4:]
    return Path(s).resolve().as_posix().lower() if len(s) < 240 else s.lower()


# ---------------------------------------------------------------- 内存态

@dataclass
class TurnState:
    thread_id: str
    turn_index: int
    turn_id: Optional[str] = None
    started_ms: Optional[int] = None
    completed_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    ttft_ms: Optional[int] = None
    status: str = "active"
    abort_reason: Optional[str] = None
    had_error: int = 0
    user_preview: Optional[str] = None
    usage_bearing_samples: int = 0
    rebroadcast_events: int = 0
    wait_status_model_calls: int = 0
    tool_calls: int = 0
    tool_output_bytes: int = 0
    patches: int = 0
    first_patch_ms: Optional[int] = None
    patch_files: List[str] = field(default_factory=list)
    compactions: int = 0
    # v1.2：MCP 一等计数；shell_failures 为 estimated 启发式（低估方向）
    mcp_calls: int = 0
    mcp_failures: int = 0
    shell_failures: int = 0
    usage_start_json: Optional[str] = None
    usage_end_json: Optional[str] = None
    dirty: bool = True


@dataclass
class ThreadCtx:
    thread_id: str
    # diag 累计计数（从 DB 恢复 + 本轮增量）
    usage_bearing_samples: int = 0
    rebroadcast_events: int = 0
    wait_status_model_calls: int = 0
    token_count_events: int = 0
    tool_calls: int = 0
    tool_output_bytes: int = 0
    patches: int = 0
    first_patch_ms: Optional[int] = None
    compactions: int = 0
    peak_context: Optional[int] = None
    model_context_window: Optional[int] = None
    web_searches: int = 0
    user_messages: int = 0
    agent_messages: int = 0
    # v1.2：MCP 调用/失败与 shell 失败（estimated）计数
    mcp_calls: int = 0
    mcp_failures: int = 0
    shell_failures: int = 0
    tool_failure_seq: int = 0           # tool_failures 表的下一个序号（跨 run 从 MAX(seq)+1 续接）
    # 暂存近期工具调用的命令文本（call_id → input/arguments 截断），供失败输出配对；跨 run 不持久化
    pending_calls: Dict[str, Optional[str]] = field(default_factory=dict)
    last_total: Optional[dict] = None      # 最后有效 total_token_usage 快照
    epoch_first: Optional[int] = None       # 当前文件内首个增长 total（跨文件独立计数诊断）
    epochs: List[tuple] = field(default_factory=list)  # [(file_first, file_last), ...]
    first_event_ms: Optional[int] = None
    last_event_ms: Optional[int] = None
    # v1.1 fork 分类器：native_total = Σ 跨 epoch 正增量；replay_* 为继承前缀的组件级账本
    forked_from_id: Optional[str] = None
    current_file: Optional[str] = None
    at_file_start: bool = False            # 当前文件尚未消费首个有效快照（文件边界 epoch 规则）
    epoch_soft_closed: bool = False        # run 末软封存的本文件 epoch（同文件续读时重开）
    native_total: int = 0
    replay_input_tokens: int = 0
    replay_cached_tokens: int = 0
    replay_output_tokens: int = 0
    replay_total_tokens: int = 0
    replay_events: int = 0
    fork: dict = field(default_factory=_fk.new_fork_state)
    # wait/status 语义分类的当前完成段状态（自上一个 usage-bearing sample 起）
    segment_tools: set = field(default_factory=set)
    segment_patches: int = 0
    # 按日归集（与 Codex 官方日用量同语义：增长事件按事件时间戳归日）
    daily: Dict[str, dict] = field(default_factory=dict)
    # fail-closed：关键字段缺失/变型记录
    schema_issues: Dict[str, int] = field(default_factory=dict)
    open_turn: Optional[TurnState] = None
    next_turn_index: int = 0
    turns_touched: Dict[int, TurnState] = field(default_factory=dict)
    dirty: bool = True

    def touch(self, ts_ms: Optional[int]):
        if ts_ms is not None:
            if self.first_event_ms is None or ts_ms < self.first_event_ms:
                self.first_event_ms = ts_ms
            if self.last_event_ms is None or ts_ms > self.last_event_ms:
                self.last_event_ms = ts_ms
        self.dirty = True


def _load_thread_ctx(conn: sqlite3.Connection, thread_id: str) -> ThreadCtx:
    ctx = ThreadCtx(thread_id=thread_id)
    d = conn.execute("SELECT * FROM threads_diag WHERE thread_id=?", (thread_id,)).fetchone()
    if d:
        for k in ("usage_bearing_samples", "rebroadcast_events", "wait_status_model_calls",
                  "token_count_events", "tool_calls", "tool_output_bytes", "patches",
                  "compactions", "web_searches", "user_messages", "agent_messages",
                  "mcp_calls", "mcp_failures", "shell_failures",
                  "native_total", "replay_input_tokens", "replay_cached_tokens",
                  "replay_output_tokens", "replay_total_tokens", "replay_events"):
            setattr(ctx, k, d[k] or 0)
        ctx.first_patch_ms = d["first_patch_ms"]
        ctx.peak_context = d["peak_context"]
        ctx.model_context_window = d["model_context_window"]
        ctx.first_event_ms = d["first_event_ms"]
        ctx.last_event_ms = d["last_event_ms"]
        if d["schema_issues"]:
            try:
                ctx.schema_issues = json.loads(d["schema_issues"])
            except json.JSONDecodeError:
                pass
        if d["last_total_json"]:
            try:
                ctx.last_total = json.loads(d["last_total_json"])
            except json.JSONDecodeError:
                pass
        if d["file_usage_epochs"]:
            try:
                ctx.epochs = [tuple(x) for x in json.loads(d["file_usage_epochs"])]
            except (json.JSONDecodeError, TypeError):
                ctx.epochs = []
        if d["fork_replay_json"]:
            _fk.parse_fork_state(d["fork_replay_json"], ctx)
    for r in conn.execute(
            "SELECT day, tokens, input_tokens, cached_input_tokens, output_tokens, samples, wait, "
            "replay_input_tokens, replay_cached_tokens, replay_output_tokens, "
            "replay_total_tokens, replay_events FROM daily_usage WHERE thread_id=?", (thread_id,)):
        ctx.daily[r["day"]] = {"tokens": r["tokens"] or 0, "input_tokens": r["input_tokens"] or 0,
                               "cached_input_tokens": r["cached_input_tokens"] or 0,
                               "output_tokens": r["output_tokens"] or 0,
                               "samples": r["samples"] or 0, "wait": r["wait"] or 0,
                               "replay_input_tokens": r["replay_input_tokens"] or 0,
                               "replay_cached_tokens": r["replay_cached_tokens"] or 0,
                               "replay_output_tokens": r["replay_output_tokens"] or 0,
                               "replay_total_tokens": r["replay_total_tokens"] or 0,
                               "replay_events": r["replay_events"] or 0}
    frow = conn.execute("SELECT forked_from_id FROM threads WHERE thread_id=?",
                        (thread_id,)).fetchone()
    if frow and frow["forked_from_id"]:
        ctx.forked_from_id = frow["forked_from_id"]
    row = conn.execute(
        "SELECT MAX(turn_index) FROM turns WHERE thread_id=?", (thread_id,)).fetchone()
    ctx.next_turn_index = (row[0] + 1) if row and row[0] is not None else 0
    # v1.2：tool_failures 序号续接（与 turns 同一恢复模式）
    frow = conn.execute("SELECT MAX(seq) FROM tool_failures WHERE thread_id=?", (thread_id,)).fetchone()
    ctx.tool_failure_seq = (frow[0] + 1) if frow and frow[0] is not None else 0
    active = conn.execute(
        "SELECT * FROM turns WHERE thread_id=? AND status='active' ORDER BY turn_index DESC LIMIT 1",
        (thread_id,)).fetchone()
    if active:
        t = TurnState(thread_id=thread_id, turn_index=active["turn_index"])
        for k in ("turn_id", "started_ms", "completed_ms", "duration_ms", "ttft_ms",
                  "status", "abort_reason", "had_error", "user_preview",
                  "usage_bearing_samples", "rebroadcast_events", "wait_status_model_calls",
                  "tool_calls", "tool_output_bytes", "patches",
                  "first_patch_ms", "compactions",
                  "mcp_calls", "mcp_failures", "shell_failures"):
            setattr(t, k, active[k])
        try:
            t.patch_files = json.loads(active["patch_files"] or "[]")
        except json.JSONDecodeError:
            t.patch_files = []
        t.usage_start_json = active["usage_start_json"]
        t.usage_end_json = active["usage_end_json"]
        ctx.open_turn = t
        ctx.turns_touched[t.turn_index] = t
    return ctx


def _total_of(total: dict) -> int:
    v = total.get("total_tokens")
    if isinstance(v, int):
        return v
    return int(total.get("input_tokens") or 0) + int(total.get("output_tokens") or 0)


def _usage_diff(start_json: Optional[str], end_json: Optional[str]) -> Dict[str, int]:
    try:
        s = json.loads(start_json) if start_json else {}
        e = json.loads(end_json) if end_json else {}
    except json.JSONDecodeError:
        return {k: 0 for k in TOKEN_FIELDS}
    out = {}
    for f in TOKEN_FIELDS:
        out[f] = max(0, int(e.get(f) or 0) - int(s.get(f) or 0))
    return out


def _flush_turn(conn: sqlite3.Connection, t: TurnState):
    diff = _usage_diff(t.usage_start_json, t.usage_end_json) if t.status != "active" else None
    cols = dict(
        turn_id=t.turn_id, started_ms=t.started_ms, completed_ms=t.completed_ms,
        duration_ms=t.duration_ms, ttft_ms=t.ttft_ms, status=t.status,
        abort_reason=t.abort_reason, had_error=t.had_error, user_preview=t.user_preview,
        usage_bearing_samples=t.usage_bearing_samples, rebroadcast_events=t.rebroadcast_events,
        wait_status_model_calls=t.wait_status_model_calls,
        usage_start_json=t.usage_start_json, usage_end_json=t.usage_end_json,
        tool_calls=t.tool_calls, tool_output_bytes=t.tool_output_bytes,
        patches=t.patches, first_patch_ms=t.first_patch_ms,
        patch_files=json.dumps(t.patch_files[:100], ensure_ascii=False),
        compactions=t.compactions,
        mcp_calls=t.mcp_calls, mcp_failures=t.mcp_failures, shell_failures=t.shell_failures)
    if diff:
        cols.update(input_tokens=diff["input_tokens"], cached_input_tokens=diff["cached_input_tokens"],
                    cache_write_tokens=diff["cache_write_input_tokens"],
                    output_tokens=diff["output_tokens"], reasoning_tokens=diff["reasoning_output_tokens"],
                    total_tokens=diff["total_tokens"])
    conn.execute("INSERT OR IGNORE INTO turns (thread_id, turn_index) VALUES (?,?)",
                 (t.thread_id, t.turn_index))
    conn.execute("UPDATE turns SET " + ",".join(f"{k}=?" for k in cols) +
                 " WHERE thread_id=? AND turn_index=?",
                 (*cols.values(), t.thread_id, t.turn_index))


def _close_epoch(ctx: ThreadCtx):
    """文件边界（run 末软封存）：记录本文件计数区间 [(first, last)]，用于跨文件独立计数诊断。
    同一文件在下一 run 续读时由 mark_file_start 重开（epoch_soft_closed），跨文件则转正。"""
    if ctx.epoch_first is not None:
        last = _total_of(ctx.last_total) if ctx.last_total else ctx.epoch_first
        ctx.epochs = (ctx.epochs + [(ctx.epoch_first, last)])[-200:]
        ctx.epoch_first = None
        ctx.epoch_soft_closed = True
        ctx.dirty = True


def _flush_thread(conn: sqlite3.Connection, ctx: ThreadCtx):
    lt = ctx.last_total or {}
    conn.execute("INSERT OR IGNORE INTO threads_diag (thread_id) VALUES (?)", (ctx.thread_id,))
    # fail-closed 阈值（protocol §4）：身份字段缺失，或畸形 token_count 超过
    # max(3, 20% of token_count_events) 才判 incompatible；零星畸形事件跳过并记录（不影响对账正确的数值）。
    malformed_tc = ctx.schema_issues.get("token_count.info.total_token_usage", 0)
    identity_bad = ctx.schema_issues.get("session_meta.id", 0)
    hard = identity_bad > 0 or malformed_tc > max(3, int(ctx.token_count_events * 0.2))
    conn.execute("""UPDATE threads_diag SET
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
        WHERE thread_id=?""",
        (ctx.usage_bearing_samples, ctx.rebroadcast_events, ctx.wait_status_model_calls,
         ctx.token_count_events, ctx.tool_calls, ctx.tool_output_bytes,
         ctx.patches, ctx.first_patch_ms, ctx.compactions,
         ctx.peak_context, ctx.model_context_window, ctx.web_searches, ctx.user_messages,
         ctx.agent_messages,
         ctx.mcp_calls, ctx.mcp_failures, ctx.shell_failures,
         int(lt.get("input_tokens") or 0), int(lt.get("cached_input_tokens") or 0),
         int(lt.get("cache_write_input_tokens") or 0), int(lt.get("output_tokens") or 0),
         int(lt.get("reasoning_output_tokens") or 0), int(lt.get("total_tokens") or 0),
         ctx.native_total, ctx.replay_input_tokens, ctx.replay_cached_tokens,
         ctx.replay_output_tokens, ctx.replay_total_tokens, ctx.replay_events,
         ctx.fork["prefix_events"], ctx.fork["digest"], _fk.fork_state_to_json(ctx),
         json.dumps(lt) if lt else None, ctx.first_event_ms, ctx.last_event_ms,
         json.dumps(ctx.epochs) if ctx.epochs else None,
         "incompatible" if hard else "ok",
         json.dumps(ctx.schema_issues) if ctx.schema_issues else None,
         CLASSIFICATION_VERSION, ctx.thread_id))
    conn.execute("UPDATE threads SET last_event_ms=? WHERE thread_id=?",
                 (ctx.last_event_ms, ctx.thread_id))
    # v1.1 fork 归因：基线/方法/验证状态由分类器给出（不再做最早日扣减——replay 列已组件级拆分）
    if ctx.forked_from_id and ctx.fork["pos"] > 0:
        conn.execute("UPDATE threads SET inherited_baseline=?, baseline_verified=?, "
                     "baseline_method=?, verification_status=? WHERE thread_id=?",
                     (ctx.fork["baseline"], 1 if ctx.fork["status"] == "verified" else 0,
                      ctx.fork["method"], ctx.fork["status"], ctx.thread_id))
    # 按日归集落盘（毛增长差分 + 组件级 replay；消耗口径 = raw − replay 由查询层派生）
    if ctx.daily:
        for day, d in ctx.daily.items():
            conn.execute("INSERT OR REPLACE INTO daily_usage (thread_id, day, tokens, input_tokens, "
                         "cached_input_tokens, output_tokens, samples, wait, "
                         "replay_input_tokens, replay_cached_tokens, replay_output_tokens, "
                         "replay_total_tokens, replay_events) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (ctx.thread_id, day, d["tokens"], d["input_tokens"], d["cached_input_tokens"],
                          d["output_tokens"], d["samples"], d["wait"],
                          d["replay_input_tokens"], d["replay_cached_tokens"],
                          d["replay_output_tokens"], d["replay_total_tokens"], d["replay_events"]))
    for t in ctx.turns_touched.values():
        if t.dirty:
            _flush_turn(conn, t)
            t.dirty = False


# ---------------------------------------------------------------- 事件处理

def _tool_output_size(payload: dict) -> int:
    out = payload.get("output")
    n = 0
    if isinstance(out, str):
        n = len(out.encode("utf-8", errors="replace"))
    elif isinstance(out, list):
        for item in out:
            if isinstance(item, dict):
                n += len(str(item.get("text") or "").encode("utf-8", errors="replace"))
            elif isinstance(item, str):
                n += len(item.encode("utf-8", errors="replace"))
    return n


def _tool_output_text(payload: dict) -> str:
    """工具输出文本（与 _tool_output_size 同一遍历；TS toolOutputText 逐字对应）。"""
    out = payload.get("output")
    if isinstance(out, str):
        return out
    if isinstance(out, list):
        s = ""
        for item in out:
            if isinstance(item, dict):
                t = item.get("text")
                s += str(t) if t else ""
            elif isinstance(item, str):
                s += item
        return s
    return ""


_EXIT_CODE_RE = re.compile(r'"exit_code"\s*:\s*(-?\d+)')


def _first_nonzero_exit(text: str) -> Optional[int]:
    """首个非零 exit_code（无则 None）。与 TS firstNonZeroExit 逐字对应。"""
    if "exit_code" not in text:
        return None
    for m in _EXIT_CODE_RE.findall(text):
        if int(m) != 0:
            return int(m)
    return None


def _shell_exit_failed(payload: dict) -> bool:
    """v1.2 shell 失败启发式（estimated）：输出文本内嵌 JSON 的 exit_code≠0 即失败（任一命中）。
    与 TS shellExitFailed 同正则同语义；不可解析不计（低估方向）。"""
    return _first_nonzero_exit(_tool_output_text(payload)) is not None


_PENDING_CALL_CAP = 64


def _call_command_text(payload: dict) -> Optional[str]:
    """工具调用的命令文本（input 优先，arguments 兜底；截断 500 code point）。"""
    inp = payload.get("input")
    if isinstance(inp, str) and inp:
        return inp[:500]
    args = payload.get("arguments")
    if isinstance(args, str) and args:
        return args[:500]
    return None


def _remember_pending_call(ctx: ThreadCtx, payload: dict) -> None:
    cid = payload.get("call_id")
    if not isinstance(cid, str) or not cid:
        return
    ctx.pending_calls[cid] = _call_command_text(payload)
    if len(ctx.pending_calls) > _PENDING_CALL_CAP:
        ctx.pending_calls.pop(next(iter(ctx.pending_calls)))


def _record_tool_failure(conn: sqlite3.Connection, ctx: ThreadCtx, ts_ms,
                         kind: str, exit_code=None, server=None, tool=None,
                         command=None, detail=None) -> None:
    """失败明细落一行 tool_failures（v1.2，事件级 drill-down；随本轮事务提交）。"""
    conn.execute("INSERT OR REPLACE INTO tool_failures (thread_id, seq, ts_ms, turn_index, "
                 "kind, exit_code, server, tool, command, detail) VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (ctx.thread_id, ctx.tool_failure_seq, ts_ms,
                  ctx.open_turn.turn_index if ctx.open_turn is not None else None,
                  kind, exit_code, server, tool, command, detail))
    ctx.tool_failure_seq += 1
    ctx.dirty = True


def _daily_replay_add(ctx: ThreadCtx, day: Optional[str], delta: List[int]) -> None:
    """组件级 replay 账本累计（线程级 + 按事件日归集）。"""
    ctx.replay_input_tokens += delta[0]
    ctx.replay_cached_tokens += delta[1]
    ctx.replay_output_tokens += delta[3]
    ctx.replay_total_tokens += delta[5]
    ctx.replay_events += 1
    if day is None:
        return
    d = ctx.daily.get(day)
    if d is None:
        d = {"tokens": 0, "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0,
             "samples": 0, "wait": 0, "replay_input_tokens": 0, "replay_cached_tokens": 0,
             "replay_output_tokens": 0, "replay_total_tokens": 0, "replay_events": 0}
        ctx.daily[day] = d
    d["replay_input_tokens"] += delta[0]
    d["replay_cached_tokens"] += delta[1]
    d["replay_output_tokens"] += delta[3]
    d["replay_total_tokens"] += delta[5]
    d["replay_events"] += 1


def process_line(conn: sqlite3.Connection, ctx: ThreadCtx, line: str) -> Optional[str]:
    """处理 rollout 单行；返回本行归属 thread_id（session_meta 可能改绑）。"""
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(rec, dict):
        return None
    rtype = rec.get("type")
    payload = rec.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    ts_ms = to_ms(rec.get("timestamp"))
    ctx.touch(ts_ms)
    pt = payload.get("type")

    if rtype == "session_meta":
        # 注意：子代理文件会在第 2 行嵌入父线程的 session_meta echo。
        # 文件身份只由首行决定（ingest 绑定），此处绝不返回 rebind 信号。
        _apply_session_meta(conn, ctx, payload, ts_ms)
        return None

    if rtype == "turn_context":
        if payload.get("model"):
            _thread_setdefault(conn, ctx.thread_id, model=payload["model"])
        if payload.get("effort"):
            _thread_setdefault(conn, ctx.thread_id, effort=payload["effort"])
        if payload.get("cwd"):
            _thread_setdefault(conn, ctx.thread_id, cwd=payload["cwd"])
        # v1.2：sandbox/approval（state DB 权威写入，rollout setdefault 兜底——见 ingest 步骤 1）
        if payload.get("approval_policy"):
            _thread_setdefault(conn, ctx.thread_id, approval_mode=payload["approval_policy"])
        sp = payload.get("sandbox_policy")
        if sp is not None:
            v = json.dumps(sp, ensure_ascii=False, separators=(",", ":")) if isinstance(sp, (dict, list)) else sp
            _thread_setdefault(conn, ctx.thread_id, sandbox_policy=v)
        return None

    if rtype == "response_item":
        turn = ctx.open_turn
        if pt in TOOL_CALL_TYPES:
            ctx.tool_calls += 1
            ctx.segment_tools.add(str(payload.get("name") or ""))  # wait 语义分类用
            _remember_pending_call(ctx, payload)  # v1.2：失败输出配对命令用
            if turn:
                turn.tool_calls += 1
                turn.dirty = True
        elif pt in TOOL_OUTPUT_TYPES:
            n = _tool_output_size(payload)
            ctx.tool_output_bytes += n
            if turn:
                turn.tool_output_bytes += n
                turn.dirty = True
            # v1.2 shell 失败启发式（estimated）：exec 包装器把 exit_code 埋在输出文本的内嵌 JSON 里；
            # 无法解析（截断/格式变化）时静默不计 → 低估方向
            out_text = _tool_output_text(payload)
            exit_code = _first_nonzero_exit(out_text)
            if exit_code is not None:
                ctx.shell_failures += 1
                cid = payload.get("call_id")
                command = ctx.pending_calls.get(cid) if isinstance(cid, str) and cid else None
                _record_tool_failure(conn, ctx, ts_ms, "shell_exit",
                                     exit_code=exit_code, command=command,
                                     detail=out_text[:1000])
                if turn:
                    turn.shell_failures += 1
                    turn.dirty = True
        return None

    if rtype != "event_msg":
        return None

    if pt == "task_started":
        if not payload.get("turn_id"):
            ctx.schema_issues["task_started.turn_id"] = \
                ctx.schema_issues.get("task_started.turn_id", 0) + 1
        t = TurnState(thread_id=ctx.thread_id, turn_index=ctx.next_turn_index,
                      turn_id=payload.get("turn_id"),
                      started_ms=to_ms(payload.get("started_at")) or ts_ms)
        ctx.next_turn_index += 1
        if payload.get("model_context_window"):
            w = int(payload["model_context_window"])
            ctx.model_context_window = max(ctx.model_context_window or 0, w)
        if ctx.open_turn is not None:   # 上一个 turn 未正常关闭，先落盘为 unknown
            ctx.open_turn.status = "unknown"
            ctx.open_turn.dirty = True
        ctx.open_turn = t
        ctx.turns_touched[t.turn_index] = t

    elif pt in ("task_complete", "turn_aborted"):
        if not payload.get("turn_id"):
            ctx.schema_issues[f"{pt}.turn_id"] = \
                ctx.schema_issues.get(f"{pt}.turn_id", 0) + 1
        turn = ctx.open_turn
        if turn is None or (payload.get("turn_id") and turn.turn_id
                            and payload["turn_id"] != turn.turn_id):
            # 按 turn_id 找回（跨增量 run 的收尾）
            turn = None
            for t in ctx.turns_touched.values():
                if t.turn_id and t.turn_id == payload.get("turn_id"):
                    turn = t
                    break
        if turn is not None:
            ctx.open_turn = turn
        else:
            turn = TurnState(thread_id=ctx.thread_id, turn_index=ctx.next_turn_index,
                             turn_id=payload.get("turn_id"))
            ctx.next_turn_index += 1
            ctx.turns_touched[turn.turn_index] = turn
            ctx.open_turn = turn
        if pt == "task_complete":
            turn.status = "completed"
            turn.completed_ms = to_ms(payload.get("completed_at")) or ts_ms
            turn.duration_ms = payload.get("duration_ms")
            turn.ttft_ms = payload.get("time_to_first_token_ms")
            if payload.get("error"):
                turn.had_error = 1
        else:
            turn.status = "aborted"
            turn.abort_reason = payload.get("reason")
            turn.completed_ms = to_ms(payload.get("completed_at")) or ts_ms
            turn.duration_ms = payload.get("duration_ms")
        turn.dirty = True
        ctx.open_turn = None

    elif pt == "token_count":
        ctx.token_count_events += 1
        info = payload.get("info")
        if not isinstance(info, dict) or not isinstance(info.get("total_token_usage"), dict):
            ctx.schema_issues["token_count.info.total_token_usage"] = \
                ctx.schema_issues.get("token_count.info.total_token_usage", 0) + 1
        total = (info or {}).get("total_token_usage") or {}
        last_usage = (info or {}).get("last_token_usage") or {}
        cur_total = _total_of(total) if total else None
        prev_total = _total_of(ctx.last_total) if ctx.last_total else None
        # v2 文件边界规则：文件首个有效快照 cur < 跨文件 carried → 独立计数 epoch（prev 归零）
        epoch_reset = False
        if ctx.at_file_start and cur_total is not None:
            ctx.at_file_start = False
            if prev_total is not None and cur_total < prev_total:
                epoch_reset = True
        grown = cur_total is not None and (epoch_reset or prev_total is None or cur_total > prev_total)
        turn = ctx.open_turn
        if grown:
            # wait/status 语义分类（v3）：本次采样对应完成段的 action set ⊆ WAIT_ACTIONS 且无 patch
            is_wait = bool(ctx.segment_tools) and ctx.segment_tools <= WAIT_ACTIONS \
                and ctx.segment_patches == 0
            if ctx.epoch_first is None:
                ctx.epoch_first = cur_total      # 本文件计数起点
            prev_snapshot = {f: 0 for f in TOKEN_FIELDS} if epoch_reset else (
                ctx.last_total if ctx.last_total is not None else {f: 0 for f in TOKEN_FIELDS})
            prev_tup = _fk.norm_tuple(prev_snapshot)
            tup = _fk.norm_tuple(total)
            day = local_date(ts_ms) if ts_ms is not None else None
            # L0 raw：毛增长差分记到事件时间戳所在日（与旧口径一致；replay/native 拆分见下）
            d = None
            if day:
                d = ctx.daily.get(day)
                if d is None:
                    d = {"tokens": 0, "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0,
                         "samples": 0, "wait": 0, "replay_input_tokens": 0, "replay_cached_tokens": 0,
                         "replay_output_tokens": 0, "replay_total_tokens": 0, "replay_events": 0}
                    ctx.daily[day] = d
                d["tokens"] += max(0, int(total.get("total_tokens") or 0)
                                   - int(prev_snapshot.get("total_tokens") or 0))
                d["input_tokens"] += max(0, int(total.get("input_tokens") or 0)
                                         - int(prev_snapshot.get("input_tokens") or 0))
                d["cached_input_tokens"] += max(0, int(total.get("cached_input_tokens") or 0)
                                                - int(prev_snapshot.get("cached_input_tokens") or 0))
                d["output_tokens"] += max(0, int(total.get("output_tokens") or 0)
                                          - int(prev_snapshot.get("output_tokens") or 0))
            # L1 fork 分类（v1.1）：replay = 继承前缀重放；native = 本线程真实调用
            cls = "native"
            retro = None
            if ctx.forked_from_id and ctx.fork["state"] != "native":
                cls, retro = _fk.classify_fork_event(conn, ctx, tup, prev_tup, ts_ms, day)
            if retro is not None:
                if retro["as"] == "replay":
                    _daily_replay_add(ctx, retro["day"], retro["delta"])
                else:
                    # 悬置事件判定为 native：补样本（wait 分类已不可考，不计）
                    ctx.usage_bearing_samples += 1
                    ctx.native_total += max(0, retro["delta"][5])
                    if retro["day"]:
                        rd = ctx.daily.setdefault(retro["day"], {
                            "tokens": 0, "input_tokens": 0, "cached_input_tokens": 0,
                            "output_tokens": 0, "samples": 0, "wait": 0,
                            "replay_input_tokens": 0, "replay_cached_tokens": 0,
                            "replay_output_tokens": 0, "replay_total_tokens": 0, "replay_events": 0})
                        rd["samples"] += 1
            if cls == "replay":
                _daily_replay_add(ctx, day, [max(0, v - prev_tup[i]) for i, v in enumerate(tup)])
            elif cls == "native":
                ctx.usage_bearing_samples += 1
                if is_wait:
                    ctx.wait_status_model_calls += 1
                ctx.native_total += max(0, int(total.get("total_tokens") or 0)
                                        - int(prev_snapshot.get("total_tokens") or 0))
                if d is not None:
                    d["samples"] += 1
                    if is_wait:
                        d["wait"] += 1
                if turn is not None:
                    turn.usage_bearing_samples += 1
                    if is_wait:
                        turn.wait_status_model_calls += 1
                    if turn.usage_start_json is None:
                        turn.usage_start_json = json.dumps(prev_snapshot)
                    turn.usage_end_json = json.dumps(total)
                    turn.dirty = True
            # "buffered"：raw 已计；样本/wait/turn 悬置，待 legacy 聚簇判定后经 retro 补记
            ctx.last_total = total
            ctx.segment_tools = set()
            ctx.segment_patches = 0
        else:
            # 未增长 = 重复/限流重播（#14489）：忽略，不计任何 call；
            # 已确认继承前缀内的 plateau 属重放静默，同样不计
            if not (ctx.forked_from_id and ctx.fork["state"] == "matching"):
                ctx.rebroadcast_events += 1
                if turn is not None:
                    turn.rebroadcast_events += 1
                    turn.dirty = True
        if last_usage.get("total_tokens") is not None:
            lc = int(last_usage["total_tokens"])
            ctx.peak_context = max(ctx.peak_context or 0, lc)
        if info and info.get("model_context_window"):
            w = int(info["model_context_window"])
            ctx.model_context_window = max(ctx.model_context_window or 0, w)

    elif pt == "user_message":
        ctx.user_messages += 1
        if ctx.open_turn is not None and not ctx.open_turn.user_preview:
            ctx.open_turn.user_preview = (payload.get("message") or "")[:80]
            ctx.open_turn.dirty = True

    elif pt == "context_compacted":
        ctx.compactions += 1
        if ctx.open_turn is not None:
            ctx.open_turn.compactions += 1
            ctx.open_turn.dirty = True

    elif pt == "patch_apply_end":
        if payload.get("success"):
            ctx.patches += 1
            ctx.segment_patches += 1  # wait 语义分类用：有 patch 即非 wait 段
            ctx.first_patch_ms = min(filter(None, [ctx.first_patch_ms, ts_ms]), default=ts_ms)
            changes = payload.get("changes") or {}
            files = [str(k) for k in changes.keys()] if isinstance(changes, dict) else []
            if ctx.open_turn is not None:
                t = ctx.open_turn
                t.patches += 1
                t.first_patch_ms = min(filter(None, [t.first_patch_ms, ts_ms]), default=ts_ms)
                for f in files:
                    if f not in t.patch_files:
                        t.patch_files.append(f)
                t.dirty = True
        elif payload.get("success") is False:
            # v1.2 kind 扩展：patch 失败此前完全盲区（patches 仅计成功，失败连计数都没有）。
            # command=目标文件列表（changes 键，空则回退 call_id 配对输入），detail=stderr；success 缺失时不计（fail-closed，低估方向）
            changes = payload.get("changes")
            files = [str(k) for k in changes.keys()] if isinstance(changes, dict) else []
            cid = payload.get("call_id")
            fallback = ctx.pending_calls.get(cid) if isinstance(cid, str) and cid else None
            stderr = payload.get("stderr")
            _record_tool_failure(conn, ctx, ts_ms, "patch_fail",
                                 command=" ".join(files)[:500] if files else fallback,
                                 detail=stderr[:1000] if isinstance(stderr, str) and stderr else None)

    elif pt == "web_search_end":
        ctx.web_searches += 1

    elif pt == "mcp_tool_call_end":
        # v1.2：MCP 一等计数（事件自包含 invocation.server/tool + result.{Ok|Err}）
        ctx.mcp_calls += 1
        result = payload.get("result")
        failed = isinstance(result, dict) and "Err" in result
        if failed:
            ctx.mcp_failures += 1
            inv = payload.get("invocation") if isinstance(payload.get("invocation"), dict) else {}
            err = result.get("Err")
            if isinstance(err, (dict, list)):
                err_text = json.dumps(err, ensure_ascii=False, separators=(",", ":"))
            elif err is None:
                err_text = None
            else:
                err_text = str(err)
            server = inv.get("server") if isinstance(inv.get("server"), str) else None
            tool = inv.get("tool") if isinstance(inv.get("tool"), str) else None
            _record_tool_failure(conn, ctx, ts_ms, "mcp_err", server=server, tool=tool,
                                 detail=err_text[:1000] if err_text is not None else None)
        if ctx.open_turn is not None:
            ctx.open_turn.mcp_calls += 1
            if failed:
                ctx.open_turn.mcp_failures += 1
            ctx.open_turn.dirty = True

    elif pt == "agent_message":
        ctx.agent_messages += 1

    return None


def _apply_session_meta(conn: sqlite3.Connection, ctx: ThreadCtx, payload: dict, ts_ms):
    tid = payload.get("id") or payload.get("session_id")
    if not tid:
        # fail-closed：session_meta.id 属关键字段
        ctx.schema_issues["session_meta.id"] = ctx.schema_issues.get("session_meta.id", 0) + 1
        return
    if tid != ctx.thread_id:
        return
    _thread_setdefault(conn, ctx.thread_id,
                       cwd=payload.get("cwd"), cli_version=payload.get("cli_version"),
                       originator=payload.get("originator"),
                       thread_source=payload.get("thread_source"),
                       agent_nickname=payload.get("agent_nickname"),
                       agent_path=payload.get("agent_path"),
                       forked_from_id=payload.get("forked_from_id"))
    if payload.get("forked_from_id"):
        ctx.forked_from_id = payload["forked_from_id"]  # 分类器用缓存，避免逐事件查库
    src = payload.get("source")
    if isinstance(src, str):
        _thread_setdefault(conn, ctx.thread_id, source=src)
    elif isinstance(src, dict):
        _thread_setdefault(conn, ctx.thread_id, source=json.dumps(src, ensure_ascii=False))
        spawn = (src.get("subagent") or {}).get("thread_spawn") or {}
        if spawn.get("parent_thread_id"):
            # source JSON 仅作 fallback（优先级 ③）
            _set_parent_fallback(conn, ctx.thread_id, spawn["parent_thread_id"], "source_json")
    if payload.get("parent_thread_id"):
        # v3 修正：线程自声明的 parent 具有最高归属证据优先级（①），无条件写入
        _set_parent(conn, ctx.thread_id, payload["parent_thread_id"], "session_meta")


def _thread_setdefault(conn: sqlite3.Connection, thread_id: str, **cols):
    """只在线程行对应字段为空时填充（state DB 是权威，rollout 只补缺）。"""
    if not cols:
        return
    row = conn.execute("SELECT " + ",".join(cols.keys()) + " FROM threads WHERE thread_id=?",
                       (thread_id,)).fetchone()
    if row is None:
        conn.execute("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)", (thread_id,))
        row = conn.execute("SELECT " + ",".join(cols.keys()) + " FROM threads WHERE thread_id=?",
                           (thread_id,)).fetchone()
    updates = {k: v for k, v in cols.items() if v is not None and not row[k]}
    if updates:
        conn.execute("UPDATE threads SET " + ",".join(f"{k}=?" for k in updates) +
                     " WHERE thread_id=?", (*updates.values(), thread_id))


def _set_parent(conn: sqlite3.Connection, tid: str, parent: str, source: str):
    """session_meta 自声明 parent：最高归属证据优先级，无条件覆盖。"""
    conn.execute("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)", (tid,))
    conn.execute("UPDATE threads SET parent_thread_id=?, parent_source=? WHERE thread_id=?",
                 (parent, source, tid))


def _set_parent_fallback(conn: sqlite3.Connection, tid: str, parent: str, source: str):
    """edges / source JSON：仅在线程尚无 parent 时填充（Guardian 场景由 session_meta 兜底）。"""
    row = conn.execute("SELECT parent_thread_id FROM threads WHERE thread_id=?",
                       (tid,)).fetchone()
    if row is None:
        conn.execute("INSERT OR IGNORE INTO threads (thread_id, parent_thread_id, parent_source) VALUES (?,?,?)",
                     (tid, parent, source))
    elif not row["parent_thread_id"]:
        conn.execute("UPDATE threads SET parent_thread_id=?, parent_source=? WHERE thread_id=?",
                     (parent, source, tid))


# ---------------------------------------------------------------- 主流程

def _file_date(path: Path) -> Optional[str]:
    parts = path.relative_to(path.parents[3]).parts if len(path.parts) > 3 else ()
    if len(parts) >= 4 and parts[0].isdigit() and len(parts[0]) == 4:
        return "-".join(parts[:3])
    return None


def _refold_thread(conn: sqlite3.Connection, thread_id: str) -> None:
    """fork 延迟复核（v1.1）：父文件后来才出现的 fork 线程，清空派生态后用同一分类器
    从全部 rollout 文件重折叠（不触碰 rollout_files.last_offset——折叠态与增量态等价）。"""
    files = [r["path"] for r in conn.execute(
        "SELECT path FROM rollout_files WHERE thread_id=? AND status!='unreadable' ORDER BY path",
        (thread_id,)) if r["path"]]
    if not files:
        return
    conn.execute("DELETE FROM threads_diag WHERE thread_id=?", (thread_id,))
    conn.execute("DELETE FROM daily_usage WHERE thread_id=?", (thread_id,))
    conn.execute("DELETE FROM turns WHERE thread_id=?", (thread_id,))
    conn.execute("DELETE FROM tool_failures WHERE thread_id=?", (thread_id,))
    conn.execute("UPDATE threads SET inherited_baseline=NULL, baseline_verified=0, "
                 "baseline_method=NULL, verification_status=NULL WHERE thread_id=?", (thread_id,))
    ctx = _load_thread_ctx(conn, thread_id)  # diag 已清 → 全新折叠；forked_from_id 取自 threads 行
    for f in files:
        offset = 0
        for _round in range(2000):
            lines, new_offset, _truncated = _rt.read_new_lines(Path(f), offset)
            if not lines:
                break
            for line in lines:
                if not line.strip():
                    continue
                _fk.mark_file_start(ctx, f, offset)
                process_line(conn, ctx, line)
            offset = new_offset
        _close_epoch(ctx)
    _flush_thread(conn, ctx)


def ingest(db_path: Optional[Path] = None, recent_days: Optional[int] = None,
           verbose: bool = True, env_codex_home: Optional[str] = None) -> dict:
    t_start = time.time()
    conn = connect(db_path)
    paths = _disc.discover(env_codex_home)
    if verbose:
        print(f"[discovery] CODEX_HOME={paths.codex_home} sqlite_home={paths.sqlite_home}")
        print(f"[discovery] state_db={paths.state_db} sessions={paths.sessions_root} "
              f"codex={paths.codex_version}")

    # 1) state DB → threads 快照（权威）
    state_threads: Dict[str, _sr.ThreadRow] = {}
    edges: Dict[str, str] = {}
    if paths.state_db and paths.state_db.exists():
        try:
            state_threads = {t.id: t for t in _sr.read_threads(paths.state_db)}
            for parent, child, _status in _sr.read_spawn_edges(paths.state_db):
                edges[child] = parent
        except sqlite3.Error as e:
            print(f"[warn] state DB 读取失败（跳过任务目录）：{e}", file=sys.stderr)
    if verbose:
        print(f"[state] threads={len(state_threads)} spawn_edges={len(edges)}")

    for t in state_threads.values():
        conn.execute("INSERT OR IGNORE INTO threads (thread_id) VALUES (?)", (t.id,))
        conn.execute("""UPDATE threads SET rollout_path=?, source=?, thread_source=?, model=?,
            model_provider=?, effort=?, cwd=?, cli_version=?, sandbox_policy=?, approval_mode=?,
            title=?, name=?, preview=?,
            first_user_message=?, tokens_used_state=?, git_branch=?, git_sha=?, git_origin_url=?,
            agent_nickname=?, agent_role=?, agent_path=?, archived=?, created_ms=?, updated_ms=?
            WHERE thread_id=?""",
            (t.rollout_path, t.source, t.thread_source, t.model, t.model_provider,
             t.reasoning_effort, t.cwd, t.cli_version, t.sandbox_policy, t.approval_mode,
             t.title, t.name, t.preview,
             t.first_user_message, t.tokens_used, t.git_branch, t.git_sha, t.git_origin_url,
             t.agent_nickname, t.agent_role, t.agent_path, t.archived,
             t.created_ms, t.updated_ms, t.id))

    # 2) rollout 文件清单：state 引用 + sessions 全量
    #   （parent 映射的构建挪到文件处理之后：运行中写入的 session_meta parent 才能参与归因）
    files = paths.session_files()
    norm = {normcase(t.rollout_path): t.id for t in state_threads.values() if t.rollout_path}
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - recent_days * 86400_000 if recent_days else None
    todo: List[Tuple[Path, Optional[str]]] = []
    for f in files:
        key = normcase(str(f))
        bound = norm.get(key)
        row = conn.execute("SELECT * FROM rollout_files WHERE path=?", (key,)).fetchone()
        if row is None:
            conn.execute("INSERT INTO rollout_files (path, thread_id, first_seen_ms) VALUES (?,?,?)",
                         (key, bound, now_ms))
            row = conn.execute("SELECT * FROM rollout_files WHERE path=?", (key,)).fetchone()
        if bound and row["thread_id"] != bound:
            conn.execute("UPDATE rollout_files SET thread_id=? WHERE path=?", (bound, key))
        if recent_days is not None:
            fdate = _file_date(f)
            f_ms = to_ms(fdate + "T00:00:00Z") if fdate else None
            if f_ms is not None and f_ms < cutoff_ms and row["last_offset"] == 0:
                conn.execute("UPDATE rollout_files SET status='skipped' WHERE path=?", (key,))
                continue
        conn.execute("UPDATE rollout_files SET status='active' WHERE path=?", (key,))
        todo.append((f, bound or row["thread_id"]))
    if verbose:
        print(f"[rollout] 文件总数={len(files)} 本轮处理={len(todo)}")

    # 4) 逐文件增量处理（巨文件分批循环直到无进展）
    n_events = 0
    ctxs: Dict[str, ThreadCtx] = {}
    for idx, (f, thread_id) in enumerate(todo, 1):
        key = normcase(str(f))
        rf = conn.execute("SELECT * FROM rollout_files WHERE path=?", (key,)).fetchone()
        offset = rf["last_offset"] or 0
        total_lines = 0
        tid = thread_id
        file_ctx = None
        for _round in range(1000):  # 1000 × 64MB/2万行，足够覆盖最大文件
            lines, new_offset, truncated = _rt.read_new_lines(f, offset)
            if truncated:
                print(f"[warn] 文件被截断/轮转，从头重读：{f.name}", file=sys.stderr)
            if not lines:
                break
            ctx = None
            for line in lines:
                if not line.strip():
                    continue
                if tid is None:
                    # 未绑定线程：第一行必须是 session_meta。
                    # 绑定只用 payload.id；缺失时回退文件名 uuid。
                    # 绝不回退 session_id——子代理文件的 session_id 存的是父线程 id。
                    try:
                        head = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if head.get("type") != "session_meta":
                        continue
                    pl = head.get("payload") or {}
                    tid = pl.get("id") or _uuid_from_name(f.name)
                    if not tid:
                        conn.execute("UPDATE rollout_files SET status='unreadable' WHERE path=?", (key,))
                        break
                    conn.execute("UPDATE rollout_files SET thread_id=? WHERE path=?", (tid, key))
                    conn.execute("INSERT OR IGNORE INTO threads (thread_id, rollout_path) VALUES (?,?)",
                                 (tid, str(f)))
                    conn.execute("UPDATE threads SET rollout_path=COALESCE(rollout_path, ?) WHERE thread_id=?",
                                 (str(f), tid))
                if tid not in ctxs:
                    ctxs[tid] = _load_thread_ctx(conn, tid)
                ctx = ctxs[tid]
                _fk.mark_file_start(ctx, str(f), offset)  # v2 文件边界 epoch 规则（重复调用内部短路）
                process_line(conn, ctx, line)
                n_events += 1
            file_ctx = ctx
            total_lines += len(lines)
            offset = new_offset
            conn.execute("UPDATE rollout_files SET size=?, last_offset=?, updated_ms=? WHERE path=?",
                         (f.stat().st_size, offset, now_ms, key))
            if ctx is not None:
                _flush_thread(conn, ctx)  # v1.1：分类器/账目状态与 offset 同事务提交
            conn.commit()  # 分批落盘，中断可续
        if file_ctx is not None:
            # 文件边界：封存本文件计数区间（与最终 offset 更新同事务）
            _close_epoch(file_ctx)  # 跨文件独立计数诊断
            _flush_thread(conn, file_ctx)
            conn.commit()
        size = f.stat().st_size
        conn.execute("UPDATE rollout_files SET size=?, last_offset=?, updated_ms=? WHERE path=?",
                     (size, offset, now_ms, key))
        if verbose and (idx % 25 == 0 or idx == len(todo)):
            print(f"[rollout] {idx}/{len(todo)}  {f.name}  +{total_lines} 行 -> offset {offset}")

    for ctx in ctxs.values():
        if ctx.dirty:
            _flush_thread(conn, ctx)
    conn.commit()

    # 5) 建立 parent 映射并解析任务图（在文件处理之后，session_meta 已入库）
    #    v3 优先级：① session_meta 自声明 > ② thread_spawn_edges > ③ source JSON
    parent_map: Dict[str, Tuple[Optional[str], str]] = {}
    for row in conn.execute("SELECT thread_id, parent_thread_id, parent_source FROM threads"):
        if row["parent_thread_id"] and (row["parent_source"] or "") == "session_meta":
            parent_map[row["thread_id"]] = (row["parent_thread_id"], "session_meta")
    for child, parent in edges.items():
        if child not in parent_map:
            parent_map[child] = (parent, "edges")
    for t in state_threads.values():
        p = t.parent_from_source()
        if p and t.id not in parent_map:
            parent_map[t.id] = (p, "source_json")
    for row in conn.execute("SELECT thread_id, parent_thread_id, parent_source FROM threads"):
        if row["thread_id"] not in parent_map and row["parent_thread_id"]:
            parent_map[row["thread_id"]] = (row["parent_thread_id"], row["parent_source"] or "unknown")

    all_ids = {r[0] for r in conn.execute("SELECT thread_id FROM threads")}
    for tid in all_ids:
        parent_map.setdefault(tid, (None, "none"))
    resolved = _tg.resolve_roots({k: v for k, v in parent_map.items() if v[0] is not None})
    for tid in all_ids:
        p, src = parent_map.get(tid, (None, "none"))
        if p is None:
            conn.execute("""UPDATE threads SET parent_thread_id=NULL, parent_source=?, root_thread_id=NULL,
                depth=0, thread_type='root' WHERE thread_id=?""", (src, tid))
        else:
            root, depth, ttype = resolved.get(tid, (tid, -1, "root"))
            conn.execute("""UPDATE threads SET parent_thread_id=?, parent_source=?, root_thread_id=?,
                depth=?, thread_type=? WHERE thread_id=?""", (p, src, root, depth, ttype, tid))
    conn.commit()

    # 5.5) fork 延迟复核（v1.1）：首轮 parent_missing 的 fork，若父文件本轮已入库，
    #      用同一分类器对该线程整体重折叠（结构化匹配取代 legacy 降级）
    for row in conn.execute("SELECT thread_id, forked_from_id FROM threads "
                            "WHERE forked_from_id IS NOT NULL AND verification_status='parent_missing'"):
        tid, pid = row["thread_id"], row["forked_from_id"]
        if tid != pid and _fk.lookup_parent_files(conn, pid):
            _refold_thread(conn, tid)
            ctxs.pop(tid, None)  # 折叠已落盘；旧 ctx 不再使用
    conn.commit()

    # 6) meta
    for k, v in {"last_update_ms": str(now_ms),
                 "schema_version": str(SCHEMA_VERSION),
                 "codex_version": paths.codex_version or "",
                 "codex_home": str(paths.codex_home),
                 "state_db": str(paths.state_db or ""),
                 "model": paths.model or ""}.items():
        conn.execute("INSERT INTO meta (key, value) VALUES (?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    conn.commit()
    conn.close()
    stats = {"files": len(todo), "events": n_events, "threads": len(all_ids),
             "roots": sum(1 for tid in all_ids if parent_map.get(tid, (None,))[0] is None),
             "elapsed_s": round(time.time() - t_start, 1)}
    if verbose:
        print(f"[done] {stats}")
    return stats

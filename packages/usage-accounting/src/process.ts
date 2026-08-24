/**
 * 事件处理 —— Python oracle collector.py process_line 的 TS 移植（逐分支对应）。
 *
 * Token 计算规则（docs/protocol.md）：
 *   - 线程累计 = 最后一个有效 total_token_usage 快照（只接受增长，防 #14489 stale 重复计费）；
 *   - Turn 用量 = Turn 结束快照 − Turn 开始前快照（累计计数器差分）；
 *   - usage_bearing_sample = total_token_usage 较上一有效快照增长的 token_count 事件；
 *   - 未增长 = rebroadcast/duplicate，忽略、不计任何 call；
 *   - wait_status_model_call = 语义分类（完成段 action ⊆ WAIT_ACTIONS 且无 patch）；
 *   - peak_context = max(last_token_usage.total_tokens)，绝不与累计混同。
 */
import {
  isPlainObject, isTokenCountMalformed, sessionMetaIdentity, toMs, localDate,
  TOKEN_FIELDS, TOOL_CALL_TYPES, TOOL_OUTPUT_TYPES, WAIT_ACTIONS,
} from "@hs/shared";
import type { Json } from "@hs/shared";
import type { LedgerStore } from "./store.ts";
import { classifyForkEvent, normTuple } from "./fork.ts";
import type { RetroAccount, SnapTuple } from "./fork.ts";
import type { DailyAgg, ThreadCtx, TurnState } from "./types.ts";
import { newDailyAgg, newTurn, touch } from "./types.ts";
import { toolBucketOf, shellExitCodeOf, extractShellCommands, readStatsOf, patchLinesOf, mcpDurationMs, type PendingToolCall, type ToolBucket } from "./toolEvents.ts";

/** Python int(x or 0)：None/""/false→0，数字截断，数字字符串转换。 */
export const pyInt = (x: unknown): number => {
  if (x === null || x === undefined || x === false || x === "") return 0;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** Python _total_of：total_tokens 为整数则用之，否则 input+output。 */
export function totalOf(total: Json): number {
  const v = total["total_tokens"];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return pyInt(total["input_tokens"]) + pyInt(total["output_tokens"]);
}

/** Python [:80] 按 code point 切片。 */
function cpSlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

function bumpIssues(ctx: ThreadCtx, key: string): void {
  ctx.schema_issues[key] = (ctx.schema_issues[key] ?? 0) + 1;
}

/** 组件级 replay 账本累计（线程级 + 按事件日归集）。 */
function dailyReplayAdd(ctx: ThreadCtx, day: string | null, delta: SnapTuple): void {
  ctx.replay_input_tokens += delta[0] ?? 0;
  ctx.replay_cached_tokens += delta[1] ?? 0;
  ctx.replay_output_tokens += delta[3] ?? 0;
  ctx.replay_total_tokens += delta[5] ?? 0;
  ctx.replay_events += 1;
  if (day === null) return;
  let d = ctx.daily.get(day);
  if (!d) {
    d = newDailyAgg();
    ctx.daily.set(day, d);
  }
  d.replay_input_tokens += delta[0] ?? 0;
  d.replay_cached_tokens += delta[1] ?? 0;
  d.replay_output_tokens += delta[3] ?? 0;
  d.replay_total_tokens += delta[5] ?? 0;
  d.replay_events += 1;
}

/** Python _tool_output_size。 */
export function toolOutputSize(payload: Json): number {
  const out = payload["output"];
  let n = 0;
  if (typeof out === "string") {
    n = Buffer.byteLength(out, "utf8");
  } else if (Array.isArray(out)) {
    for (const item of out) {
      if (isPlainObject(item)) {
        const t = item["text"];
        n += Buffer.byteLength(t ? String(t) : "", "utf8");
      } else if (typeof item === "string") {
        n += Buffer.byteLength(item, "utf8");
      }
    }
  }
  return n;
}

/** 工具输出文本（与 _tool_output_size 同一遍历；Python _tool_output_text 逐字对应）。 */
export function toolOutputText(payload: Json): string {
  const out = payload["output"];
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    let s = "";
    for (const item of out) {
      if (isPlainObject(item)) {
        const t = item["text"];
        s += t ? String(t) : "";
      } else if (typeof item === "string") {
        s += item;
      }
    }
    return s;
  }
  return "";
}

const EXIT_CODE_RE = /"exit_code"\s*:\s*(-?\d+)/g;

/** v1.2 shell 失败启发式（estimated）：输出文本内嵌 JSON 的 exit_code≠0 即失败（任一命中）。
 * 与 Python _shell_exit_failed 同正则同语义；不可解析不计（低估方向）。 */
export function shellExitFailed(payload: Json): boolean {
  return firstNonZeroExit(toolOutputText(payload)) !== null;
}

/** 首个非零 exit_code（无则 null）。与 Python _first_nonzero_exit 逐字对应。 */
export function firstNonZeroExit(text: string): number | null {
  if (!text.includes("exit_code")) return null;
  EXIT_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXIT_CODE_RE.exec(text)) !== null) {
    if (Number(m[1]) !== 0) return Number(m[1]);
  }
  return null;
}

/** Python [:n] 按 code point 截断。 */
function cpTrunc(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join("") : s;
}

const PENDING_CALL_CAP = 64;

/** 工具调用的命令文本（input 优先，arguments 兜底；截断 500 code point）。 */
function callCommandText(payload: Json): string | null {
  const inp = payload["input"];
  if (typeof inp === "string" && inp) return cpTrunc(inp, 500);
  const args = payload["arguments"];
  if (typeof args === "string" && args) return cpTrunc(args, 500);
  return null;
}

function rememberPendingCall(ctx: ThreadCtx, payload: Json, tsMs: number | null): void {
  const cid = payload["call_id"];
  if (typeof cid !== "string" || !cid) return;
  const name = String(payload["name"] ?? "");
  const namespace = typeof payload["namespace"] === "string" ? payload["namespace"] : null;
  const pt = String(payload["type"] ?? "");
  ctx.pending_calls.set(cid, {
    command: callCommandText(payload),
    ts_ms: tsMs,
    name,
    bucket: toolBucketOf(pt, name, namespace),
    consumed: false,
  });
  if (ctx.pending_calls.size > PENDING_CALL_CAP) {
    const first = ctx.pending_calls.keys().next().value;
    if (first !== undefined) ctx.pending_calls.delete(first);
  }
}

/** 失败明细落一行 tool_failures（v1.2，事件级 drill-down；随本轮事务提交）。 */
function recordToolFailure(
  store: LedgerStore, ctx: ThreadCtx, tsMs: number | null,
  kind: "shell_exit" | "mcp_err" | "patch_fail",
  opts: { exitCode?: number | null; server?: string | null; tool?: string | null; command?: string | null; detail?: string | null },
): void {
  store.prepare(
    "INSERT OR REPLACE INTO tool_failures (thread_id, seq, ts_ms, turn_index, kind, exit_code, server, tool, command, detail) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ctx.thread_id, ctx.tool_failure_seq, tsMs,
    ctx.open_turn !== null ? ctx.open_turn.turn_index : null,
    kind,
    opts.exitCode ?? null, opts.server ?? null, opts.tool ?? null,
    opts.command ?? null, opts.detail ?? null,
  );
  ctx.tool_failure_seq += 1;
  ctx.dirty = true;
}

/** 工具事件明细落一行 tool_events（TS-only v1.3；随本轮事务提交，seq 续接同 tool_failures 模式）。 */
function recordToolEvent(
  store: LedgerStore, ctx: ThreadCtx, tsMs: number | null,
  ev: {
    bucket: ToolBucket; name?: string | null; call_id?: string | null;
    duration_ms?: number | null; ok?: 0 | 1 | null; exit_code?: number | null;
    files_touched?: number | null; lines_plus?: number | null; lines_minus?: number | null;
    reads?: number | null; read_files?: string[] | null; detail?: string | null;
  },
): void {
  store.prepare(
    "INSERT OR REPLACE INTO tool_events (thread_id, seq, ts_ms, turn_index, bucket, name, call_id, duration_ms, ok, exit_code, files_touched, lines_plus, lines_minus, reads, read_files, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ctx.thread_id, ctx.tool_event_seq, tsMs,
    ctx.open_turn !== null ? ctx.open_turn.turn_index : null,
    ev.bucket, ev.name ?? null, ev.call_id ?? null,
    ev.duration_ms ?? null, ev.ok ?? null, ev.exit_code ?? null,
    ev.files_touched ?? null, ev.lines_plus ?? null, ev.lines_minus ?? null,
    ev.reads ?? null, ev.read_files && ev.read_files.length ? JSON.stringify(ev.read_files) : null,
    ev.detail ? cpTrunc(ev.detail, 500) : null,
  );
  ctx.tool_event_seq += 1;
  ctx.dirty = true;
}

/** 输出侧配对落行（shell/collab/other 桶）：duration = call↔output 时间戳差；shell 双口径退出码 + 读检测。 */
function recordPairedOutput(store: LedgerStore, ctx: ThreadCtx, tsMs: number | null, payload: Json, outText: string): void {
  const cid = payload["call_id"];
  if (typeof cid !== "string" || !cid) return;
  const pending = ctx.pending_calls.get(cid);
  if (!pending || pending.consumed) return;
  pending.consumed = true;
  const duration = pending.ts_ms != null && tsMs != null ? Math.max(0, tsMs - pending.ts_ms) : null;
  if (pending.bucket === "shell") {
    const exitCode = shellExitCodeOf(outText);
    const rs = readStatsOf(extractShellCommands(pending.command ?? ""));
    recordToolEvent(store, ctx, tsMs, {
      bucket: "shell", name: pending.name, call_id: cid, duration_ms: duration,
      ok: exitCode === null ? null : exitCode === 0 ? 1 : 0,
      exit_code: exitCode, reads: rs.reads, read_files: rs.files, detail: pending.command,
    });
  } else {
    recordToolEvent(store, ctx, tsMs, {
      bucket: pending.bucket, name: pending.name, call_id: cid, duration_ms: duration,
      detail: pending.command,
    });
  }
}

/** 文件边界（run 末软封存）：记录本文件计数区间 [(first, last)]，用于跨文件独立计数诊断。
 * 同一文件在下一 run 续读时由 markFileStart 重开（epoch_soft_closed）。
 * v1.3：传入 store 时，把本 run 内未等到输出的孤儿 call 落行为 tool_events（ok/duration=NULL，不猜）
 * 并清空暂存——若输出在后续 run 才到，因暂存已清不会重复计行（与 tool_failures 孤儿口径同类限制）。 */
export function closeEpoch(ctx: ThreadCtx, store?: LedgerStore): void {
  if (store) {
    for (const [cid, p] of ctx.pending_calls) {
      if (p.consumed) continue;
      const rs = p.bucket === "shell" ? readStatsOf(extractShellCommands(p.command ?? "")) : null;
      recordToolEvent(store, ctx, p.ts_ms, {
        bucket: p.bucket, name: p.name, call_id: cid, ok: null,
        reads: rs ? rs.reads : null, read_files: rs ? rs.files : null, detail: p.command,
      });
    }
    ctx.pending_calls.clear();
  }
  if (ctx.epoch_first !== null) {
    const last = ctx.last_total && Object.keys(ctx.last_total).length ? totalOf(ctx.last_total) : ctx.epoch_first;
    const pair: [number, number] = [ctx.epoch_first, last];
    ctx.epochs = [...ctx.epochs, pair].slice(-200);
    ctx.epoch_first = null;
    ctx.epoch_soft_closed = true;
    ctx.dirty = true;
  }
}

function minDefined(a: number | null, b: number | null): number | null {
  // Python: min(filter(None, [a, b]), default=b) —— b 即 ts_ms
  const cands: number[] = [];
  if (a) cands.push(a);
  if (b) cands.push(b);
  return cands.length ? Math.min(...cands) : b;
}

/** 处理 rollout 单行。文件身份（绑定/改绑）由 ingest 决定，本函数不做 rebind。 */
export function processLine(store: LedgerStore, ctx: ThreadCtx, line: string): void {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!isPlainObject(rec)) return;
  const rtype = rec["type"];
  const payload: Json = isPlainObject(rec["payload"]) ? rec["payload"] : {};
  const tsMs = toMs(rec["timestamp"]);
  touch(ctx, tsMs);
  const pt = payload["type"];

  if (rtype === "session_meta") {
    // 注意：子代理文件会在第 2 行嵌入父线程的 session_meta echo。
    // 文件身份只由首行决定（ingest 绑定），此处绝不返回 rebind 信号。
    applySessionMeta(store, ctx, payload, tsMs);
    return;
  }

  if (rtype === "turn_context") {
    const cols: Record<string, unknown> = {};
    if (payload["model"]) cols["model"] = payload["model"];
    if (payload["effort"]) cols["effort"] = payload["effort"];
    if (payload["cwd"]) cols["cwd"] = payload["cwd"];
    // v1.2：sandbox/approval（state DB 权威写入，rollout setdefault 兜底——见 ingest 步骤 1）
    if (payload["approval_policy"]) cols["approval_mode"] = payload["approval_policy"];
    const sp = payload["sandbox_policy"];
    if (sp !== null && sp !== undefined) {
      cols["sandbox_policy"] = typeof sp === "object" ? JSON.stringify(sp) : sp;
    }
    store.threadSetdefault(ctx.thread_id, cols);
    return;
  }

  if (rtype === "response_item") {
    const turn = ctx.open_turn;
    if (typeof pt === "string" && TOOL_CALL_TYPES.has(pt)) {
      ctx.tool_calls += 1;
      ctx.segment_tools.add(String(payload["name"] ?? "")); // wait 语义分类用
      rememberPendingCall(ctx, payload, tsMs); // v1.2 失败配对 + v1.3 工具事件配对（命令/时间/分桶）
      if (turn) {
        turn.tool_calls += 1;
        turn.dirty = true;
      }
    } else if (typeof pt === "string" && TOOL_OUTPUT_TYPES.has(pt)) {
      const n = toolOutputSize(payload);
      ctx.tool_output_bytes += n;
      if (turn) {
        turn.tool_output_bytes += n;
        turn.dirty = true;
      }
      // v1.2 shell 失败启发式（estimated）：exec 包装器把 exit_code 埋在输出文本的内嵌 JSON 里；
      // 无法解析（截断/格式变化）时静默不计 → 低估方向
      const outText = toolOutputText(payload);
      const exitCode = firstNonZeroExit(outText);
      if (exitCode !== null) {
        ctx.shell_failures += 1;
        const cid = payload["call_id"];
        const command = typeof cid === "string" && cid ? ctx.pending_calls.get(cid)?.command ?? null : null;
        recordToolFailure(store, ctx, tsMs, "shell_exit", {
          exitCode,
          command,
          detail: cpTrunc(outText, 1000),
        });
        if (turn) {
          turn.shell_failures += 1;
          turn.dirty = true;
        }
      }
      // v1.3 工具事件：输出侧配对落行（duration/成败/读检测）
      recordPairedOutput(store, ctx, tsMs, payload, outText);
    }
    return;
  }

  if (rtype !== "event_msg") return;

  if (pt === "task_started") {
    if (!payload["turn_id"]) bumpIssues(ctx, "task_started.turn_id");
    const t = newTurn(ctx.thread_id, ctx.next_turn_index);
    t.turn_id = typeof payload["turn_id"] === "string" ? payload["turn_id"] : null;
    t.started_ms = toMs(payload["started_at"]) || tsMs;
    ctx.next_turn_index += 1;
    if (payload["model_context_window"]) {
      const w = pyInt(payload["model_context_window"]);
      ctx.model_context_window = Math.max(ctx.model_context_window ?? 0, w);
    }
    if (ctx.open_turn !== null) {
      // 上一个 turn 未正常关闭，先落盘为 unknown
      ctx.open_turn.status = "unknown";
      ctx.open_turn.dirty = true;
    }
    ctx.open_turn = t;
    ctx.turns_touched.set(t.turn_index, t);
  } else if (pt === "task_complete" || pt === "turn_aborted") {
    if (!payload["turn_id"]) bumpIssues(ctx, `${pt}.turn_id`);
    let turn: TurnState | null = ctx.open_turn;
    const payloadTurnId = payload["turn_id"];
    if (
      turn === null ||
      (payloadTurnId && turn.turn_id && payloadTurnId !== turn.turn_id)
    ) {
      // 按 turn_id 找回（跨增量 run 的收尾）
      turn = null;
      for (const t of ctx.turns_touched.values()) {
        if (t.turn_id && t.turn_id === payloadTurnId) {
          turn = t;
          break;
        }
      }
    }
    if (turn !== null) {
      ctx.open_turn = turn;
    } else {
      turn = newTurn(ctx.thread_id, ctx.next_turn_index);
      turn.turn_id = typeof payloadTurnId === "string" ? payloadTurnId : null;
      ctx.next_turn_index += 1;
      ctx.turns_touched.set(turn.turn_index, turn);
      ctx.open_turn = turn;
    }
    if (pt === "task_complete") {
      turn.status = "completed";
      turn.completed_ms = toMs(payload["completed_at"]) || tsMs;
      turn.duration_ms = typeof payload["duration_ms"] === "number" ? payload["duration_ms"] : null;
      turn.ttft_ms = typeof payload["time_to_first_token_ms"] === "number" ? payload["time_to_first_token_ms"] : null;
      if (payload["error"]) turn.had_error = 1;
    } else {
      turn.status = "aborted";
      turn.abort_reason = typeof payload["reason"] === "string" ? payload["reason"] : null;
      turn.completed_ms = toMs(payload["completed_at"]) || tsMs;
      turn.duration_ms = typeof payload["duration_ms"] === "number" ? payload["duration_ms"] : null;
    }
    turn.dirty = true;
    ctx.open_turn = null;
  } else if (pt === "token_count") {
    ctx.token_count_events += 1;
    const info = payload["info"];
    if (isTokenCountMalformed(info)) bumpIssues(ctx, "token_count.info.total_token_usage");
    const infoObj = isPlainObject(info) ? info : {};
    const totalRaw = infoObj["total_token_usage"];
    const total = isPlainObject(totalRaw) ? totalRaw : {};
    const lastUsage = isPlainObject(infoObj["last_token_usage"]) ? infoObj["last_token_usage"] : {};
    const curTotal = Object.keys(total).length ? totalOf(total) : null;
    const prevTotal = ctx.last_total && Object.keys(ctx.last_total).length ? totalOf(ctx.last_total) : null;
    // v2 文件边界规则：文件首个有效快照 cur < 跨文件 carried → 独立计数 epoch（prev 归零）
    let epochReset = false;
    if (ctx.at_file_start && curTotal !== null) {
      ctx.at_file_start = false;
      if (prevTotal !== null && curTotal < prevTotal) epochReset = true;
    }
    const grown = curTotal !== null && (epochReset || prevTotal === null || curTotal > prevTotal);
    const turn = ctx.open_turn;
    if (grown) {
      // wait/status 语义分类（v3）：本次采样对应完成段的 action set ⊆ WAIT_ACTIONS 且无 patch
      const isWait =
        ctx.segment_tools.size > 0 &&
        [...ctx.segment_tools].every((a) => WAIT_ACTIONS.has(a)) &&
        ctx.segment_patches === 0;
      if (ctx.epoch_first === null) ctx.epoch_first = curTotal; // 本文件计数起点
      const zero = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) as Json;
      const prevSnapshot: Json = epochReset ? zero : (ctx.last_total ?? zero);
      const prevTuple = normTuple(prevSnapshot as Record<string, unknown>);
      const tuple = normTuple(total as Record<string, unknown>);
      const day = tsMs !== null ? localDate(tsMs) : null;
      // L0 raw：毛增长差分记到事件时间戳所在日（与旧口径一致；replay/native 拆分见下）
      let d: DailyAgg | undefined;
      if (day) {
        d = ctx.daily.get(day);
        if (!d) {
          d = newDailyAgg();
          ctx.daily.set(day, d);
        }
        const pv = (k: string): number => pyInt(prevSnapshot[k]);
        const tv = (k: string): number => pyInt(total[k]);
        d.tokens += Math.max(0, tv("total_tokens") - pv("total_tokens"));
        d.input_tokens += Math.max(0, tv("input_tokens") - pv("input_tokens"));
        d.cached_input_tokens += Math.max(0, tv("cached_input_tokens") - pv("cached_input_tokens"));
        d.output_tokens += Math.max(0, tv("output_tokens") - pv("output_tokens"));
      }
      // L1 fork 分类（v1.1）：replay = 继承前缀重放；native = 本线程真实调用
      let cls: "replay" | "native" | "buffered" = "native";
      let retro: RetroAccount | null = null;
      if (ctx.forked_from_id !== null && ctx.fork.state !== "native") {
        const r = classifyForkEvent(store, ctx, tuple, prevTuple, tsMs, day);
        cls = r.cls;
        retro = r.retro;
      }
      if (retro !== null) {
        if (retro.as === "replay") {
          dailyReplayAdd(ctx, retro.day, retro.delta);
        } else {
          // 悬置事件判定为 native：补样本（wait 分类已不可考，不计）
          ctx.usage_bearing_samples += 1;
          ctx.native_total += Math.max(0, retro.delta[5] ?? 0);
          if (retro.day !== null) {
            const rd = ctx.daily.get(retro.day) ?? (ctx.daily.set(retro.day, newDailyAgg()), ctx.daily.get(retro.day)!);
            rd.samples += 1;
          }
        }
      }
      if (cls === "replay") {
        const delta = tuple.map((v, i) => Math.max(0, v - prevTuple[i]!)) as SnapTuple;
        dailyReplayAdd(ctx, day, delta);
      } else if (cls === "native") {
        ctx.usage_bearing_samples += 1;
        if (isWait) ctx.wait_status_model_calls += 1;
        ctx.native_total += Math.max(0, pyInt(total["total_tokens"]) - pyInt(prevSnapshot["total_tokens"]));
        if (d !== undefined) {
          d.samples += 1;
          if (isWait) d.wait += 1;
        }
        if (turn !== null) {
          turn.usage_bearing_samples += 1;
          if (isWait) turn.wait_status_model_calls += 1;
          if (turn.usage_start_json === null) turn.usage_start_json = JSON.stringify(prevSnapshot);
          turn.usage_end_json = JSON.stringify(total);
          turn.dirty = true;
        }
      }
      // "buffered"：raw 已计；样本/wait/turn 悬置，待 legacy 聚簇判定后经 retro 补记
      ctx.last_total = total;
      ctx.segment_tools = new Set();
      ctx.segment_patches = 0;
    } else {
      // 未增长 = 重复/限流重播（#14489）：忽略，不计任何 call；
      // 已确认继承前缀内的 plateau 属重放静默，同样不计
      if (!(ctx.forked_from_id !== null && ctx.fork.state === "matching")) {
        ctx.rebroadcast_events += 1;
        if (turn !== null) {
          turn.rebroadcast_events += 1;
          turn.dirty = true;
        }
      }
    }
    if (lastUsage["total_tokens"] !== null && lastUsage["total_tokens"] !== undefined) {
      const lc = pyInt(lastUsage["total_tokens"]);
      ctx.peak_context = Math.max(ctx.peak_context ?? 0, lc);
    }
    const mcw = infoObj["model_context_window"];
    if (infoObj && mcw) {
      const w = pyInt(mcw);
      ctx.model_context_window = Math.max(ctx.model_context_window ?? 0, w);
    }
  } else if (pt === "user_message") {
    ctx.user_messages += 1;
    if (ctx.open_turn !== null && !ctx.open_turn.user_preview) {
      ctx.open_turn.user_preview = cpSlice(String(payload["message"] ?? ""), 80);
      ctx.open_turn.dirty = true;
    }
  } else if (pt === "context_compacted") {
    ctx.compactions += 1;
    if (ctx.open_turn !== null) {
      ctx.open_turn.compactions += 1;
      ctx.open_turn.dirty = true;
    }
  } else if (pt === "patch_apply_end") {
    // v1.3 工具事件：file 桶（成败都落行；± 行来自 unified_diff / add 类 content 行数，estimated）
    // v1.4 时长配对（estimated）：apply_patch 走 exec 通道，patch_apply_end.call_id ↔ pending 调用时戳差；
    //   只 peek 不 consume（shell 行的 exit/读检测仍由 output 配对负责）；无匹配（fork/重放剥离 call 事件）→ NULL 不猜
    {
      const pl = patchLinesOf(payload["changes"]);
      const pCid = payload["call_id"];
      const pend = typeof pCid === "string" && pCid ? ctx.pending_calls.get(pCid) : undefined;
      recordToolEvent(store, ctx, tsMs, {
        bucket: "file", name: "apply_patch",
        call_id: typeof pCid === "string" ? pCid : null,
        duration_ms: pend && pend.ts_ms != null && tsMs != null ? Math.max(0, tsMs - pend.ts_ms) : null,
        files_touched: pl.files, lines_plus: pl.linesPlus, lines_minus: pl.linesMinus,
        ok: payload["success"] === true ? 1 : payload["success"] === false ? 0 : null,
      });
    }
    if (payload["success"]) {
      ctx.patches += 1;
      ctx.segment_patches += 1; // wait 语义分类用：有 patch 即非 wait 段
      ctx.first_patch_ms = minDefined(ctx.first_patch_ms, tsMs ?? 0);
      const changes = payload["changes"];
      const files = isPlainObject(changes) ? Object.keys(changes).map(String) : [];
      if (ctx.open_turn !== null) {
        const t = ctx.open_turn;
        t.patches += 1;
        t.first_patch_ms = minDefined(t.first_patch_ms, tsMs ?? 0);
        for (const f of files) {
          if (!t.patch_files.includes(f)) t.patch_files.push(f);
        }
        t.dirty = true;
      }
    } else if (payload["success"] === false) {
      // v1.2 kind 扩展：patch 失败此前完全盲区（patches 仅计成功，失败连计数都没有）。
      // command=目标文件列表（changes 键，空则回退 call_id 配对输入），detail=stderr；success 缺失时不计（fail-closed，低估方向）
      const changes = payload["changes"];
      const files = isPlainObject(changes) ? Object.keys(changes).map(String) : [];
      const cid = payload["call_id"];
      const fallback = typeof cid === "string" && cid ? ctx.pending_calls.get(cid)?.command ?? null : null;
      const stderr = payload["stderr"];
      recordToolFailure(store, ctx, tsMs, "patch_fail", {
        command: files.length ? cpTrunc(files.join(" "), 500) : fallback,
        detail: typeof stderr === "string" && stderr ? cpTrunc(stderr, 1000) : null,
      });
    }
  } else if (pt === "web_search_end") {
    ctx.web_searches += 1;
    // v1.3 工具事件：web 桶
    {
      const wCid = payload["call_id"];
      recordToolEvent(store, ctx, tsMs, {
        bucket: "web", name: "web_search",
        call_id: typeof wCid === "string" ? wCid : null, ok: 1,
      });
    }
  } else if (pt === "mcp_tool_call_end") {
    // v1.2：MCP 一等计数（事件自包含 invocation.server/tool + result.{Ok|Err}）
    ctx.mcp_calls += 1;
    const result = payload["result"];
    const failed = isPlainObject(result) && result["Err"] !== undefined;
    if (failed) {
      ctx.mcp_failures += 1;
      const inv = isPlainObject(payload["invocation"]) ? payload["invocation"] : {};
      const err = result["Err"];
      const errText = err !== null && err !== undefined && typeof err === "object"
        ? JSON.stringify(err)
        : err === null || err === undefined ? null : String(err);
      recordToolFailure(store, ctx, tsMs, "mcp_err", {
        server: typeof inv["server"] === "string" ? inv["server"] : null,
        tool: typeof inv["tool"] === "string" ? inv["tool"] : null,
        detail: errText === null ? null : cpTrunc(errText, 1000),
      });
    }
    if (ctx.open_turn !== null) {
      ctx.open_turn.mcp_calls += 1;
      if (failed) ctx.open_turn.mcp_failures += 1;
      ctx.open_turn.dirty = true;
    }
    // v1.3 工具事件：mcp 桶（结构化 duration；ok = result.Ok）
    {
      const mCid = payload["call_id"];
      const inv2 = isPlainObject(payload["invocation"]) ? payload["invocation"] : {};
      recordToolEvent(store, ctx, tsMs, {
        bucket: "mcp",
        name: typeof inv2["tool"] === "string" ? inv2["tool"] : null,
        call_id: typeof mCid === "string" ? mCid : null,
        duration_ms: mcpDurationMs(payload),
        ok: failed ? 0 : 1,
        detail: typeof inv2["server"] === "string" ? `server=${inv2["server"]}` : null,
      });
    }
  } else if (pt === "sub_agent_activity") {
    // v1.3 工具事件：collab 桶（子代理编排活动）
    {
      const sCid = payload["event_id"];
      recordToolEvent(store, ctx, tsMs, {
        bucket: "collab", name: "sub_agent_activity",
        call_id: typeof sCid === "string" ? sCid : null, ok: 1,
        detail: typeof payload["agent_path"] === "string"
          ? `agent=${payload["agent_path"]} kind=${String(payload["kind"] ?? "")}`
          : null,
      });
    }
  } else if (pt === "agent_message") {
    ctx.agent_messages += 1;
  }
}

function applySessionMeta(store: LedgerStore, ctx: ThreadCtx, payload: Json, _tsMs: number | null): void {
  const tid = sessionMetaIdentity(payload); // id / session_id（非空字符串）
  if (!tid) {
    // fail-closed：session_meta.id 属关键字段
    bumpIssues(ctx, "session_meta.id");
    return;
  }
  if (tid !== ctx.thread_id) return; // 父线程 echo：忽略
  const sv = (k: string): string | null => {
    const v = payload[k];
    return typeof v === "string" && v ? v : null;
  };
  store.threadSetdefault(ctx.thread_id, {
    cwd: sv("cwd"),
    cli_version: sv("cli_version"),
    originator: sv("originator"),
    thread_source: sv("thread_source"),
    agent_nickname: sv("agent_nickname"),
    agent_path: sv("agent_path"),
    forked_from_id: sv("forked_from_id"),
  });
  const ffid = sv("forked_from_id");
  if (ffid !== null) ctx.forked_from_id = ffid; // 分类器用缓存，避免逐事件查库
  const src = payload["source"];
  if (typeof src === "string") {
    store.threadSetdefault(ctx.thread_id, { source: src });
  } else if (isPlainObject(src)) {
    store.threadSetdefault(ctx.thread_id, { source: JSON.stringify(src) });
    const sub = src["subagent"];
    const spawn = (isPlainObject(sub) ? sub["thread_spawn"] : null) ?? {};
    const p = isPlainObject(spawn) ? spawn["parent_thread_id"] : null;
    if (typeof p === "string" && p) {
      // source JSON 仅作 fallback（优先级 ③）
      store.setParentFallback(ctx.thread_id, p, "source_json");
    }
  }
  const ptp = payload["parent_thread_id"];
  if (typeof ptp === "string" && ptp) {
    // v3 修正：线程自声明的 parent 具有最高归属证据优先级（①），无条件写入
    store.setParent(ctx.thread_id, ptp, "session_meta");
  }
}

/**
 * Fork replay 分类器（契约 v1.1 / fork-v2）——与 Python oracle ledger/fork.py 逐条对应。
 *
 * 判定链（时间戳不参与主判定；EOF 与时间 gap 都不是 replay 边界）：
 *   1. 父前缀位置匹配（主）：子第 i 个增长快照（六字段元组）== 父第 i 个 → 继承前缀延续；
 *      首个不等位置 = 边界，其后全部 native；匹配长度 0 且父可达 → 阳性判定无 replay（method=none）。
 *   2. 父文件缺失：起始密集聚簇（连续间隔 ≤1s 且 ≥2 条）→ legacy_time（unverified 降级）。
 *   3. 父文件缺失且无签名 → unresolved：不扣减（baseline=0），显式标注，绝不自动扣首快照。
 *
 * 工程约束：
 *   - 父序列游标（文件列表 + 逻辑 offset + 位置）持久化在 fork_replay_json，
 *     全部轮次合计只顺序读父文件一遍；buf 仅内存态，持久化时换算逻辑 offset。
 *   - 分类器状态与账目、rollout offset 同轮事务落盘（见 ingest）。
 *   - 父文件按路径排序 = 时间序（sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { normcase } from "@hs/shared";
import type { LedgerStore } from "./store.ts";
import { newForkState } from "./types.ts";
import type { ForkReplayState, ParentCursorState, ThreadCtx } from "./types.ts";

type Row = Record<string, unknown>;

const pyInt = (x: unknown): number => {
  if (x === null || x === undefined || x === false || x === "") return 0;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export const TUPLE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

export type SnapTuple = number[];

/** 六字段规范化元组（pyInt；total_tokens 原样取记录值，与 raw 口径一致）。 */
export function normTuple(total: Record<string, unknown>): SnapTuple {
  return TUPLE_FIELDS.map((f) => pyInt(total[f]));
}

export function tuplesEqual(a: SnapTuple, b: SnapTuple): boolean {
  for (let i = 0; i < TUPLE_FIELDS.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function digestStep(prev: string, t: SnapTuple): string {
  return createHash("sha256").update(prev + "|" + t.join(","), "utf8").digest("hex");
}

export const DIGEST_SEED = createHash("sha256").update("fork-v2", "utf8").digest("hex");

/** 分类器状态序列化（cursor 换算逻辑 offset；buf 不落盘）。 */
export function forkStateToJson(ctx: ThreadCtx): string {
  const c = ctx.fork;
  const cursor =
    c.cursor === null
      ? null
      : {
          files: c.cursor.files,
          file_idx: c.cursor.file_idx,
          offset: c.cursor.offset - (c.cursor.buf?.length ?? 0),
          pos: c.cursor.pos,
          last: c.cursor.last,
          at_start: c.cursor.at_start,
        };
  return JSON.stringify({
    state: c.state,
    method: c.method,
    status: c.status,
    pos: c.pos,
    baseline: c.baseline,
    prefix_events: c.prefix_events,
    digest: c.digest,
    legacy_mode: c.legacy_mode,
    cursor,
    legacy: { last_ts: c.legacy.last_ts, buf: c.legacy.buf },
    // 辅助状态（与分类器共用一个持久化槽位，保证崩溃后文件边界规则可恢复）
    current_file: ctx.current_file,
    at_file_start: ctx.at_file_start,
    epoch_soft_closed: ctx.epoch_soft_closed,
  });
}

export function parseForkState(json: string | null | undefined, ctx: ThreadCtx): void {
  const c = ctx.fork;
  if (typeof json !== "string" || !json) return;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v["state"] === "matching" || v["state"] === "native") c.state = v["state"];
    if (typeof v["method"] === "string") c.method = v["method"];
    if (typeof v["status"] === "string") c.status = v["status"];
    c.pos = pyInt(v["pos"]);
    c.baseline = pyInt(v["baseline"]);
    c.prefix_events = pyInt(v["prefix_events"]);
    if (typeof v["digest"] === "string") c.digest = v["digest"];
    c.legacy_mode = v["legacy_mode"] === true;
    const cur = v["cursor"];
    if (cur && typeof cur === "object" && Array.isArray((cur as Row)["files"])) {
      const cc = cur as Row;
      c.cursor = {
        files: (cc["files"] as unknown[]).map(String),
        file_idx: pyInt(cc["file_idx"]),
        offset: pyInt(cc["offset"]),
        pos: pyInt(cc["pos"]),
        last: Array.isArray(cc["last"]) ? (cc["last"] as unknown[]).map((x) => pyInt(x)) : null,
        at_start: cc["at_start"] === true,
        buf: Buffer.alloc(0),
      };
    }
    const lg = v["legacy"];
    if (lg && typeof lg === "object") {
      const l = lg as Row;
      c.legacy.last_ts = typeof l["last_ts"] === "number" ? (l["last_ts"] as number) : null;
      const b = l["buf"];
      if (b && typeof b === "object" && Array.isArray((b as Row)["delta"])) {
        const bb = b as Row;
        c.legacy.buf = {
          day: typeof bb["day"] === "string" ? (bb["day"] as string) : null,
          delta: (bb["delta"] as unknown[]).map((x) => pyInt(x)),
          tuple: Array.isArray(bb["tuple"]) ? (bb["tuple"] as unknown[]).map((x) => pyInt(x)) : [],
        };
      }
    }
    if (typeof v["current_file"] === "string") ctx.current_file = v["current_file"];
    if (v["at_file_start"] === true) ctx.at_file_start = true;
    if (v["epoch_soft_closed"] === true) ctx.epoch_soft_closed = true;
  } catch {
    /* 坏 JSON → 保持全新状态（fail-open 到 native 不扣减的保守路径由 pos=0 自然保证） */
  }
}

/** 父线程的 rollout 文件清单（rollout_files 绑定 + threads.rollout_path 兜底，按路径时间序）。 */
export function lookupParentFiles(store: LedgerStore, parentId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of store
    .prepare("SELECT path FROM rollout_files WHERE thread_id=? AND status!='unreadable' ORDER BY path")
    .all(parentId) as Row[]) {
    const p = String(r["path"] ?? "");
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  const t = store.prepare("SELECT rollout_path FROM threads WHERE thread_id=?").get(parentId) as Row | undefined;
  const rp = t && typeof t["rollout_path"] === "string" && t["rollout_path"] ? normcase(t["rollout_path"]) : null;
  if (rp && !seen.has(rp)) {
    seen.add(rp);
    out.push(rp);
    out.sort();
  }
  return out;
}

/** 顺序读父文件下一完整行；跨文件推进（EOF→下一文件）；打不开的文件跳过。返回 null = 全部读尽。 */
function nextParentLine(cur: ParentCursorState): string | null {
  for (;;) {
    if (cur.buf && cur.buf.length > 0) {
      const nl = cur.buf.indexOf(10); // '\n'
      if (nl >= 0) {
        const line = cur.buf.subarray(0, nl).toString("utf8");
        cur.buf = cur.buf.subarray(nl + 1);
        return line;
      }
    }
    if (cur.file_idx >= cur.files.length) return null;
    const f = cur.files[cur.file_idx]!;
    let chunk: Buffer | null = null;
    try {
      const fd = fs.openSync(f, "r");
      try {
        const b = Buffer.alloc(4 * 1024 * 1024);
        const n = fs.readSync(fd, b, 0, b.length, cur.offset);
        if (n > 0) chunk = b.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      chunk = null;
    }
    if (chunk === null || chunk.length === 0) {
      // EOF 或读失败 → 下一文件
      cur.file_idx += 1;
      cur.offset = 0;
      cur.buf = Buffer.alloc(0);
      cur.at_start = true;
      continue;
    }
    cur.buf = Buffer.concat([cur.buf ?? Buffer.alloc(0), chunk]);
    cur.offset += chunk.length;
  }
}

/**
 * 推进父序列直到产出 needed 个增长快照或读尽。
 * 增长规则与主解析器 v2 一致（文件首快照：较小=计数重启、相等=重发不增长、较大=增长）。
 */
function advanceParent(cur: ParentCursorState, needed: number): void {
  while (cur.pos < needed) {
    const line = nextParentLine(cur);
    if (line === null) return;
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const r = rec as Row;
    if (r["type"] !== "event_msg") continue;
    const p = r["payload"];
    if (!p || typeof p !== "object" || (p as Row)["type"] !== "token_count") continue;
    const info = (p as Row)["info"];
    const tt = info && typeof info === "object" ? (info as Row)["total_token_usage"] : null;
    if (!tt || typeof tt !== "object") continue;
    const t = normTuple(tt as Record<string, unknown>);
    const prevTotal = cur.last !== null ? cur.last[5]! : null;
    let grown: boolean;
    if (cur.at_start) {
      cur.at_start = false;
      grown = prevTotal === null || t[5]! !== prevTotal; // 重启(<)→增长；==→重发；>→增长
    } else {
      grown = prevTotal === null || t[5]! > prevTotal;
    }
    if (grown) {
      cur.pos += 1;
      cur.last = t;
    }
  }
}

export interface RetroAccount {
  day: string | null;
  delta: SnapTuple;
  as: "replay" | "native";
}

export interface ForkDecision {
  cls: "replay" | "native" | "buffered";
  retro: RetroAccount | null;
}

/**
 * 对一个增长快照做 fork 分类。只更新分类器自身状态；账目（replay/native 列、样本、
 * turn usage）由调用方按返回值统一处理，保证 TS/Python 逐语句对齐。
 */
export function classifyForkEvent(
  store: LedgerStore,
  ctx: ThreadCtx,
  tuple: SnapTuple,
  prevTuple: SnapTuple,
  tsMs: number | null,
  day: string | null,
): ForkDecision {
  const c = ctx.fork;
  if (c.state === "native") return { cls: "native", retro: null };
  c.pos += 1;
  if (c.cursor === null && !c.legacy_mode) {
    const files =
      ctx.forked_from_id && ctx.forked_from_id !== ctx.thread_id
        ? lookupParentFiles(store, ctx.forked_from_id)
        : [];
    if (files.length > 0) {
      c.cursor = { files, file_idx: 0, offset: 0, pos: 0, last: null, at_start: true, buf: Buffer.alloc(0) };
    } else {
      c.legacy_mode = true;
    }
  }
  if (!c.legacy_mode) {
    const cur = c.cursor!;
    advanceParent(cur, c.pos);
    const pt = cur.pos >= c.pos ? cur.last : null; // 父在当前位置的元组（读尽则为 null）
    if (pt !== null && tuplesEqual(pt, tuple)) {
      // 继承前缀延续
      c.state = "matching";
      c.method = "parent_prefix";
      c.status = "verified";
      c.prefix_events = c.pos;
      c.baseline = tuple[5]!;
      c.digest = digestStep(c.digest ?? DIGEST_SEED, tuple);
      return { cls: "replay", retro: null };
    }
    // 结构性边界（divergence 或子序列超前于父的已知序列）
    c.state = "native";
    c.status = "verified";
    c.method = c.prefix_events > 0 ? "parent_prefix" : "none";
    return { cls: "native", retro: null };
  }
  // legacy：父缺失，时间聚簇兜底（unverified 降级模式）
  const lg = c.legacy;
  const delta = tuple.map((v, i) => Math.max(0, v - (prevTuple[i] ?? 0)));
  if (c.pos === 1) {
    // 首事件悬置：等下一事件的间隔决定聚簇是否成立（EOF 不是边界）
    lg.last_ts = tsMs;
    lg.buf = { day, delta, tuple };
    c.status = "pending";
    return { cls: "buffered", retro: null };
  }
  const gap = tsMs !== null && lg.last_ts !== null ? tsMs - lg.last_ts : Number.POSITIVE_INFINITY;
  lg.last_ts = tsMs;
  if (gap <= 1000) {
    let retro: RetroAccount | null = null;
    if (lg.buf !== null) {
      retro = { day: lg.buf.day, delta: lg.buf.delta, as: "replay" };
      c.prefix_events = 1;
      c.baseline = lg.buf.tuple[5] ?? 0;
      c.digest = digestStep(DIGEST_SEED, lg.buf.tuple);
      lg.buf = null;
    }
    c.state = "matching";
    c.method = "legacy_time";
    c.status = "parent_missing";
    c.prefix_events = c.pos;
    c.baseline = tuple[5]!;
    c.digest = digestStep(c.digest ?? DIGEST_SEED, tuple);
    return { cls: "replay", retro };
  }
  const retroN: RetroAccount | null =
    lg.buf !== null ? { day: lg.buf.day, delta: lg.buf.delta, as: "native" } : null;
  lg.buf = null;
  c.state = "native";
  c.method = c.prefix_events > 0 ? "legacy_time" : "unresolved";
  c.status = "parent_missing";
  return { cls: "native", retro: retroN };
}

/** 文件切换钩子：offset==0 视为文件起点（v2 文件边界 epoch 规则的输入）。
 * 同一文件跨 run 续读时，重开上一轮 run 末软封存的 epoch（避免把一个文件拆成多个计数区间）。 */
export function markFileStart(ctx: ThreadCtx, file: string, offset: number): void {
  if (ctx.current_file === file) {
    if (ctx.epoch_soft_closed) {
      const lastPair = ctx.epochs.length ? ctx.epochs[ctx.epochs.length - 1] : null;
      if (lastPair) {
        ctx.epochs.pop();
        ctx.epoch_first = lastPair[0];
      }
      ctx.epoch_soft_closed = false;
      ctx.dirty = true;
    }
    return;
  }
  ctx.current_file = file;
  ctx.epoch_soft_closed = false; // 换新文件：上一文件的软封存转正
  if (offset === 0) ctx.at_file_start = true;
}

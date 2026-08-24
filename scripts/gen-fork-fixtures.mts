/**
 * 生成 fork 分类器（fork-v2）fixture 矩阵 + 期望标注 sidecar。
 *
 * 用法：node scripts/gen-fork-fixtures.mts
 * 产物：
 *   tests/fixtures/fork-home/          —— 完整矩阵（除「迟到父」parentX 外的全部文件）
 *   tests/fixtures/fork-home-stash/    —— 迟到父 parentX（两阶段 golden 用）
 *   tests/fixtures/fork-home/expected.json —— 期望标注（phase1 = 无 parentX；phase2 = 全量）
 *
 * 期望天数一律由 localDate(事件时间戳) 推导（与账目同一分桶逻辑，时区无关）。
 * 覆盖矩阵：43ms 重放 / 跨秒重放 / 重放+native 同秒 / 保留历史时间戳跨日 /
 * 单一继承快照 / 无 replay 子线程 / 父缺失 legacy 聚簇 / 父缺失无签名 unresolved /
 * 迟到父 refold / 嵌套 fork / unchanged 重发 / 计数器 reset（非 fork 双文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDate } from "@hs/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = path.join(ROOT, "tests", "fixtures", "fork-home");
const STASH = path.join(ROOT, "tests", "fixtures", "fork-home-stash");
const DAY_DIR = path.join(HOME, "sessions", "2026", "08", "01");

interface Snap {
  i: number;
  c: number;
  cw: number;
  o: number;
  r: number;
}
interface Ev {
  ts: string;
  s: Snap;
}
const mk = (i: number, c: number, o: number, cw = 0, r = 0): Snap => ({ i, c, cw, o, r });
const tot = (s: Snap): number => s.i + s.o;
const tuple = (s: Snap): number[] => [s.i, s.c, s.cw, s.o, s.r, tot(s)];
const ev = (ts: string, s: Snap): Ev => ({ ts, s });
const dayOf = (ts: string): string => localDate(Date.parse(ts)) ?? "";

const J = (o: unknown): string => JSON.stringify(o);
const meta = (ts: string, tid: string, extra: Record<string, unknown> = {}): string =>
  J({ timestamp: ts, type: "session_meta", payload: { id: tid, cwd: "E:\\proj\\fixtures", cli_version: "0.146.0", originator: "hs_fixture", ...extra } });
const tc = (ts: string, s: Snap, peak = 5000): string =>
  J({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: s.i, cached_input_tokens: s.c, cache_write_input_tokens: s.cw, output_tokens: s.o, reasoning_output_tokens: s.r, total_tokens: tot(s) },
    last_token_usage: { input_tokens: peak, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: peak },
  } } });
const taskStart = (ts: string, turn: string): string =>
  J({ timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: turn, started_at: ts } });
const taskComplete = (ts: string, turn: string): string =>
  J({ timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: turn, completed_at: ts, duration_ms: 1000 } });
const toolCall = (ts: string, name: string): string =>
  J({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", name, input: "{}" } });

function writeRollout(fname: string, lines: string[], dir = DAY_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fname), lines.join("\n") + "\n", "utf8");
}

// —— 期望标注计算（与账目语义一致：replay/native = 毛差分按事件时间戳 localDate 归桶） ——
interface ExpectThread {
  method: string | null;
  status: string | null;
  baseline: number | null;
  baseline_verified: number;
  prefix_events: number | null;
  replay_input: number;
  replay_cached: number;
  replay_output: number;
  replay_total: number;
  replay_events: number;
  native_total: number;
  daily: Record<string, { tokens: number; replay_total: number; samples: number }>;
}
function newExpect(method: string | null, status: string | null, baseline: number | null, prefix: number, baselineVerified: number): ExpectThread {
  return { method, status, baseline, baseline_verified: baselineVerified, prefix_events: prefix, replay_input: 0, replay_cached: 0, replay_output: 0, replay_total: 0, replay_events: 0, native_total: 0, daily: {} };
}
function bump(e: ExpectThread, ts: string, t: number[], prev: number[], kind: "replay" | "raw-only"): void {
  const day = dayOf(ts);
  let d = e.daily[day];
  if (!d) {
    d = { tokens: 0, replay_total: 0, samples: 0 };
    e.daily[day] = d;
  }
  d.tokens += Math.max(0, t[5] - prev[5]);
  if (kind === "replay") {
    e.replay_input += Math.max(0, t[0] - prev[0]);
    e.replay_cached += Math.max(0, t[1] - prev[1]);
    e.replay_output += Math.max(0, t[3] - prev[3]);
    e.replay_total += Math.max(0, t[5] - prev[5]);
    e.replay_events += 1;
    d.replay_total += Math.max(0, t[5] - prev[5]);
  }
}
/** 由 replay/native 事件序列推导 fork 子线程期望；replay 为空即普通线程期望。 */
function expectFrom(method: string | null, status: string | null, baseline: number | null, prefix: number, verified: number, replay: Ev[], native: Ev[]): ExpectThread {
  const e = newExpect(method, status, baseline, prefix, verified);
  let prev = [0, 0, 0, 0, 0, 0];
  for (const { ts, s } of replay) {
    bump(e, ts, tuple(s), prev, "replay");
    prev = tuple(s);
  }
  for (const { ts, s } of native) {
    const t = tuple(s);
    bump(e, ts, t, prev, "raw-only");
    e.native_total += Math.max(0, t[5] - prev[5]);
    e.daily[dayOf(ts)]!.samples += 1;
    prev = t;
  }
  return e;
}
const plainExpect = (events: Ev[]): ExpectThread => expectFrom(null, null, null, 0, 0, [], events);

const expectedPhase2: Record<string, ExpectThread> = {};
const expectedPhase1: Record<string, ExpectThread> = {};

// =====================================================================
// case1 parentA + childA：43ms 重放 + 前缀内 plateau 重发 + 边界后重发 + turn 账目
// =====================================================================
const PA = "f1a0a000-0000-4000-8000-00000000000a";
const CA = "f1a0a000-0000-4000-8000-00000000000b";
{
  const paEvents: Ev[] = [
    mk(1000, 800, 100), mk(2000, 1700, 150), mk(3000, 2600, 200), mk(4000, 3500, 250), mk(5000, 4400, 300),
    mk(6000, 5300, 350), mk(7000, 6200, 400), // 后两段为 fork 后父自身增长
  ].map((s, idx) => ev(`2026-08-01T10:00:${String(idx + 1).padStart(2, "0")}Z`, s));
  const lines = [meta("2026-08-01T10:00:00Z", PA)];
  paEvents.forEach((x) => {
    lines.push(toolCall(x.ts, "bash"));
    lines.push(tc(x.ts, x.s));
  });
  writeRollout("rollout-2026-08-01T10-00-00-f1a0a000-0000-4000-8000-00000000000a.jsonl", lines);
  expectedPhase2[PA] = plainExpect(paEvents);

  const replayA: Ev[] = paEvents.slice(0, 5).map((x, idx) =>
    ev(["2026-08-01T11:00:00.500Z", "2026-08-01T11:00:00.510Z", "2026-08-01T11:00:00.520Z", "2026-08-01T11:00:00.530Z", "2026-08-01T11:00:00.543Z"][idx]!, x.s));
  const nativeA: Ev[] = [
    ev("2026-08-01T11:00:20Z", mk(9000, 8000, 600)),
    ev("2026-08-01T11:00:23Z", mk(10000, 9000, 700)),
    ev("2026-08-01T11:00:26Z", mk(11000, 9900, 800)),
  ];
  const linesC = [meta("2026-08-01T11:00:00Z", CA, { forked_from_id: PA })];
  linesC.push(taskStart("2026-08-01T11:00:00.100Z", "turn-a1"));
  replayA.forEach((x) => linesC.push(tc(x.ts, x.s)));
  linesC.push(tc("2026-08-01T11:00:00.560Z", replayA[4]!.s)); // 前缀内 unchanged 重发 → 静默
  nativeA.forEach((x) => linesC.push(tc(x.ts, x.s)));
  linesC.push(tc("2026-08-01T11:00:24Z", nativeA[1]!.s)); // 边界后 unchanged 重发 → rebroadcast
  linesC.push(taskComplete("2026-08-01T11:00:27Z", "turn-a1"));
  writeRollout("rollout-2026-08-01T11-00-00-f1a0a000-0000-4000-8000-00000000000b.jsonl", linesC);
  expectedPhase2[CA] = expectFrom("parent_prefix", "verified", tot(replayA[4]!.s), 5, 1, replayA, nativeA);
}

// =====================================================================
// case2 parentB + childB：跨多秒重放（gap 2s）+ 首个 native 与末位重放同秒（反 #1460）
// =====================================================================
const PB = "f1a0a000-0000-4000-8000-00000000000c";
const CB = "f1a0a000-0000-4000-8000-00000000000d";
{
  const pbEvents: Ev[] = [
    mk(12000, 10000, 300), mk(14000, 12000, 400), mk(16000, 14000, 500), mk(18000, 16000, 600),
    mk(20000, 18000, 700), mk(22000, 20000, 800),
  ].map((s, idx) => ev(`2026-08-01T12:00:${String(idx * 10).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T12-00-00-f1a0a000-0000-4000-8000-00000000000c.jsonl",
    [meta("2026-08-01T12:00:00Z", PB), ...pbEvents.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[PB] = plainExpect(pbEvents);
  const replayB: Ev[] = pbEvents.slice(0, 4).map((x, idx) => ev(`2026-08-01T12:01:${String(idx * 2).padStart(2, "0")}Z`, x.s));
  const nativeB: Ev[] = [
    ev("2026-08-01T12:01:06.200Z", mk(25000, 23000, 900)), // 与末位重放同秒（gap 200ms）
    ev("2026-08-01T12:01:10Z", mk(27000, 25000, 1000)),
  ];
  writeRollout("rollout-2026-08-01T12-01-00-f1a0a000-0000-4000-8000-00000000000d.jsonl",
    [meta("2026-08-01T12:01:00Z", CB, { forked_from_id: PB }),
     ...replayB.map((x) => tc(x.ts, x.s)), ...nativeB.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[CB] = expectFrom("parent_prefix", "verified", tot(replayB[3]!.s), 4, 1, replayB, nativeB);
}

// =====================================================================
// case3 parentC + childC：保留历史时间戳的跨日重放（replay 归事件日，native 归 fork 日）
// =====================================================================
const PC = "f1a0a000-0000-4000-8000-00000000000e";
const CC = "f1a0a000-0000-4000-8000-00000000000f";
{
  const pcEvents: Ev[] = [mk(500, 400, 50), mk(600, 500, 60), mk(700, 600, 70)]
    .map((s, idx) => ev(`2026-07-30T09:00:${String(idx * 5).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T09-30-00-f1a0a000-0000-4000-8000-00000000000e.jsonl",
    [meta("2026-07-30T09:00:00Z", PC), ...pcEvents.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[PC] = plainExpect(pcEvents);
  const nativeC: Ev[] = [
    ev("2026-08-01T13:00:00Z", mk(900, 800, 80)),
    ev("2026-08-01T13:00:04Z", mk(1000, 900, 90)),
  ];
  writeRollout("rollout-2026-08-01T13-00-00-f1a0a000-0000-4000-8000-00000000000f.jsonl",
    [meta("2026-08-01T13:00:00Z", CC, { forked_from_id: PC }),
     ...pcEvents.map((x) => tc(x.ts, x.s)), // 保留父的原始时间戳
     ...nativeC.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[CC] = expectFrom("parent_prefix", "verified", tot(pcEvents[2]!.s), 3, 1, pcEvents, nativeC);
}

// =====================================================================
// case4 parentD + childD：单一继承快照（prefix_events=1）
// =====================================================================
const PD = "f1a0a000-0000-4000-8000-00000000000h";
const CD = "f1a0a000-0000-4000-8000-00000000000i";
{
  const pdEvents: Ev[] = [mk(300, 250, 30), mk(400, 350, 40), mk(500, 450, 50)]
    .map((s, idx) => ev(`2026-08-01T14:00:${String(idx * 5).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T14-00-00-f1a0a000-0000-4000-8000-00000000000h.jsonl",
    [meta("2026-08-01T14:00:00Z", PD), ...pdEvents.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[PD] = plainExpect(pdEvents);
  const replayD: Ev[] = [ev("2026-08-01T15:00:00Z", pdEvents[0]!.s)];
  const nativeD: Ev[] = [
    ev("2026-08-01T15:00:30Z", mk(6000, 5000, 600)),
    ev("2026-08-01T15:00:35Z", mk(7000, 6000, 700)),
  ];
  writeRollout("rollout-2026-08-01T15-00-00-f1a0a000-0000-4000-8000-00000000000i.jsonl",
    [meta("2026-08-01T15:00:00Z", CD, { forked_from_id: PD }),
     ...replayD.map((x) => tc(x.ts, x.s)), ...nativeD.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[CD] = expectFrom("parent_prefix", "verified", tot(pdEvents[0]!.s), 1, 1, replayD, nativeD);
}

// =====================================================================
// case5+13 childE：迟到父（phase1 legacy_time → phase2 refold 为 parent_prefix）
// parentX 写入 STASH，不在 fork-home 内
// =====================================================================
const PX = "f1a0a000-0000-4000-8000-00000000000x";
const CE = "f1a0a000-0000-4000-8000-00000000000y";
{
  const pxEvents: Ev[] = [mk(2000, 1800, 200), mk(2400, 2200, 240), mk(2800, 2600, 280), mk(3200, 3000, 320)]
    .map((s, idx) => ev(`2026-08-01T16:00:${String(idx * 3).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T16-00-00-f1a0a000-0000-4000-8000-00000000000x.jsonl",
    [meta("2026-08-01T16:00:00Z", PX), ...pxEvents.map((x) => tc(x.ts, x.s))],
    path.join(STASH, "sessions", "2026", "08", "01"));
  expectedPhase2[PX] = plainExpect(pxEvents);
  const replayE: Ev[] = pxEvents.map((x, idx) => ev(`2026-08-01T17:00:00.${String(idx * 100).padStart(3, "0")}Z`, x.s));
  const nativeE: Ev[] = [
    ev("2026-08-01T17:00:30Z", mk(8000, 7000, 800)),
    ev("2026-08-01T17:00:34Z", mk(8200, 7200, 820)),
  ];
  writeRollout("rollout-2026-08-01T17-00-00-f1a0a000-0000-4000-8000-00000000000y.jsonl",
    [meta("2026-08-01T17:00:00Z", CE, { forked_from_id: PX }),
     ...replayE.map((x) => tc(x.ts, x.s)), ...nativeE.map((x) => tc(x.ts, x.s))]);
  // 数值口径两阶段一致（legacy 与结构匹配对此 burst 结论相同），仅方法/验证态不同
  expectedPhase1[CE] = expectFrom("legacy_time", "parent_missing", tot(replayE[3]!.s), 4, 0, replayE, nativeE);
  expectedPhase2[CE] = expectFrom("parent_prefix", "verified", tot(replayE[3]!.s), 4, 1, replayE, nativeE);
}

// =====================================================================
// case6 childF：父缺失且无聚簇 → unresolved（首事件悬置后判 native，绝不扣首快照）
// =====================================================================
const CF = "f1a0a000-0000-4000-8000-00000000000z";
{
  const nativeF: Ev[] = [
    ev("2026-08-01T18:00:00Z", mk(400, 300, 40)),
    ev("2026-08-01T18:00:20Z", mk(600, 500, 60)),
    ev("2026-08-01T18:00:25Z", mk(800, 700, 80)),
  ];
  writeRollout("rollout-2026-08-01T18-00-00-f1a0a000-0000-4000-8000-00000000000z.jsonl",
    [meta("2026-08-01T18:00:00Z", CF, { forked_from_id: "f1a0a000-0000-4000-8000-0000000000zz" }),
     ...nativeF.map((x) => tc(x.ts, x.s))]);
  const e = expectFrom("unresolved", "parent_missing", 0, 0, 0, [], nativeF);
  expectedPhase2[CF] = e;
  expectedPhase1[CF] = e;
}

// =====================================================================
// case7 parentG + childG：无 replay 子线程（首元组即 divergence → method=none）
// =====================================================================
const PG = "f1a0a000-0000-4000-8000-00000000001a";
const CG = "f1a0a000-0000-4000-8000-00000000001b";
{
  const pgEvents: Ev[] = [mk(100, 90, 10), mk(200, 180, 20)]
    .map((s, idx) => ev(`2026-08-01T19:00:${String(idx * 5).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T19-00-00-f1a0a000-0000-4000-8000-00000000001a.jsonl",
    [meta("2026-08-01T19:00:00Z", PG), ...pgEvents.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[PG] = plainExpect(pgEvents);
  const nativeG: Ev[] = [
    ev("2026-08-01T20:00:00Z", mk(1500, 1400, 150)),
    ev("2026-08-01T20:00:06Z", mk(1700, 1600, 170)),
  ];
  writeRollout("rollout-2026-08-01T20-00-00-f1a0a000-0000-4000-8000-00000000001b.jsonl",
    [meta("2026-08-01T20:00:00Z", CG, { forked_from_id: PG }),
     ...nativeG.map((x) => tc(x.ts, x.s))]);
  const e = expectFrom("none", "verified", 0, 0, 1, [], nativeG);
  expectedPhase2[CG] = e;
  expectedPhase1[CG] = e;
}

// =====================================================================
// case9 嵌套 fork：parentI → childI → grandchildI（孙重放子的完整增长序列）
// =====================================================================
const PI = "f1a0a000-0000-4000-8000-00000000002a";
const CI = "f1a0a000-0000-4000-8000-00000000002b";
const GI = "f1a0a000-0000-4000-8000-00000000002c";
{
  const piEvents: Ev[] = [mk(1000, 900, 100), mk(1300, 1200, 130), mk(1600, 1500, 160), mk(1900, 1800, 190)]
    .map((s, idx) => ev(`2026-08-01T21:00:${String(idx * 4).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T21-00-00-f1a0a000-0000-4000-8000-00000000002a.jsonl",
    [meta("2026-08-01T21:00:00Z", PI), ...piEvents.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[PI] = plainExpect(piEvents);
  const replayI: Ev[] = piEvents.slice(0, 3).map((x, idx) => ev(`2026-08-01T21:01:${String(idx).padStart(2, "0")}.500Z`, x.s));
  const nativeI: Ev[] = [
    ev("2026-08-01T21:01:30Z", mk(3000, 2800, 300)),
    ev("2026-08-01T21:01:35Z", mk(3200, 3000, 320)),
  ];
  writeRollout("rollout-2026-08-01T21-01-00-f1a0a000-0000-4000-8000-00000000002b.jsonl",
    [meta("2026-08-01T21:01:00Z", CI, { forked_from_id: PI }),
     ...replayI.map((x) => tc(x.ts, x.s)), ...nativeI.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[CI] = expectFrom("parent_prefix", "verified", tot(replayI[2]!.s), 3, 1, replayI, nativeI);
  const giSeq: Ev[] = [...replayI, ...nativeI].map((x, idx) => ev(`2026-08-01T21:02:00.${String(idx * 100).padStart(3, "0")}Z`, x.s));
  const giNative: Ev[] = [ev("2026-08-01T21:02:30Z", mk(5000, 4800, 500))];
  writeRollout("rollout-2026-08-01T21-02-00-f1a0a000-0000-4000-8000-00000000002c.jsonl",
    [meta("2026-08-01T21:02:00Z", GI, { forked_from_id: CI }),
     ...giSeq.map((x) => tc(x.ts, x.s)), ...giNative.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[GI] = expectFrom("parent_prefix", "verified", tot(giSeq[giSeq.length - 1]!.s), giSeq.length, 1, giSeq, giNative);
}

// =====================================================================
// case11 计数器 reset（非 fork 双文件）：native_total = 跨 epoch 正增量之和
// =====================================================================
const RT = "f1a0a000-0000-4000-8000-00000000003a";
{
  const f1: Ev[] = [mk(10000, 9000, 1000), mk(50000, 47000, 3000)]
    .map((s, idx) => ev(`2026-08-01T08:00:${String(idx * 4).padStart(2, "0")}Z`, s));
  const f2raw: Ev[] = [mk(5000, 4500, 500), mk(30000, 28000, 2000)]
    .map((s, idx) => ev(`2026-08-01T09:00:${String(idx * 4).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T08-00-00-f1a0a000-0000-4000-8000-00000000003a.jsonl",
    [meta("2026-08-01T08:00:00Z", RT), ...f1.map((x) => tc(x.ts, x.s))]);
  writeRollout("rollout-2026-08-01T09-00-00-f1a0a000-0000-4000-8000-00000000003a.jsonl",
    [meta("2026-08-01T09:00:00Z", RT), ...f2raw.map((x) => tc(x.ts, x.s))]);
  const e = newExpect(null, null, null, 0, 0);
  let prev = [0, 0, 0, 0, 0, 0];
  [...f1, ...f2raw].forEach((x, idx) => {
    if (idx === f1.length) prev = [0, 0, 0, 0, 0, 0]; // 文件2 首快照 5500 < carried 53000 → epoch 重启
    bump(e, x.ts, tuple(x.s), prev, "raw-only");
    e.native_total += Math.max(0, tuple(x.s)[5] - prev[5]);
    e.daily[dayOf(x.ts)]!.samples += 1;
    prev = tuple(x.s);
  });
  expectedPhase2[RT] = e;
  expectedPhase1[RT] = e;
}

// =====================================================================
// 普通根线程 S（锚点）
// =====================================================================
const ST = "f1a0a000-0000-4000-8000-00000000004a";
{
  const events: Ev[] = [mk(100, 80, 10), mk(200, 170, 20)]
    .map((s, idx) => ev(`2026-08-01T07:00:${String(idx * 3).padStart(2, "0")}Z`, s));
  writeRollout("rollout-2026-08-01T07-00-00-f1a0a000-0000-4000-8000-00000000004a.jsonl",
    [meta("2026-08-01T07:00:00Z", ST), ...events.map((x) => tc(x.ts, x.s))]);
  expectedPhase2[ST] = plainExpect(events);
  expectedPhase1[ST] = expectedPhase2[ST]!;
}

// =====================================================================
// caseM（v1.2）：turn_context sandbox/approval + mcp_tool_call_end Ok/Err +
// custom_tool_call_output 内嵌 exit_code 启发式（失败/成功/不可解析三种）
// =====================================================================
const MID = "f1a0a000-0000-4000-8000-00000000005a";
{
  const mEvents: Ev[] = [
    mk(1200, 1000, 120),
    mk(2400, 2100, 240),
    mk(3600, 3200, 360),
  ].map((s, idx) => ev(`2026-08-01T22:00:${String(idx * 4).padStart(2, "0")}Z`, s));
  const turnCtx = J({ timestamp: "2026-08-01T22:00:00Z", type: "turn_context", payload: {
    cwd: "E:\\proj\\fixtures", model: "gpt-5.6-sol", effort: "high",
    approval_policy: "never", sandbox_policy: { type: "read-only" } } });
  const toolOutput = (ts: string, text: string): string =>
    J({ timestamp: ts, type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "call_m", output: [{ type: "input_text", text }] } });
  const mcpEnd = (ts: string, ok: boolean): string =>
    J({ timestamp: ts, type: "event_msg", payload: {
      type: "mcp_tool_call_end", call_id: "exec-m1",
      invocation: { server: "fs", tool: ok ? "list_dir" : "read_file", arguments: {} },
      duration: { secs: 1, nanos: 0 },
      result: ok ? { Ok: { content: [] } } : { Err: "permission denied" } } });
  const patchEnd = (ts: string, success: boolean | null, files: string[], stderr?: string): string => {
    const payload: Record<string, unknown> = {
      type: "patch_apply_end", call_id: "call_p1",
      changes: Object.fromEntries(files.map((f) => [f, { type: "add", content: "x" }])),
      stdout: "", stderr: stderr ?? "",
    };
    if (success !== null) payload["success"] = success;
    return J({ timestamp: ts, type: "event_msg", payload });
  };
  const lines = [
    meta("2026-08-01T22:00:00Z", MID),
    turnCtx,
    taskStart("2026-08-01T22:00:01Z", "turn-m1"),
    J({ timestamp: "2026-08-01T22:00:02Z", type: "response_item", payload: {
      type: "custom_tool_call", name: "exec", call_id: "call_m", input: "tools.exec_command({cmd:[\"node\",\"-e\",\"1\"]})" } }),
    toolOutput("2026-08-01T22:00:03Z", '{"chunk_id":"c1","wall_time_seconds":0.2,"exit_code":1,"output":"boom"}'), // 失败（可配对 call_m）
    toolOutput("2026-08-01T22:00:04Z", '{"chunk_id":"c2","wall_time_seconds":0.1,"exit_code":0,"output":"ok"}'),   // 成功
    toolOutput("2026-08-01T22:00:05Z", "Script completed\nOutput:\n(no embedded json)"),                              // 不可解析 → 不计
    mcpEnd("2026-08-01T22:00:06Z", true),
    mcpEnd("2026-08-01T22:00:07Z", false),
    patchEnd("2026-08-01T22:00:08Z", true, ["docs/a.md", "src/b.ts"]),                       // patch 成功 → patches+1、patch_files
    patchEnd("2026-08-01T22:00:09Z", false, ["bad.txt"], "patch failed: no such file: bad.txt"), // patch 失败 → tool_failures(patch_fail)
    patchEnd("2026-08-01T22:00:10Z", null, ["ghost.txt"]),                                   // success 缺失 → fail-closed 不计
    ...mEvents.map((x) => tc(x.ts, x.s)),
    taskComplete("2026-08-01T22:00:12Z", "turn-m1"),
  ];
  writeRollout("rollout-2026-08-01T22-00-00-f1a0a000-0000-4000-8000-00000000005a.jsonl", lines);
  expectedPhase2[MID] = plainExpect(mEvents);
}

// —— phase1 期望：fork-home 无 parentX（PX 无线程行），其余与 phase2 相同 ——
for (const [tid, e] of Object.entries(expectedPhase2)) {
  if (tid !== PX && !(tid in expectedPhase1)) expectedPhase1[tid] = e;
}

// —— sidecar ——
fs.writeFileSync(
  path.join(HOME, "expected.json"),
  JSON.stringify({
    late_parent_file: "rollout-2026-08-01T16-00-00-f1a0a000-0000-4000-8000-00000000000x.jsonl",
    phase1: expectedPhase1,
    phase2: expectedPhase2,
    // v1.2 契约列期望（caseM 线程）：sandbox/approval 与 MCP/shell 失败计数
    v12: {
      thread: "f1a0a000-0000-4000-8000-00000000005a",
      sandbox_policy: { type: "read-only" }, // NORM_COLS parse 后比较
      approval_mode: "never",
      mcp_calls: 2, mcp_failures: 1, shell_failures: 1,
      turn: { mcp_calls: 2, mcp_failures: 1, shell_failures: 1, patches: 1 },
      // 事件级失败明细（tool_failures 表，seq 按事件顺序）
      failures: [
        { seq: 0, kind: "shell_exit", exit_code: 1, turn_index: 0,
          command: "tools.exec_command({cmd:[\"node\",\"-e\",\"1\"]})",
          detail: '{"chunk_id":"c1","wall_time_seconds":0.2,"exit_code":1,"output":"boom"}' },
        { seq: 1, kind: "mcp_err", exit_code: null, turn_index: 0,
          server: "fs", tool: "read_file", command: null, detail: "permission denied" },
        { seq: 2, kind: "patch_fail", exit_code: null, turn_index: 0,
          server: null, tool: null, command: "bad.txt", detail: "patch failed: no such file: bad.txt" },
      ],
    },
  }, null, 2),
  "utf8",
);
const n1 = Object.keys(expectedPhase1).length;
const n2 = Object.keys(expectedPhase2).length;
console.log(`[gen-fork-fixtures] fork-home threads(phase2)=${n2} phase1=${n1}; stash=parentX；expected.json 已写出`);

// 探针：用 turns 表按完成日归集，计算每日实际消耗（root/sub/按模型），对齐 Codex 官方日用量口径
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/ts/collector.sqlite", { readOnly: true });
const localDate = (ms: number | null | undefined): string | null => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const threads = new Map();
for (const r of db.prepare(`SELECT t.thread_id tid, t.thread_type ty, t.root_thread_id root, t.model m,
  t.inherited_baseline base, d.final_total ft, d.last_event_ms lem, d.usage_bearing_samples us, d.wait_status_model_calls w
  FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id`).all()) {
  threads.set(r.tid, r);
}

type Day = { root: number; sub: number; byModel: Map<string, number>; samples: number; wait: number };
const days = new Map<string, Day>();
const dayOf = (d: string) => {
  let e = days.get(d);
  if (!e) { e = { root: 0, sub: 0, byModel: new Map(), samples: 0, wait: 0 }; days.set(d, e); }
  return e;
};

const turnSum = new Map<string, number>();
for (const t of db.prepare(`SELECT thread_id tid, turn_index, status, completed_ms, started_ms,
  total_tokens, usage_start_json, usage_end_json, usage_bearing_samples us, wait_status_model_calls w
  FROM turns ORDER BY thread_id, turn_index`).all()) {
  const th = threads.get(t.tid);
  if (!th) continue;
  let tot = t.total_tokens || 0;
  if (t.status === "active" && t.usage_start_json) {
    try {
      const s = JSON.parse(t.usage_start_json);
      const e = JSON.parse(t.usage_end_json || "{}");
      const g = (x: any, k: string) => Math.max(0, Number(x?.[k] ?? 0) || 0);
      tot = g(e, "total_tokens") - g(s, "total_tokens");
    } catch { /* ignore */ }
  }
  if (!tot && !t.us) continue;
  const day = localDate(t.completed_ms ?? t.started_ms);
  if (!day) continue;
  const d = dayOf(day);
  const isSub = th.ty === "subagent";
  if (isSub) d.sub += tot; else d.root += tot;
  const model = String(th.m || "-");
  d.byModel.set(model, (d.byModel.get(model) || 0) + tot);
  d.samples += t.us || 0;
  d.wait += t.w || 0;
  turnSum.set(t.tid, (turnSum.get(t.tid) || 0) + tot);
}

// 余量（thread 累计 − turns 之和）归到 last_event 日，保证 Σ天 == Σ线程 exclusive
let remainderTotal = 0;
for (const [tid, th] of threads) {
  const excl = Math.max(0, (th.ft || 0) - (th.base || 0));
  const rem = excl - (turnSum.get(tid) || 0);
  if (Math.abs(rem) <= 0) continue;
  remainderTotal += rem;
  const day = localDate(th.lem);
  if (!day) continue;
  const d = dayOf(day);
  if (th.ty === "subagent") d.sub += rem; else d.root += rem;
}

const want = process.argv.slice(2);
console.log("日期         root         sub          合计         采样   余量Σ=" + remainderTotal);
for (const [day, d] of [...days.entries()].sort().slice(-8)) {
  if (want.length && !want.includes(day)) continue;
  console.log(
    `${day}  ${String(d.root).padStart(12)} ${String(d.sub).padStart(12)} ${String(d.root + d.sub).padStart(12)} ${String(d.samples).padStart(6)}`,
  );
  if (want.includes(day)) {
    for (const [m, v] of [...d.byModel.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${m}: ${v.toLocaleString("en-US")}`);
    }
  }
}
db.close();

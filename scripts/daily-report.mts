// daily_usage 验证：按日消耗（v1.1：毛差分 − replay = native）+ 与 token-monitor / 官方面板对照
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/ts/collector.sqlite", { readOnly: true });
const rows = db.prepare(`SELECT du.day, th.thread_type ty, th.model m, th.root_thread_id root,
  SUM(du.tokens - COALESCE(du.replay_total_tokens,0)) t,
  SUM(du.input_tokens - COALESCE(du.replay_input_tokens,0) - (du.cached_input_tokens - COALESCE(du.replay_cached_tokens,0))) unc,
  SUM(du.output_tokens - COALESCE(du.replay_output_tokens,0)) o,
  SUM(du.samples) s, SUM(du.wait) w
  FROM daily_usage du JOIN threads th ON th.thread_id = du.thread_id
  GROUP BY du.day, ty, m, root, th.thread_id`).all();

type Day = { root: number; sub: number; byModel: Map<string, number>; unc: number; out: number; samples: number; wait: number };
const days = new Map<string, Day>();
const perTaskDay = new Map<string, Map<string, number>>(); // root -> day -> tokens(域)
for (const r of rows) {
  const d = days.get(r.day) ?? { root: 0, sub: 0, byModel: new Map(), unc: 0, out: 0, samples: 0, wait: 0 };
  days.set(r.day, d);
  const t = r.t || 0;
  if (r.ty === "subagent") d.sub += t; else d.root += t;
  const model = String(r.m || "-");
  d.byModel.set(model, (d.byModel.get(model) || 0) + t);
  d.unc += r.unc || 0;
  d.out += r.o || 0;
  d.samples += r.s || 0;
  d.wait += r.w || 0;
  const root = String(r.ty === "subagent" ? r.root : r.root ?? "");
  // 注意 root 列：root 线程自身 root_thread_id 为 NULL，用 thread_id 兜底——上面 SQL 未选 th.thread_id，改由 root/ty 组合
}
// 每任务每日（含子代理域，native 口径）：单独查
const taskRows = db.prepare(`SELECT CASE WHEN th.thread_type='subagent' THEN th.root_thread_id ELSE th.thread_id END task,
  du.day, SUM(du.tokens - COALESCE(du.replay_total_tokens,0)) t
  FROM daily_usage du JOIN threads th ON th.thread_id = du.thread_id
  GROUP BY task, du.day`).all();
for (const r of taskRows) {
  const m = perTaskDay.get(r.task) ?? new Map();
  m.set(r.day, (m.get(r.day) || 0) + (r.t || 0));
  perTaskDay.set(r.task, m);
}

console.log("日期        root        sub         合计        未命中    输出    采样   | token-monitor");
const hubRef: Record<string, string> = { "2026-08-17": "791,525", "2026-08-19": "31,206,419", "2026-08-20": "1,352,112", "2026-08-21": "39,076,396（官方 41,854,000；本地 native 已逐位对齐 39,076,396，~2.78M 记 unresolved reconciliation gap）" };
for (const [day, d] of [...days.entries()].sort().slice(-6)) {
  console.log(
    `${day}  ${String(d.root.toLocaleString("en-US")).padStart(11)} ${String(d.sub.toLocaleString("en-US")).padStart(11)} ${String((d.root + d.sub).toLocaleString("en-US")).padStart(11)} ${String(d.unc.toLocaleString("en-US")).padStart(9)} ${String(d.out.toLocaleString("en-US")).padStart(7)} ${String(d.samples).padStart(5)}  | ${hubRef[day] ?? ""}`,
  );
}
for (const day of ["2026-08-19", "2026-08-21"]) {
  const d = days.get(day);
  if (!d) continue;
  console.log(`\n${day} 按模型:`);
  for (const [m, v] of [...d.byModel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${m}: ${v.toLocaleString("en-US")}`);
  }
  console.log(`${day} 当日任务域分解:`);
  for (const [task, m] of perTaskDay) {
    const t = m.get(day) || 0;
    if (t > 100000) console.log(`  ${task.slice(0, 8)}: ${t.toLocaleString("en-US")}`);
  }
}
db.close();

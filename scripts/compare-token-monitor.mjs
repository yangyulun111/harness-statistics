// token-monitor hub (:17321) ↔ TS ledger 逐会话对比
import { DatabaseSync } from "node:sqlite";

const hub = await (await fetch("http://127.0.0.1:17321/api/stats")).json();
const db = new DatabaseSync("data/ts/collector.sqlite", { readOnly: true });

// thread_id -> {final_total, baseline, type, root}
const th = new Map();
for (const r of db.prepare(`SELECT t.thread_id tid, t.thread_type ty, t.root_thread_id root,
  t.inherited_baseline base, d.final_total ft
  FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id`).all()) {
  th.set(r.tid, r);
}
const subTokens = new Map(); // root -> Σ sub excl
for (const r of th.values()) {
  if (r.ty === "subagent" && r.root) {
    const excl = Math.max(0, (r.ft || 0) - (r.base || 0));
    subTokens.set(r.root, (subTokens.get(r.root) || 0) + excl);
  }
}

const sessions = hub.periods?.today?.sessions ?? {};
const rows = [];
for (const [key, s] of Object.entries(sessions)) {
  if (s.client !== "codex") continue;
  const uuid = (s.sessionId || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)?.[1];
  const t = uuid ? th.get(uuid) : null;
  if (!t) {
    rows.push({ name: s.sessionId.slice(-20), hub: s.totalTokens, root: null, task: null, note: "ledger 无此线程" });
    continue;
  }
  const rootExcl = Math.max(0, (t.ft || 0) - (t.base || 0));
  const taskTotal = rootExcl + (subTokens.get(uuid) || 0);
  rows.push({ name: uuid.slice(0, 8), hub: s.totalTokens, root: rootExcl, task: taskTotal,
    note: subTokens.get(uuid) ? `子代理 +${subTokens.get(uuid).toLocaleString("en-US")}` : "" });
}

console.log("token-monitor 今日 codex 会话 vs TS ledger（root exclusive / 任务域）\n");
let hubSum = 0;
for (const r of rows) {
  hubSum += r.hub;
  const d1 = r.root != null ? ((r.hub - r.root) / r.root * 100).toFixed(1) + "%" : "–";
  const d2 = r.task != null ? ((r.hub - r.task) / r.task * 100).toFixed(1) + "%" : "–";
  console.log(
    `  ${r.name}  hub=${r.hub.toLocaleString("en-US").padStart(14)}  root=${(r.root ?? 0).toLocaleString("en-US").padStart(14)} (${d1})  任务域=${(r.task ?? 0).toLocaleString("en-US").padStart(14)} (${d2})  ${r.note}`,
  );
}
console.log(`\n  hub 今日 codex 合计=${hubSum.toLocaleString("en-US")}（口径=当日事件增量）`);

// 全库总量对照（agent 采集以来的 codex 累计 vs ledger root-only / 任务域）
let rootAll = 0, taskAll = 0;
for (const [tid, t] of th) {
  if (t.ty !== "root") continue;
  const excl = Math.max(0, (t.ft || 0) - (t.base || 0));
  rootAll += excl;
  taskAll += excl + (subTokens.get(tid) || 0);
}
const hist = await (await fetch("http://127.0.0.1:17321/api/history")).json().catch(() => null);
console.log(`  ledger 全库 root-only=${rootAll.toLocaleString("en-US")}  任务域=${taskAll.toLocaleString("en-US")}`);
if (hist) console.log(`  hub /api/history keys=${JSON.stringify(Object.keys(hist)).slice(0, 200)}`);
db.close();

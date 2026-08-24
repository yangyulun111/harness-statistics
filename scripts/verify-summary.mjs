const r = await fetch("http://127.0.0.1:8766/api/summary");
const j = await r.json();
console.log("日期:", j.date);
console.log("今日消耗 consumption.total =", (j.consumption?.total ?? 0).toLocaleString("en-US"),
  "= root", (j.consumption?.root ?? 0).toLocaleString("en-US"), "+ sub", (j.consumption?.sub ?? 0).toLocaleString("en-US"));
console.log("对照 totals.total(任务域累计) =", j.totals.total.toLocaleString("en-US"));
console.log("\n今日任务（标题 | 今日消耗 | 任务域累计）:");
for (const t of j.tasks) {
  console.log("  ·", t.name, "|", (t.day_tokens ?? 0).toLocaleString("en-US"), "|", t.total_tokens.toLocaleString("en-US"));
}

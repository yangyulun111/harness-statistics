// 诊断：state_5.sqlite 中的标题字段实况（title/name/preview/first_user_message）
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const db = new DatabaseSync(path.join(os.homedir(), ".codex", "state_5.sqlite"), { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("tables:", tables.map((t) => t.name).join(", "));

const cols = db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name);
console.log("\nthreads cols:", cols.join(", "));

const rows = db.prepare(`SELECT id, title, name, preview,
  substr(first_user_message, 1, 50) AS fum, thread_source, updated_at_ms
  FROM threads ORDER BY updated_at_ms DESC LIMIT 12`).all();
for (const r of rows) {
  console.log(`\n[${String(r.id).slice(0, 8)}] ${r.thread_source}`);
  console.log(`  title : ${JSON.stringify(r.title)}`);
  console.log(`  name  : ${JSON.stringify(r.name)}`);
  console.log(`  preview: ${JSON.stringify(r.preview)}`);
  console.log(`  fum   : ${JSON.stringify(r.fum)}`);
}

const stats = db.prepare(`SELECT
  COUNT(*) AS total,
  SUM(title IS NULL) AS no_title,
  SUM(name IS NOT NULL) AS has_name,
  SUM(title IS NOT NULL AND first_user_message IS NOT NULL
      AND title != first_user_message AND title != substr(first_user_message,1,length(title))) AS title_differs
  FROM threads`).get();
console.log("\nstats:", JSON.stringify(stats));

// 是否有任何 title 与首消息明显不同（即“云端摘要标题”同步到本地的证据）
const diffRows = db.prepare(`SELECT id, title, substr(first_user_message,1,40) fum FROM threads
  WHERE title IS NOT NULL AND first_user_message IS NOT NULL
    AND title != first_user_message AND title != substr(first_user_message,1,length(title))
  LIMIT 8`).all();
console.log("\ntitle != 首消息 的线程:");
for (const r of diffRows) console.log(`  [${String(r.id).slice(0, 8)}] title=${JSON.stringify(r.title)} fum=${JSON.stringify(r.fum)}`);
db.close();

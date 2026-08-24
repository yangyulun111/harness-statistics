/**
 * wait/status Token 归集 + 时变价格目录成本层的单元测试（内存库，零 fixture、零 schema 依赖）。
 * 覆盖：wait_tokens_est 公式（任务域 root+子代理）、取价时点窗口（含促销边界）、
 * 前缀匹配、目录缺失/未配置 fail-closed、部分计价下界语义。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "@hs/shared";
import { taskRows, taskDetail, daySummary } from "@hs/ledger-core";
import { parseCatalog, resolvePrice, costAggregate, type PriceCatalog } from "@hs/ledger-core";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function seed(db: DatabaseSync): void {
  const t0 = Date.UTC(2026, 7, 14, 10, 0, 0); // 促销边界（08-15）之前
  const t1 = Date.UTC(2026, 7, 16, 10, 0, 0); // 促销期（半价）之内
  db.prepare(`INSERT INTO threads(thread_id, thread_type, model, cwd, created_ms, updated_ms, last_event_ms)
              VALUES('r1','root','gpt-5.6-sol','C:/p/x',@t0,@t1,@t1)`).run({ t0, t1 });
  db.prepare(`INSERT INTO threads(thread_id, root_thread_id, thread_type, model, cwd, created_ms, updated_ms, last_event_ms)
              VALUES('s1','r1','subagent','gpt-5.5','C:/p/x',@t0,@t1,@t1)`).run({ t0, t1 });
  const diag = db.prepare(`INSERT INTO threads_diag(thread_id, final_input, final_cached, final_cache_write,
                           final_output, final_reasoning, final_total, native_total, first_event_ms, last_event_ms,
                           schema_compat, usage_bearing_samples, wait_status_model_calls)
                           VALUES(?,?,?,?,?,?,?,?,?,?,'ok',?,?)`);
  diag.run("r1", 1000, 400, 0, 200, 50, 1600, 1600, t0, t1, 10, 4);
  diag.run("s1", 500, 0, 0, 100, 0, 600, 600, t0, t1, 5, 5);
  const turn = db.prepare(`INSERT INTO turns(thread_id, turn_index, started_ms, completed_ms, duration_ms,
                          input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, total_tokens,
                          usage_bearing_samples, wait_status_model_calls, status)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // r1：turn0 采样 10 / wait 4（ratio 0.4）→ total 1000×0.4=400；turn1 无 wait → 0
  turn.run("r1", 0, t0, t0 + 60_000, 60_000, 500, 200, 0, 100, 1000, 10, 4, "completed");
  turn.run("r1", 1, t1, t1 + 60_000, 60_000, 500, 200, 0, 100, 600, 8, 0, "completed");
  // s1：turn0 采样 5 / wait 5（ratio 1.0）→ total 600 全记 wait
  turn.run("s1", 0, t1, t1 + 30_000, 30_000, 500, 0, 0, 100, 600, 5, 5, "completed");
}

const CATALOG_JSON = {
  version: 1,
  entries: [
    { model: "gpt-5.6-sol", effective_from: "2026-07-01", effective_to: "2026-08-15",
      currency: "USD", input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 20, source: "标准价" },
    { model: "gpt-5.6-sol", effective_from: "2026-08-15", effective_to: null,
      currency: "USD", input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 10, promo: true, source: "促销半价" },
    { model: "gpt-5.6-terra", effective_from: "2026-07-01", effective_to: null,
      currency: "USD", input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 10, source: "标准价" },
  ],
};

const cat: PriceCatalog = parseCatalog(CATALOG_JSON, "(test)");

test("取价：时点窗口 + 促销边界 + 前缀匹配 + fail-closed", () => {
  const before = Date.UTC(2026, 7, 14);
  const after = Date.UTC(2026, 7, 16);
  assert.equal(resolvePrice(cat, "gpt-5.6-sol", before)!.input_per_mtok, 2);   // 边界前 → 标准价
  assert.equal(resolvePrice(cat, "gpt-5.6-sol", after)!.input_per_mtok, 1);    // 促销期 → 半价
  assert.equal(resolvePrice(cat, "gpt-5.6-sol", Date.UTC(2026, 5, 15)), null); // 早于全部条目
  assert.equal(resolvePrice(cat, "gpt-5.6-sol-2026-08-20", after)!.promo, true); // 最长前缀
  assert.equal(resolvePrice(cat, "gpt-9", after), null);                        // 未配置
  // 目录为空 → 聚合返回 null（fail-closed）
  assert.equal(costAggregate(null, [{ model: "gpt-5.6-sol", ts_ms: after, input: 1, cached: 0, cache_write: 0, output: 0 }]), null);
});

test("成本：部分模型未配置 → 下界并列出缺失", () => {
  const r = costAggregate(cat, [
    { model: "gpt-5.6-sol", ts_ms: Date.UTC(2026, 7, 16), input: 1_000_000, cached: 0, cache_write: 0, output: 0 }, // $1
    { model: "no-price-model", ts_ms: Date.UTC(2026, 7, 16), input: 5_000_000, cached: 0, cache_write: 0, output: 0 },
  ])!;
  assert.equal(r.total, 1);
  assert.deepEqual(r.missing_models, ["no-price-model"]);
});

test("wait_tokens_est：任务域归集（root 比例 + 子代理全量）", () => {
  const db = makeDb();
  seed(db);
  const rows = taskRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.wait_tokens_est, 400 + 600); // r1 turn0 400 + s1 600
  const det = taskDetail(db, "r1") as Record<string, any>;
  assert.equal(det.orchestration.wait_tokens_est, 1000);
  assert.equal(det.orchestration.wait_tokens_split.input, Math.round(500 * 0.4) + 500); // 200 + 500
  assert.equal(det.orchestration.wait_cost_est, null); // 未传目录 → null
  assert.equal(det.cost_est, null);
});

test("成本按时点价：跨促销边界分段计价（任务域轮级）", () => {
  const db = makeDb();
  seed(db);
  const det = taskDetail(db, "r1", cat) as Record<string, any>;
  // turn0（标准价）：in 500×2 + cached 200×0.2 + out 100×20 = 3040 → $0.00304
  // turn1（半价）：  in 500×1 + cached 200×0.1 + out 100×10 = 1540 → $0.00154
  // s1（gpt-5.5 未配置）→ missing
  assert.ok(Math.abs(det.cost_est.total - 0.0046) < 1e-9);
  assert.deepEqual(det.cost_est.missing_models, ["gpt-5.5"]);
  // wait 成本：turn0 wait 比例 0.4（标准价段）+ s1 全 wait（未配置不计）
  assert.ok(Math.abs(det.orchestration.wait_cost_est - 0.0012) < 1e-9);
});

test("daySummary：当日 wait Token 与成本（按完成时点归日）", () => {
  const db = makeDb();
  seed(db);
  const s = daySummary(db, "2026-08-16", cat) as Record<string, any>;
  assert.equal(s.consumption.wait_tokens_est, 600); // r1 turn1 无 wait + s1 600
  assert.ok(Math.abs(s.consumption.cost_est.total - 0.0015) < 1e-9); // 仅 r1 turn1（s1 未配价）
});

/**
 * 契约 v1.1 校准报告（对 data/ts/collector.sqlite 只读）：
 *   1. G0-B v2 —— fork 归因覆盖表（method × status）+ verified 的 digest 非空检查
 *   2. 不变量 —— 每线程 Σ daily native == native_total；Σ daily replay == threads_diag replay（组件级）
 *   3. 8/21 取证对照 —— fork 01a023e9 的 baseline/method/replay/native 与实测期望
 *   4. G0-A 复跑 —— final_total（raw 观测累计）vs state DB tokens_used
 * 用法：node scripts/fork-verify.mts
 */
import { DatabaseSync } from "node:sqlite";

const DB = "data/ts/collector.sqlite";

function main(): void {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    console.log("== 1. G0-B v2：fork 归因覆盖表 ==");
    const cov = db.prepare(
      `SELECT COALESCE(t.baseline_method,'(未分类)') m, COALESCE(t.verification_status,'(未判定)') s,
              COUNT(*) n, COALESCE(SUM(d.replay_total_tokens),0) replay
       FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id
       WHERE t.forked_from_id IS NOT NULL GROUP BY m, s ORDER BY n DESC`,
    ).all() as Record<string, unknown>[];
    for (const r of cov) {
      console.log(`  ${String(r["m"]).padEnd(14)} ${String(r["s"]).padEnd(15)} n=${r["n"]}  replay=${Number(r["replay"]).toLocaleString("en-US")}`);
    }
    const noDigest = (db.prepare(
      `SELECT COUNT(*) c FROM threads t JOIN threads_diag d ON d.thread_id=t.thread_id
       WHERE t.forked_from_id IS NOT NULL AND t.verification_status='verified'
         AND COALESCE(d.baseline_prefix_events,0) > 0 AND d.baseline_parent_digest IS NULL`,
    ).get() as Record<string, unknown>)["c"];
    console.log(`  verified 且有前缀但缺 digest 的 fork：${noDigest}（期望 0；method=none 无前缀、无 digest 属正确行为）`);

    console.log("== 2. 不变量 ==");
    const daily = db.prepare(
      `SELECT thread_id, SUM(tokens - replay_total_tokens) nt, SUM(replay_input_tokens) ri,
              SUM(replay_cached_tokens) rc, SUM(replay_output_tokens) ro,
              SUM(replay_total_tokens) rr, SUM(replay_events) rev
       FROM daily_usage GROUP BY thread_id`,
    ).all() as Record<string, unknown>[];
    const byT = new Map(daily.map((r) => [String(r["thread_id"]), r]));
    let badNative = 0, badReplay = 0, checked = 0;
    for (const d of db.prepare(
      "SELECT thread_id, native_total, replay_input_tokens ri, replay_cached_tokens rc, replay_output_tokens ro, replay_total_tokens rr, replay_events rev FROM threads_diag",
    ).all() as Record<string, unknown>[]) {
      const x = byT.get(String(d["thread_id"]));
      if (!x) continue;
      checked++;
      if (Number(x["nt"]) !== Number(d["native_total"])) {
        if (badNative < 5) console.log(`  ✗ native 不变量 ${String(d["thread_id"]).slice(0, 8)}: Σdaily=${x["nt"]} native_total=${d["native_total"]}`);
        badNative++;
      }
      const cmp = (a: unknown, b: unknown): boolean => Number(a) === Number(b);
      if (!cmp(x["ri"], d["ri"]) || !cmp(x["rc"], d["rc"]) || !cmp(x["ro"], d["ro"]) || !cmp(x["rr"], d["rr"]) || !cmp(x["rev"], d["rev"])) {
        if (badReplay < 5) console.log(`  ✗ replay 组件不变量 ${String(d["thread_id"]).slice(0, 8)}`);
        badReplay++;
      }
    }
    console.log(`  检查 ${checked} 线程：native 不变量违例 ${badNative}，replay 组件违例 ${badReplay}（期望均 0）`);

    console.log("== 3. 8/21 取证对照 ==");
    const child = db.prepare(
      `SELECT t.thread_id, t.inherited_baseline, t.baseline_method, t.verification_status,
              d.replay_total_tokens, d.native_total, d.final_total, d.replay_events
       FROM threads t JOIN threads_diag d ON d.thread_id=t.thread_id
       WHERE t.thread_id LIKE '01a023e9%'`,
    ).get() as Record<string, unknown> | undefined;
    if (child) {
      console.log(`  fork 01a023e9：method=${child["baseline_method"]} status=${child["verification_status"]}`);
      console.log(`    baseline=${Number(child["inherited_baseline"]).toLocaleString("en-US")}（期望 37,901,458）`);
      console.log(`    replay_total=${Number(child["replay_total_tokens"]).toLocaleString("en-US")}（期望 37,901,458）`);
      console.log(`    native_total=${Number(child["native_total"]).toLocaleString("en-US")}（期望 1,076,756）`);
      console.log(`    raw final_total=${Number(child["final_total"]).toLocaleString("en-US")}（期望 38,978,214 == replay+native）`);
    } else {
      console.log("  （未找到 01a023e9 —— 可能 rebuild 窗口不同）");
    }
    const day = db.prepare(
      `SELECT COALESCE(SUM(tokens - replay_total_tokens),0) native, COALESCE(SUM(tokens),0) raw,
              COALESCE(SUM(replay_total_tokens),0) replay
       FROM daily_usage WHERE day='2026-08-21'`,
    ).get() as Record<string, unknown>;
    console.log(`  8/21 全天：native=${Number(day["native"]).toLocaleString("en-US")}  raw=${Number(day["raw"]).toLocaleString("en-US")}  replay=${Number(day["replay"]).toLocaleString("en-US")}`);
    console.log("  参考：token-monitor 39,076,396 / 官方面板 41,854,000（~2.7M 记 unresolved reconciliation gap）");

    console.log("== 4. G0-A 复跑（final_total vs state tokens_used）==");
    const stateDb = String((db.prepare("SELECT value FROM meta WHERE key='state_db'").get() as Record<string, unknown>)["value"] ?? "");
    let equal = 0, close = 0, miss = 0;
    const diffs: string[] = [];
    if (stateDb) {
      const sdb = new DatabaseSync(stateDb, { readOnly: true });
      try {
        const state = new Map<string, number>(
          (sdb.prepare("SELECT id, tokens_used FROM threads WHERE tokens_used IS NOT NULL").all() as Record<string, unknown>[]).map(
            (r) => [String(r["id"]), Number(r["tokens_used"])],
          ),
        );
        for (const r of db.prepare(
          "SELECT t.thread_id, d.final_total FROM threads t JOIN threads_diag d ON d.thread_id=t.thread_id",
        ).all() as Record<string, unknown>[]) {
          const su = state.get(String(r["thread_id"]));
          if (su === undefined) continue;
          const ft = Number(r["final_total"]);
          if (su === ft) equal++;
          else if (Math.abs(su - ft) <= Math.max(1000, su * 0.01)) close++;
          else {
            miss++;
            if (diffs.length < 8) diffs.push(`    ${String(r["thread_id"]).slice(0, 8)}: ledger=${ft.toLocaleString("en-US")} state=${su.toLocaleString("en-US")} Δ=${(ft - su).toLocaleString("en-US")}`);
          }
        }
      } finally {
        sdb.close();
      }
    }
    console.log(`  完全相等 ${equal} / 容差内 ${close} / 超容差 ${miss}`);
    for (const d of diffs) console.log(d);
    console.log("  注：epoch 重启线程的 final_total 现为末 epoch 值（native_total 才是 canonical），少量超容差属预期——逐条人工核后再定论");
  } finally {
    db.close();
  }
}

main();

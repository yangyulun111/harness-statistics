/**
 * G0-A 对账 —— rollout 累计（threads_diag.final_total）↔ state DB tokens_used。
 * 通过标准：逐线程一致（或差异可解释）。
 */
import { DatabaseSync } from "node:sqlite";
import { openRo, cleanTitle } from "./queries.ts";

type Row = Record<string, any>;

export interface ReconcileReport {
  threads: number;
  matched: number;
  mismatched: number;
  sum_state: number;
  sum_ledger: number;
  ratio: number;
  diffs: Array<{ thread_id: string; name: string; state: number; ledger: number; diff: number }>;
}

export function reconcile(dbPath?: string): ReconcileReport {
  const conn: DatabaseSync = openRo(dbPath);
  try {
    const rows = conn.prepare(`SELECT t.thread_id, t.tokens_used_state, d.final_total,
                                      t.thread_type, t.name, t.agent_nickname
                               FROM threads t JOIN threads_diag d ON d.thread_id = t.thread_id
                               WHERE t.tokens_used_state IS NOT NULL`).all() as Row[];
    let matched = 0;
    let sumState = 0;
    let sumLedger = 0;
    const diffs: ReconcileReport["diffs"] = [];
    for (const r of rows) {
      const st = Number(r["tokens_used_state"]);
      const lg = Number(r["final_total"] ?? 0);
      sumState += st;
      sumLedger += lg;
      if (st === lg) matched += 1;
      else if (diffs.length < 200) {
        diffs.push({
          thread_id: r["thread_id"],
          name: r["thread_type"] === "subagent"
            ? `${r["agent_nickname"] ?? "subagent"}（子代理）`
            : cleanTitle(String(r["name"] ?? "")),
          state: st,
          ledger: lg,
          diff: lg - st,
        });
      }
    }
    return {
      threads: rows.length,
      matched,
      mismatched: rows.length - matched,
      sum_state: sumState,
      sum_ledger: sumLedger,
      ratio: sumState > 0 ? sumLedger / sumState : 1,
      diffs,
    };
  } finally {
    conn.close();
  }
}

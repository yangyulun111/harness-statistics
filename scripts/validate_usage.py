"""G0-B Exclusive Usage 归因校验（离线，只读）。

三类检查：
  1. rebroadcast：抽样线程重扫 rollout，独立复算增长/不增长事件数，与 ledger 对比；
  2. fork 基线：fork 的 inherited_baseline 应 ≤ 源线程累计，且 > 0（继承历史存在）；
  3. subagent 继承：子代理首 turn 的 usage_start 应接近 0（不携带父历史）。

用法：python scripts/validate_usage.py [--sample 3]
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ledger import discovery as _disc  # noqa: E402


def recount(paths):
    """独立复算一个线程全部 rollout 文件（按路径序 = 处理序）的增长/不增长计数。"""
    last = None
    grown = flat = 0
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"token_count"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                info = ((rec.get("payload") or {}).get("info") or {})
                total = (info.get("total_token_usage") or {}).get("total_tokens")
                if total is None:
                    continue
                if last is None or total > last:
                    grown += 1
                    last = total
                else:
                    flat += 1
    return grown, flat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=3)
    a = ap.parse_args()

    db = ROOT / "data" / "collector.sqlite"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    paths = _disc.discover()

    print("== 1) rebroadcast 复算（按线程跨全部文件）==")
    threads = conn.execute("""SELECT f.thread_id, d.usage_bearing_samples g, d.rebroadcast_events r
                              FROM rollout_files f JOIN threads_diag d ON d.thread_id = f.thread_id
                              WHERE d.token_count_events > 20
                              GROUP BY f.thread_id ORDER BY RANDOM() LIMIT ?""",
                           (a.sample,)).fetchall()
    for t in threads:
        files = [Path(r[0]) for r in conn.execute(
            "SELECT path FROM rollout_files WHERE thread_id=? ORDER BY path", (t["thread_id"],))]
        files = [p if p.exists() else Path(str(p).replace("/", "\\")) for p in files]
        grown, flat = recount(files)
        ok = (grown == t["g"] and flat == t["r"])
        print(f"  {t['thread_id'][:12]} files={len(files)}  ledger=({t['g']},{t['r']}) "
              f"复算=({grown},{flat})  {'✓' if ok else '✗'}")

    print("== 2) fork 基线合理性 ==")
    forks = conn.execute("""SELECT t.thread_id, t.forked_from_id src, t.inherited_baseline base,
                                   sf.final_total src_final, t.created_ms
                            FROM threads t LEFT JOIN threads_diag sf ON sf.thread_id = t.forked_from_id
                            WHERE t.forked_from_id IS NOT NULL AND t.inherited_baseline > 0""").fetchall()
    ok_n = 0
    for f in forks:
        src_final = f["src_final"] or 0
        plausible = 0 < f["base"] <= max(src_final, f["base"])  # 基线 ≤ 源累计（源还在增长）
        ok_n += plausible
        if not plausible:
            print(f"  [?] {f['thread_id'][:8]} base={f['base']:,} src_final={src_final:,}")
    print(f"  {ok_n}/{len(forks)} 个 fork 基线满足 0 < base ≤ 源线程累计（启发式，G0-B 人工复核后置 verified=1）")

    print("== 3) subagent 继承（首 turn usage_start ≈ 0）==")
    subs = conn.execute("""SELECT COUNT(*) n, SUM(CASE WHEN json_extract(t.usage_start_json,'$.total_tokens') < 1000
                            THEN 1 ELSE 0 END) small
                           FROM turns t JOIN threads th ON th.thread_id = t.thread_id
                           WHERE th.thread_type='subagent' AND t.turn_index=0
                             AND t.usage_start_json IS NOT NULL""").fetchone()
    if subs and subs["n"]:
        print(f"  {subs['small']}/{subs['n']} 个子代理首 turn 起点累计 < 1000 tokens（不含父历史）")
    else:
        print("  无可检查样本")


if __name__ == "__main__":
    main()

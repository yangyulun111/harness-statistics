"""Golden harness（Python 侧）：把 collector.sqlite 规范化 dump 成 JSON（stdout）。
与 TS 侧 scripts/golden.ts 的 dumpGolden 逐列同构：
  - *_json / patch_files / file_usage_epochs / threads.source → parse 成对象再比
  - rollout_files 只取确定性列（排除 wall-clock 列）
  - meta 表整体排除（含绝对路径与时间戳）
"""
import json
import sqlite3
import sys


def norm(v, col):
    if isinstance(v, str) and col in ("patch_files", "file_usage_epochs", "source", "schema_issues",
                                      "sandbox_policy") or (
            isinstance(v, str) and col.endswith("_json")):
        s = v.strip()
        if s.startswith(("{", "[")):
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                return v
    return v


def dump(conn, table, cols=None, order="rowid"):
    rows = []
    for r in conn.execute(f"SELECT * FROM {table} ORDER BY {order}"):
        d = {k: norm(r[k], k) for k in r.keys() if cols is None or k in cols}
        rows.append(d)
    return rows


def main():
    db = sys.argv[1]
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    out = {
        "threads": dump(conn, "threads", order="thread_id"),
        "threads_diag": dump(conn, "threads_diag", order="thread_id"),
        "turns": dump(conn, "turns", order="thread_id, turn_index"),
        "daily_usage": dump(conn, "daily_usage", order="thread_id, day"),
        "tool_failures": dump(conn, "tool_failures", order="thread_id, seq"),
        "rollout_files": dump(conn, "rollout_files",
                              cols={"path", "thread_id", "size", "last_offset", "status"},
                              order="path"),
    }
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

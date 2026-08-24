"""CLI 入口：python -m ledger <command>

命令：
  update [--recent-days N] [--db PATH]   增量采集（默认全量回放，首次较慢）
  daemon [--interval S]                  常驻自动采集（周期增量，可独立运行）
  serve [--port P] [--interval S]        本地网页实时视图（内嵌采集线程 + 自动刷新）
  today [--date YYYY-MM-DD]              今日任务与 Token
  projects [--days N]                    项目级聚合
  tasks [--days N]                       近 N 天根任务
  task <thread-id|前缀>                  任务详情（Token 树 / turns / 诊断）
  turns <thread-id|前缀>                 同 task（turns 表）
  threads [--days N]                     全部线程（含子代理）
  reconcile [--days N]                   与 state DB tokens_used 对账
  env [--write FILE]                     环境发现信息
"""
from __future__ import annotations

import argparse
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ledger", description="Codex Desktop Task Ledger（只读）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("update", help="增量采集 rollout + state DB")
    p.add_argument("--recent-days", type=int, default=None, help="只处理近 N 天的 rollout 文件")
    p.add_argument("--db", default=None, help="collector.sqlite 路径")
    p.add_argument("-q", "--quiet", action="store_true")

    p = sub.add_parser("daemon", help="常驻自动采集")
    p.add_argument("--interval", type=float, default=30.0, help="采集间隔秒（默认 30）")
    p.add_argument("--db", default=None)

    p = sub.add_parser("serve", help="本地网页实时视图")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--interval", type=float, default=20.0, help="内嵌采集间隔秒（默认 20）")
    p.add_argument("--no-collect", action="store_true", help="不启动内嵌采集（仅展示）")
    p.add_argument("--db", default=None)

    p = sub.add_parser("today", help="今日任务与 Token")
    p.add_argument("--date", default=None)
    p.add_argument("--db", default=None)

    p = sub.add_parser("projects", help="项目级聚合")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--db", default=None)

    p = sub.add_parser("tasks", help="近 N 天根任务")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--db", default=None)

    p = sub.add_parser("task", help="任务详情")
    p.add_argument("id")
    p.add_argument("--db", default=None)

    p = sub.add_parser("turns", help="turns 视图")
    p.add_argument("id")
    p.add_argument("--db", default=None)

    p = sub.add_parser("threads", help="全部线程")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--db", default=None)

    p = sub.add_parser("reconcile", help="与 state DB 对账")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--db", default=None)

    p = sub.add_parser("env", help="环境发现")
    p.add_argument("--write", default=None)

    a = parser.parse_args(argv)
    from . import views
    from .collector import DEFAULT_DB, ingest
    from pathlib import Path

    db = Path(a.db) if getattr(a, "db", None) else None
    if a.cmd == "update":
        ingest(db_path=db, recent_days=a.recent_days, verbose=not a.quiet)
    elif a.cmd == "daemon":
        from . import daemon
        print(f"[daemon] 常驻采集启动，每 {a.interval:.0f}s 增量（Ctrl+C 停止）")
        try:
            daemon.run(interval=a.interval, db=db)
        except KeyboardInterrupt:
            print("\n[daemon] 退出")
    elif a.cmd == "serve":
        from . import webserve
        webserve.serve(host=a.host, port=a.port, collect=not a.no_collect,
                       interval=a.interval, db=db)
    elif a.cmd == "env":
        views.cmd_env(a.write)
    else:
        conn = views.open_default_db() if db is None else views.connect(db)
        try:
            if a.cmd == "today":
                views.cmd_today(conn, a.date)
            elif a.cmd == "projects":
                views.cmd_projects(conn, a.days)
            elif a.cmd == "tasks":
                views.cmd_tasks(conn, a.days, a.limit)
            elif a.cmd == "task":
                views.cmd_task(conn, a.id)
            elif a.cmd == "turns":
                views.cmd_task(conn, a.id, show_turns=True)
            elif a.cmd == "threads":
                views.cmd_threads(conn, a.days)
            elif a.cmd == "reconcile":
                views.cmd_reconcile(conn, a.days)
        finally:
            conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

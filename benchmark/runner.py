"""Benchmark runner（Level-0 运行编排，交互式协议）。

用法：
  python -m benchmark.runner start --task T01 --repeat 1            # 正式 run（人工投递）
  python -m benchmark.runner start --task T01 --repeat 0 --simulate # 自测链路（无需 ChatGPT）

正式 run 协议（保证唯一线程绑定）：
  1. run 开始：快照 ledger 全部 thread id；
  2. 从本地基仓 git worktree add --detach 建 workspace（固定 base_commit）；
  3. 运行 setup（不计入耗时）；
  4. 操作者【在 ChatGPT Desktop 的 Codex 视图新建任务、cwd 指向 workspace】并粘贴 prompt，
     回车记录 t0；
  5. 任务结束后回车记录 t_end；
  6. grader 独立评分 → ledger 增量采集 → 候选线程 = 新 id ∧ cwd==workspace ∧ created≥t0-2min
     ∧ thread_source=user；≠1 唯一 → attribution_ambiguous（不进正式 Baseline）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from ledger.collector import connect, normcase  # noqa: E402
from benchmark import grading as _g  # noqa: E402
from benchmark import metrics as _mx  # noqa: E402
from benchmark import watcher as _w  # noqa: E402

TASKS_DIR = PROJECT_ROOT / "tasks"
RAW_DIR = PROJECT_ROOT / "results" / "raw"
METRICS_DIR = PROJECT_ROOT / "results" / "metrics"


def sh(cmd: List[str], cwd: Optional[Path] = None, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)


def load_task(task_id: str) -> dict:
    tdir = TASKS_DIR / task_id
    meta_p = tdir / "task.yaml"
    if not meta_p.is_file():
        raise FileNotFoundError(f"任务不存在：{tdir}")
    meta = {}
    for line in meta_p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip()
    meta["dir"] = str(tdir)
    meta.setdefault("timeout_s", "1800")
    return meta


def pre_snapshot() -> set:
    conn = connect()
    ids = {r[0] for r in conn.execute("SELECT thread_id FROM threads")}
    conn.close()
    return ids


def find_thread(pre_ids: set, ws_norm: str, t0_ms: int) -> List[dict]:
    conn = connect()
    cands = []
    for r in conn.execute("""SELECT thread_id, cwd, created_ms, thread_source, thread_type
                             FROM threads"""):
        if r["thread_id"] in pre_ids:
            continue
        if normcase(r["cwd"] or "") != ws_norm:
            continue
        if (r["created_ms"] or 0) < t0_ms - 120_000:
            continue
        if r["thread_source"] not in ("user", None) and r["thread_type"] != "root":
            continue
        cands.append(dict(thread_id=r["thread_id"], created_ms=r["created_ms"]))
    conn.close()
    return cands


def start_run(task_id: str, repeat: int, simulate: bool, keep_ws: bool = True) -> dict:
    task = load_task(task_id)
    run_id = f"{task_id}-R{repeat}-{time.strftime('%Y%m%d-%H%M%S')}"
    run_dir = RAW_DIR / run_id
    ws = run_dir / "ws"
    repo = Path(task["dir"]) / "repo"

    print(f"[run] {run_id}")
    pre = pre_snapshot() if not simulate else set()
    (run_dir).mkdir(parents=True, exist_ok=True)
    (run_dir / "pre_threads.json").write_text(json.dumps(sorted(pre)), encoding="utf-8")

    # worktree 隔离（本地基仓 + 固定 base_commit）
    rev = sh(["git", "-C", str(repo), "rev-parse", "HEAD"])
    if rev.returncode != 0:
        raise RuntimeError(f"基仓不可用：{rev.stderr}")
    base_commit = rev.stdout.strip()
    r = sh(["git", "-C", str(repo), "worktree", "add", "--detach", str(ws), base_commit])
    if r.returncode != 0:
        raise RuntimeError(f"worktree 创建失败：{r.stderr}")
    print(f"[run] workspace = {ws}")
    print(f"[run] base_commit = {base_commit}")

    # setup（不计入耗时）
    setup = Path(task["dir"]) / "setup.py"
    if setup.is_file():
        r = sh([sys.executable, str(setup)], cwd=ws, timeout=900)
        print(f"[run] setup exit={r.returncode}")

    prompt = (Path(task["dir"]) / "prompt.md").read_text(encoding="utf-8")

    if simulate:
        print("[simulate] 使用模拟 agent（应用 solution.patch 并跑测试），无需 ChatGPT。")
        t0_ms = int(time.time() * 1000)
        wc = _w.WorkspaceWatcher(ws, run_dir / "timeline.jsonl")
        wc.start()
        sim = sh([sys.executable, str(PROJECT_ROOT / "benchmark" / "sim_agent.py"),
                  "--task-dir", task["dir"], "--workspace", str(ws)],
                 cwd=ws, timeout=int(task["timeout_s"]))
        print(f"[simulate] agent exit={sim.returncode} {(sim.stdout or '')[-200:]}")
        t_end_ms = int(time.time() * 1000)
        wc.stop()
        attribution, thread_id = "none", None
        grade = _g.grade(Path(task["dir"]), ws, timeout=int(task["timeout_s"]))
    else:
        print("\n" + "=" * 78)
        print("请现在操作：")
        print(f"  1. 在 ChatGPT Desktop 的 Codex 视图【新建任务】；")
        print(f"  2. 工作目录选择：{ws}")
        print("  3. 把下面的 prompt 粘贴发送（不要追加其他指示）：")
        print("-" * 78)
        print(prompt)
        print("-" * 78)
        input("prompt 已发送？发送完成按回车记录 t0 ...")
        t0_ms = int(time.time() * 1000)
        wc = _w.WorkspaceWatcher(ws, run_dir / "timeline.jsonl")
        wc.start()
        input("Codex 任务已结束？按回车记录 t_end ...")
        t_end_ms = int(time.time() * 1000)
        wc.stop()
        grade = _g.grade(Path(task["dir"]), ws, timeout=int(task["timeout_s"]))

        # 增量采集 + 唯一线程绑定
        up = sh([sys.executable, "-m", "ledger", "update"], cwd=PROJECT_ROOT, timeout=1800)
        print(f"[run] ledger update exit={up.returncode}")
        cands = find_thread(pre, normcase(str(ws)), t0_ms)
        if len(cands) == 1:
            attribution, thread_id = "unique", cands[0]["thread_id"]
            print(f"[run] 绑定线程 {thread_id}")
        else:
            attribution, thread_id = ("ambiguous" if cands else "none"), None
            print(f"[run][!] attribution={attribution} 候选数={len(cands)}（本 run 不进正式 Baseline）")

    (run_dir / "grader_result.json").write_text(
        json.dumps(grade, ensure_ascii=False, indent=2), encoding="utf-8")

    out = METRICS_DIR / f"{run_id}.json"
    m = _mx.build(run_id, task_id, repeat, ws, t0_ms, t_end_ms, grade,
                  thread_id, attribution, timeline=run_dir / "timeline.jsonl", out_path=out)
    print(f"[run] metrics → {out}")
    print(f"[run] success={m['quality']['task_completed']}  authoritative={m['authoritative']}  "
          f"tokens={m['tokens'].get('total_tokens')}")

    conn = connect()
    conn.execute("""INSERT OR REPLACE INTO benchmark_runs
        (run_id, task_id, repeat, created_ms, thread_id, root_thread_id, workspace, base_commit,
         t0_ms, t_end_ms, status, grader_json, metrics_file)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (run_id, task_id, repeat, t0_ms, thread_id,
         m.get("thread_id"), str(ws), base_commit, t0_ms, t_end_ms,
         "done" if attribution != "ambiguous" else "attribution_ambiguous",
         json.dumps(grade, ensure_ascii=False), str(out)))
    conn.commit()
    conn.close()

    if not keep_ws:
        sh(["git", "-C", str(repo), "worktree", "remove", "--force", str(ws)])
    else:
        print(f"[run] workspace 保留于 {ws}（复查后可 git worktree remove）")
    return m


def main(argv=None):
    p = argparse.ArgumentParser(prog="benchmark.runner")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start", help="开始一次 benchmark run")
    s.add_argument("--task", required=True)
    s.add_argument("--repeat", type=int, default=1)
    s.add_argument("--simulate", action="store_true", help="自测链路（模拟 agent，不连 ChatGPT）")
    s.add_argument("--keep-ws", action="store_true", default=True)
    a = p.parse_args(argv)
    if a.cmd == "start":
        start_run(a.task, a.repeat, a.simulate, a.keep_ws)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""模拟 agent（--simulate 自测专用）：应用 solution.patch 并运行测试。

不连接 ChatGPT；仅用于验证 runner → watcher → grader → metrics 全链路。
真实指标（Token/编排/上下文）在此模式下为 null（attribution=none），符合预期。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-dir", required=True)
    ap.add_argument("--workspace", required=True)
    a = ap.parse_args()
    task_dir, ws = Path(a.task_dir), Path(a.workspace)

    print("[sim] 阅读任务（模拟分析阶段）...")
    time.sleep(2)

    patch = task_dir / "solution.patch"
    if patch.is_file():
        print("[sim] 应用 solution.patch（模拟首个有效修改）...")
        r = subprocess.run(["git", "-C", str(ws), "apply", str(patch)],
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(f"[sim][!] patch 应用失败：{r.stderr}")
            sys.exit(2)
    else:
        print("[sim][!] 任务缺少 solution.patch，跳过修改")

    print("[sim] 运行测试（模拟验证阶段）...")
    time.sleep(1)
    sys.exit(0)


if __name__ == "__main__":
    main()

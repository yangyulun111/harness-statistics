"""任务集初始化：git 基仓提交 + 基线/解法测试验证 + solution.patch 生成。

对每个任务：
  1. git init + commit（本地基仓，worktree 的父仓）；
  2. 跑基线测试（T01-T04/T06 应失败，T05 应全绿）；
  3. 覆盖 .solutions → 跑解法测试（应全绿）→ git diff 生成 solution.patch → 还原基线。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from benchmark import grading  # noqa: E402

GIT = ["git", "-c", "user.name=bench", "-c", "user.email=bench@local"]
EXPECT_BASE_GREEN = {"T05"}


def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def init_repo(repo: Path):
    if not (repo / ".git").exists():
        sh(GIT + ["init", "-b", "main"], repo)
    sh(GIT + ["add", "-A"], repo)
    r = sh(GIT + ["diff", "--cached", "--quiet"], repo)
    if r.returncode != 0:  # 有待提交变更
        sh(GIT + ["commit", "-m", "task base"], repo)
    head = sh(GIT + ["rev-parse", "HEAD"], repo)
    return head.stdout.strip()


def copy_tree(src: Path, dst: Path):
    for f in src.rglob("*"):
        if f.is_file():
            target = dst / f.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)


def main():
    tasks_root = ROOT / "tasks"
    for tdir in sorted(p for p in tasks_root.iterdir() if p.is_dir() and p.name[0] == "T"):
        repo = tdir / "repo"
        sols = tdir / ".solutions"
        head = init_repo(repo)
        base = grading.run_unittest(repo, timeout=1800)
        expect_green = tdir.name in EXPECT_BASE_GREEN
        ok_base = (base["success"] == expect_green)

        patched = False
        if sols.is_dir():
            copy_tree(sols, repo)
            sol = grading.run_unittest(repo, timeout=1800)
            diff = sh(GIT + ["diff"], repo)
            (tdir / "solution.patch").write_text(diff.stdout, encoding="utf-8")
            sh(GIT + ["checkout", "--", "."], repo)
            patched = sol["success"]

        print(f"{tdir.name}: base={'绿' if base['success'] else '红'}"
              f"({'✓' if ok_base else '✗ 期望' + ('绿' if expect_green else '红')})"
              f"  solution={'绿' if patched else '无/✗'}"
              f"  base测试 {base['passed']}/{base['total']}"
              f"  patch={(tdir / 'solution.patch').stat().st_size if (tdir / 'solution.patch').exists() else 0}B"
              f"  HEAD={head[:8]}")
        if not ok_base or (sols.is_dir() and not patched):
            print(f"  [!] {tdir.name} 验证未通过：base={base} ")


if __name__ == "__main__":
    main()

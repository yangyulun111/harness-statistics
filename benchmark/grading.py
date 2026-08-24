"""独立 grader：在 run 结束后由 harness 运行，绝不信任模型自称完成。

约定：每个任务的 grader.py 读取环境变量 BENCH_WORKSPACE，向 stdout 输出单行 JSON：
  {"total": int, "failures": int, "errors": int, "success": bool, "details": str}
本模块提供通用 unittest 运行器（零第三方依赖）与调用封装。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

_RUNNER_SNIPPET = (
    "import sys, os, io, json, unittest, contextlib\n"
    "ws = os.environ['BENCH_WORKSPACE']\n"
    "extra = os.environ.get('BENCH_EXTRA_TESTS', '')\n"
    "loader = unittest.TestLoader()\n"
    "suite = unittest.TestSuite()\n"
    "for d in [os.path.join(ws, 'tests')] + [x for x in extra.split(os.pathsep) if x]:\n"
    "    if os.path.isdir(d):\n"
    "        suite.addTests(loader.discover(d))\n"
    "buf = io.StringIO()\n"
    "with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):\n"
    "    r = unittest.TextTestRunner(stream=buf, verbosity=1).run(suite)\n"
    "print(json.dumps({'total': r.testsRun, 'failures': len(r.failures),\n"
    "                  'errors': len(r.errors), 'skipped': len(r.skipped)}))\n"
    "sys.stderr.write(buf.getvalue())\n"
)


def run_unittest(workspace: Path, timeout: int = 600,
                 extra_test_dirs: Optional[list] = None) -> dict:
    """在 workspace 运行 unittest 发现的测试，返回 {total, passed, failures, errors, success}。"""
    env = dict(os.environ)
    env["BENCH_WORKSPACE"] = str(workspace)
    if extra_test_dirs:
        env["BENCH_EXTRA_TESTS"] = os.pathsep.join(str(d) for d in extra_test_dirs)
    proc = subprocess.run([sys.executable, "-c", _RUNNER_SNIPPET],
                          capture_output=True, text=True, timeout=timeout,
                          encoding="utf-8", errors="replace", env=env, cwd=str(workspace))
    result = None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                result = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if result is None:
        return {"total": 0, "passed": 0, "failures": 0, "errors": 1, "success": False,
                "details": (proc.stderr or proc.stdout or "")[-2000:],
                "runner_exit": proc.returncode}
    total = int(result.get("total") or 0)
    failures = int(result.get("failures") or 0)
    errors = int(result.get("errors") or 0)
    return {"total": total, "passed": max(0, total - failures - errors),
            "failures": failures, "errors": errors,
            "success": total > 0 and failures == 0 and errors == 0,
            "details": (proc.stderr or "")[-2000:], "runner_exit": proc.returncode}


def grade(task_dir: Path, workspace: Path, timeout: int = 900) -> dict:
    """运行任务自带 grader.py（BENCH_WORKSPACE=workspace）。"""
    grader = task_dir / "grader.py"
    if not grader.is_file():
        raise FileNotFoundError(f"缺少 grader.py: {grader}")
    env = dict(os.environ)
    env["BENCH_WORKSPACE"] = str(workspace)
    proc = subprocess.run([sys.executable, str(grader)],
                          capture_output=True, text=True, timeout=timeout, env=env,
                          encoding="utf-8", errors="replace", cwd=str(workspace))
    result = None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                result = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if result is None:
        result = {"total": 0, "passed": 0, "failures": 0, "errors": 1, "success": False,
                  "details": (proc.stderr or proc.stdout or "")[-2000:]}
    result.setdefault("success", result.get("total", 0) > 0
                      and result.get("failures", 1) == 0 and result.get("errors", 1) == 0)
    result["grader_exit"] = proc.returncode
    return result

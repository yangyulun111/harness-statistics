"""发现 Codex 本地状态：CODEX_HOME / sqlite home / state DB / sessions 根。

优先 `codex doctor --json`（Codex 自己报告的路径，避免本机两套 sqlite home 的歧义），
失败时回退到约定路径。绝不做任何写操作。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class CodexPaths:
    codex_home: Path
    sqlite_home: Path
    state_db: Optional[Path]
    sessions_root: Path
    codex_version: Optional[str] = None
    model: Optional[str] = None
    model_provider: Optional[str] = None
    doctor_used: bool = False
    notes: List[str] = field(default_factory=list)

    def session_files(self) -> List[Path]:
        """sessions/YYYY/MM/DD/*.jsonl，按路径排序（即按时间有序）。"""
        if not self.sessions_root.is_dir():
            return []
        return sorted(self.sessions_root.glob("*/*/*/*.jsonl"))


def _find_codex_exe() -> Optional[str]:
    exe = shutil.which("codex")
    if exe:
        return exe
    sandbox = Path.home() / ".codex" / ".sandbox-bin" / ("codex.exe" if os.name == "nt" else "codex")
    if sandbox.is_file():
        return str(sandbox)
    return None


def _run_doctor(exe: str) -> Optional[dict]:
    try:
        proc = subprocess.run(
            [exe, "doctor", "--json"],
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace",
        )
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        return None


def _pick_state_db(sqlite_home: Path, codex_home: Path, notes: List[str]) -> Optional[Path]:
    """在 doctor 报告的 sqlite home 里找最高版本号的 state_*.sqlite；找不到再查 codex_home。

    注意：本机实测根目录与 sqlite/ 子目录可能各有一套，只用 doctor 指定的那套，不合并。
    """
    def best(dirp: Path) -> Optional[Path]:
        if not dirp.is_dir():
            return None
        cands = []
        for p in dirp.glob("state_*.sqlite"):
            m = re.search(r"state_(\d+)\.sqlite$", p.name)
            cands.append((int(m.group(1)) if m else -1, p))
        return max(cands)[1] if cands else None

    hit = best(sqlite_home)
    if hit is None and sqlite_home != codex_home:
        hit = best(codex_home)
        if hit is not None:
            notes.append(f"state DB 不在 sqlite home，回退到 {hit}")
    return hit


def discover(env_codex_home: Optional[str] = None, use_doctor: Optional[bool] = None) -> CodexPaths:
    """env_codex_home 显式指定时（fixture/Golden 测试）默认跳过 doctor，保证可复现。"""
    notes: List[str] = []
    if use_doctor is None:
        use_doctor = env_codex_home is None
    env_home = Path(env_codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    paths = CodexPaths(
        codex_home=env_home,
        sqlite_home=env_home,
        state_db=None,
        sessions_root=env_home / "sessions",
    )

    exe = _find_codex_exe() if use_doctor else None
    doc = _run_doctor(exe) if exe else None
    if doc:
        paths.doctor_used = True
        paths.codex_version = doc.get("codexVersion")
        cfg = ((doc.get("checks") or {}).get("config.load") or {}).get("details") or {}
        home = cfg.get("CODEX_HOME")
        sqhome = cfg.get("sqlite home")
        if home:
            paths.codex_home = Path(home)
            paths.sessions_root = paths.codex_home / "sessions"
        if sqhome:
            paths.sqlite_home = Path(sqhome)
        paths.model = cfg.get("model")
        paths.model_provider = cfg.get("model provider")
    else:
        notes.append("codex doctor --json 不可用，使用约定路径（CODEX_HOME 环境变量或 ~/.codex）")

    paths.state_db = _pick_state_db(paths.sqlite_home, paths.codex_home, notes)
    if paths.state_db is None:
        notes.append("未找到 state_*.sqlite，任务目录将仅来自 rollout session_meta")
    return paths

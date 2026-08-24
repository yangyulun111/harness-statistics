"""workspace watcher：性能补充通道（TTFM 交叉验证 / 修改时间线 / 失败恢复辅助）。

纯轮询实现（mtime 扫描 + 周期性 git status），无第三方依赖，对被测环境零侵入。
"""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Dict, Optional


class WorkspaceWatcher:
    def __init__(self, workspace: Path, timeline_path: Path, interval: float = 1.0,
                 git_interval: float = 5.0):
        self.ws = workspace
        self.timeline_path = timeline_path
        self.interval = interval
        self.git_interval = git_interval
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._fh = None
        self.first_change_ms: Optional[int] = None
        self.first_git_diff_ms: Optional[int] = None
        self.events: list = []

    def _emit(self, type_: str, **kw):
        rec = {"t_ms": int(time.time() * 1000), "type": type_, **kw}
        self.events.append(rec)
        if self._fh:
            import json
            self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._fh.flush()

    def _scan(self) -> Dict[str, tuple]:
        out = {}
        for p in self.ws.rglob("*"):
            if any(part == ".git" for part in p.parts):
                continue
            try:
                if p.is_file():
                    st = p.stat()
                    out[str(p)] = (st.st_mtime_ns, st.st_size)
            except OSError:
                continue
        return out

    def _git_dirty(self) -> bool:
        try:
            proc = subprocess.run(["git", "-C", str(self.ws), "status", "--porcelain"],
                                  capture_output=True, text=True, timeout=15,
                                  encoding="utf-8", errors="replace")
            return bool(proc.stdout.strip())
        except (OSError, subprocess.SubprocessError):
            return False

    def _loop(self):
        prev = self._scan()
        last_git = 0.0
        while not self._stop.is_set():
            time.sleep(self.interval)
            cur = self._scan()
            for path, sig in cur.items():
                if path not in prev:
                    self._mark("file_add", path)
                elif prev[path] != sig:
                    self._mark("file_change", path)
            for path in prev:
                if path not in cur:
                    self._mark("file_delete", path)
            prev = cur
            now = time.time()
            if now - last_git >= self.git_interval:
                last_git = now
                if self.first_git_diff_ms is None and self._git_dirty():
                    self.first_git_diff_ms = int(now * 1000)
                    self._emit("git_diff_first")

    def _mark(self, kind: str, path: str):
        if self.first_change_ms is None:
            self.first_change_ms = int(time.time() * 1000)
        self._emit(kind, path=path)

    def start(self):
        self.timeline_path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.timeline_path, "a", encoding="utf-8")
        self._emit("watch_start", workspace=str(self.ws))
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self.interval * 3 + 5)
        if self._fh:
            self._emit("watch_stop", first_change_ms=self.first_change_ms,
                       first_git_diff_ms=self.first_git_diff_ms)
            self._fh.close()
            self._fh = None

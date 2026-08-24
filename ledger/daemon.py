"""常驻自动采集：周期性增量 ingest（可被 serve 内嵌，也可独立运行）。"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Optional

from .collector import ingest


def run(interval: float = 20.0, db: Optional[Path] = None, verbose: bool = True,
        stop: Optional[threading.Event] = None):
    """循环增量采集；stop.set() 后在一个 interval 内退出。异常不中断循环。"""
    while True:
        if stop is not None and stop.is_set():
            return
        try:
            stats = ingest(db_path=db, recent_days=None, verbose=False)
            if verbose:
                print(f"[daemon] {time.strftime('%H:%M:%S')}  "
                      f"+{stats['events']} events / {stats['files']} files  "
                      f"({stats['elapsed_s']}s)", flush=True)
        except Exception as e:  # 采集失败不退出（文件锁/权限等瞬时问题）
            if verbose:
                print(f"[daemon] 采集异常（继续重试）: {e}", file=sys.stderr, flush=True)
        for _ in range(max(1, int(interval * 10))):
            if stop is not None and stop.is_set():
                return
            time.sleep(0.1)

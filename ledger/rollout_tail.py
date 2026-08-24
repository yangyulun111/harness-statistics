"""rollout JSONL 增量读取：断点续读只处理新增字节，只消费完整行。

背景：本机实测最大 rollout 达 694MB，绝不能全量重扫。
状态（size/offset）持久化在 collector.sqlite 的 rollout_files 表，由 collector 维护。
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator, List, Optional, Tuple

CHUNK = 4 * 1024 * 1024      # 每次磁盘读取 4MB
MAX_LINES = 20_000           # 单次返回行数上限（防巨文件一次吃满内存）
MAX_BYTES = 64 * 1024 * 1024  # 单次消费字节上限


def read_new_lines(path: Path, last_offset: int) -> Tuple[List[str], int, bool]:
    """从 last_offset 起读取新增完整行。

    返回 (lines, new_offset, truncated)：
      - 只消费到最后一个 '\\n'，半行留到下一轮；
      - 达到 MAX_LINES / MAX_BYTES 即返回，调用方循环调用直到无进展；
      - 文件变小（轮转/截断）时置 truncated=True 并从头读。
    """
    size = path.stat().st_size
    if size < last_offset:
        last_offset = 0
        truncated = True
    else:
        truncated = False

    lines: List[str] = []
    offset = last_offset
    consumed = 0
    with open(path, "rb") as fh:
        fh.seek(offset)
        remainder = b""
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            data = remainder + chunk
            *complete, remainder = data.split(b"\n")
            stop = False
            for line in complete:
                lines.append(line.decode("utf-8", errors="replace"))
                offset += len(line) + 1
                consumed += len(line) + 1
                if len(lines) >= MAX_LINES or consumed >= MAX_BYTES:
                    stop = True
                    break
            if stop:
                break
    return lines, offset, truncated

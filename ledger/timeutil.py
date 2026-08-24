"""时间戳归一化：rollout 中混用 ISO-8601 字符串与 epoch 秒，统一为 epoch 毫秒（本地时区展示）。"""
from __future__ import annotations

import datetime as _dt
from typing import Optional


def to_ms(value) -> Optional[int]:
    """ISO 字符串 / epoch 秒 / epoch 毫秒 -> epoch 毫秒；无法解析返回 None。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v <= 0:
            return None
        # 1e12 ms ≈ 2001-09；大于它按已是毫秒处理
        return int(v) if v >= 1e12 else int(v * 1000)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            if s.endswith(("Z", "z")):
                s = s[:-1] + "+00:00"
            d = _dt.datetime.fromisoformat(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=_dt.timezone.utc)
            return int(d.timestamp() * 1000)
        except ValueError:
            return None
    return None


def local_date(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    return _dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def fmt_hm(ms: Optional[int]) -> str:
    if ms is None:
        return "--:--"
    return _dt.datetime.fromtimestamp(ms / 1000).strftime("%H:%M")


def fmt_dt(ms: Optional[int]) -> str:
    if ms is None:
        return "-"
    return _dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S")


def fmt_duration(ms: Optional[int]) -> str:
    if ms is None:
        return "-"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m, s = divmod(int(s), 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"

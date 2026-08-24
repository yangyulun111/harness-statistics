import calendar
from datetime import date


def next_month(d: date) -> date:
    """返回下个月同一天；目标月不足该日时收敛到目标月最后一天。"""
    if d.month == 12:
        year, month = d.year + 1, 1
    else:
        year, month = d.year, d.month + 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(d.day, last))

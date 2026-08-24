from datetime import date


def next_month(d: date) -> date:
    """返回下个月同一天；目标月不足该日时收敛到目标月最后一天。"""
    if d.month == 12:
        return date(d.year + 1, 1, min(d.day, 31))
    return date(d.year, d.month + 1, min(d.day, 30))

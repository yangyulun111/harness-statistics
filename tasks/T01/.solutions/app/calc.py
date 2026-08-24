UNIT = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    """解析 '1h30m' / '45s' / '2m15s' 等时长字符串，返回总秒数（各段累加）。"""
    total = 0
    num = ""
    for ch in text:
        if ch.isdigit():
            num += ch
        elif ch in UNIT:
            if num:
                total += int(num) * UNIT[ch]
                num = ""
    if num:
        total += int(num)
    return total

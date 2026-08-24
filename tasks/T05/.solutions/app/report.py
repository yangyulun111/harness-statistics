def _border(width: int) -> str:
    return "+" + "-" * (width - 2) + "+"


def _clean_line(raw, width: int) -> str:
    ln = str(raw).replace("\t", "    ")
    if width - 4 < len(ln):
        ln = ln[: width - 7] + "..."
    return ln


def _split_marker(ln: str) -> tuple:
    if ln.startswith("# "):
        return "#", ln[2:]
    return " ", ln


def _format_row(ln: str, marker: str, width: int) -> str:
    pad = width - 4 - len(ln)
    left = pad // 2
    right = pad - left
    return "|" + marker + " " + " " * left + ln + " " * right + "|"


def render_report(lines, width):
    """把多行文本渲染为定宽边框报告：标题行以 # 标记，超长行截断加省略号。"""
    out = [_border(width)]
    for raw in lines:
        ln = _clean_line(raw, width)
        marker, ln = _split_marker(ln)
        out.append(_format_row(ln, marker, width))
    out.append(_border(width))
    return "\n".join(out)

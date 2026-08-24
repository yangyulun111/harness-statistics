def render_report(lines, width):
    out = []
    out.append("+" + "-" * (width - 2) + "+")
    for ln in lines:
        ln = str(ln).replace("\t", "    ")
        if width - 4 < len(ln):
            ln = ln[: width - 7] + "..."
        pad = width - 4 - len(ln)
        left = pad // 2
        right = pad - left
        if ln.startswith("# "):
            marker = "#"
            ln = ln[2:]
        else:
            marker = " "
        out.append("|" + marker + " " + " " * left + ln + " " * right + "|")
    out.append("+" + "-" * (width - 2) + "+")
    return "\n".join(out)

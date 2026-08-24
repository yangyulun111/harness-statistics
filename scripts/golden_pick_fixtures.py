"""挑选 Golden fixtures：从真实 ~/.codex/sessions 复制代表性小样本到 tests/fixtures。

覆盖：普通根线程 / 子代理+父线程对 / fork / session_meta.parent_thread_id 自声明 /
含 rebroadcast 的文件 / 大文件。挑选规则与账目无关，只服务回归测试的输入多样性。
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path.home() / ".codex" / "sessions"
DST = ROOT / "tests" / "fixtures" / "codex-home" / "sessions"
PICKED: set = set()


def head_of(p: Path):
    try:
        with p.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    return json.loads(line)
    except (OSError, json.JSONDecodeError):
        return None
    return None


def scan():
    files = sorted(SRC.glob("*/*/*/*.jsonl"))
    out = []
    for f in files:
        try:
            size = f.stat().st_size
        except OSError:
            continue
        rec = head_of(f)
        if not rec or rec.get("type") != "session_meta":
            continue
        pl = rec.get("payload") or {}
        out.append((f, size, pl))
    return out


def rel_dst(f: Path) -> Path:
    parts = f.parts[-4:]
    return DST.joinpath(*parts)


def pick(f: Path):
    if f in PICKED:
        return
    PICKED.add(f)
    d = rel_dst(f)
    d.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(f, d)


def main():
    files = scan()
    picked_counts = {"root": 0, "subagent": 0, "fork": 0, "selfdeclared": 0, "rebroadcast": 0, "big": 0}
    subagent_parents = []

    # 1) 子代理文件 + 其父线程文件（source JSON 或 session_id 指父）
    for f, size, pl in files:
        src = pl.get("source")
        parent = None
        if isinstance(src, dict):
            spawn = (src.get("subagent") or {}).get("thread_spawn") or {}
            parent = spawn.get("parent_thread_id")
        if parent and 50_000 < size < 3_000_000 and picked_counts["subagent"] < 2:
            pick(f)
            picked_counts["subagent"] += 1
            subagent_parents.append(parent)

    by_id = {pl.get("id"): f for f, size, pl in files}
    for parent in subagent_parents:
        pf = by_id.get(parent)
        if pf:
            pick(pf)

    # 2) fork / 自声明 parent / 普通根 / 大文件
    for f, size, pl in files:
        if f in PICKED:
            continue
        if pl.get("forked_from_id") and picked_counts["fork"] < 1 and size < 3_000_000:
            pick(f); picked_counts["fork"] += 1
        elif pl.get("parent_thread_id") and picked_counts["selfdeclared"] < 1 and size < 3_000_000:
            pick(f); picked_counts["selfdeclared"] += 1
        elif size > 8_000_000 and picked_counts["big"] < 1 and size < 40_000_000:
            pick(f); picked_counts["big"] += 1
        elif 100_000 < size < 800_000 and picked_counts["root"] < 3:
            pick(f); picked_counts["root"] += 1

    total = sum(rel_dst(f).stat().st_size for f in PICKED if rel_dst(f).exists())
    print(f"picked={len(PICKED)} total={total/1e6:.1f}MB -> {DST}")
    for k, v in picked_counts.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()

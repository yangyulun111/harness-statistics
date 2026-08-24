"""Fork replay 分类器（契约 v1.1 / fork-v2）——与 TS packages/usage-accounting/src/fork.ts 逐条对应。

判定链（时间戳不参与主判定；EOF 与时间 gap 都不是 replay 边界）：
  1. 父前缀位置匹配（主）：子第 i 个增长快照（六字段元组）== 父第 i 个 → 继承前缀延续；
     首个不等位置 = 边界，其后全部 native；匹配长度 0 且父可达 → 阳性判定无 replay（method=none）。
  2. 父文件缺失：起始密集聚簇（连续间隔 ≤1s 且 ≥2 条）→ legacy_time（unverified 降级）。
  3. 父文件缺失且无签名 → unresolved：不扣减（baseline=0），显式标注，绝不自动扣首快照。

工程约束：父序列游标（文件列表 + 逻辑 offset + 位置）持久化在 fork_replay_json，
全部轮次合计只顺序读父文件一遍；buf 仅内存态。分类器状态与账目、offset 同轮事务落盘。
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import List, Optional, Tuple

TUPLE_FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
                "output_tokens", "reasoning_output_tokens", "total_tokens")
DIGEST_SEED = hashlib.sha256(b"fork-v2").hexdigest()
LEGACY_GAP_MS = 1000


def _py_int(x) -> int:
    """TS pyInt 的 Python 对应（None/False/''→0，截断，非有限→0）。"""
    if x is None or x is False or x == "":
        return 0
    if isinstance(x, bool):
        return 1 if x else 0
    if isinstance(x, (int, float)):
        return int(x) if math.isfinite(x) else 0
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return 0


def norm_tuple(total: dict) -> List[int]:
    """六字段规范化元组（total_tokens 原样取记录值，与 raw 口径一致）。"""
    return [_py_int(total.get(f)) for f in TUPLE_FIELDS]


def tuples_equal(a: List[int], b: List[int]) -> bool:
    return a == b


def digest_step(prev: str, t: List[int]) -> str:
    return hashlib.sha256(f"{prev}|{','.join(str(v) for v in t)}".encode()).hexdigest()


def new_fork_state() -> dict:
    return {
        "state": "unknown",       # unknown | matching | native
        "method": None,           # parent_prefix | legacy_time | none | unresolved
        "status": None,           # verified | parent_missing | pending
        "pos": 0,
        "baseline": 0,
        "prefix_events": 0,
        "digest": None,
        "legacy_mode": False,
        "cursor": None,           # {files, file_idx, offset, pos, last, at_start}（buf 仅内存）
        "legacy": {"last_ts": None, "buf": None},
    }


def fork_state_to_json(ctx) -> Optional[str]:
    c = ctx.fork
    cur = c["cursor"]
    cursor = None
    if cur is not None:
        cursor = {"files": cur["files"], "file_idx": cur["file_idx"],
                  "offset": cur["offset"] - len(cur.get("buf") or b""),
                  "pos": cur["pos"], "last": cur["last"], "at_start": cur["at_start"]}
    return json.dumps({
        "state": c["state"], "method": c["method"], "status": c["status"],
        "pos": c["pos"], "baseline": c["baseline"], "prefix_events": c["prefix_events"],
        "digest": c["digest"], "legacy_mode": c["legacy_mode"], "cursor": cursor,
        "legacy": {"last_ts": c["legacy"]["last_ts"], "buf": c["legacy"]["buf"]},
        # 辅助状态（与分类器共用一个持久化槽位，保证崩溃后文件边界规则可恢复）
        "current_file": ctx.current_file, "at_file_start": ctx.at_file_start,
        "epoch_soft_closed": ctx.epoch_soft_closed,
    }, ensure_ascii=False)


def parse_fork_state(raw, ctx) -> None:
    if not raw:
        return
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return
    if not isinstance(v, dict):
        return
    c = ctx.fork
    if v.get("state") in ("matching", "native"):
        c["state"] = v["state"]
    if isinstance(v.get("method"), str):
        c["method"] = v["method"]
    if isinstance(v.get("status"), str):
        c["status"] = v["status"]
    c["pos"] = _py_int(v.get("pos"))
    c["baseline"] = _py_int(v.get("baseline"))
    c["prefix_events"] = _py_int(v.get("prefix_events"))
    if isinstance(v.get("digest"), str):
        c["digest"] = v["digest"]
    c["legacy_mode"] = v.get("legacy_mode") is True
    cur = v.get("cursor")
    if isinstance(cur, dict) and isinstance(cur.get("files"), list):
        c["cursor"] = {
            "files": [str(x) for x in cur["files"]],
            "file_idx": _py_int(cur.get("file_idx")),
            "offset": _py_int(cur.get("offset")),
            "pos": _py_int(cur.get("pos")),
            "last": [_py_int(x) for x in cur["last"]] if isinstance(cur.get("last"), list) else None,
            "at_start": cur.get("at_start") is True,
            "buf": b"",
        }
    lg = v.get("legacy")
    if isinstance(lg, dict):
        c["legacy"]["last_ts"] = lg.get("last_ts") if isinstance(lg.get("last_ts"), int) else None
        b = lg.get("buf")
        if isinstance(b, dict) and isinstance(b.get("delta"), list):
            c["legacy"]["buf"] = {
                "day": b.get("day") if isinstance(b.get("day"), str) else None,
                "delta": [_py_int(x) for x in b["delta"]],
                "tuple": [_py_int(x) for x in b["tuple"]] if isinstance(b.get("tuple"), list) else [],
            }
    if isinstance(v.get("current_file"), str):
        ctx.current_file = v["current_file"]
    if v.get("at_file_start") is True:
        ctx.at_file_start = True
    if v.get("epoch_soft_closed") is True:
        ctx.epoch_soft_closed = True


def lookup_parent_files(conn, parent_id: str) -> List[str]:
    """父线程的 rollout 文件清单（rollout_files 绑定 + threads.rollout_path 兜底，按路径时间序）。"""
    from .collector import normcase  # 函数级导入，避免模块级循环依赖
    out: List[str] = []
    seen = set()
    for r in conn.execute("SELECT path FROM rollout_files WHERE thread_id=? AND status!='unreadable' "
                          "ORDER BY path", (parent_id,)):
        p = r["path"]
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    row = conn.execute("SELECT rollout_path FROM threads WHERE thread_id=?", (parent_id,)).fetchone()
    rp = normcase(row["rollout_path"]) if row is not None and row["rollout_path"] else None
    if rp and rp not in seen:
        seen.add(rp)
        out.append(rp)
        out.sort()
    return out


def _next_parent_line(cur: dict) -> Optional[str]:
    """顺序读父文件下一完整行；跨文件推进（EOF→下一文件）；打不开的文件跳过。None = 全部读尽。"""
    while True:
        buf = cur.get("buf") or b""
        nl = buf.find(b"\n")
        if nl >= 0:
            line = buf[:nl].decode("utf-8", errors="replace")
            cur["buf"] = buf[nl + 1:]
            return line
        if cur["file_idx"] >= len(cur["files"]):
            return None
        f = cur["files"][cur["file_idx"]]
        chunk = None
        try:
            with open(f, "rb") as fh:
                fh.seek(cur["offset"])
                chunk = fh.read(4 * 1024 * 1024)
        except OSError:
            chunk = None
        if not chunk:
            cur["file_idx"] += 1
            cur["offset"] = 0
            cur["buf"] = b""
            cur["at_start"] = True
            continue
        cur["buf"] = buf + chunk
        cur["offset"] += len(chunk)


def _advance_parent(cur: dict, needed: int) -> None:
    """推进父序列直到产出 needed 个增长快照或读尽（增长规则与主解析器 v2 一致）。"""
    while cur["pos"] < needed:
        line = _next_parent_line(cur)
        if line is None:
            return
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict) or rec.get("type") != "event_msg":
            continue
        p = rec.get("payload")
        if not isinstance(p, dict) or p.get("type") != "token_count":
            continue
        info = p.get("info")
        tt = info.get("total_token_usage") if isinstance(info, dict) else None
        if not isinstance(tt, dict):
            continue
        t = norm_tuple(tt)
        prev_total = cur["last"][5] if cur["last"] is not None else None
        if cur["at_start"]:
            cur["at_start"] = False
            grown = prev_total is None or t[5] != prev_total  # 重启(<)→增长；==→重发；>→增长
        else:
            grown = prev_total is None or t[5] > prev_total
        if grown:
            cur["pos"] += 1
            cur["last"] = t


def classify_fork_event(conn, ctx, tup: List[int], prev_tup: List[int],
                        ts_ms: Optional[int], day: Optional[str]) -> Tuple[str, Optional[dict]]:
    """对一个增长快照做 fork 分类。只更新分类器自身状态；账目由 process_line 按返回值统一处理。

    返回 (cls, retro)：cls ∈ replay|native|buffered；retro 为悬置事件的迟判（{day,delta,as}）。
    """
    c = ctx.fork
    if c["state"] == "native":
        return "native", None
    c["pos"] += 1
    if c["cursor"] is None and not c["legacy_mode"]:
        files = lookup_parent_files(conn, ctx.forked_from_id) \
            if ctx.forked_from_id and ctx.forked_from_id != ctx.thread_id else []
        if files:
            c["cursor"] = {"files": files, "file_idx": 0, "offset": 0, "pos": 0,
                           "last": None, "at_start": True, "buf": b""}
        else:
            c["legacy_mode"] = True
    if not c["legacy_mode"]:
        cur = c["cursor"]
        _advance_parent(cur, c["pos"])
        pt = cur["last"] if cur["pos"] >= c["pos"] else None  # 父在当前位置的元组（读尽为 None）
        if pt is not None and tuples_equal(pt, tup):
            # 继承前缀延续
            c["state"] = "matching"
            c["method"] = "parent_prefix"
            c["status"] = "verified"
            c["prefix_events"] = c["pos"]
            c["baseline"] = tup[5]
            c["digest"] = digest_step(c["digest"] or DIGEST_SEED, tup)
            return "replay", None
        # 结构性边界（divergence 或子序列超前于父的已知序列）
        c["state"] = "native"
        c["status"] = "verified"
        c["method"] = "parent_prefix" if c["prefix_events"] > 0 else "none"
        return "native", None
    # legacy：父缺失，时间聚簇兜底（unverified 降级模式）
    lg = c["legacy"]
    delta = [max(0, v - (prev_tup[i] if i < len(prev_tup) else 0)) for i, v in enumerate(tup)]
    if c["pos"] == 1:
        # 首事件悬置：等下一事件的间隔决定聚簇是否成立（EOF 不是边界）
        lg["last_ts"] = ts_ms
        lg["buf"] = {"day": day, "delta": delta, "tuple": tup}
        c["status"] = "pending"
        return "buffered", None
    gap = (ts_ms - lg["last_ts"]) if ts_ms is not None and lg["last_ts"] is not None else float("inf")
    lg["last_ts"] = ts_ms
    if gap <= LEGACY_GAP_MS:
        retro = None
        if lg["buf"] is not None:
            retro = {"day": lg["buf"]["day"], "delta": lg["buf"]["delta"], "as": "replay"}
            c["prefix_events"] = 1
            c["baseline"] = lg["buf"]["tuple"][5] if lg["buf"]["tuple"] else 0
            c["digest"] = digest_step(DIGEST_SEED, lg["buf"]["tuple"])
            lg["buf"] = None
        c["state"] = "matching"
        c["method"] = "legacy_time"
        c["status"] = "parent_missing"
        c["prefix_events"] = c["pos"]
        c["baseline"] = tup[5]
        c["digest"] = digest_step(c["digest"] or DIGEST_SEED, tup)
        return "replay", retro
    retro_n = {"day": lg["buf"]["day"], "delta": lg["buf"]["delta"], "as": "native"} \
        if lg["buf"] is not None else None
    lg["buf"] = None
    c["state"] = "native"
    c["method"] = "legacy_time" if c["prefix_events"] > 0 else "unresolved"
    c["status"] = "parent_missing"
    return "native", retro_n


def mark_file_start(ctx, f: str, offset: int) -> None:
    """文件切换钩子：offset==0 视为文件起点（v2 文件边界 epoch 规则的输入）。
    同一文件跨 run 续读时，重开上一轮 run 末软封存的 epoch（避免把一个文件拆成多个计数区间）。"""
    if ctx.current_file == f:
        if ctx.epoch_soft_closed:
            if ctx.epochs:
                ctx.epoch_first = ctx.epochs.pop()[0]
            ctx.epoch_soft_closed = False
            ctx.dirty = True
        return
    ctx.current_file = f
    ctx.epoch_soft_closed = False  # 换新文件：上一文件的软封存转正
    if offset == 0:
        ctx.at_file_start = True

"""共享查询层：CLI 与 Web 共用的数据组装（对 collector.sqlite 只读）。

在 Python 侧聚合（线程量级 ~百，成本可忽略），保证 CLI / Web / Benchmark 三处口径一致：
  - v1.1：任务 Token = root native（native_total）+ Σ子代理 native；raw = final_total（含继承前缀）；
  - 消耗口径 = daily 毛差分 − replay（组件级，与 Codex 官方每日用量同语义）；
  - 采样/wait/压缩等诊断量按任务域（root+子代理）求和；
  - 项目 = 按 cwd 归一化分组。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional

from .collector import DEFAULT_DB
from .timeutil import local_date


def open_ro(db: Optional[Path] = None) -> sqlite3.Connection:
    db = Path(db or DEFAULT_DB)
    if not db.exists():
        raise FileNotFoundError(f"collector.sqlite 不存在：{db}（先运行 python -m ledger update）")
    conn = sqlite3.connect("file:" + db.as_posix().replace("?", "%3f") + "?mode=ro", uri=True,
                           timeout=10.0)
    conn.execute("PRAGMA busy_timeout = 8000")
    conn.row_factory = sqlite3.Row
    return conn


def _norm_cwd(cwd: Optional[str]) -> str:
    if not cwd:
        return ""
    s = cwd
    if s.startswith("\\\\?\\UNC\\"):
        s = "\\\\" + s[8:]
    elif s.startswith("\\\\?\\"):
        s = s[4:]
    return s


def project_key(cwd: Optional[str]) -> str:
    s = _norm_cwd(cwd)
    if not s:
        return "（未知）"
    name = s.rstrip("\\/").replace("/", "\\").split("\\")[-1]
    return name or s


def task_name(r: dict) -> str:
    for k in ("name", "title"):
        if r.get(k):
            return str(r[k]).strip().replace("\n", " ")[:60]
    v = r.get("preview") or r.get("first_user_message") or ""
    return str(v).strip().replace("\n", " ")[:60]


def _snapshot(conn: sqlite3.Connection) -> Dict[str, dict]:
    # v1.1 组件级 native（= daily 毛差分 − replay，按线程聚合）
    native: Dict[str, dict] = {r["thread_id"]: dict(r) for r in conn.execute(
        """SELECT thread_id, SUM(input_tokens - COALESCE(replay_input_tokens,0)) ni,
                  SUM(cached_input_tokens - COALESCE(replay_cached_tokens,0)) nc,
                  SUM(output_tokens - COALESCE(replay_output_tokens,0)) no
           FROM daily_usage GROUP BY thread_id""")}
    out: Dict[str, dict] = {}
    q = """SELECT t.*, d.usage_bearing_samples s, d.wait_status_model_calls w,
                  d.rebroadcast_events rb, d.peak_context pc, d.compactions comp,
                  d.final_input fi, d.final_cached fc, d.final_cache_write fcw,
                  d.final_output fo, d.final_reasoning fr, d.final_total ft,
                  d.native_total nt, d.replay_input_tokens ri, d.replay_cached_tokens rc,
                  d.replay_output_tokens ro, d.replay_total_tokens rr, d.replay_events rev,
                  d.baseline_prefix_events bpe, d.baseline_parent_digest bpd,
                  d.schema_compat sc, d.file_usage_epochs ep, d.token_count_events tce
           FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id"""
    for r in conn.execute(q):
        d = dict(r)
        base = d.get("inherited_baseline") or 0
        d["raw_total"] = d.get("ft") or 0
        d["excl_total"] = d["nt"] if d.get("nt") is not None else max(0, (d.get("ft") or 0) - base)
        nb = native.get(d["thread_id"], {})
        d["n_input"] = nb.get("ni") or 0
        d["n_cached"] = nb.get("nc") or 0
        d["n_output"] = nb.get("no") or 0
        d["excl_uncached"] = max(0, d["n_input"] - d["n_cached"])
        d["activity_ms"] = d.get("last_event_ms") or d.get("updated_ms") or d.get("created_ms")
        out[d["thread_id"]] = d
    return out


def _turn_stats(conn: sqlite3.Connection) -> Dict[str, dict]:
    per: Dict[str, dict] = {}
    for tid, idx, status in conn.execute(
            "SELECT thread_id, turn_index, status FROM turns WHERE turn_index>=0 "
            "ORDER BY thread_id, turn_index"):
        s = per.setdefault(tid, {"turns": 0, "status": "idle"})
        s["turns"] += 1
        s["status"] = status
    return per


_STATUS_MAP = {"completed": "completed", "aborted": "interrupted",
               "active": "possibly_active", "unknown": "unknown", "idle": "idle"}


def task_rows(conn: sqlite3.Connection, since_ms: Optional[int] = None,
              limit: int = 300) -> List[dict]:
    snap = _snapshot(conn)
    turns = _turn_stats(conn)
    subs_by_root: Dict[str, List[dict]] = {}
    for t in snap.values():
        if t.get("thread_type") == "subagent" and t.get("root_thread_id"):
            subs_by_root.setdefault(t["root_thread_id"], []).append(t)

    rows = []
    for t in snap.values():
        if t.get("thread_type") != "root":
            continue
        act = t["activity_ms"]
        if since_ms is not None and (act or 0) < since_ms:
            continue
        subs = subs_by_root.get(t["thread_id"], [])
        ts = turns.get(t["thread_id"], {"turns": 0, "status": "idle"})
        agg = lambda f: (t.get(f) or 0) + sum(s.get(f) or 0 for s in subs)
        uncached_sum = max(0, t["n_input"] - t["n_cached"]) + \
            sum(max(0, s["n_input"] - s["n_cached"]) for s in subs)
        rows.append({
            "thread_id": t["thread_id"],
            "name": task_name(t),
            "project": project_key(t.get("cwd")),
            "cwd": _norm_cwd(t.get("cwd")),
            "model": t.get("model") or "-",
            "effort": t.get("effort"),
            "turns": ts["turns"],
            "status": _STATUS_MAP.get(ts["status"], ts["status"]),
            "root_tokens": t["excl_total"],
            "subagent_tokens": sum(s["excl_total"] for s in subs),
            "total_tokens": t["excl_total"] + sum(s["excl_total"] for s in subs),
            "uncached_tokens": uncached_sum,
            "cached_tokens": agg("n_cached"),
            "output_tokens": agg("n_output"),
            "samples": agg("s"), "wait": agg("w"), "rebroadcast": agg("rb"),
            "subagents": len(subs), "compactions": agg("comp"),
            "peak_context": max([t.get("pc") or 0] + [s.get("pc") or 0 for s in subs]),
            "patches": (t.get("patches") or 0) + sum(s.get("patches") or 0 for s in subs),
            "activity_ms": act,
            "schema_ok": all((x.get("sc") or "ok") == "ok" for x in [t, *subs]),
        })
    rows.sort(key=lambda r: r["activity_ms"] or 0, reverse=True)
    return rows[:limit]


def day_summary(conn: sqlite3.Connection, date: Optional[str] = None) -> dict:
    import time as _time
    day = date or local_date(int(_time.time() * 1000))
    rows = [r for r in task_rows(conn) if local_date(r["activity_ms"]) == day]
    tot = {
        "tasks": len(rows),
        "root": sum(r["root_tokens"] for r in rows),
        "sub": sum(r["subagent_tokens"] for r in rows),
        "total": sum(r["total_tokens"] for r in rows),
        "uncached": sum(r["uncached_tokens"] for r in rows),
        "output": sum(r["output_tokens"] for r in rows),
        "samples": sum(r["samples"] for r in rows),
        "wait": sum(r["wait"] for r in rows),
    }
    return {"date": day, "tasks": rows, "totals": tot}


def project_rows(conn: sqlite3.Connection, since_ms: Optional[int] = None) -> List[dict]:
    rows = task_rows(conn, since_ms=since_ms, limit=100000)
    by: Dict[str, dict] = {}
    for r in rows:
        k = r["project"]
        p = by.setdefault(k, {
            "project": k, "cwd": r["cwd"], "tasks": 0, "root_tokens": 0, "subagent_tokens": 0,
            "total_tokens": 0, "uncached_tokens": 0, "output_tokens": 0, "samples": 0,
            "wait": 0, "subagents": 0, "compactions": 0, "models": set(),
            "last_active_ms": 0, "schema_ok": True,
        })
        p["tasks"] += 1
        for f in ("root_tokens", "subagent_tokens", "total_tokens", "uncached_tokens",
                  "output_tokens", "samples", "wait", "subagents", "compactions"):
            p[f] += r[f]
        p["models"].add(r["model"])
        p["last_active_ms"] = max(p["last_active_ms"], r["activity_ms"] or 0)
        p["schema_ok"] = p["schema_ok"] and r["schema_ok"]
        if len(k) > 3 and k != r["cwd"]:
            p.setdefault("cwds", set()).add(r["cwd"])
    out = list(by.values())
    for p in out:
        p["models"] = sorted(p["models"])
        p["cwds"] = sorted(p.pop("cwds", set()))
    out.sort(key=lambda p: p["last_active_ms"], reverse=True)
    return out


def task_detail(conn: sqlite3.Connection, id_or_prefix: str) -> Optional[dict]:
    snap = _snapshot(conn)
    tid = None
    if id_or_prefix in snap:
        tid = id_or_prefix
    else:
        hits = [k for k in snap if k.startswith(id_or_prefix)]
        if len(hits) == 1:
            tid = hits[0]
    if tid is None:
        return None
    t = snap[tid]
    root_id = t.get("root_thread_id") or tid
    root = snap.get(root_id, t)
    subs = [s for s in snap.values()
            if s.get("root_thread_id") == root_id and s.get("thread_type") == "subagent"]
    subs.sort(key=lambda s: s.get("created_ms") or 0)

    def header(x: dict) -> dict:
        return {
            "thread_id": x["thread_id"], "thread_type": x.get("thread_type"),
            "agent_nickname": x.get("agent_nickname"), "depth": x.get("depth"),
            "forked_from_id": x.get("forked_from_id"),
            "inherited_baseline": x.get("inherited_baseline"),
            "baseline_verified": x.get("baseline_verified"),
            "model": x.get("model"), "effort": x.get("effort"),
            "cli_version": x.get("cli_version"), "cwd": _norm_cwd(x.get("cwd")),
            "git_origin_url": x.get("git_origin_url"), "git_branch": x.get("git_branch"),
            "created_ms": x.get("created_ms"),
            "updated_ms": x.get("updated_ms") or x.get("last_event_ms"),
            "tokens_used_state": x.get("tokens_used_state"),
        }

    def tokens(x: dict) -> dict:
        return {
            "input": x.get("fi") or 0, "cached": x.get("fc") or 0,
            "uncached": x["excl_uncached"], "cache_write": x.get("fcw") or 0,
            "output": x.get("fo") or 0, "reasoning": x.get("fr") or 0,
            "total": x["excl_total"],
        }

    def diag(x: dict) -> dict:
        return {
            "samples": x.get("s") or 0, "wait": x.get("w") or 0,
            "rebroadcast": x.get("rb") or 0, "tool_calls": x.get("tool_calls") or 0,
            "tool_output_bytes": x.get("tool_output_bytes") or 0,
            "patches": x.get("patches") or 0, "compactions": x.get("comp") or 0,
            "peak_context": x.get("pc"), "model_context_window": x.get("model_context_window"),
            "schema_compat": x.get("sc") or "ok",
        }

    turns = []
    for r in conn.execute("""SELECT * FROM turns WHERE thread_id=? AND turn_index>=0
                             ORDER BY turn_index""", (root_id,)):
        d = dict(r)
        if d.get("status") == "active" and d.get("usage_start_json"):
            try:
                s = json.loads(d["usage_start_json"])
                e = json.loads(d.get("usage_end_json") or "{}")
                g = lambda x, k: max(0, int(x.get(k) or 0))
                d["input_tokens"] = g(e, "input_tokens") - g(s, "input_tokens")
                d["cached_input_tokens"] = g(e, "cached_input_tokens") - g(s, "cached_input_tokens")
                d["output_tokens"] = g(e, "output_tokens") - g(s, "output_tokens")
                d["reasoning_tokens"] = g(e, "reasoning_output_tokens") - g(s, "reasoning_output_tokens")
                d["total_tokens"] = g(e, "total_tokens") - g(s, "total_tokens")
            except json.JSONDecodeError:
                pass
        turns.append(d)

    warnings = []
    for x in [root, *subs]:
        if (x.get("sc") or "ok") != "ok":
            warnings.append(f"线程 {x['thread_id'][:8]} schema_incompatible → Token 非 authoritative")
        try:
            eps = json.loads(x.get("ep") or "[]")
            if len(eps) > 1:
                sums = sum(e - f for f, e in eps)
                warnings.append(f"线程 {x['thread_id'][:8]} 跨 {len(eps)} 个独立计数会话，"
                                f"Σ区间 {sums:,}（高水位口径可能少计）")
        except (json.JSONDecodeError, TypeError):
            pass
        if x.get("forked_from_id") and not x.get("baseline_verified"):
            warnings.append(f"线程 {x['thread_id'][:8]} 为 fork（基线 {x.get('inherited_baseline') or 0:,}，未验证）")

    ts = _turn_stats(conn).get(root_id, {"turns": 0, "status": "idle"})
    return {
        "header": header(root), "tokens": tokens(root), "diag": diag(root),
        "status": _STATUS_MAP.get(ts["status"], ts["status"]),
        "subagents": [{"header": header(s), "tokens": tokens(s), "diag": diag(s)} for s in subs],
        "turns": turns[:100],
        "warnings": warnings,
        "task_totals": {
            "root_tokens": root["excl_total"],
            "subagent_tokens": sum(s["excl_total"] for s in subs),
            "total_tokens": root["excl_total"] + sum(s["excl_total"] for s in subs),
        },
    }


def status_info(conn: sqlite3.Connection) -> dict:
    meta = {r[0]: r[1] for r in conn.execute("SELECT key, value FROM meta")}
    counts: Dict[str, int] = {}
    for r in conn.execute("SELECT COALESCE(thread_type,'unknown') ty, COUNT(*) n "
                          "FROM threads GROUP BY ty"):
        counts[r["ty"]] = r["n"]
    tot = conn.execute("""SELECT COALESCE(SUM(usage_bearing_samples),0) s,
                                 COALESCE(SUM(wait_status_model_calls),0) w,
                                 COALESCE(SUM(rebroadcast_events),0) rb
                          FROM threads_diag""").fetchone()
    schema_issues = conn.execute(
        "SELECT COUNT(*) FROM threads_diag WHERE schema_compat!='ok'").fetchone()[0]
    files = conn.execute("SELECT COUNT(*), SUM(status='active') FROM rollout_files").fetchone()
    return {
        "last_update_ms": int(meta.get("last_update_ms") or 0),
        "codex_version": meta.get("codex_version") or "?",
        "model": meta.get("model") or "?",
        "state_db": meta.get("state_db") or "?",
        "counts": counts,
        "totals": {"samples": tot[0], "wait": tot[1], "rebroadcast": tot[2]},
        "schema_issues": schema_issues,
        "rollout_files": {"total": files[0] or 0, "active": files[1] or 0},
    }

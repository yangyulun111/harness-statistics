"""metrics.json v2 组装：从 Ledger Contract（collector.sqlite）+ grader + timeline 生成五组指标。

协议要点（docs/protocol.md）：
  - usage_source 固定 rollout_cumulative；authoritative = 唯一线程绑定 ∧ 全部线程 schema_compat=ok
    ∧ 任务域内无未验证 fork 基线；主 Token 指标非 authoritative 的 run 不得进入正式 Baseline；
  - 任务 Token = root exclusive（累计 − fork 继承基线）+ Σ 子代理 exclusive；
  - Failure Recovery v2：可恢复失败（turn had_error/aborted）→ 下一次 workspace 内成功 patch；grader 终局失败 → terminal_failure=true, recovery=null。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time as _time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import sys
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from ledger.collector import connect, normcase  # noqa: E402

USAGE_SOURCE = "rollout_cumulative"

# 时变价格目录（默认仓库根 model_prices.json；HS_PRICES 可覆盖）。成本为 estimated 参考口径，
# Token 永远是主口径；目录哈希钉入 metrics.json，保证跨 run / A/B 可复现（促销调价不失真）。
PRICE_PATH = Path(__import__("os").environ.get("HS_PRICES", str(PROJECT_ROOT / "model_prices.json")))


def _parse_time_ms(v) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _load_prices(path: Path = PRICE_PATH) -> Optional[List[Dict]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    entries = []
    for e in raw.get("entries", []):
        model = str(e.get("model", "")).strip()
        if not model:
            continue
        entries.append({
            "model": model,
            "from": _parse_time_ms(e["effective_from"]),
            "to": _parse_time_ms(e["effective_to"]) if e.get("effective_to") is not None else None,
            "currency": str(e.get("currency", "USD")),
            "in": float(e.get("input_per_mtok", 0) or 0),
            "cached": float(e.get("cached_input_per_mtok", 0) or 0),
            "out": float(e.get("output_per_mtok", 0) or 0),
            "cw": float(e["cache_write_per_mtok"]) if e.get("cache_write_per_mtok") is not None else None,
            "source": e.get("source"),
        })
    return entries or None


def _resolve_price(entries: List[Dict], model: str, ts_ms: int) -> Optional[Dict]:
    def pick(m: str) -> Optional[Dict]:
        best = None
        for e in entries:
            if e["model"] != m or e["from"] > ts_ms:
                continue
            if e["to"] is not None and e["to"] <= ts_ms:
                continue
            if best is None or e["from"] > best["from"]:
                best = e
        return best

    exact = pick(model)
    if exact:
        return exact
    best = None  # 前缀匹配（模型日期后缀变体），取最长前缀
    for e in entries:
        if e["model"] == model or not model.startswith(e["model"]):
            continue
        cand = pick(e["model"])
        if cand and (best is None or len(e["model"]) > len(best["model"])):
            best = {**cand, "model": e["model"]}
    return best


def _cost_est(conn: sqlite3.Connection, threads: List[sqlite3.Row]) -> Dict:
    entries = _load_prices()
    if not entries:
        return {"available": False, "path": str(PRICE_PATH)}
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    now_ms = int(_time.time() * 1000)
    tot = {"input": 0.0, "cached": 0.0, "cache_write": 0.0, "output": 0.0}
    currency, missing, sources = "USD", [], []
    for t in threads:
        model = t["model"] or ""
        for r in conn.execute(
            """SELECT started_ms, completed_ms, input_tokens, cached_input_tokens,
                      cache_write_tokens, output_tokens FROM turns WHERE thread_id=?""",
            (t["thread_id"],),
        ).fetchall():
            if (r["input_tokens"] or 0) + (r["cached_input_tokens"] or 0) + (r["cache_write_tokens"] or 0) + (r["output_tokens"] or 0) <= 0:
                continue
            e = _resolve_price(entries, model, r["started_ms"] or r["completed_ms"] or now_ms)
            if e is None:
                if model and model not in missing:
                    missing.append(model)
                continue
            currency = e["currency"]
            tot["input"] += (r["input_tokens"] or 0) * e["in"] / 1e6
            tot["cached"] += (r["cached_input_tokens"] or 0) * e["cached"] / 1e6
            tot["cache_write"] += (r["cache_write_tokens"] or 0) * (e["cw"] if e["cw"] is not None else e["in"]) / 1e6
            tot["output"] += (r["output_tokens"] or 0) * e["out"] / 1e6
            if e["source"] and e["source"] not in sources:
                sources.append(e["source"])
    priced = tot["input"] + tot["cached"] + tot["cache_write"] + tot["output"]
    if priced <= 0:
        return {"available": True, "total": None, "missing_models": missing,
                "catalog_digest": digest, "path": str(PRICE_PATH)}
    return {
        "available": True, "currency": currency,
        "total": round(priced, 4),
        "components": {k: round(v, 4) for k, v in tot.items()},
        "missing_models": missing, "sources": sources,
        "catalog_digest": digest, "path": str(PRICE_PATH),
    }


def _task_threads(conn: sqlite3.Connection, thread_id: str) -> Tuple[sqlite3.Row, List[sqlite3.Row]]:
    row = conn.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
    if row is None:
        raise LookupError(f"thread {thread_id} 不在 ledger 中")
    root_id = row["root_thread_id"] or row["thread_id"]
    root = conn.execute("SELECT * FROM threads WHERE thread_id=?", (root_id,)).fetchone()
    subs = conn.execute("""SELECT * FROM threads WHERE root_thread_id=? AND thread_type='subagent'
                           ORDER BY created_ms""", (root_id,)).fetchall()
    return root, subs


def _exclusive(d: sqlite3.Row, t: sqlite3.Row) -> Dict[str, int]:
    base = t["inherited_baseline"] or 0
    out = {}
    for f, col in (("input_tokens", "final_input"), ("cached_input_tokens", "final_cached"),
                   ("cache_write_tokens", "final_cache_write"), ("output_tokens", "final_output"),
                   ("reasoning_tokens", "final_reasoning"), ("total_tokens", "final_total")):
        out[f] = max(0, ((d[col] or 0) if d else 0) - (base if f == "total_tokens" else 0))
    return out


def _sum_usage(rows: List[Tuple[sqlite3.Row, sqlite3.Row]]) -> Dict[str, int]:
    agg = {k: 0 for k in ("input_tokens", "cached_input_tokens", "cache_write_tokens",
                          "output_tokens", "reasoning_tokens", "total_tokens")}
    for d, t in rows:
        e = _exclusive(d, t)
        for k in agg:
            agg[k] += e[k]
    agg["uncached_input_tokens"] = max(0, agg["input_tokens"] - agg["cached_input_tokens"])
    return agg


def build(run_id: str, task_id: str, repeat: int, workspace: Path,
          t0_ms: int, t_end_ms: int, grade: dict,
          thread_id: Optional[str], attribution: str,
          timeline: Optional[Path] = None, out_path: Optional[Path] = None) -> dict:
    conn = connect()
    m = {
        "run_id": run_id, "task_id": task_id, "repeat": repeat,
        "workspace": str(workspace),
        "t0_ms": t0_ms, "t_end_ms": t_end_ms,
        "thread_id": thread_id, "attribution": attribution,   # unique | ambiguous | none
        "usage_source": USAGE_SOURCE,
        "authoritative": False,
        "quality": {"test_pass_rate": None, "task_completed": None,
                    "manual_score": None, "terminal_failure": False},
        "tokens": {}, "turns": [],
        "cost": {"available": False},
        "orchestration": {"user_turns": None, "usage_bearing_samples": None,
                          "wait_status_model_calls": None, "rebroadcast_events": None,
                          "subagents": None, "retries": None, "wait_tokens_est": None,
                          "classification_version": None},
        "context": {"peak_context_tokens": None, "model_context_window": None,
                    "compactions": None, "tool_output_bytes": None},
        "performance": {"total_ms": t_end_ms - t0_ms, "ttft_ms_first": None,
                        "time_to_first_patch_ms": None, "failure_recovery_ms": None},
    }
    if grade:
        total = grade.get("total") or 0
        m["quality"]["test_pass_rate"] = (grade.get("passed") / total) if total else None
        m["quality"]["task_completed"] = bool(grade.get("success"))
        m["quality"]["terminal_failure"] = not bool(grade.get("success"))
    if grade and not grade.get("success"):
        pass  # terminal_failure 已置；recovery 保持 null（grader 是终局评估）

    if thread_id and attribution == "unique":
        root, subs = _task_threads(conn, thread_id)
        pairs = []
        for t in [root, *subs]:
            d = conn.execute("SELECT * FROM threads_diag WHERE thread_id=?", (t["thread_id"],)).fetchone()
            pairs.append((d, t))
        m["tokens"] = _sum_usage(pairs)

        # turns（root 的用户视角轮次）
        turns = conn.execute("""SELECT * FROM turns WHERE thread_id=? AND turn_index>=0
                                ORDER BY turn_index""", (root["thread_id"],)).fetchall()
        m["turns"] = [{
            "turn_index": r["turn_index"], "started_ms": r["started_ms"],
            "duration_ms": r["duration_ms"], "ttft_ms": r["ttft_ms"], "status": r["status"],
            "input_tokens": r["input_tokens"], "cached_input_tokens": r["cached_input_tokens"],
            "uncached_input_tokens": max(0, (r["input_tokens"] or 0) - (r["cached_input_tokens"] or 0)),
            "output_tokens": r["output_tokens"], "reasoning_tokens": r["reasoning_tokens"],
            "usage_bearing_samples": r["usage_bearing_samples"],
            "wait_status_model_calls": r["wait_status_model_calls"],
            "patches": r["patches"], "compactions": r["compactions"],
        } for r in turns]

        o = m["orchestration"]
        o["user_turns"] = len(turns)
        o["usage_bearing_samples"] = sum((d["usage_bearing_samples"] or 0) for d, _ in pairs)
        o["wait_status_model_calls"] = sum((d["wait_status_model_calls"] or 0) for d, _ in pairs)
        # wait/status Token 估算（estimated：采样占比≈消耗占比；任务域=root+子代理）
        wait_tok = 0
        for t in [root, *subs]:
            for r in conn.execute(
                """SELECT total_tokens, usage_bearing_samples, wait_status_model_calls FROM turns
                   WHERE thread_id=? AND usage_bearing_samples>0 AND wait_status_model_calls>0""",
                (t["thread_id"],),
            ).fetchall():
                wait_tok += round((r["total_tokens"] or 0) * min(1.0, r["wait_status_model_calls"] / r["usage_bearing_samples"]))
        o["wait_tokens_est"] = wait_tok
        # 成本（estimated · 按时点价；目录哈希钉入，A/B 可复现）
        m["cost"] = _cost_est(conn, [root, *subs])
        o["rebroadcast_events"] = sum((d["rebroadcast_events"] or 0) for d, _ in pairs)
        o["subagents"] = len(subs)
        o["retries"] = sum(1 for r in turns if r["had_error"] or r["status"] == "aborted")
        o["retries"] += sum(1 for s in subs
                            for r in conn.execute(
                                "SELECT had_error, status FROM turns WHERE thread_id=? AND turn_index>=0",
                                (s["thread_id"],)).fetchall()
                            if r["had_error"] or r["status"] == "aborted")
        d0 = conn.execute("SELECT classification_version FROM threads_diag WHERE thread_id=?",
                          (root["thread_id"],)).fetchone()
        o["classification_version"] = d0["classification_version"] if d0 else None

        c = m["context"]
        c["peak_context_tokens"] = max((d["peak_context"] or 0) for d, _ in pairs) if pairs else None
        c["model_context_window"] = max((d["model_context_window"] or 0) for d, _ in pairs) if pairs else None
        c["compactions"] = sum((d["compactions"] or 0) for d, _ in pairs)
        c["tool_output_bytes"] = sum((d["tool_output_bytes"] or 0) for d, _ in pairs)

        # 性能：TTFT / TTFM / 失败恢复
        ws_norm = normcase(str(workspace))
        ttfts = [r["ttft_ms"] for r in turns if r["ttft_ms"]]
        m["performance"]["ttft_ms_first"] = ttfts[0] if ttfts else None

        patch_ts = []
        for t in [root, *subs]:
            for r in conn.execute("""SELECT first_patch_ms, patch_files FROM turns
                                     WHERE thread_id=? AND first_patch_ms IS NOT NULL""",
                                  (t["thread_id"],)).fetchall():
                files = []
                try:
                    files = json.loads(r["patch_files"] or "[]")
                except json.JSONDecodeError:
                    pass
                if not files or any(normcase(f or "").startswith(ws_norm) for f in files):
                    patch_ts.append(r["first_patch_ms"])
        if patch_ts:
            first_patch = min(patch_ts)
            m["performance"]["time_to_first_patch_ms"] = max(0, first_patch - t0_ms)

        fail_ts = []
        for t in [root, *subs]:
            for r in conn.execute("""SELECT completed_ms, started_ms, had_error, status FROM turns
                                     WHERE thread_id=? AND turn_index>=0
                                       AND (had_error=1 OR status='aborted')""",
                                  (t["thread_id"],)).fetchall():
                fail_ts.append(r["completed_ms"] or r["started_ms"])
        if fail_ts and patch_ts:
            f0 = min(fail_ts)
            later = [p for p in patch_ts if p > f0]
            if later:
                m["performance"]["failure_recovery_ms"] = min(later) - f0

        # authoritative 判定
        schema_ok = all((d["schema_compat"] or "ok") == "ok" for d, _ in pairs if d)
        fork_ok = all(not t["forked_from_id"] or t["baseline_verified"] for _, t in pairs)
        m["authoritative"] = bool(schema_ok and fork_ok and pairs)
        if not schema_ok:
            m["usage_source"] = "missing"  # schema_incompatible → 禁入正式 Baseline

    conn.close()

    if timeline and timeline.is_file():
        try:
            first_ev = None
            for line in timeline.read_text(encoding="utf-8").splitlines():
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("type") in ("file_add", "file_change", "file_delete"):
                    first_ev = rec.get("t_ms")
                    break
            if first_ev and m["performance"]["time_to_first_patch_ms"] is None:
                m["performance"]["time_to_first_patch_ms"] = max(0, first_ev - t0_ms)
        except OSError:
            pass

    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    return m

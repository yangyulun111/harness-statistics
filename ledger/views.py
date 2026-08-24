"""CLI 视图：today / tasks / task / turns / threads / reconcile。

所有 Token 数字都是服务端权威值（rollout token_count 差分），无估算。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional

from . import discovery as _disc
from .collector import connect
from .timeutil import fmt_dt, fmt_duration, fmt_hm, local_date, to_ms


def _utf8_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def fmt_tok(n: Optional[int]) -> str:
    if n is None:
        return "-"
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if abs(n) >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _task_name(row) -> str:
    for k in ("name", "title"):
        v = row[k]
        if v:
            return str(v).strip().replace("\n", " ")[:46]
    v = row["preview"] or row["first_user_message"] or ""
    return str(v).strip().replace("\n", " ")[:46]


def _resolve_thread(conn: sqlite3.Connection, id_or_prefix: str) -> Optional[sqlite3.Row]:
    row = conn.execute("SELECT * FROM threads WHERE thread_id=?", (id_or_prefix,)).fetchone()
    if row:
        return row
    like = id_or_prefix.replace("%", "").replace("_", "") + "%"
    hits = conn.execute("SELECT * FROM threads WHERE thread_id LIKE ? LIMIT 5", (like,)).fetchall()
    if len(hits) == 1:
        return hits[0]
    if not hits:
        print(f"未找到线程：{id_or_prefix}")
    else:
        print(f"前缀不唯一（{len(hits)} 个），请补全：")
        for h in hits:
            print(f"  {h['thread_id']}  {_task_name(h)}")
    return None


def _thread_status(conn: sqlite3.Connection, thread_id: str) -> str:
    row = conn.execute("""SELECT status FROM turns WHERE thread_id=? AND turn_index>=0
                          ORDER BY turn_index DESC LIMIT 1""", (thread_id,)).fetchone()
    if row is None:
        return "idle"
    return {"completed": "completed", "aborted": "interrupted",
            "active": "possibly_active", "unknown": "unknown"}.get(row["status"], row["status"])


def _task_rows(conn: sqlite3.Connection, since_ms: Optional[int], limit: int = 50):
    q = """SELECT t.*, tu.root_tokens, tu.subagent_count, tu.subagent_tokens, tu.total_tokens,
                  COALESCE(d.usage_bearing_samples,0) mc, COALESCE(d.wait_status_model_calls,0) we,
                  COALESCE(d.rebroadcast_events,0) rb,
                  COALESCE(d.peak_context,0) pc, COALESCE(d.compactions,0) comp,
                  (SELECT COUNT(*) FROM turns y WHERE y.thread_id=t.thread_id AND y.turn_index>=0) turns
           FROM threads t
           LEFT JOIN task_usage tu ON tu.root_thread_id = t.thread_id
           LEFT JOIN threads_diag d ON d.thread_id = t.thread_id
           WHERE t.thread_type='root'"""
    args: List = []
    if since_ms is not None:
        q += " AND COALESCE(t.last_event_ms, t.updated_ms, t.created_ms) >= ?"
        args.append(since_ms)
    q += " ORDER BY COALESCE(t.last_event_ms, t.updated_ms, t.created_ms) DESC LIMIT ?"
    args.append(limit)
    return conn.execute(q, args).fetchall()


def cmd_today(conn: sqlite3.Connection, date: Optional[str] = None):
    _utf8_stdout()
    day = date or local_date(to_ms(__import__("time").time()))
    rows = _task_rows(conn, since_ms=None, limit=500)
    rows = [r for r in rows
            if local_date(r["last_event_ms"] or r["updated_ms"] or r["created_ms"]) == day]
    if not rows:
        print(f"{day}：没有匹配的根任务（先运行 `python -m ledger update`）。")
        return
    print(f"{day} — Codex 任务（{len(rows)} 个）")
    print("-" * 100)
    print(f"{'时间':<6}{'任务':<48}{'Token':>9}  {'模型':<12}{'轮':>3}{'调用':>5}{'等待':>5}{'子代':>4}  状态")
    print("-" * 100)
    agg = dict(root=0, sub=0, total=0, cached=0, calls=0, wait=0)
    for r in rows:
        ts = fmt_hm(r["last_event_ms"] or r["updated_ms"] or r["created_ms"])
        print(f"{ts:<6}{_task_name(r):<48}{fmt_tok(r['total_tokens']):>9}  "
              f"{(r['model'] or '-')[:12]:<12}{r['turns'] or 0:>3}{r['mc'] or 0:>5}"
              f"{r['we'] or 0:>5}{r['subagent_count'] or 0:>4}  {_thread_status(conn, r['thread_id'])}")
        agg["root"] += r["root_tokens"] or 0
        agg["sub"] += r["subagent_tokens"] or 0
        agg["total"] += r["total_tokens"] or 0
        agg["calls"] += r["mc"] or 0
        agg["wait"] += r["we"] or 0
    print("-" * 100)
    print(f"合计：任务 {len(rows)}  Root {fmt_tok(agg['root'])}  子代理 {fmt_tok(agg['sub'])}  "
          f"总 {fmt_tok(agg['total'])}  model calls {agg['calls']}  wait/status {agg['wait']}")


def cmd_tasks(conn: sqlite3.Connection, days: int = 7, limit: int = 50):
    _utf8_stdout()
    since = to_ms(__import__("time").time() - days * 86400) if days else None
    rows = _task_rows(conn, since_ms=since, limit=limit)
    print(f"根任务（近 {days} 天，{len(rows)} 个）")
    print("-" * 118)
    print(f"{'日期':<12}{'任务':<46}{'项目':<24}{'Token':>9}{'轮':>3}{'调用':>5}{'等待':>5}{'子代':>4}{'峰值ctx':>9}  状态")
    for r in rows:
        d = local_date(r["last_event_ms"] or r["updated_ms"] or r["created_ms"]) or "-"
        proj = r["cwd"] or "-"
        if proj[0:1] == "\\" and proj[2:3] == "?":  # \\?\ Windows extended path prefix
            proj = proj[4:]
        proj = (Path(proj).name if proj and proj != "-" else "-")[:24]
        print(f"{d:<12}{_task_name(r):<46}{proj:<24}{fmt_tok(r['total_tokens']):>9}"
              f"{r['turns'] or 0:>3}{r['mc'] or 0:>5}{r['we'] or 0:>5}{r['subagent_count'] or 0:>4}"
              f"{fmt_tok(r['pc'] or 0):>9}  {_thread_status(conn, r['thread_id'])}")


def cmd_task(conn: sqlite3.Connection, id_or_prefix: str, show_turns: bool = False):
    _utf8_stdout()
    row = _resolve_thread(conn, id_or_prefix)
    if row is None:
        return
    tid = row["thread_id"]
    print(f"任务 {_task_name(row)}")
    print(f"  thread_id   : {tid}")
    print(f"  root/depth  : {row['root_thread_id'] or '(根)'} / {row['depth']}"
          f"   type={row['thread_type']}  status={_thread_status(conn, tid)}")
    print(f"  项目/目录   : {row['cwd']}")
    if row["git_origin_url"]:
        print(f"  git         : {row['git_origin_url']} @ {row['git_branch'] or '-'}")
    print(f"  模型        : {row['model']}  effort={row['effort']}  cli={row['cli_version']}")
    print(f"  创建/最近   : {fmt_dt(row['created_ms'])} → {fmt_dt(row['updated_ms'] or row['last_event_ms'])}")
    if row["tokens_used_state"] is not None:
        print(f"  state累计   : {row['tokens_used_state']:,}")

    d = conn.execute("SELECT * FROM threads_diag WHERE thread_id=?", (tid,)).fetchone()
    if d:
        print("\n  Token 账目（本线程，累计差分）")
        print(f"    input={d['final_input']:,}  cached={d['final_cached']:,}  "
              f"uncached={max(0, (d['final_input'] or 0) - (d['final_cached'] or 0)):,}")
        print(f"    output={d['final_output']:,}（含 reasoning {d['final_reasoning']:,}）  "
              f"total={d['final_total']:,}")
        print(f"    peak_context={fmt_tok(d['peak_context'])}"
              f"{'/' + fmt_tok(d['model_context_window']) if d['model_context_window'] else ''}"
              f"  compactions={d['compactions']}  patches={d['patches']}")
        print(f"    采样(usage-bearing)={d['usage_bearing_samples']}  wait/status={d['wait_status_model_calls']}  "
              f"rebroadcast={d['rebroadcast_events']}  "
              f"tool_calls={d['tool_calls']}  tool_output={fmt_tok(d['tool_output_bytes'])}B")
        if d["schema_compat"] and d["schema_compat"] != "ok":
            print(f"    [!] schema_compat={d['schema_compat']}  issues={d['schema_issues']}"
                  f"  → Token 指标 authoritative=false")
        if d["file_usage_epochs"]:
            try:
                epochs = json.loads(d["file_usage_epochs"])
                if len(epochs) > 1:
                    sums = sum(e - f for f, e in epochs)
                    excl = (d["final_total"] or 0) - (row["inherited_baseline"] or 0)
                    under = max(0, sums - excl)
                    print(f"    [!] 跨文件独立计数会话 {len(epochs)} 个：Σ区间={sums:,} vs 线程口径={excl:,}"
                          f"（高水位语义与 state 一致，但真实消耗可能少计 ~{fmt_tok(under)}，"
                          f"采样数同样受高水位压制）")
            except (json.JSONDecodeError, TypeError):
                pass

    # 子代理树
    subs = conn.execute("""SELECT th.*, COALESCE(d.final_total,0) tok,
                                  COALESCE(d.final_total,0) - COALESCE(th.inherited_baseline,0) excl,
                                  COALESCE(d.usage_bearing_samples,0) mc
                           FROM threads th LEFT JOIN threads_diag d ON d.thread_id=th.thread_id
                           WHERE th.root_thread_id=? AND th.thread_type='subagent'
                           ORDER BY th.created_ms""", (tid,)).fetchall()
    if subs:
        print(f"\n  子代理（{len(subs)} 个，Token 归集到本任务）")
        for s in subs:
            nick = s["agent_nickname"] or s["agent_role"] or "agent"
            print(f"    [{nick}]{'  depth=' + str(s['depth']) if s['depth'] and s['depth'] > 1 else ''}"
                  f"  {fmt_tok(s['tok']):>9} tok  {s['mc']} samples  {s['thread_id'][:8]}")
        root_tok = max(0, ((d["final_total"] if d else 0) or 0) - (row["inherited_baseline"] or 0))
        sub_tok = sum(s["excl"] for s in subs)
        print(f"    {'─' * 44}")
        print(f"    Root {fmt_tok(root_tok):>9} + 子代理 {fmt_tok(sub_tok):>9} = 任务总 Token {fmt_tok(root_tok + sub_tok):>9}")
    if row["forked_from_id"]:
        print(f"\n  [fork] forked_from={row['forked_from_id'][:8]}  "
              f"inherited_baseline={row['inherited_baseline'] or 0:,}"
              f"{'(未验证)' if not row['baseline_verified'] else ''}"
              f"  exclusive={fmt_tok(max(0, (d['final_total'] if d else 0) - (row['inherited_baseline'] or 0)))}")
    _print_turns(conn, tid)
    if show_turns:
        pass  # turns 已默认展示


def _print_turns(conn: sqlite3.Connection, tid: str):
    rows = conn.execute("""SELECT * FROM turns WHERE thread_id=? AND turn_index>=0
                           ORDER BY turn_index""", (tid,)).fetchall()
    if not rows:
        return
    print(f"\n  Turns（{len(rows)}）")
    print(f"    {'#':>3}{'开始':<7}{'耗时':<9}{'TTFT':<8}{'input':>9}{'cached':>9}{'out':>8}"
          f"{'rsn':>8}{'采样':>5}{'等待':>5}{'补丁':>4}{'压缩':>4}  状态/预览")
    for r in rows:
        started = fmt_hm(r["started_ms"])
        in_tok = r["input_tokens"]
        if r["status"] == "active":  # 活跃 turn 用快照现算
            diff = _live_diff(r)
            in_tok, cached, out, rsn, tot = diff
        else:
            cached, out, rsn, tot = (r["cached_input_tokens"], r["output_tokens"],
                                     r["reasoning_tokens"], r["total_tokens"])
            in_tok = r["input_tokens"]
        preview = (r["user_preview"] or "").replace("\n", " ")[:36]
        err = " ✗" if r["had_error"] else ""
        print(f"    {r['turn_index']:>3}{started:<7}{fmt_duration(r['duration_ms']):<9}"
              f"{fmt_duration(r['ttft_ms']):<8}{fmt_tok(in_tok):>9}{fmt_tok(cached):>9}{fmt_tok(out):>8}"
              f"{fmt_tok(rsn):>8}{r['usage_bearing_samples'] or 0:>5}{r['wait_status_model_calls'] or 0:>5}"
              f"{r['patches'] or 0:>4}{r['compactions'] or 0:>4}  {r['status']}{err} {preview}")


def _live_diff(r: sqlite3.Row):
    try:
        s = json.loads(r["usage_start_json"] or "{}")
        e = json.loads(r["usage_end_json"] or "{}")
    except json.JSONDecodeError:
        s, e = {}, {}
    g = lambda d, k: max(0, int((d.get(k) or 0)) )
    return (g(e, "input_tokens") - g(s, "input_tokens"),
            g(e, "cached_input_tokens") - g(s, "cached_input_tokens"),
            g(e, "output_tokens") - g(s, "output_tokens"),
            g(e, "reasoning_output_tokens") - g(s, "reasoning_output_tokens"),
            g(e, "total_tokens") - g(s, "total_tokens"))


def cmd_projects(conn: sqlite3.Connection, days: int = 30):
    """项目级聚合（CLI 视图，与 Web /api/projects 同源 queries.project_rows）。"""
    _utf8_stdout()
    from . import queries as _q
    since = to_ms(__import__("time").time() - days * 86400)
    projects = _q.project_rows(conn, since_ms=since)
    if not projects:
        print(f"近 {days} 天没有根任务。")
        return
    print(f"项目聚合（近 {days} 天，{len(projects)} 个项目）")
    print("-" * 112)
    print(f"{'项目':<22}{'任务':>4}{'总Token':>10}{'root':>9}{'子代理':>9}{'未缓存':>9}"
          f"{'输出':>8}{'采样':>6}{'wait':>5}{'子代':>4}  最近活跃")
    print("-" * 112)
    for p in projects:
        print(f"{p['project'][:22]:<22}{p['tasks']:>4}{fmt_tok(p['total_tokens']):>10}"
              f"{fmt_tok(p['root_tokens']):>9}{fmt_tok(p['subagent_tokens']):>9}"
              f"{fmt_tok(p['uncached_tokens']):>9}{fmt_tok(p['output_tokens']):>8}"
              f"{p['samples']:>6}{p['wait']:>5}{p['subagents']:>4}  "
              f"{fmt_dt(p['last_active_ms'])}")
        for cwd in p["cwds"][:2]:
            print(f"    · {cwd[:80]}")


def cmd_threads(conn: sqlite3.Connection, days: int = 7):
    _utf8_stdout()
    since = to_ms(__import__("time").time() - days * 86400) if days else None
    q = """SELECT t.thread_id, t.thread_type, t.depth, t.root_thread_id, t.agent_nickname,
                  t.model, t.created_ms, t.last_event_ms, COALESCE(d.final_total,0) tok,
                  COALESCE(d.usage_bearing_samples,0) mc
           FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id"""
    args: List = []
    if since is not None:
        q += " WHERE COALESCE(t.last_event_ms, t.created_ms) >= ?"
        args.append(since)
    q += " ORDER BY COALESCE(t.last_event_ms, t.created_ms) DESC LIMIT 300"
    for r in conn.execute(q, args):
        print(f"{r['thread_id'][:8]}  {r['thread_type']:<9}d{r['depth'] if r['depth'] is not None else '-'}  "
              f"{fmt_tok(r['tok']):>9} tok {r['mc']:>4} calls  "
              f"{(r['agent_nickname'] or r['model'] or '-')[:16]:<16}"
              f"  root={r['root_thread_id'][:8] if r['root_thread_id'] else '(root)'}")


def cmd_reconcile(conn: sqlite3.Connection, days: int = 30):
    """对账：ledger 差分累计 vs state DB threads.tokens_used（应一致或差异可解释）。"""
    _utf8_stdout()
    since = to_ms(__import__("time").time() - days * 86400)
    rows = conn.execute("""SELECT t.thread_id, t.tokens_used_state, COALESCE(d.final_total,0) ledger_total,
                                  COALESCE(d.usage_bearing_samples,0) mc, COALESCE(d.token_count_events,0) tc
                           FROM threads t LEFT JOIN threads_diag d ON d.thread_id=t.thread_id
                           WHERE t.tokens_used_state IS NOT NULL
                             AND COALESCE(t.last_event_ms, t.created_ms) >= ?""", (since,)).fetchall()
    if not rows:
        print("无可对账线程。")
        return
    ok = bad = missing = 0
    worst = []
    for r in rows:
        if r["ledger_total"] == 0 and r["mc"] == 0:
            missing += 1
            continue
        diff = abs(r["ledger_total"] - r["tokens_used_state"])
        rel = diff / r["tokens_used_state"] if r["tokens_used_state"] else 0
        if rel <= 0.01:
            ok += 1
        else:
            bad += 1
            worst.append((rel, r))
    worst.sort(reverse=True)
    print(f"对账窗口 {days} 天：一致(≤1%) {ok}  超差 {bad}  未采集到rollout {missing}")
    for rel, r in worst[:10]:
        print(f"  {r['thread_id'][:8]}  state={r['tokens_used_state']:,}  ledger={r['ledger_total']:,}  "
              f"偏差={rel:.1%}  (token_count事件 {r['tc']} 次，可能原因：rollout 未写满/会话迁移)")
    print("建议另用社区解析器二次对账：`npx ccusage codex session`（见 docs/calibration.md）")


def cmd_env(write_path: Optional[str] = None):
    _utf8_stdout()
    p = _disc.discover()
    import platform
    info = {
        "codex_version": p.codex_version, "codex_home": str(p.codex_home),
        "sqlite_home": str(p.sqlite_home), "state_db": str(p.state_db or ""),
        "sessions_root": str(p.sessions_root), "model": p.model or "",
        "model_provider": p.model_provider or "", "doctor_used": p.doctor_used,
        "notes": p.notes,
        "host": {"os": platform.platform(), "python": platform.python_version(),
                 "conda_env": "harness-stats"},
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    if write_path:
        Path(write_path).write_text(json.dumps(info, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
        print(f"\n已写入 {write_path}")


def open_default_db() -> sqlite3.Connection:
    return connect()

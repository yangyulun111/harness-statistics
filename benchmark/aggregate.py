"""聚合与报告：baseline.csv + report.md + 静态 HTML 报告 v0（零新运行时）。

统计口径（v3）：
  Primary  = median + IQR（Q1/Q3）
  Secondary = mean / max / total（Token 极端消耗是真实成本，不因 heavy-tail 隐藏）
  Tokens/Successful Task = 所有 runs 的 Token 总量 / 成功 runs 数（失败消耗被惩罚）
  authoritative=false 或 attribution!=unique 的 run 不计入 Primary，单独列出。
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
METRICS_DIR = PROJECT_ROOT / "results" / "metrics"
RESULTS_DIR = PROJECT_ROOT / "results"

PRIMARY_KEYS = [
    ("quality.task_completed", "任务成功"),
    ("tokens.total_tokens", "总Token"),
    ("tokens.uncached_input_tokens", "未缓存输入"),
    ("tokens.output_tokens", "输出Token"),
    ("orchestration.usage_bearing_samples", "采样数"),
    ("orchestration.wait_status_model_calls", "wait/status"),
    ("orchestration.wait_tokens_est", "wait Token(est)"),
    ("orchestration.subagents", "子代理数"),
    ("context.peak_context_tokens", "峰值上下文"),
    ("context.compactions", "压缩次数"),
    ("performance.total_ms", "总耗时ms"),
    ("performance.time_to_first_patch_ms", "TTFM ms"),
    ("performance.ttft_ms_first", "TTFT ms"),
    ("performance.failure_recovery_ms", "恢复时间ms"),
]


def _get(m: dict, dotted: str):
    cur = m
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _fmt(v):
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "✓" if v else "✗"
    if isinstance(v, (int, float)):
        return f"{v:,.0f}" if isinstance(v, int) or (isinstance(v, float) and v == int(v)) else f"{v:.3f}"
    return str(v)


def _stats(values: List[float]) -> dict:
    vs = [v for v in values if v is not None]
    if not vs:
        return {"n": 0}
    q = statistics.quantiles(vs, n=4) if len(vs) >= 4 else None
    return {"n": len(vs), "median": statistics.median(vs), "mean": statistics.mean(vs),
            "min": min(vs), "max": max(vs), "total": sum(vs),
            "q1": q[0] if q else None, "q3": q[2] if q else None}


def load_runs() -> List[dict]:
    runs = []
    for p in sorted(METRICS_DIR.glob("*.json")):
        try:
            runs.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return runs


def merge_manual(runs: List[dict]):
    scores = {}
    csv_path = RESULTS_DIR / "manual_scores.csv"
    if csv_path.is_file():
        with open(csv_path, encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                try:
                    scores[row["run_id"]] = (int(row.get("correctness") or 0)
                                             + int(row.get("quality") or 0)
                                             + int(row.get("minimalism") or 0)) / 3.0
                except (ValueError, KeyError):
                    continue
    for r in runs:
        if r["run_id"] in scores:
            r["quality"]["manual_score"] = scores[r["run_id"]]
        r["quality"].setdefault("manual_score", None)


def aggregate() -> dict:
    runs = load_runs()
    merge_manual(runs)
    valid = [r for r in runs if r.get("authoritative") and r.get("attribution") == "unique"]
    excluded = [r for r in runs if r not in valid]

    by_task: Dict[str, List[dict]] = {}
    for r in valid:
        by_task.setdefault(r["task_id"], []).append(r)

    report = {"runs": runs, "valid": valid, "excluded": excluded,
              "per_task": {}, "overall": {}}
    for key, _label in PRIMARY_KEYS:
        report["overall"][key] = _stats([_get(r, key) for r in valid
                                         if isinstance(_get(r, key), (int, float))])
    for task_id, rs in by_task.items():
        report["per_task"][task_id] = {
            "n_runs": len(rs),
            "success_rate": sum(1 for r in rs if _get(r, "quality.task_completed")) / len(rs),
            "tokens_total": sum(_get(r, "tokens.total_tokens") or 0 for r in rs),
            "n_success": sum(1 for r in rs if _get(r, "quality.task_completed")),
            "stats": {key: _stats([_get(r, key) for r in rs
                                   if isinstance(_get(r, key), (int, float))])
                      for key, _ in PRIMARY_KEYS},
        }
    n_success = sum(1 for r in valid if _get(r, "quality.task_completed"))
    # 成本参考口径（estimated · 按时点价）：仅统计已配置价格且可计价的 runs；Token 仍为主口径
    costs = [_get(r, "cost.total") for r in valid if isinstance(_get(r, "cost.total"), (int, float))]
    report["primary"] = {
        "task_success_rate": (n_success / len(valid)) if valid else None,
        "tokens_per_successful_task": (sum(_get(r, "tokens.total_tokens") or 0 for r in valid) / n_success)
        if n_success else None,
        "median_wall_time_ms": report["overall"]["performance.total_ms"].get("median"),
        "model_calls_per_task": report["overall"]["orchestration.usage_bearing_samples"].get("median"),
        "wait_status_calls": report["overall"]["orchestration.wait_status_model_calls"].get("median"),
        "wait_tokens_est_median": report["overall"].get("orchestration.wait_tokens_est", {}).get("median"),
        "cost_per_successful_task": (sum(costs) / n_success) if (costs and n_success) else None,
        "cost_runs_priced": len(costs),
    }
    return report


def write_csv(report: dict, out: Path):
    cols = ["run_id", "task_id", "repeat", "authoritative", "attribution",
            "quality.test_pass_rate", "quality.task_completed", "quality.manual_score",
            "tokens.total_tokens", "tokens.input_tokens", "tokens.cached_input_tokens",
            "tokens.uncached_input_tokens", "tokens.cache_write_tokens",
            "tokens.output_tokens", "tokens.reasoning_tokens",
            "orchestration.user_turns", "orchestration.usage_bearing_samples",
            "orchestration.wait_status_model_calls", "orchestration.rebroadcast_events",
            "orchestration.subagents", "orchestration.retries", "orchestration.wait_tokens_est",
            "cost.total", "cost.catalog_digest",
            "context.peak_context_tokens", "context.model_context_window",
            "context.compactions", "context.tool_output_bytes",
            "performance.total_ms", "performance.ttft_ms_first",
            "performance.time_to_first_patch_ms", "performance.failure_recovery_ms"]
    with open(out, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in report["runs"]:
            w.writerow([_fmt(_get(r, c)) if "." in c else _get(r, c) for c in cols])


def write_md(report: dict, out: Path):
    L = []
    L.append("# Level-0 Baseline 报告\n")
    L.append(f"- runs：{len(report['runs'])}（有效 {len(report['valid'])}，"
             f"排除 {len(report['excluded'])}：非 authoritative / 归因歧义）\n")
    p = report["primary"]
    L.append("## Primary 指标\n")
    L.append("| 指标 | 值 |")
    L.append("|---|---|")
    L.append(f"| Task Success Rate | {_fmt(p['task_success_rate'] and round(p['task_success_rate'], 3))} |")
    L.append(f"| Tokens / Successful Task | {_fmt(p['tokens_per_successful_task'])} |")
    L.append(f"| Median Wall Time | {_fmt(p['median_wall_time_ms'])} ms |")
    L.append(f"| Model Calls / Task (median) | {_fmt(p['model_calls_per_task'])} |")
    L.append(f"| Wait/Status Calls (median) | {_fmt(p['wait_status_calls'])} |")
    L.append(f"| Wait/Status Tokens (median, estimated) | {_fmt(p.get('wait_tokens_est_median'))} |")
    if p.get("cost_per_successful_task") is not None:
        L.append(f"| Cost / Successful Task (estimated · 按时点价) | ${p['cost_per_successful_task']:.4f}（{p.get('cost_runs_priced', 0)} runs 已计价） |")
    L.append("\n")
    L.append("## 分任务\n")
    L.append("| 任务 | runs | 成功率 | Token 总量 | Tokens/成功任务 | median 耗时 | median 采样 | median wait |")
    L.append("|---|---|---|---|---|---|---|---|")
    for tid, t in sorted(report["per_task"].items()):
        tps = (t["tokens_total"] / t["n_success"]) if t["n_success"] else None
        L.append(f"| {tid} | {t['n_runs']} | {t['success_rate']:.0%} | {_fmt(t['tokens_total'])} | "
                 f"{_fmt(tps)} | {_fmt(t['stats']['performance.total_ms'].get('median'))} | "
                 f"{_fmt(t['stats']['orchestration.usage_bearing_samples'].get('median'))} | "
                 f"{_fmt(t['stats']['orchestration.wait_status_model_calls'].get('median'))} |")
    L.append("")
    if report["excluded"]:
        L.append("## 排除的 runs\n")
        for r in report["excluded"]:
            L.append(f"- {r['run_id']}：authoritative={r['authoritative']} "
                     f"attribution={r['attribution']}")
        L.append("")
    L.append("> Primary=median+IQR；Secondary（mean/max/total）见 baseline.csv 与 HTML 报告。")
    out.write_text("\n".join(L), encoding="utf-8")


def _bar_html(label: str, s: dict, unit: str = "") -> str:
    if not s or not s.get("n"):
        return f"<div class='metric'><span class='k'>{label}</span><span class='v'>-</span></div>"
    med, q1, q3, mx = s.get("median"), s.get("q1"), s.get("q3"), s.get("max")
    def pct(x): return (100 * x / mx) if mx else 0
    iqr_l, iqr_r = pct(q1 or 0), pct(q3 or 0)
    return (
        f"<div class='metric'><span class='k'>{label}</span>"
        f"<span class='dist'><span class='range' style='width:{pct(med):.1f}%'>"
        f"<span class='iqr' style='left:{iqr_l:.1f}%;width:{max(0.5, iqr_r - iqr_l):.1f}%'></span>"
        f"<span class='med' style='left:{pct(med):.1f}%'></span></span></span>"
        f"<span class='v'>{_fmt(med)}{unit}<small> IQR {_fmt(q1)}–{_fmt(q3)} · mean {_fmt(s.get('mean'))}"
        f" · max {_fmt(mx)}</small></span></div>")


def write_html(report: dict, out: Path):
    runs = report["runs"]
    cards = []
    for r in sorted(runs, key=lambda x: x["run_id"]):
        ok = r["quality"]["task_completed"]
        auth = r["authoritative"]
        amb = r["attribution"] != "unique"
        badge = ("<span class='badge red'>schema_incompatible</span>" if not auth and not amb else "")
        badge += ("<span class='badge orange'>attribution_ambiguous</span>" if amb else "")
        badge += "<span class='badge green'>authoritative</span>" if auth else ""
        turns = r.get("turns") or []
        tbars = ""
        for t in turns[:30]:
            dur = t.get("duration_ms") or 1
            wait = t.get("wait_status_model_calls") or 0
            wsamp = t.get("usage_bearing_samples") or 0
            wait_frac = min(1.0, wait / wsamp) if wsamp else 0
            comp = "◆" if t.get("compactions") else ""
            tbars += (f"<div class='turnbar'><span class='lbl'>#{t['turn_index']}</span>"
                      f"<span class='track'><span class='seg wait' style='width:{wait_frac * 100:.0f}%'></span>"
                      f"<span class='seg work' style='width:{(1 - wait_frac) * 100:.0f}%'></span></span>"
                      f"<span class='dur'>{(dur / 1000):.0f}s {comp}</span></div>")
        cards.append(f"""
<div class="card {'ok' if ok else 'fail'}">
  <div class="head"><b>{r['run_id']}</b>
    <span class="badge {'green' if ok else 'red'}">{'✓ 成功' if ok else '✗ 失败'}</span>{badge}</div>
  <div class="grid">
    <span>Token 总量</span><b>{_fmt(_get(r, 'tokens.total_tokens'))}</b>
    <span>未缓存输入</span><b>{_fmt(_get(r, 'tokens.uncached_input_tokens'))}</b>
    <span>输出</span><b>{_fmt(_get(r, 'tokens.output_tokens'))}</b>
    <span>采样 / wait</span><b>{_fmt(_get(r, 'orchestration.usage_bearing_samples'))} / {_fmt(_get(r, 'orchestration.wait_status_model_calls'))}</b>
    <span>子代理 / 重试</span><b>{_fmt(_get(r, 'orchestration.subagents'))} / {_fmt(_get(r, 'orchestration.retries'))}</b>
    <span>峰值上下文</span><b>{_fmt(_get(r, 'context.peak_context_tokens'))}</b>
    <span>压缩次数</span><b>{_fmt(_get(r, 'context.compactions'))}</b>
    <span>总耗时</span><b>{_fmt(_get(r, 'performance.total_ms'))} ms</b>
    <span>TTFM / TTFT</span><b>{_fmt(_get(r, 'performance.time_to_first_patch_ms'))} / {_fmt(_get(r, 'performance.ttft_ms_first'))} ms</b>
    <span>失败恢复</span><b>{_fmt(_get(r, 'performance.failure_recovery_ms'))} ms</b>
  </div>
  {('<div class="turns">' + tbars + '</div>') if tbars else ''}
</div>""")

    task_rows = ""
    for tid, t in sorted(report["per_task"].items()):
        task_rows += (f"<tr><td>{tid}</td><td>{t['n_runs']}</td><td>{t['success_rate']:.0%}</td>"
                      f"<td>{_fmt(t['tokens_total'])}</td>"
                      f"<td>{_fmt(t['stats']['performance.total_ms'].get('median'))}</td>"
                      f"<td>{_fmt(t['stats']['orchestration.usage_bearing_samples'].get('median'))}</td>"
                      f"<td>{_fmt(t['stats']['orchestration.wait_status_model_calls'].get('median'))}</td></tr>")

    p = report["primary"]
    html = f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Codex Task Ledger — Baseline 报告 v0</title><style>
body{{font:14px/1.5 -apple-system,"Segoe UI",sans-serif;margin:24px;background:#f7f8fa;color:#1c1e21}}
h1{{font-size:20px}} h2{{font-size:16px;margin-top:28px}}
.card{{background:#fff;border:1px solid #e2e5ea;border-radius:10px;padding:14px 16px;margin:12px 0;max-width:860px}}
.card.fail{{border-left:4px solid #d93025}} .card.ok{{border-left:4px solid #188038}}
.head{{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}}
.badge{{font-size:11px;padding:2px 8px;border-radius:10px;color:#fff}} .green{{background:#188038}}
.red{{background:#d93025}} .orange{{background:#e8710a}}
.grid{{display:grid;grid-template-columns:auto auto auto auto;gap:2px 14px}}
.grid span{{color:#5f6368}} .grid b{{font-weight:600}}
.turns{{margin-top:10px}} .turnbar{{display:flex;gap:8px;align-items:center;margin:2px 0}}
.turnbar .lbl{{width:24px;color:#5f6368;font-size:12px}} .turnbar .dur{{width:70px;color:#5f6368;font-size:12px}}
.track{{flex:1;height:8px;background:#e8eaed;border-radius:4px;display:flex;overflow:hidden}}
.seg.wait{{background:#e8710a}} .seg.work{{background:#1a73e8}}
table{{border-collapse:collapse;background:#fff}} td,th{{border:1px solid #e2e5ea;padding:6px 12px;text-align:left}}
.metric{{display:flex;align-items:center;gap:12px;margin:6px 0;max-width:760px}}
.metric .k{{width:170px;color:#5f6368}} .metric .v{{font-variant-numeric:tabular-nums}}
.metric .v small{{color:#80868b;margin-left:8px}}
.dist{{flex:1;height:10px;background:#e8eaed;border-radius:5px;position:relative}}
.range{{position:absolute;left:0;top:0;bottom:0;background:#c6dafc;border-radius:5px}}
.iqr{{position:absolute;top:0;bottom:0;background:#5f9bff}} .med{{position:absolute;top:-2px;bottom:-2px;width:2px;background:#1c1e21}}
</style></head><body>
<h1>Codex Task Ledger — Level-0 Baseline 报告（v0 静态报告）</h1>
<p>runs {len(report['runs'])}（有效 {len(report['valid'])} / 排除 {len(report['excluded'])}）·
usage_source=rollout_cumulative · Primary=median+IQR，Secondary=mean/max/total</p>
<h2>Primary 指标</h2>
{_bar_html('Task Success Rate', {'n': 1, 'median': p['task_success_rate'] or 0, 'max': 1.0, 'q1': p['task_success_rate'] or 0, 'q3': p['task_success_rate'] or 0, 'mean': p['task_success_rate'] or 0})}
{_bar_html('Tokens/Successful Task', {'n': 1, 'median': p['tokens_per_successful_task'] or 0, 'max': p['tokens_per_successful_task'] or 0, 'q1': p['tokens_per_successful_task'] or 0, 'q3': p['tokens_per_successful_task'] or 0, 'mean': p['tokens_per_successful_task'] or 0})}
{_bar_html('Median Wall Time (ms)', report['overall']['performance.total_ms'])}
{_bar_html('Model Calls/Task', report['overall']['orchestration.usage_bearing_samples'])}
{_bar_html('Wait/Status Calls', report['overall']['orchestration.wait_status_model_calls'])}
{_bar_html('Wait/Status Tokens (est)', report['overall'].get('orchestration.wait_tokens_est', {'median': None}))}
{_bar_html('TTFM (ms)', report['overall']['performance.time_to_first_patch_ms'])}
{_bar_html('Tokens/Task', report['overall']['tokens.total_tokens'])}
{_bar_html('Peak Context', report['overall']['context.peak_context_tokens'])}
<h2>分任务</h2>
<table><tr><th>任务</th><th>runs</th><th>成功率</th><th>Token 总量</th><th>median 耗时ms</th><th>median 采样</th><th>median wait</th></tr>
{task_rows}</table>
<h2>Run 卡片（turn 时间条：蓝=有效采样占比，橙=wait/status 占比，◆=发生压缩）</h2>
{''.join(cards) or '<p>暂无 run。先运行 <code>python -m benchmark.runner start --task T01 --repeat 1</code></p>'}
</body></html>"""
    out.write_text(html, encoding="utf-8")


def main(argv=None):
    report = aggregate()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(report, RESULTS_DIR / "baseline.csv")
    write_md(report, RESULTS_DIR / "report.md")
    write_html(report, RESULTS_DIR / "report.html")
    print(f"[aggregate] runs={len(report['runs'])} 有效={len(report['valid'])} → "
          f"baseline.csv / report.md / report.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())

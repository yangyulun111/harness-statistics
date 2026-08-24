"""本地网页实时视图：`python -m ledger serve`。

- 内嵌采集线程（默认每 20s 增量 ingest），页面每 5s 自动刷新 → 近实时；
- 纯标准库（http.server），只读 API（mode=ro），监听 127.0.0.1；
- 视图：今日 / 项目聚合 / 近 7 天任务 / 任务详情（Token 树 + turns）/ 运行状态。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from . import daemon as _daemon
from . import queries as _q
from .timeutil import fmt_dt, fmt_duration, fmt_hm


def _ok(handler, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class _Handler(BaseHTTPRequestHandler):
    db: Optional[Path] = None

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def _conn(self) -> sqlite3.Connection:
        return _q.open_ro(self.db)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/" or u.path == "/index.html":
                body = PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if u.path == "/api/summary":
                date = (parse_qs(u.query).get("date") or [None])[0]
                conn = self._conn()
                try:
                    _ok(self, _q.day_summary(conn, date))
                finally:
                    conn.close()
                return
            if u.path == "/api/tasks":
                days = int((parse_qs(u.query).get("days") or ["7"])[0])
                conn = self._conn()
                try:
                    since = _now_ms() - days * 86400_000
                    _ok(self, {"days": days, "tasks": _q.task_rows(conn, since_ms=since)})
                finally:
                    conn.close()
                return
            if u.path == "/api/projects":
                days = int((parse_qs(u.query).get("days") or ["30"])[0])
                conn = self._conn()
                try:
                    since = _now_ms() - days * 86400_000
                    _ok(self, {"days": days, "projects": _q.project_rows(conn, since_ms=since)})
                finally:
                    conn.close()
                return
            m = re.match(r"^/api/task/(.+)$", u.path)
            if m:
                conn = self._conn()
                try:
                    detail = _q.task_detail(conn, m.group(1))
                    if detail is None:
                        self.send_error(404, "thread not found")
                    else:
                        _ok(self, detail)
                finally:
                    conn.close()
                return
            if u.path == "/api/status":
                conn = self._conn()
                try:
                    _ok(self, _q.status_info(conn))
                finally:
                    conn.close()
                return
            self.send_error(404)
        except (sqlite3.Error, FileNotFoundError) as e:
            body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


def make_handler(db: Optional[Path]):
    h = type("BoundHandler", (_Handler,), {"db": db})
    return h


def serve(host: str = "127.0.0.1", port: int = 8765, collect: bool = True,
          interval: float = 20.0, db: Optional[Path] = None):
    stop = threading.Event()
    if collect:
        t = threading.Thread(target=_daemon.run, kwargs=dict(interval=interval, db=db,
                                                            verbose=True, stop=stop), daemon=True)
        t.start()
        print(f"[serve] 内嵌采集线程已启动（每 {interval:.0f}s 增量）")
    else:
        print("[serve] 未启用内嵌采集（--no-collect），页面仅展示已有数据")
    httpd = ThreadingHTTPServer((host, port), make_handler(db))
    print(f"[serve] 打开 http://{host}:{port}  （页面每 5s 自动刷新，Ctrl+C 退出）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve] 退出")
    finally:
        stop.set()
        httpd.server_close()


PAGE = r"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>Codex Task Ledger — 实时视图</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--line:#e2e5ea;--tx:#1c1e21;--sub:#5f6368;--blue:#1a73e8;
--green:#188038;--red:#d93025;--orange:#e8710a}
body{font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:var(--bg);color:var(--tx)}
header{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid var(--line);
padding:10px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header h1{font-size:16px;margin:0}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block;margin-right:5px}
.dot.off{background:var(--red)}
.meta{color:var(--sub);font-size:12px}
nav{display:flex;gap:4px;margin-left:auto}
nav button{border:0;background:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:14px;color:var(--sub)}
nav button.on{background:#e8f0fe;color:var(--blue);font-weight:600}
main{padding:18px 20px;max-width:1180px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;cursor:pointer;
transition:box-shadow .15s}
.card:hover{box-shadow:0 2px 10px rgba(0,0,0,.09)}
.card .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.card .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .tok{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.card .row{display:flex;gap:14px;color:var(--sub);font-size:12.5px;margin-top:6px;flex-wrap:wrap}
.badge{font-size:11px;padding:1px 8px;border-radius:9px;color:#fff;background:var(--green)}
.badge.gray{background:#80868b}.badge.red{background:var(--red)}.badge.orange{background:var(--orange)}
.badge.blue{background:var(--blue)}
.bar{height:6px;border-radius:3px;background:#e8eaed;overflow:hidden;margin-top:8px;display:flex}
.bar .r{background:#c6dafc}.bar .s{background:#5f9bff}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:12px;overflow:hidden}
th,td{padding:7px 12px;border-bottom:1px solid var(--line);text-align:left;font-variant-numeric:tabular-nums}
th{color:var(--sub);font-weight:600;font-size:12.5px;background:#fafbfc}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
.tag{color:var(--sub);font-size:12px}
h2{font-size:15px;margin:20px 0 10px}
h2 small{color:var(--sub);font-weight:400}
#detail{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.kv{display:grid;grid-template-columns:130px 1fr;gap:3px 14px;margin:8px 0;font-size:13px}
.kv span{color:var(--sub)}
.warn{background:#fef7e0;border:1px solid #fdd663;border-radius:8px;padding:8px 12px;margin:8px 0;font-size:13px}
.back{cursor:pointer;color:var(--blue);border:0;background:none;font-size:13px;padding:0}
.subrow{display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:13px}
.subrow b{font-variant-numeric:tabular-nums}
.turntrack{height:7px;background:#e8eaed;border-radius:4px;display:flex;overflow:hidden;min-width:120px}
.turntrack .w{background:var(--orange)}.turntrack .k{background:var(--blue)}
footer{color:var(--sub);font-size:12px;padding:14px 20px;text-align:center}
.muted{color:var(--sub)}
.big{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
</style></head><body>
<header>
 <h1><span class="dot" id="dot"></span>Codex Task Ledger</h1>
 <span class="meta" id="hdrmeta">加载中…</span>
 <nav>
  <button data-tab="today" class="on">今日</button>
  <button data-tab="projects">项目</button>
  <button data-tab="tasks">近7天</button>
  <button data-tab="status">状态</button>
 </nav>
</header>
<main id="main">加载中…</main>
<footer>usage_source=rollout_cumulative（服务端权威） · Primary=median+IQR · 只读零侵入</footer>
<script>
const $=s=>document.querySelector(s);
let tab='today', curTask=null, lastRefresh=0;
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;curTask=null;render();});

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tok(n){n=n||0;if(Math.abs(n)>=1e6)return (n/1e6).toFixed(2)+'M';
if(Math.abs(n)>=1e3)return (n/1e3).toFixed(1)+'k';return String(n)}
function hm(ms){if(!ms)return '--:--';const d=new Date(ms);return d.toTimeString().slice(0,5)}
function dt(ms){if(!ms)return '-';return new Date(ms).toLocaleString('zh-CN',{hour12:false})}
function dur(ms){if(ms==null)return '-';const s=ms/1000;if(s<60)return s.toFixed(1)+'s';
const m=Math.floor(s/60);if(m<60)return m+'m'+String(Math.floor(s%60)).padStart(2,'0')+'s';
return Math.floor(m/60)+'h'+String(m%60).padStart(2,'0')+'m'}
const stBadge=s=>{const m={completed:['completed',''],interrupted:['interrupted','orange'],
 possibly_active:['possibly_active*','orange'],unknown:['unknown','gray'],idle:['idle','gray']};
 const[x,c]=m[s]||[s,'gray'];return `<span class="badge ${c}">${x}</span>`};
const schBadge=t=>t.schema_ok?'':' <span class="badge red">schema!</span> ';

function taskCard(t){const frac=Math.min(1,(t.root_tokens||1)/(t.total_tokens||1));
 return `<div class="card" onclick="openTask('${t.thread_id}')">
  <div class="t"><span class="name">${esc(t.name)}</span><span class="tok">${tok(t.total_tokens)}</span></div>
  <div class="row"><span>${hm(t.activity_ms)}</span><span>${esc(t.project)}</span>
   <span>${esc(t.model)}</span><span>${t.turns} 轮</span><span>${t.samples} 采样</span>
   ${t.wait?`<span style="color:var(--orange)">${t.wait} wait</span>`:''}
   <span>${t.subagents} 子代理</span></div>
  <div class="bar"><span class="r" style="width:${(frac*100).toFixed(1)}%"></span>
   <span class="s" style="width:${((1-frac)*100).toFixed(1)}%"></span></div>
  <div class="row"><span class="muted">root ${tok(t.root_tokens)} · 子代理 ${tok(t.subagent_tokens)}</span>
   ${stBadge(t.status)}${schBadge(t)}</div></div>`}

async function getJSON(u){const r=await fetch(u);if(!r.ok)throw new Error((await r.json()).error||r.status);return r.json()}

async function render(){
 try{
  if(tab==='detail'&&curTask){await renderDetail(curTask)}
  else if(tab==='today'){const d=await getJSON('/api/summary');
   $('#hdrmeta').textContent=`${d.date} · 任务 ${d.totals.tasks} · Token ${tok(d.totals.total)} · 采样 ${d.totals.samples}`;
   $('#main').innerHTML=(d.tasks.length?`<div class="grid">${d.tasks.map(taskCard).join('')}</div>`:
    `<p class="muted">今天还没有 Codex 任务。在 ChatGPT Desktop 的 Codex 视图开始任务后 ~25s 内出现。</p>`)
   +`<h2>合计</h2><table><tr><th>Root</th><th>子代理</th><th>总Token</th><th>未缓存输入</th>
     <th>输出</th><th>采样</th><th>wait/status</th></tr>
     <tr><td class="num">${tok(d.totals.root)}</td><td class="num">${tok(d.totals.sub)}</td>
     <td class="num"><b>${tok(d.totals.total)}</b></td><td class="num">${tok(d.totals.uncached)}</td>
     <td class="num">${tok(d.totals.output)}</td><td class="num">${d.totals.samples}</td>
     <td class="num">${d.totals.wait}</td></tr></table>`}
  else if(tab==='projects'){const d=await getJSON('/api/projects?days=30');
   $('#hdrmeta').textContent=`近 30 天 · ${d.projects.length} 个项目`;
   const rs=d.projects.map(p=>`<tr onclick="void 0"><td><b>${esc(p.project)}</b><br>
     <span class="tag" title="${esc(p.cwds.join(' | '))}">${esc((p.cwds[0]||'').slice(0,52))}</span></td>
     <td class="num">${p.tasks}</td><td class="num"><b>${tok(p.total_tokens)}</b></td>
     <td class="num">${tok(p.root_tokens)}</td><td class="num">${tok(p.subagent_tokens)}</td>
     <td class="num">${tok(p.uncached_tokens)}</td><td class="num">${tok(p.output_tokens)}</td>
     <td class="num">${p.samples}</td><td class="num">${p.wait}</td><td class="num">${p.subagents}</td>
     <td>${dt(p.last_active_ms)}</td></tr>`).join('');
   $('#main').innerHTML=`<table><tr><th>项目</th><th class="num">任务</th><th class="num">总Token</th>
    <th class="num">root</th><th class="num">子代理</th><th class="num">未缓存</th><th class="num">输出</th>
    <th class="num">采样</th><th class="num">wait</th><th class="num">子代数</th><th>最近活跃</th></tr>${rs}</table>`}
  else if(tab==='tasks'){const d=await getJSON('/api/tasks?days=7');
   $('#hdrmeta').textContent=`近 ${d.days} 天 · ${d.tasks.length} 个任务`;
   const rs=d.tasks.map(t=>`<tr onclick="openTask('${t.thread_id}')" style="cursor:pointer">
    <td>${hm(t.activity_ms)}</td><td>${esc(t.name)}</td><td>${esc(t.project)}</td>
    <td>${esc(t.model)}</td><td class="num">${t.turns}</td><td class="num"><b>${tok(t.total_tokens)}</b></td>
    <td class="num">${tok(t.uncached_tokens)}</td><td class="num">${t.samples}</td>
    <td class="num">${t.wait}</td><td class="num">${t.subagents}</td><td>${stBadge(t.status)}</td></tr>`).join('');
   $('#main').innerHTML=`<table><tr><th>时间</th><th>任务</th><th>项目</th><th>模型</th><th class="num">轮</th>
    <th class="num">总Token</th><th class="num">未缓存</th><th class="num">采样</th><th class="num">wait</th>
    <th class="num">子代</th><th>状态</th></tr>${rs}</table>`}
  else if(tab==='status'){const s=await getJSON('/api/status');
   $('#hdrmeta').textContent=`codex ${s.codex_version} · model ${s.model}`;
   $('#main').innerHTML=`<div id="detail">
    <div class="kv"><span>最近采集</span><b>${dt(s.last_update_ms)}</b>
    <span>线程</span><b>${(s.counts.root||0)} root / ${(s.counts.subagent||0)} 子代理</b>
    <span>rollout 文件</span><b>${s.rollout_files.total}（活跃 ${s.rollout_files.active}）</b>
    <span>全库采样 / wait / 重播</span><b>${s.totals.samples.toLocaleString()} /
     ${s.totals.wait.toLocaleString()} / ${s.totals.rebroadcast.toLocaleString()}</b>
    <span>schema 告警</span><b style="color:${s.schema_issues?'var(--red)':'var(--green)'}">${s.schema_issues}</b>
    <span>state DB</span><b class="tag">${esc(s.state_db)}</b></div>
    <p class="muted" style="margin-top:10px">采集线程每 20s 增量 tail（进行中任务的 Token 近实时更新）；
    页面每 5s 刷新。possibly_active* 为启发式（离线无法 100% 判定运行状态）。</p></div>`}
  lastRefresh=Date.now();$('#dot').classList.remove('off');
 }catch(e){$('#dot').classList.add('off');
  $('#hdrmeta').textContent='连接失败：'+e.message}
}

async function renderDetail(id){
 const d=await getJSON('/api/task/'+id);curTask=id;
 const h=d.header,t=d.tokens,g=d.diag;
 $('#hdrmeta').textContent=h.thread_id.slice(0,13)+'…';
 const subs=d.subagents.map(s=>`<div class="subrow">
  <span class="badge blue">${esc(s.header.agent_nickname||'agent')}</span>
  <span class="muted">depth ${s.header.depth??'-'}</span>
  <b>${tok(s.tokens.total)} tok</b><span class="muted">${s.diag.samples} 采样 /
  ${s.diag.wait} wait</span><span class="tag">${s.header.thread_id.slice(0,8)}</span></div>`).join('');
 const trs=d.turns.map(r=>{const ws=r.usage_bearing_samples||0,w=r.wait_status_model_calls||0;
  const f=ws?Math.min(100,w/ws*100):0;
  return `<tr><td class="num">${r.turn_index}</td><td>${hm(r.started_ms)}</td>
  <td class="num">${dur(r.duration_ms)}</td><td class="num">${dur(r.ttft_ms)}</td>
  <td class="num">${tok(r.input_tokens)}</td><td class="num">${tok(r.cached_input_tokens)}</td>
  <td class="num">${tok(r.output_tokens)}</td><td class="num">${tok(r.reasoning_tokens)}</td>
  <td class="num">${ws}</td><td><div class="turntrack"><div class="w" style="width:${f}%"></div>
  <div class="k" style="width:${100-f}%"></div></div></td>
  <td class="num">${r.patches||0}</td><td class="num">${r.compactions||0}</td>
  <td>${r.status}${r.had_error?' ✗':''}</td></tr>`}).join('');
 $('#main').innerHTML=`<div id="detail">
  <button class="back" onclick="tab='today';curTask=null;render()">← 返回</button>
  <h2 style="margin-top:6px">${esc(h.cwd.split('\\\\').pop()||'-')} ·
   <span class="muted">${esc(h.model)} / effort=${esc(h.effort||'-')} / cli ${esc(h.cli_version||'-')}</span>
   ${stBadge(d.status)}</h2>
  <div class="kv"><span>thread</span><b>${h.thread_id}</b>
   <span>目录</span><b>${esc(h.cwd)}</b>
   ${h.git_origin_url?`<span>git</span><b>${esc(h.git_origin_url)} @ ${esc(h.git_branch||'-')}</b>`:''}
   <span>创建 → 最近</span><b>${dt(h.created_ms)} → ${dt(h.updated_ms)}</b>
   ${h.tokens_used_state!=null?`<span>state 累计</span><b>${h.tokens_used_state.toLocaleString()}</b>`:''}</div>
  <h2>Token 账目 <small>（root 线程，累计差分）</small></h2>
  <div class="kv"><span>input</span><b>${t.input.toLocaleString()}</b>
   <span>cached</span><b>${t.cached.toLocaleString()}</b>
   <span>uncached</span><b>${t.uncached.toLocaleString()}</b>
   <span>output</span><b>${t.output.toLocaleString()}（含 reasoning ${t.reasoning.toLocaleString()}）</b>
   <span>total</span><b class="big">${t.total.toLocaleString()}</b>
   <span>peak context</span><b>${tok(g.peak_context)}${g.model_context_window?'/'+tok(g.model_context_window):''}</b>
   <span>压缩 / 补丁</span><b>${g.compactions} / ${g.patches}</b>
   <span>采样 / wait / 重播</span><b>${g.samples} / ${g.wait} / ${g.rebroadcast}</b>
   <span>工具调用 / 输出量</span><b>${g.tool_calls} / ${tok(g.tool_output_bytes)}B</b></div>
  ${d.subagents.length?`<h2>子代理（${d.subagents.length} 个）<br>
   <small class="muted">Root ${tok(d.task_totals.root_tokens)} + 子代理 ${tok(d.task_totals.subagent_tokens)}
   = <b>${tok(d.task_totals.total_tokens)}</b></small></h2>${subs}`:''}
  ${d.warnings.length?`<div class="warn">${d.warnings.map(esc).join('<br>')}</div>`:''}
  ${d.turns.length?`<h2>Turns（${d.turns.length}）</h2><table><tr><th class="num">#</th><th>开始</th>
   <th class="num">耗时</th><th class="num">TTFT</th><th class="num">input</th><th class="num">cached</th>
   <th class="num">out</th><th class="num">rsn</th><th class="num">采样</th><th>wait 占比</th>
   <th class="num">补丁</th><th class="num">压缩</th><th>状态</th></tr>${trs}</table>`:''}
 </div>`;
}

async function openTask(id){tab='detail';curTask=id;await render()}

render();setInterval(()=>{if(!document.hidden)render()},5000);
</script></body></html>
"""

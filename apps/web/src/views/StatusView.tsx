import { usePoll, type StatusInfo, type ReconcileReport, type FailureOverview, type PricesView, type PriceEntryView } from "../api.ts";
import { fmtFull, fmtDt, fmtTok } from "../format.ts";
import { Loading, StatCard, SectionTitle, Icon, ICONS } from "../components/basics.tsx";
import { useState } from "react";

const KIND_LABEL: Record<string, string> = { shell_exit: "shell", mcp_err: "mcp", patch_fail: "patch" };

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function PriceSection() {
  const { data, err } = usePoll<PricesView>("/api/prices", 20000);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ model: "", from: "", to: "", input: "", cached: "", output: "" });
  const [formMsg, setFormMsg] = useState<string | null>(null);

  if (!data) return <Loading />;
  if (err && !data.entries.length) return <div className="dim">价格目录加载失败：{err}</div>;

  const doSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/prices/sync", { method: "POST" });
      const j = (await r.json()) as { source?: string; written?: number; rotated?: number; warnings?: string[]; error?: string };
      setSyncMsg(
        j.error
          ? `同步失败：${j.error}`
          : `已同步（源=${j.source}）：新增 ${j.written ?? 0} 条，封窗 ${j.rotated ?? 0} 条${j.warnings?.length ? `；注意：${j.warnings.join("；")}` : ""}。刷新页面查看。`,
      );
    } catch (e) {
      setSyncMsg(`同步请求失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
    }
  };

  const upsert = async (e: PriceEntryView | null) => {
    const payload = e
      ? { model: e.model, effective_from: e.effective_from_ms, effective_to: e.effective_to_ms, input_per_mtok: e.input_per_mtok, cached_input_per_mtok: e.cached_input_per_mtok, output_per_mtok: e.output_per_mtok }
      : {
          model: form.model.trim(),
          effective_from: form.from || new Date().toISOString().slice(0, 10),
          effective_to: form.to || null,
          input_per_mtok: Number(form.input),
          cached_input_per_mtok: Number(form.cached || "0"),
          output_per_mtok: Number(form.output),
        };
    setFormMsg(null);
    try {
      const r = await fetch("/api/prices/entry", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      setFormMsg(j.ok ? "已保存（用户条目优先于同步条目，立即生效）" : `保存失败：${j.error}`);
      if (j.ok && !e) setForm({ model: "", from: "", to: "", input: "", cached: "", output: "" });
    } catch (e2) {
      setFormMsg(`请求失败：${e2 instanceof Error ? e2.message : e2}`);
    }
  };

  const remove = async (e: PriceEntryView) => {
    try {
      const r = await fetch("/api/prices/entry", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: e.model, effective_from_ms: e.effective_from_ms }) });
      const j = (await r.json()) as { ok?: boolean; removed?: number; error?: string };
      setFormMsg(j.ok ? `已删除 ${j.removed ?? 0} 条` : `删除失败：${j.error}`);
    } catch (e2) {
      setFormMsg(`请求失败：${e2 instanceof Error ? e2.message : e2}`);
    }
  };

  const entries = [...data.entries].sort((a, b) => a.model.localeCompare(b.model) || b.effective_from_ms - a.effective_from_ms);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="seg" style={{ border: "none" }} onClick={doSync} disabled={syncing}>
          <span className="badge accent" style={{ cursor: "pointer" }}>{syncing ? "同步中…" : "同步官网价格"}</span>
        </button>
        <span className="dim" style={{ fontSize: 11.5 }}>
          OpenAI 无官方机读价格 API：官网页面解析优先，失败自动降级 LiteLLM 社区源（来源均在条目上标注）。
          同步只写 {data.synced_path?.split(/[\\/]/).pop() ?? "model_prices.synced.json"}，{data.user_path?.split(/[\\/]/).pop() ?? "model_prices.json"} 用户条目永不被覆盖且优先。
        </span>
      </div>
      {syncMsg && <div className="dim" style={{ fontSize: 11.5 }}>{syncMsg}</div>}
      {data.uncovered_models && data.uncovered_models.length > 0 && (
        <div className="dim" style={{ fontSize: 11.5, color: "var(--amber)" }}>未覆盖模型（成本显示为下界/未配置）：{data.uncovered_models.join("、")}</div>
      )}
      <div className="tablewrap" style={{ maxHeight: 260 }}>
        <table className="table">
          <thead>
            <tr>
              <th>模型</th><th>生效窗</th><th className="r">in $/M</th><th className="r">cached $/M</th><th className="r">out $/M</th>
              <th>来源</th><th>层</th><th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.model}-${e.effective_from_ms}-${i}`}>
                <td><b>{e.model}</b>{e.promo && <span className="badge warn" style={{ marginLeft: 4 }}>促销</span>}</td>
                <td className="num dim" style={{ fontSize: 11.5 }}>{fmtDate(e.effective_from_ms)} → {e.effective_to_ms ? fmtDate(e.effective_to_ms) : "开放"}</td>
                <td className="r num">{e.input_per_mtok}</td>
                <td className="r num dim">{e.cached_input_per_mtok}</td>
                <td className="r num">{e.output_per_mtok}</td>
                <td className="dim" style={{ fontSize: 11 }} title={e.note ?? ""}>{e.source ?? "–"}</td>
                <td><span className={`badge ${e.origin === "user" ? "ok" : "dim"}`}>{e.origin === "user" ? "用户" : "同步"}</span></td>
                <td style={{ display: "flex", gap: 6 }}>
                  {e.origin === "user" && <button className="iconbtn" title="编辑" onClick={() => upsert(e)}>✎</button>}
                  {e.origin === "user" && <button className="iconbtn" title="删除" onClick={() => remove(e)}>✕</button>}
                </td>
              </tr>
            ))}
            {!entries.length && (
              <tr><td colSpan={8} className="dim" style={{ textAlign: "center", padding: 14 }}>暂无条目：点上方同步，或用下方表单手工添加（促销期建议手工加独立条目）</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
        <span className="dim">新增用户条目：</span>
        <input className="input" style={{ width: 150 }} placeholder="模型（如 gpt-5.6-sol）" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        <input className="input" style={{ width: 115 }} type="date" title="生效起" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        <input className="input" style={{ width: 115 }} type="date" title="生效止（空=开放）" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        <input className="input" style={{ width: 80 }} type="number" step="0.001" placeholder="in $/M" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} />
        <input className="input" style={{ width: 80 }} type="number" step="0.001" placeholder="cached" value={form.cached} onChange={(e) => setForm({ ...form, cached: e.target.value })} />
        <input className="input" style={{ width: 80 }} type="number" step="0.001" placeholder="out $/M" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} />
        <button className="seg" style={{ border: "none" }} onClick={() => upsert(null)}><span className="badge accent" style={{ cursor: "pointer" }}>保存</span></button>
        {formMsg && <span className="dim" style={{ fontSize: 11.5 }}>{formMsg}</span>}
      </div>
      <div className="dim" style={{ fontSize: 11 }}>
        说明：主口径永远是 Token，成本一律 estimated·按时点取价；趋势页不含成本（跨期价格不可比）。目录文件：{data.user_path} ＋ {data.synced_path}
      </div>
    </div>
  );
}

export function StatusView(props: { onOpenTask?: (id: string) => void }) {
  const { data } = usePoll<StatusInfo & { daemon: any }>("/api/status", 5000);
  const rec = usePoll<ReconcileReport>("/api/reconcile", 30000);
  const failures = usePoll<FailureOverview>("/api/failures?limit=100", 15000);

  if (!data) return <Loading />;
  const d = data.daemon ?? {};
  const pr = data.prices;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="grid cols4">
        <StatCard
          label="采集守护" icon={ICONS.bolt}
          accent={d.running ? "var(--green)" : "var(--red)"}
          value={d.running ? "运行中" : "停止"}
          foot={<span>{d.interval_sec ?? "?"}s 间隔 · 上轮 {d.elapsedMs != null ? `${(d.elapsedMs / 1000).toFixed(1)}s` : "–"} 前</span>}
        />
        <StatCard
          label="G0-A 对账（ledger ↔ state DB）" icon={ICONS.status}
          accent={rec.data && rec.data.mismatched === 0 ? "var(--green)" : "var(--amber)"}
          value={rec.data ? `${rec.data.matched}/${rec.data.threads}` : "…"}
          foot={rec.data ? <span>比率 {(rec.data.ratio * 100).toFixed(3)}% · Σstate {fmtTok(rec.data.sum_state)}</span> : <span>加载中</span>}
        />
        <StatCard label="线程 / 根任务" icon={ICONS.tasks} value={`${data.counts.root ?? 0} + ${data.counts.subagent ?? 0}`} foot={<span>根 {data.counts.root ?? 0} · 子代理 {data.counts.subagent ?? 0}（合计线程）</span>} />
        <StatCard
          label="schema 兼容" icon={ICONS.status}
          accent={data.schema_issues > 0 ? "var(--red)" : "var(--green)"}
          value={data.schema_issues > 0 ? `${data.schema_issues} 个异常` : "全部 OK"}
          foot={<span>fail-closed：关键字段缺失/变型 → 非 authoritative</span>}
        />
        <StatCard
          label="价格目录" icon={ICONS.db}
          accent={pr?.loaded ? ((pr.uncovered_models?.length ?? 0) > 0 ? "var(--amber)" : "var(--green)") : "var(--dim)"}
          value={pr?.loaded ? `${(pr.user_entries ?? 0) + (pr.synced_entries ?? 0)} 条` : "未配置"}
          foot={
            <span>
              {pr?.loaded
                ? `用户 ${pr.user_entries ?? 0} · 同步 ${pr.synced_entries ?? 0} · 未覆盖 ${(pr.uncovered_models?.length ?? 0)} · 按时点取价`
                : `下方添加条目或同步官网价启用成本估算`}
            </span>
          }
        />
      </div>

      <SectionTitle>环境</SectionTitle>
      <div className="card">
        <div className="kv">
          <span className="k">Codex 版本</span><span className="v num">{data.codex_version}</span>
          <span className="k">默认模型</span><span className="v">{data.model}</span>
          <span className="k">CODEX_HOME</span><span className="v num" style={{ fontSize: 12 }}>{data.codex_home}</span>
          <span className="k">state DB</span><span className="v num" style={{ fontSize: 12 }}>{data.state_db}</span>
          <span className="k">rollout 文件</span><span className="v">{data.rollout_files.total} 个（active {data.rollout_files.active}）</span>
          <span className="k">最近入库</span><span className="v">{fmtDt(data.last_update_ms)}</span>
        </div>
      </div>

      <SectionTitle>价格目录（用户优先 · 官网同步 · 按时点取价）</SectionTitle>
      <div className="card">
        <PriceSection />
      </div>

      <SectionTitle>账本口径（全库累计）</SectionTitle>
      <div className="grid cols4">
        <StatCard label="usage-bearing 采样" value={fmtFull(data.totals.samples)} foot={<span>native 增长事件（不含 replay）</span>} />
        <StatCard label="wait/status 调用" value={fmtFull(data.totals.wait)} foot={<span>语义分类（G0-C 待校准）</span>} />
        <StatCard label="rebroadcast 事件" value={fmtFull(data.totals.rebroadcast)} foot={<span>未增长重复（#14489），不计调用</span>} />
        <StatCard
          label="fork replay（已剥离）" icon={ICONS.db}
          accent={data.replay?.total_tokens > 0 ? "var(--purple, #8b7cff)" : undefined}
          value={fmtTok(data.replay?.total_tokens ?? 0)}
          foot={<span>{fmtFull(data.replay?.events ?? 0)} 个继承前缀事件 · raw 含、消耗不含</span>}
        />
      </div>

      <div className="grid cols4">
        <StatCard label="MCP 调用（v1.2）" value={fmtFull(data.totals.mcp_calls ?? 0)} foot={<span>失败 {fmtFull(data.totals.mcp_failures ?? 0)}（Ok|Err 一等计数）</span>} />
        <StatCard label="shell 失败（v1.2）" accent={(data.totals.shell_failures ?? 0) > 0 ? "var(--amber)" : undefined} value={fmtFull(data.totals.shell_failures ?? 0)} foot={<span>estimated：输出内嵌 exit_code≠0</span>} />
        <StatCard label="web 搜索" value={fmtFull(data.totals.web_searches ?? 0)} foot={<span>web_search_end 事件</span>} />
        <StatCard label="契约版本" value={`v1.2 / schema ${data.schema_version ?? "?"}`} foot={<span>classification fork-v2</span>} />
      </div>

      {(data.schema_details ?? []).length > 0 && (
        <>
          <SectionTitle>schema 异常明细（{data.schema_details!.length} 线程 · 字段名×次数，含未达阈值的零星异常）</SectionTitle>
          <div className="tablewrap" style={{ maxHeight: "none" }}>
            <table className="table">
              <thead><tr><th>线程</th><th>任务 / 代理</th><th>兼容状态</th><th>异常字段</th></tr></thead>
              <tbody>
                {data.schema_details!.map((s) => (
                  <tr key={s.thread_id}>
                    <td className="num dim" style={{ fontSize: 12 }}>{s.thread_id.slice(0, 8)}</td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}</td>
                    <td><span className={`badge ${s.compat === "ok" ? "dim" : "err"}`}>{s.compat}</span></td>
                    <td className="num" style={{ fontSize: 11 }} title={Object.entries(s.issues ?? {}).map(([k, v]) => `${k} × ${v}`).join("\n")}>
                      {Object.entries(s.issues ?? {}).map(([k, v]) => (
                        <span key={k} className="badge dim" style={{ marginRight: 4 }}>{k}×{v}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionTitle>
        失败总览（全库 tool_failures{failures.data ? ` · 最新 ${failures.data.rows.length} / 共 ${failures.data.total}` : ""}）
      </SectionTitle>
      {!failures.data ? (
        <Loading />
      ) : failures.data.rows.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>无失败记录（shell exit_code≠0 / MCP Err / patch 失败）</div>
      ) : (
        <div className="tablewrap" style={{ maxHeight: 300 }}>
          <table className="table">
            <thead>
              <tr>
                <th>时间</th><th>任务 / 代理</th><th className="r">turn</th><th>类型</th><th className="r">exit</th>
                <th>命令 / 工具</th><th>输出片段</th>
              </tr>
            </thead>
            <tbody>
              {failures.data.rows.map((f, i) => (
                <tr
                  key={`${f.thread_id}-${i}`}
                  className="clickable"
                  title="点击查看任务详情（含完整失败明细）"
                  onClick={() => props.onOpenTask?.(f.root_thread_id ?? f.thread_id)}
                >
                  <td className="num dim" style={{ fontSize: 11.5 }}>{f.ts_ms != null ? fmtDt(f.ts_ms).slice(6) : "–"}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={f.name}>{f.name}</td>
                  <td className="r num dim">{f.turn_index ?? "–"}</td>
                  <td>
                    <span className="badge err">{KIND_LABEL[f.kind] ?? f.kind}</span>
                    {f.kind === "mcp_err" && f.server && <span className="dim" style={{ fontSize: 10.5 }}> {f.server}</span>}
                  </td>
                  <td className="r num" style={{ color: "var(--red)" }}>{f.exit_code ?? "–"}</td>
                  <td className="num" style={{ maxWidth: 300, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.command ?? f.tool ?? ""}>
                    {f.kind === "mcp_err" ? (f.tool ?? "–") : (f.command ?? "（命令未配对）")}
                  </td>
                  <td className="dim" style={{ maxWidth: 320, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.detail ?? ""}>{f.detail ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>fork 归因覆盖（G0-B v2 · 契约 v1.1）</SectionTitle>
      <div className="tablewrap" style={{ maxHeight: "none" }}>
        <table className="table">
          <thead><tr><th>判定方法</th><th>验证状态</th><th className="r">fork 数</th><th className="r">replay tokens</th></tr></thead>
          <tbody>
            {(data.fork_coverage ?? []).map((r) => (
              <tr key={`${r.method}/${r.status}`}>
                <td><span className="badge dim">{r.method}</span></td>
                <td>
                  <span className={`badge ${r.status === "verified" ? "ok" : "warn"}`}>{r.status}</span>
                </td>
                <td className="r num">{r.n}</td>
                <td className="r num">{fmtFull(r.replay)}</td>
              </tr>
            ))}
            {(data.fork_coverage ?? []).length === 0 && (
              <tr><td colSpan={4} className="dim" style={{ textAlign: "center" }}>无 fork 线程</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="dim" style={{ fontSize: 11.5 }}>
        parent_prefix = 父前缀结构匹配（六字段元组逐位、时间无关）；none = 阳性无重放；legacy_time = 父缺失时间聚簇兜底（unverified）；unresolved = 无证据不扣减。
      </div>

      {rec.data && rec.data.diffs.length > 0 && (
        <>
          <SectionTitle>对账差异明细（{rec.data.diffs.length}{rec.data.diffs.length >= 200 ? "+" : ""}）</SectionTitle>
          <div className="tablewrap" style={{ maxHeight: "none" }}>
            <table className="table">
              <thead><tr><th>线程</th><th>任务 / 代理</th><th className="r">state tokens_used</th><th className="r">ledger final_total</th><th className="r">差</th></tr></thead>
              <tbody>
                {rec.data.diffs.map((x) => (
                  <tr
                    key={x.thread_id}
                    className="clickable"
                    title="点击查看任务详情"
                    onClick={() => props.onOpenTask?.(x.thread_id)}
                  >
                    <td className="num" style={{ fontSize: 12 }}>{x.thread_id.slice(0, 8)}</td>
                    <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={x.name}>{x.name || "–"}</td>
                    <td className="r num">{fmtFull(x.state)}</td>
                    <td className="r num">{fmtFull(x.ledger)}</td>
                    <td className="r num" style={{ color: x.diff !== 0 ? "var(--amber)" : undefined }}>{x.diff > 0 ? "+" : ""}{fmtFull(x.diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionTitle>轨道状态</SectionTitle>
      <div className="card" style={{ fontSize: 12.5, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 6 }}>
        <span><b style={{ color: "var(--text)" }}>TS 轨（本服务）</b>：packages/* 7 包 + apps/cli · apps/server · apps/web；G1 Golden = TS ↔ Python oracle 逐字段 EXACT（fixtures + 全量 237 线程验证）。</span>
        <span><b style={{ color: "var(--text)" }}>Python oracle（冻结）</b>：ledger/ 只做参照计算与验证，不新增功能；benchmark/ 跑基线。</span>
        <span className="dim" style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon d={ICONS.db} size={13} /> Ledger Contract v1：collector.sqlite schema + metrics.json 协议。</span>
      </div>
    </div>
  );
}

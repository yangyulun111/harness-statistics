import { useState } from "react";
import { usePoll, type TaskDetail, type TurnRow, type ForkAttribution } from "../api.ts";
import { fmtTok, fmtFull, fmtHm, fmtDt, fmtDuration, fmtBytes, fmtPct, fmtCost, STATUS_LABEL, STATUS_CLASS } from "../format.ts";
import { Loading, Empty, StatCard, SectionTitle, Icon, ICONS } from "../components/basics.tsx";
import { Donut, SplitBar } from "../components/charts.tsx";

const KIND_LABEL: Record<string, string> = { shell_exit: "shell", mcp_err: "mcp", patch_fail: "patch" };

const todayStr = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** fork 归因卡（契约 v1.1）：基线/方法/验证态 + replay vs native 组件级拆分。 */
function ForkCard(props: { f: ForkAttribution }) {
  const f = props.f;
  const verified = f.status === "verified";
  const methodLabel: Record<string, string> = {
    parent_prefix: "父前缀结构匹配",
    legacy_time: "时间聚簇兜底",
    none: "无重放",
    unresolved: "未解析",
  };
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionTitle>fork 归因（v1.1）</SectionTitle>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`badge ${verified ? "ok" : "warn"}`}>{methodLabel[f.method ?? ""] ?? f.method ?? "–"}</span>
        <span className="badge dim">{f.status ?? "pending"}</span>
        <span className="num dim" style={{ fontSize: 11 }}>
          ← {f.forked_from_id.slice(0, 8)} · 前缀 {f.prefix_events ?? 0} 事件
        </span>
      </div>
      <SplitBar height={10} segs={[
        { v: f.replay.total, cls: "seg2" },
        { v: f.native_total, cls: "seg1" },
      ]} />
      <div className="legend">
        <span className="key"><span className="swatch" style={{ background: "#8b7cff" }} />继承重放 {fmtTok(f.replay.total)}（不计消耗）</span>
        <span className="key"><span className="swatch" style={{ background: "#5b9dff" }} />原生 {fmtTok(f.native_total)}</span>
      </div>
      <div className="kv" style={{ fontSize: 11.5 }}>
        <span className="k">继承基线</span><span className="v num">{fmtFull(f.baseline ?? 0)}</span>
        <span className="k">replay in/cached/out</span>
        <span className="v num">{fmtTok(f.replay.input)} / {fmtTok(f.replay.cached)} / {fmtTok(f.replay.output)}</span>
        <span className="k">父前缀 digest</span>
        <span className="v num" style={{ fontSize: 10.5 }} title={f.parent_digest ?? ""}>{f.parent_digest ? f.parent_digest.slice(0, 16) + "…" : "–"}</span>
      </div>
      {!verified && (
        <div className="dim" style={{ fontSize: 11 }}>
          ⚠ replay 扣减未经父验证，数值仅供参考（父文件缺失或签名不足）
        </div>
      )}
    </div>
  );
}

function TurnRowView(props: { t: TurnRow; maxTok: number }) {
  const t = props.t;
  const inTok = Math.max(0, t.input_tokens - t.cached_input_tokens);
  const waitPct = t.usage_bearing_samples ? Math.round((t.wait_status_model_calls / t.usage_bearing_samples) * 100) : 0;
  const fails = (t.shell_failures ?? 0) + (t.mcp_failures ?? 0);
  const patchTitle = (t.patch_files ?? []).join("\n");
  return (
    <tr>
      <td className="num dim">{t.turn_index}</td>
      <td className="num dim">{fmtHm(t.started_ms)}</td>
      <td>
        <span className={`badge ${STATUS_CLASS[t.status] ?? "dim"}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
        {t.compactions > 0 && <span className="badge warn" style={{ marginLeft: 4 }} title="上下文压缩">×{t.compactions} 压缩</span>}
        {t.had_error > 0 && <span className="badge err" style={{ marginLeft: 4 }}>error</span>}
        {t.abort_reason && <span className="badge warn" style={{ marginLeft: 4 }} title={t.abort_reason}>{t.abort_reason}</span>}
      </td>
      <td className="r num">{fmtDuration(t.duration_ms)}</td>
      <td className="r num dim">{t.ttft_ms != null ? fmtDuration(t.ttft_ms) : "–"}</td>
      <td className="r num" style={{ fontWeight: 600 }}>{fmtTok(t.total_tokens)}</td>
      <td>
        <div
          className="minibar"
          style={{ width: 110 }}
          title={`未命中输入 ${fmtTok(inTok)} · 缓存命中 ${fmtTok(t.cached_input_tokens)} · 输出 ${fmtTok(t.output_tokens)}（含推理 ${fmtTok(t.reasoning_tokens ?? 0)}）`}
        >
          <div className="a" style={{ width: `${(inTok / Math.max(props.maxTok, 1)) * 100}%`, background: "var(--accent)" }} />
          <div className="b" style={{ width: `${(t.output_tokens / Math.max(props.maxTok, 1)) * 100}%`, background: "var(--cyan)" }} />
        </div>
      </td>
      <td className="r num dim">{t.usage_bearing_samples || "–"}{t.rebroadcast_events ? <span className="dim" title="rebroadcast"> ⟳{t.rebroadcast_events}</span> : null}</td>
      <td className="r num">{t.wait_status_model_calls ? <span className="badge warn">{t.wait_status_model_calls} · {waitPct}%</span> : <span className="dim">–</span>}</td>
      <td className="r num dim" title={`工具输出量 ${fmtBytes(t.tool_output_bytes ?? 0)}`}>{t.tool_calls || "–"}</td>
      <td className="r num dim">{t.mcp_calls || "–"}{(t.mcp_failures ?? 0) > 0 && <span style={{ color: "var(--red)" }}> ✕{t.mcp_failures}</span>}</td>
      <td className="r num">{fails > 0 ? <span className="badge err" title={`shell ${t.shell_failures ?? 0} · MCP ${t.mcp_failures ?? 0}`}>✗ {fails}</span> : <span className="dim">–</span>}</td>
      <td className="r num dim" title={patchTitle || undefined}>{t.patches || "–"}{(t.patch_files ?? []).length > 0 && <span className="dim" title={patchTitle}> ·{(t.patch_files ?? []).length}文件</span>}</td>
      <td className="dim" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.user_preview ?? ""}>{t.user_preview ?? ""}</td>
    </tr>
  );
}

export function TaskDetailView(props: { id: string; day?: string | null; onClose: () => void }) {
  // v1.4 视图口径：总计 / 当日切片（从今日·日用量打开时默认当日；其他入口默认总计）
  const navDay = props.day ?? null;
  const [scope, setScope] = useState<"total" | "day">(navDay ? "day" : "total");
  const sd = scope === "day";
  const scopeDay = sd ? (navDay ?? todayStr()) : null;
  const { data, err } = usePoll<TaskDetail>(`/api/task/${props.id}${scopeDay ? `?day=${scopeDay}` : ""}`, 5000);
  // 子代理 turn 下钻：选中子代理线程后从 /api/turns 拉取（root 用 taskDetail 自带；随 scope 同步过滤）
  const [turnsThread, setTurnsThread] = useState<string>("");
  // 长表区块（失败明细/子代理/Turns）收起/展开：默认收起，点击标题切换
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});
  const toggleSec = (k: string) => setOpenSec((s) => ({ ...s, [k]: !s[k] }));
  const subTurns = usePoll<{ thread_id: string; turns: TurnRow[] }>(
    turnsThread ? `/api/turns?thread_id=${turnsThread}${scopeDay ? `&day=${scopeDay}` : ""}` : null,
    10000,
  );
  const activeTurns = turnsThread ? subTurns.data?.turns ?? [] : data?.turns ?? [];

  // 失败明细计数拆分：卡片 diag 仅主线程，明细为任务域（root+子代理），标题需自带口径
  const tf = data?.tool_failures ?? [];
  const tfKind = (kind: string) => tf.filter((f) => f.kind === kind).length;
  const tfSub = tf.filter((f) => f.thread_type !== "root").length;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="panel">
        <div className="phead">
          <span className={`dot-status ${data?.status ?? "idle"}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {data ? data.name : "…"}
            </div>
            <div className="dim" style={{ fontSize: 11.5, display: "flex", gap: 8, marginTop: 1 }}>
              {data && <>
                <span>{data.project}</span>
                {data.header.model && <span>· {data.header.model}</span>}
                {data.header.effort && <span className="badge dim">{data.header.effort}</span>}
                <span className={`badge ${STATUS_CLASS[data.status] ?? "dim"}`}>{STATUS_LABEL[data.status] ?? data.status}</span>
              </>}
            </div>
          </div>
          <div className="scopebar" title="视图口径：总计 = 任务全生命周期；当日 = 仅该日切片（消耗/工具/turn）">
            <button className={`scopebtn ${!sd ? "on" : ""}`} onClick={() => setScope("total")}>总计</button>
            <button className={`scopebtn ${sd ? "on" : ""}`} onClick={() => setScope("day")}>当日 {navDay ?? todayStr()}</button>
          </div>
          {data && (
            <span className="num dim" style={{ fontSize: 11 }}>
              {data.header.thread_id.slice(0, 8)} · {data.turns.length} turns
            </span>
          )}
          <button className="iconbtn" onClick={props.onClose} title="关闭 (Esc)">
            <Icon d={ICONS.close} size={15} />
          </button>
        </div>

        <div className="pbody">
          {err && <Empty title="加载失败" sub={err} />}
          {!data && !err && <Loading />}

          {data && (
            <>
              {data.warnings.length > 0 && (
                <div className="warnbox">
                  {data.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}

              <div className="grid cols2">
                <div
                  className="card"
                  style={{ display: "flex", flexDirection: "column", gap: 10 }}
                  title={
                    sd
                      ? `当日切片（${scopeDay}）：daily_usage native 口径（毛差分 − replay），与今日视图同源`
                      : `任务域累计口径：root exclusive + Σ子代理 exclusive（native，剔除 fork 重放）\n上下文压缩 ${data.diag.compactions} 次：compact 会重置模型侧上下文窗口，但累计账目不回退——累计 Token 不可当上下文真实占用解读\n上下文峰值（last_token_usage 采样高水位）${fmtTok(data.diag.peak_context ?? 0)}${data.diag.model_context_window ? ` / 窗口 ${fmtTok(data.diag.model_context_window)}` : "（窗口未知）"}`
                  }
                >
                  <SectionTitle>任务 Token（任务域{sd ? ` · 当日 ${scopeDay}` : ""}）</SectionTitle>
                  <div>
                    <div className="num" style={{ fontSize: 30, fontWeight: 700 }}>{fmtTok(data.task_totals.total_tokens)}</div>
                    <div className="dim" style={{ fontSize: 11 }}>{sd ? "当日 root + Σ子代理（native）" : "root exclusive + Σ子代理 exclusive"}</div>
                  </div>
                  <SplitBar height={8} segs={[
                    { v: data.task_totals.root_tokens, cls: "seg1" },
                    { v: data.task_totals.subagent_tokens, cls: "seg2" },
                  ]} />
                  <div className="legend">
                    <span className="key"><span className="swatch" style={{ background: "#5b9dff" }} />主线程 {fmtTok(data.task_totals.root_tokens)}</span>
                    <span className="key"><span className="swatch" style={{ background: "#8b7cff" }} />子代理 {fmtTok(data.task_totals.subagent_tokens)}（{data.subagents.length}）</span>
                  </div>
                  {(data.sub_model_breakdown?.length ?? 0) > 0 && (
                    <div className="legend" style={{ marginTop: 2 }}>
                      <span className="dim">子代理模型：</span>
                      {data.sub_model_breakdown.map((m) => (
                        <span className="key" key={m.model} title={`${m.model}：${fmtTok(m.tokens)}${m.threads > 1 ? `（${m.threads} 个）` : ""}`}>
                          <span className="badge purple">{m.model}{m.threads > 1 ? `×${m.threads}` : ""}</span>
                          <span className="num">{fmtTok(m.tokens)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {!sd && data.header.tokens_used_state != null && (
                    <div className="dim" style={{ fontSize: 11 }}>
                      state DB tokens_used：<span className="num">{fmtFull(data.header.tokens_used_state)}</span>
                      {data.task_totals.total_tokens !== data.header.tokens_used_state && (
                        <span style={{ color: "var(--amber)" }}>（与任务域口径不同：state 为 root 线程累计）</span>
                      )}
                    </div>
                  )}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4 }}>
                    <SectionTitle>成本（estimated · 按时点价{sd ? ` · ${scopeDay}` : ""}）</SectionTitle>
                    {data.cost_est ? (
                      <>
                        <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{fmtCost(data.cost_est.total, data.cost_est.currency)}</div>
                        <div className="dim" style={{ fontSize: 11 }}>
                          input {data.cost_est.input.toFixed(3)} · cached {data.cost_est.cached.toFixed(3)} · cache_write {data.cost_est.cache_write.toFixed(3)} · output {data.cost_est.output.toFixed(3)}
                        </div>
                        {data.cost_est.missing_models.length > 0 && (
                          <div className="dim" style={{ fontSize: 11, color: "var(--amber)" }}>
                            部分模型未配置价格，此为下界：{data.cost_est.missing_models.join("、")}
                          </div>
                        )}
                        {data.cost_est.sources.length > 0 && (
                          <div className="dim" style={{ fontSize: 11 }}>价格来源：{data.cost_est.sources.join("；")}</div>
                        )}
                      </>
                    ) : (
                      <div className="dim" style={{ fontSize: 12 }}>价格未配置（编辑仓库根 model_prices.json；serve 可用 --prices 指定路径）</div>
                    )}
                  </div>
                </div>

                <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <SectionTitle>主线程 Token 构成{sd ? `（${scopeDay}）` : ""}</SectionTitle>
                  <Donut
                    size={150}
                    center={[fmtTok(data.tokens.total), sd ? "root 当日" : "root exclusive"]}
                    segs={[
                      { name: "缓存命中输入", v: data.tokens.cached, color: "#5b9dff" },
                      { name: "未命中输入", v: data.tokens.uncached, color: "#3fcdd0" },
                      { name: "输出", v: data.tokens.output, color: "#f5c451" },
                    ]}
                  />
                  <div className="kv" style={{ fontSize: 11.5 }}>
                    <span className="k">cache_write</span><span className="v num">{fmtTok(data.tokens.cache_write)}</span>
                    <span className="k">推理输出</span><span className="v num">{fmtTok(data.tokens.reasoning)}</span>
                    <span className="k">压缩次数</span>
                    <span className="v num" title="上下文压缩：compact 重置模型侧窗口，累计账目不回退（详见左卡悬停说明）">{data.diag.compactions}</span>
                  </div>
                </div>
              </div>

              {data.header.fork && !sd && (
                <div className="grid cols3">
                  <ForkCard f={data.header.fork} />
                  <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" }}>
                    <SectionTitle style={{ width: "100%" }}>三层口径（root 线程）</SectionTitle>
                    <div className="kv" style={{ fontSize: 12 }}>
                      <span className="k">L0 raw 观测累计</span><span className="v num">{fmtFull(data.tokens.raw_total)}</span>
                      <span className="k">L1 native（真实调用）</span><span className="v num" style={{ fontWeight: 650 }}>{fmtFull(data.tokens.total)}</span>
                      <span className="k">raw − replay 恒等式</span>
                      <span className="v num dim">
                        {fmtFull(data.header.fork.replay.total)} + {fmtFull(data.tokens.total)} = {fmtFull(data.header.fork.replay.total + data.tokens.total)}
                      </span>
                    </div>
                    <div className="dim" style={{ fontSize: 11 }}>
                      state DB tokens_used = <span className="num">{fmtFull(data.header.tokens_used_state ?? 0)}</span>（lifetime 累计，含继承，勿当 context）
                    </div>
                  </div>
                </div>
              )}

              <div className="grid cols6">
                <StatCard label="Turns" value={data.turns.length} foot={<span>{sd ? `当日开始的轮（${scopeDay}）` : "主线程 turn 数"}</span>} />
                <StatCard label="采样 / wait" value={<>{fmtFull(data.diag.samples)}<small> / {data.diag.wait}</small></>} foot={<span>wait 占比 {fmtPct(data.diag.wait, data.diag.samples, 1)}</span>} />
                <StatCard label="工具调用" value={fmtFull(data.diag.tool_calls)} foot={<span>{data.diag.tool_output_bytes == null ? (sd ? "当日输出量不入账" : "–") : `输出量 ${fmtBytes(data.diag.tool_output_bytes)}`}</span>} />
                <StatCard label="补丁" value={data.diag.patches} foot={<span>patch_apply 成功次数</span>} />
                <StatCard label="rebroadcast" value={data.diag.rebroadcast == null ? "–" : fmtFull(data.diag.rebroadcast)} foot={<span>{data.diag.rebroadcast == null ? "当日不入账" : "未增长重复事件"}</span>} />
                <StatCard label="schema" accent={data.diag.schema_compat === "ok" ? "var(--green)" : "var(--red)"} value={data.diag.schema_compat} foot={<span>fail-closed 状态</span>} />
              </div>

              <div className="grid cols6">
                <StatCard label="耗时 wall" value={fmtDuration(data.header.wall_ms)} foot={<span>{sd ? `当日首→末事件（派生 · ${scopeDay}）` : "首事件 → 末事件（派生）"}</span>} />
                <StatCard
                  label="首改文件 TTFM"
                  value={data.header.ttfm_ms != null ? fmtDuration(data.header.ttfm_ms) : "–"}
                  foot={<span>{sd ? "当日切片无此指标（切回『总计』）" : "Time To First Modification：首个有效文件修改 − 任务首事件（派生）"}</span>}
                />
                <StatCard
                  label="wait 时长"
                  value={fmtDuration(data.orchestration.wait_call_ms ?? data.orchestration.wait_ms_est)}
                  foot={
                    <span>
                      {data.orchestration.wait_call_ms != null
                        ? `实测 wait/status 调用 ×${data.orchestration.wait_call_n}（call↔output）`
                        : "本范围无 wait/status 调用配对时长，显示折算值"}
                      {" · 折算 "}{fmtDuration(data.orchestration.wait_ms_est)}（estimated）
                    </span>
                  }
                />
                <StatCard
                  label="wait/status Token"
                  accent={
                    data.orchestration.wait_tokens_est > 0 && data.task_totals.total_tokens > 0 &&
                    data.orchestration.wait_tokens_est / data.task_totals.total_tokens > 0.15
                      ? "var(--amber)"
                      : undefined
                  }
                  value={fmtTok(data.orchestration.wait_tokens_est)}
                  foot={
                    <span>
                      estimated · {fmtPct(data.orchestration.wait_tokens_est, data.task_totals.total_tokens, 1)}
                      {data.orchestration.wait_cost_est != null ? ` · 浪费≈${fmtCost(data.orchestration.wait_cost_est)}` : ""}
                    </span>
                  }
                />
                <StatCard label="MCP 调用" value={<>{fmtFull(data.diag.mcp_calls)}{data.diag.mcp_failures > 0 && <small style={{ color: "var(--red)" }}> ✕{data.diag.mcp_failures}</small>}</>} foot={<span>v1.2 一等计数（含成败）</span>} />
                <StatCard label="shell 失败" accent={data.diag.shell_failures > 0 ? "var(--amber)" : undefined} value={data.diag.shell_failures} foot={<span>estimated：输出内嵌 exit_code · 仅主线程</span>} />
                <StatCard label="并发峰值" value={data.orchestration.concurrency_peak} foot={<span>子代理活跃区间重叠（estimated）</span>} />
              </div>

              {data.tool_failures.length > 0 && (
                <>
                  <div className="sectoggle" onClick={() => toggleSec("fail")}>
                    <SectionTitle><span className="chev">{openSec.fail ? "▾" : "▸"}</span>失败明细（{tf.length}{tf.length >= 200 ? "+" : ""} · shell {tfKind("shell_exit")} / patch {tfKind("patch_fail")} / mcp {tfKind("mcp_err")}{tfSub > 0 ? ` · 含子代理 ${tfSub}` : ""}）<span className="dim" style={{ fontSize: 11, fontWeight: 400 }}> · estimated：输出内嵌 exit_code / MCP Err / patch stderr · 点击{openSec.fail ? "收起" : "展开"}</span></SectionTitle>
                  </div>
                  <div className="tablewrap" style={{ maxHeight: "none", display: openSec.fail ? undefined : "none" }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>时间</th><th>线程</th><th className="r">turn</th><th>类型</th><th className="r">exit</th>
                          <th>命令 / 工具</th><th>输出片段</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.tool_failures.map((f, i) => (
                          <tr key={i}>
                            <td className="num dim">{f.ts_ms != null ? fmtDt(f.ts_ms).slice(6) : "–"}</td>
                            <td>{f.thread_type === "root" ? <span className="badge dim">root</span> : <span className="badge purple">sub</span>}</td>
                            <td className="r num dim">{f.turn_index ?? "–"}</td>
                            <td>
                              <span className="badge err">{KIND_LABEL[f.kind] ?? f.kind}</span>
                              {f.kind === "mcp_err" && f.server && <span className="dim" style={{ fontSize: 10.5 }}> {f.server}</span>}
                            </td>
                            <td className="r num" style={{ color: "var(--red)" }}>{f.exit_code ?? "–"}</td>
                            <td className="num" style={{ maxWidth: 320, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.command ?? f.tool ?? ""}>
                              {f.kind === "mcp_err" ? (f.tool ?? "–") : (f.command ?? "（命令未配对）")}
                            </td>
                            <td className="dim" style={{ maxWidth: 360, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.detail ?? ""}>{f.detail ?? "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {(data.tool_behavior?.buckets?.length ?? 0) > 0 && (
                <>
                  <div className="sectoggle" onClick={() => toggleSec("tools")}>
                    <SectionTitle><span className="chev">{openSec.tools ? "▾" : "▸"}</span>工具行为（分桶 · estimated{sd ? ` · ${scopeDay}` : ""}）<span className="dim" style={{ fontSize: 11, fontWeight: 400 }}> · 时长=call↔output 时戳差 · 读检测/±行为启发式</span></SectionTitle>
                  </div>
                  <div style={{ display: openSec.tools ? undefined : "none" }}>
                    <div className="tablewrap" style={{ maxHeight: "none" }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th>桶</th><th className="r">调用</th><th className="r">失败</th><th className="r">失败率</th>
                            <th className="r">总时长</th><th className="r">均时长</th><th>特征（estimated）</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.tool_behavior!.buckets.map((b) => (
                            <tr key={b.bucket}>
                              <td><span className="badge dim">{b.bucket}</span></td>
                              <td className="r num">{b.calls}</td>
                              <td className="r num">{b.failures > 0 ? <span style={{ color: "var(--red)" }}>{b.failures}</span> : "0"}</td>
                              <td className="r num dim" title={`成败已知 ${b.ok_known}/${b.calls}（孤儿调用不计）`}>
                                {fmtPct(b.failures, Math.max(b.ok_known, 1), 1)}
                              </td>
                              <td className="r num dim">{fmtDuration(b.duration_ms)}</td>
                              <td className="r num dim">{b.duration_n ? fmtDuration((b.duration_ms ?? 0) / b.duration_n) : "–"}</td>
                              <td className="dim" style={{ fontSize: 11.5 }}>
                                {b.bucket === "shell" ? `读检测 ${b.reads} 次`
                                  : b.bucket === "file" ? `${b.files_touched} 文件 · +${b.lines_plus}/−${b.lines_minus} 行`
                                  : b.bucket === "mcp" ? "结构化 duration"
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {data.tool_behavior!.file_behavior && (
                      <div className="dim" style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
                        <span>文件读取（启发式）：{data.tool_behavior!.file_behavior.reads} 次 · {data.tool_behavior!.file_behavior.distinct_files} 个不同文件</span>
                        <span>修改：{data.tool_behavior!.file_behavior.files_touched} 文件 · +{data.tool_behavior!.file_behavior.lines_plus}/−{data.tool_behavior!.file_behavior.lines_minus} 行</span>
                        {data.tool_behavior!.file_behavior.repeated_reads.length > 0 && (
                          <span title={data.tool_behavior!.file_behavior.repeated_reads.map((r) => `${r.file} ×${r.n}`).join("\n")}>
                            重复读取 top{data.tool_behavior!.file_behavior.repeated_reads.length}：{data.tool_behavior!.file_behavior.repeated_reads[0]!.file.split(/[\\/]/).pop()} ×{data.tool_behavior!.file_behavior.repeated_reads[0]!.n}…
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {data.subagents.length > 0 && (
                <>
                  <div className="sectoggle" onClick={() => toggleSec("subs")}>
                    <SectionTitle><span className="chev">{openSec.subs ? "▾" : "▸"}</span>子代理（{data.subagents.length}）</SectionTitle>
                  </div>
                  <div className="tablewrap" style={{ maxHeight: "none", display: openSec.subs ? undefined : "none" }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>代理</th><th>模型</th><th className="r">{sd ? `当日 Token（${scopeDay}）` : "exclusive Token"}</th><th className="r">采样/wait</th>
                          <th className="r">补丁</th><th className="r" title="last_token_usage 采样高水位（lifetime）">上下文峰</th><th>状态</th><th>fork</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.subagents.map((s) => (
                          <tr
                            key={s.header.thread_id}
                            className="clickable"
                            title="点击在下方 Turns 表查看该子代理的 turn 明细"
                            onClick={() => { setTurnsThread(s.header.thread_id); setOpenSec((st) => ({ ...st, turns: true })); }}
                          >
                            <td>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <span className="badge purple">{s.header.agent_nickname ?? `d${s.header.depth ?? "?"}`}</span>
                                <span className="num dim" style={{ fontSize: 11 }}>{s.header.thread_id.slice(0, 8)}</span>
                              </div>
                            </td>
                            <td className="muted" style={{ fontSize: 12 }}>{s.header.model ?? "–"}</td>
                            <td
                              className="r num"
                              style={{ fontWeight: 600 }}
                              title={sd ? `当日（${scopeDay}）native 消耗；任务总计 ${fmtTok(s.tokens.total)}` : undefined}
                            >
                              {sd ? fmtTok(s.day_tokens ?? 0) : fmtTok(s.tokens.total)}
                            </td>
                            <td className="r num dim">{s.diag.samples}{s.diag.wait ? ` / ${Math.round((s.diag.wait / Math.max(s.diag.samples, 1)) * 100)}%` : ""}</td>
                            <td className="r num dim">{s.diag.patches}</td>
                            <td className="r num dim">{fmtTok(s.diag.peak_context)}</td>
                            <td><span className={`badge ${STATUS_CLASS[s.status] ?? "dim"}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
                            <td>
                              {s.header.fork && (
                                <span
                                  className={`badge ${s.header.fork.status === "verified" ? "ok" : "warn"}`}
                                  title={`基线 ${fmtFull(s.header.fork.baseline ?? 0)} · replay ${fmtFull(s.header.fork.replay.total)} · native ${fmtFull(s.header.fork.native_total)}`}
                                >
                                  {s.header.fork.method ?? "fork"}{s.header.fork.status !== "verified" ? ` ${s.header.fork.status ?? "pending"}` : ""}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="section-title sectoggle" style={{ flex: 1, minWidth: 120 }} onClick={() => toggleSec("turns")}>
                  <span className="chev">{openSec.turns ? "▾" : "▸"}</span>Turns（{turnsThread ? "子代理" : "主线程"} · {activeTurns.length}{sd ? ` · 当日 ${scopeDay}` : ""}）
                </div>
                {data.subagents.length > 0 && (
                  <select
                    className="input"
                    style={{ minWidth: 240, padding: "4px 8px" }}
                    value={turnsThread}
                    onChange={(e) => { setTurnsThread(e.target.value); setOpenSec((st) => ({ ...st, turns: true })); }}
                    title="切换 Turns 表的线程（主线程 / 子代理）"
                  >
                    <option value="">主线程 · {data.header.thread_id.slice(0, 8)}</option>
                    {data.subagents.map((s) => (
                      <option key={s.header.thread_id} value={s.header.thread_id}>
                        {s.header.agent_nickname ?? `d${s.header.depth ?? "?"}`} · {s.header.thread_id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="tablewrap" style={{ display: openSec.turns ? undefined : "none" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th><th>开始</th><th>状态</th><th className="r">耗时</th><th className="r">TTFT</th>
                      <th className="r">Token</th><th>in/out</th><th className="r">采样</th><th className="r">wait</th>
                      <th className="r">工具</th><th className="r">MCP</th><th className="r">失败</th><th className="r">补丁</th><th>首条消息</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTurns.map((t) => (
                      <TurnRowView key={t.turn_index} t={t} maxTok={Math.max(...activeTurns.map((x) => x.total_tokens), 1)} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <div className="kv">
                  <span className="k">thread_id</span><span className="v num" style={{ fontSize: 11.5 }}>{data.header.thread_id}</span>
                  <span className="k">工作目录</span><span className="v num" style={{ fontSize: 11.5 }}>{data.header.cwd || "–"}</span>
                  {data.header.git_origin_url && <><span className="k">仓库</span><span className="v num" style={{ fontSize: 11.5 }}>{data.header.git_origin_url}{data.header.git_branch ? ` (${data.header.git_branch})` : ""}</span></>}
                  <span className="k">创建 / 更新</span><span className="v">{fmtDt(data.header.created_ms)} / {fmtDt(data.header.updated_ms)}</span>
                  {data.header.cli_version && <><span className="k">CLI</span><span className="v num">{data.header.cli_version}</span></>}
                  {data.header.originator && <><span className="k">来源</span><span className="v num">{data.header.originator}</span></>}
                  {(data.header.sandbox_policy || data.header.approval_mode) && <>
                    <span className="k">sandbox / approval</span>
                    <span className="v num" style={{ fontSize: 11 }} title={`${data.header.sandbox_policy ?? "–"} · ${data.header.approval_mode ?? "–"}`}>
                      {data.header.sandbox_policy ?? "–"} · {data.header.approval_mode ?? "–"}
                    </span>
                  </>}
                  {data.diag.web_searches > 0 && <><span className="k">web 搜索</span><span className="v num">{data.diag.web_searches}</span></>}
                  {data.diag.schema_issues && (
                    <>
                      <span className="k">schema 异常字段</span>
                      <span
                        className="v num"
                        style={{ fontSize: 11 }}
                        title={Object.entries(data.diag.schema_issues).map(([k, v]) => `${k} × ${v}`).join("\n")}
                      >
                        {Object.entries(data.diag.schema_issues).map(([k, v]) => `${k}×${v}`).join(" · ")}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import { usePoll, type DayDetail } from "../api.ts";
import { fmtTok, fmtFull, fmtPct, fmtMd, fmtHm, STATUS_LABEL, STATUS_CLASS } from "../format.ts";
import { Loading, Empty, StatCard, Icon, ICONS } from "../components/basics.tsx";
import { SplitBar } from "../components/charts.tsx";

const todayStr = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const shiftDate = (date: string, days: number): string => {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 日用量视图：与 Codex 官方每日用量同语义（事件时间戳归日的实际消耗）。 */
export function DayView(props: { date: string; onOpenTask: (id: string) => void; onNavigate: (date: string) => void }) {
  const { data } = usePoll<DayDetail>(`/api/day?date=${props.date}`, 5000);
  const isToday = props.date === todayStr();
  const weekday = useMemo(() => new Date(props.date + "T12:00:00").toLocaleDateString("zh-CN", { weekday: "long" }), [props.date]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="controls">
        <button className="iconbtn" title="前一天" onClick={() => props.onNavigate(shiftDate(props.date, -1))}>
          <Icon d="M15 18l-6-6 6-6" size={15} />
        </button>
        <input
          className="input"
          style={{ minWidth: 150 }}
          type="date"
          value={props.date}
          onChange={(e) => e.target.value && props.onNavigate(e.target.value)}
        />
        <button className="iconbtn" title="后一天" disabled={isToday} onClick={() => props.onNavigate(shiftDate(props.date, 1))} style={isToday ? { opacity: 0.35, cursor: "not-allowed" } : undefined}>
          <Icon d="M9 6l6 6-6 6" size={15} />
        </button>
        {!isToday && (
          <button className="seg" style={{ border: "none" }} onClick={() => props.onNavigate(todayStr())}>
            <span className="badge accent" style={{ cursor: "pointer" }}>回到今天</span>
          </button>
        )}
        <span className="dim" style={{ fontSize: 12 }}>{weekday} · 按事件时间归日的实际消耗</span>
      </div>

      {!data ? (
        <Loading />
      ) : data.total === 0 ? (
        <Empty title="该日无用量" sub="试试 ← → 切换日期，或去「趋势」点击柱状图" />
      ) : (
        <>
          <div className="grid cols4">
            <StatCard
              label="当日消耗" icon={ICONS.bolt} accent="var(--accent)"
              value={fmtTok(data.total)}
              foot={
                <span style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
                  <SplitBar segs={[{ v: data.root, cls: "seg1" }, { v: data.sub, cls: "seg2" }]} />
                  <span>主 {fmtTok(data.root)} · 子代理 {fmtTok(data.sub)}</span>
                </span>
              }
            />
            <StatCard label="按模型" icon={ICONS.tasks} value={<span style={{ fontSize: 16 }}>{data.by_model.slice(0, 2).map((m) => m.model).join(" · ")}</span>}
              foot={data.by_model.map((m) => (
                <span key={m.model} className="badge purple" title={`${m.model}：${fmtFull(m.tokens)}`}>{m.model} {fmtTok(m.tokens)}</span>
              ))} />
            <StatCard label="未命中 / 输出" icon={ICONS.db} value={<>{fmtTok(data.uncached)}<small> / {fmtTok(data.output)}</small></>}
              foot={<span>缓存外输入 · 输出（含推理）</span>} />
            <StatCard label="采样 / wait" icon={ICONS.clock} value={<>{fmtFull(data.samples)}<small> / {data.wait}</small></>}
              foot={<span>wait 占比 {fmtPct(data.wait, data.samples, 1)} · 活跃任务 {data.tasks}</span>} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="section-title" style={{ flex: 1 }}>当日任务（按当日消耗排序）</div>
            <span className="dim" style={{ fontSize: 11.5 }}>「任务域累计」= 该任务开工以来的 root+子代理全量</span>
          </div>
          <div className="tablewrap" style={{ maxHeight: "none" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>任务</th><th>项目</th><th>模型</th>
                  <th className="r">当日消耗</th><th className="r">当日主 / 子</th>
                  <th className="r">任务域累计</th><th className="r">失败</th><th>状态</th><th className="r">最近活动</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks_detail.map((t) => (
                  <tr key={t.thread_id} className="clickable" onClick={() => props.onOpenTask(t.thread_id)}>
                    <td style={{ maxWidth: 320 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span className={`dot-status ${t.status}`} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }} title={t.name}>{t.name}</span>
                      </div>
                    </td>
                    <td className="muted">{t.project}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{t.model}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>{fmtTok(t.day_tokens)}</td>
                    <td className="r num" style={{ fontSize: 12 }}>
                      <span style={{ color: "var(--accent)" }}>{fmtTok(t.day_root)}</span>
                      {" / "}
                      <span style={{ color: t.day_sub > 0 ? "var(--accent2)" : "var(--dim)" }}>{fmtTok(t.day_sub)}</span>
                    </td>
                    <td className="r num dim" title="任务开工以来 root+子代理全量">{fmtTok(t.task_total)}</td>
                    <td className="r num">
                      {t.shell_failures + t.mcp_failures > 0 ? (
                        <span className="badge warn" title={`shell 失败 ${t.shell_failures} · MCP 失败 ${t.mcp_failures}（点击行查看失败明细）`}>
                          ✗ {t.shell_failures + t.mcp_failures}
                        </span>
                      ) : (
                        <span className="dim">–</span>
                      )}
                    </td>
                    <td><span className={`badge ${STATUS_CLASS[t.status] ?? "dim"}`}>{STATUS_LABEL[t.status] ?? t.status}</span></td>
                    <td className="r num dim">{fmtMd(t.activity_ms)} {fmtHm(t.activity_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

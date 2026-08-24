import type { TaskRow } from "../api.ts";
import { fmtHm, fmtTok, fmtDuration, STATUS_LABEL, STATUS_CLASS } from "../format.ts";
import { SplitBar } from "./charts.tsx";
import { Icon, ICONS } from "./basics.tsx";

/** 任务卡：状态点 + 名称 + 项目/时间 + token 总量与 root/sub 拆分 + 关键指标。
 *  showDay=true 时主数字切换为「今日消耗」（当日实际消耗口径），任务域累计降为次要。 */
export function TaskCard(props: { task: TaskRow; onOpen: (id: string) => void; showDay?: boolean }) {
  const t = props.task;
  const waitPct = t.samples ? Math.round((t.wait / t.samples) * 100) : null;
  const dayMode = props.showDay === true && t.day_tokens !== undefined;
  const mainTok = dayMode ? t.day_tokens! : t.total_tokens;
  const barRoot = dayMode ? t.day_root ?? 0 : t.root_tokens;
  const barSub = dayMode ? t.day_sub ?? 0 : t.subagent_tokens;
  return (
    <div className="card hoverable taskcard" onClick={() => props.onOpen(t.thread_id)}>
      <div className="head">
        <span className={`dot-status ${t.status}`} style={{ marginTop: 6 }} />
        <div className="name" title={t.name}>{t.name}</div>
        <span className={`badge ${t.schema_ok ? "dim" : "err"}`}>
          {t.schema_ok ? "schema ok" : "schema!"}
        </span>
      </div>
      <div className="meta">
        <span>{t.project}</span>
        <span>·</span>
        <span>{fmtHm(t.activity_ms)}</span>
        <span>·</span>
        <span>{t.model}</span>
        {t.effort && <span className="badge dim">{t.effort}</span>}
      </div>
      <div className="tokens">
        <span className="big">{fmtTok(mainTok)}</span>
        <span className="dim" style={{ fontSize: 11.5 }}>{dayMode ? "今日消耗" : "tokens"}</span>
        {dayMode && (
          <span className="dim num" style={{ fontSize: 11.5 }} title="任务开工以来 root+子代理全量">累计 {fmtTok(t.total_tokens)}</span>
        )}
        <span style={{ marginLeft: "auto" }} className={`badge ${STATUS_CLASS[t.status] ?? "dim"}`}>
          {STATUS_LABEL[t.status] ?? t.status}
        </span>
      </div>
      <div className="bar">
        <SplitBar
          segs={[
            { v: barRoot, cls: "seg1" },
            { v: barSub, cls: "seg2" },
          ]}
        />
      </div>
      <div className="metrics">
        <span title="主线程 token">主 <b className="num" style={{ color: "var(--accent)" }}>{fmtTok(barRoot)}</b></span>
        <span title="子代理 token（按模型悬停查看明细）">子 <b className="num" style={{ color: "var(--accent2)" }}>{fmtTok(barSub)}</b></span>
        {(t.sub_models ?? [])
          .slice(0, 2)
          .map((m) => (
            <span className="badge purple" key={m.model} title={`${m.model}：${fmtTok(m.tokens)}${m.threads > 1 ? `（${m.threads} 个子代理）` : ""}`}>
              {m.model}{m.threads > 1 ? `×${m.threads}` : ""}
            </span>
          ))}
        {(t.sub_models?.length ?? 0) > 2 && <span className="dim">+{(t.sub_models?.length ?? 0) - 2}</span>}
        <span title="Turn 数 / 子代理数"><Icon d={ICONS.fork} size={12} /> {t.turns} turns · {t.subagents} 子代理</span>
        <span title="usage-bearing 采样 / wait 占比">采样 {t.samples}{waitPct !== null && t.wait > 0 ? ` · wait ${waitPct}%` : ""}</span>
        {t.patches > 0 && <span>补丁 {t.patches}</span>}
        {t.peak_context > 0 && <span title="上下文峰值">峰 {fmtTok(t.peak_context)}</span>}
      </div>
    </div>
  );
}

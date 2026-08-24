import { usePoll, type Summary } from "../api.ts";
import { fmtTok, fmtPct, fmtFull } from "../format.ts";
import { StatCard, Loading, Empty, Icon, ICONS } from "../components/basics.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { SplitBar } from "../components/charts.tsx";

export function TodayView(props: { onOpen: (id: string) => void }) {
  const { data, err } = usePoll<Summary>("/api/summary", 5000);

  if (err && !data) {
    return <Empty title="无法连接采集服务" sub={`请确认 npm run serve 已启动（${err}）`} />;
  }
  if (!data) return <Loading />;
  // 主口径：当日实际消耗（daily_usage，与 Codex 官方每日用量同语义）；任务域累计为辅
  const c = data.consumption ?? {
    root: 0, sub: 0, total: 0, uncached: 0, output: 0, samples: 0, wait: 0, tasks: 0, by_model: [],
    date: data.date,
  };
  const cachedShare = Math.max(0, c.total - c.uncached - c.output);
  const cacheHit = cachedShare + c.uncached > 0 ? cachedShare / (cachedShare + c.uncached) : 0;
  const peak = Math.max(0, ...data.tasks.map((x) => x.peak_context));
  const active = data.tasks.filter((x) => x.status === "possibly_active").length;
  const waitPct = c.samples ? (c.wait / c.samples) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="grid cols6">
        <StatCard
          label="今日消耗"
          icon={ICONS.bolt}
          accent="var(--accent)"
          value={<>{fmtTok(c.total)}</>}
          foot={
            <span style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
              <SplitBar segs={[{ v: c.root, cls: "seg1" }, { v: c.sub, cls: "seg2" }]} />
              <span>主 {fmtTok(c.root)} · 子 {fmtTok(c.sub)}</span>
            </span>
          }
        />
        <StatCard label="任务 / 进行中" icon={ICONS.tasks} value={<>{data.tasks.length}{active > 0 && <small style={{ color: "var(--green)" }}> · {active} 活跃</small>}</>} foot={<span>今日活跃任务（卡内含当日消耗）</span>} />
        <StatCard label="缓存命中率" icon={ICONS.db} value={fmtPct(cachedShare, cachedShare + c.uncached, 1)} foot={<span>未命中 {fmtTok(c.uncached)}</span>} />
        <StatCard label="输出 Token" icon={ICONS.bolt} accent="var(--cyan)" value={fmtTok(c.output)} foot={<span>含推理输出</span>} />
        <StatCard label="模型采样" icon={ICONS.clock} value={fmtFull(c.samples)} foot={<span>wait/status 调用 {fmtFull(c.wait)}（{waitPct.toFixed(1)}%）· wait Token {fmtTok(c.wait_tokens_est ?? null)}</span>} />
        <StatCard label="上下文峰值" icon={ICONS.trend} accent={peak > 200000 ? "var(--amber)" : undefined} value={fmtTok(peak)} foot={<span>当日任务最大值</span>} />
        <StatCard
          label="当日成本"
          icon={ICONS.db}
          value={c.cost_est ? `$${c.cost_est.total.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "–"}
          foot={
            <span>
              {c.cost_est
                ? `estimated · 按时点价${c.cost_est.missing_models.length ? ` · ${c.cost_est.missing_models.length} 模型未配价（下界）` : ""}`
                : "价格未配置（model_prices.json）"}
            </span>
          }
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="section-title" style={{ flex: 1 }}>今日任务</div>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {data.date} · 采集于 {new Date(data.status.last_update_ms).toLocaleTimeString("zh-CN")}
          {data.daemon?.running ? " · 实时采集运行中" : ""}
        </span>
      </div>

      {data.tasks.length === 0 ? (
        <Empty title="今天还没有任务" sub="在 ChatGPT 桌面端（Codex 视图）发起一个任务试试" />
      ) : (
        <div className="grid cols2">
          {data.tasks.map((task) => (
            <TaskCard key={task.thread_id} task={task} onOpen={props.onOpen} showDay />
          ))}
        </div>
      )}
      {data.tasks.length === 8 && (
        <div className="dim" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <Icon d={ICONS.tasks} size={13} /> 仅显示最新 8 个任务，完整列表见「任务」页
        </div>
      )}
    </div>
  );
}

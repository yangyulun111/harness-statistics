import { useState } from "react";
import { usePoll, type DailyPoint } from "../api.ts";
import { fmtTok, fmtFull } from "../format.ts";
import { StackedBars, type StackDatum } from "../components/charts.tsx";
import { Loading, Empty, StatCard, Icon, ICONS } from "../components/basics.tsx";

/** 趋势：按日实际消耗（与 Codex 官方日用量同语义），点击柱子进入当日详情。 */
export function TrendView(props: { onOpenDay: (date: string) => void }) {
  const [days, setDays] = useState(14);
  const { data } = usePoll<DailyPoint[]>(`/api/daily?days=${days}`, 10000);

  if (!data) return <Loading />;
  if (data.every((d) => d.total === 0)) return <Empty title="区间内没有用量" />;

  const chartData: StackDatum[] = data.map((d) => ({
    label: d.date.slice(5),
    parts: [
      { v: d.root, name: "主线程", color: "#5b9dff" },
      { v: d.sub, name: "子代理", color: "#8b7cff" },
    ],
  }));
  const dates = data.map((d) => d.date);
  const total = data.reduce((a, d) => a + d.total, 0);
  const active = data.filter((d) => d.total > 0);
  const avg = total / Math.max(active.length, 1);
  const peakDay = data.reduce((m, d) => (d.total > m.total ? d : m), data[0]!);
  const samples = data.reduce((a, d) => a + d.samples, 0);
  const wait = data.reduce((a, d) => a + d.wait, 0);
  const tasks = data.reduce((a, d) => a + d.tasks, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="controls">
        <div className="seg">
          {[7, 14, 30, 60].map((d) => (
            <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
              {d} 天
            </button>
          ))}
        </div>
        <span className="dim" style={{ fontSize: 12 }}>按日实际消耗 · 点击柱子查看当日详情</span>
        <div className="legend" style={{ marginLeft: "auto" }}>
          <span className="key"><span className="swatch" style={{ background: "#5b9dff" }} />主线程</span>
          <span className="key"><span className="swatch" style={{ background: "#8b7cff" }} />子代理</span>
        </div>
      </div>

      <div className="card" style={{ padding: "18px 14px 8px" }}>
        <StackedBars
          data={chartData}
          height={260}
          tipRows={(d) => [
            ["主线程", fmtTok(d.parts[0]!.v)],
            ["子代理", fmtTok(d.parts[1]!.v)],
            ["合计", fmtTok(d.parts[0]!.v + d.parts[1]!.v)],
          ]}
          onBarClick={(label) => {
            const idx = chartData.findIndex((c) => c.label === label);
            if (idx >= 0 && dates[idx]) props.onOpenDay(dates[idx]!);
          }}
        />
      </div>

      <div className="grid cols4">
        <StatCard label="区间总消耗" icon={ICONS.bolt} accent="var(--accent)" value={fmtTok(total)} foot={<span>{data.length} 天窗口 · 与官方日用量同口径</span>} />
        <StatCard label="活跃日均" value={fmtTok(avg)} foot={<span>仅统计有用量的 {active.length} 天</span>} />
        <StatCard label="峰值日" icon={ICONS.trend} accent="var(--amber)" value={fmtTok(peakDay.total)} foot={<span>{peakDay.date} · {peakDay.tasks} 任务</span>} />
        <StatCard label="采样 / wait" icon={ICONS.clock} value={fmtFull(samples)} foot={<span>wait {fmtFull(wait)}（{((wait / Math.max(samples, 1)) * 100).toFixed(1)}%）· 任务数 Σ{tasks}</span>} />
      </div>
    </div>
  );
}

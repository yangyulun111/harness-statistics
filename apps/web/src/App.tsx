import { useEffect, useState } from "react";
import { Icon, ICONS } from "./components/basics.tsx";
import { TodayView } from "./views/TodayView.tsx";
import { TasksView } from "./views/TasksView.tsx";
import { ProjectsView } from "./views/ProjectsView.tsx";
import { TrendView } from "./views/TrendView.tsx";
import { StatusView } from "./views/StatusView.tsx";
import { TaskDetailView } from "./views/TaskDetail.tsx";
import { DayView, shiftDate } from "./views/DayView.tsx";

type View = "today" | "day" | "tasks" | "projects" | "trend" | "status";

const todayStr = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const NAV: Array<{ key: View; label: string; icon: string; title: string; sub: string }> = [
  { key: "today", label: "今日", icon: ICONS.today, title: "今日概览", sub: "当日实际消耗为主 · 任务域累计为辅" },
  { key: "day", label: "日用量", icon: ICONS.calendar, title: "日用量", sub: "按日实际消耗（与 Codex 官方每日用量同语义）" },
  { key: "tasks", label: "任务", icon: ICONS.tasks, title: "任务列表", sub: "全部任务（任务域 = root + 子代理）" },
  { key: "projects", label: "项目", icon: ICONS.projects, title: "项目聚合", sub: "按工作目录分组" },
  { key: "trend", label: "趋势", icon: ICONS.trend, title: "使用趋势", sub: "按日消耗 · 点击柱子看当日详情" },
  { key: "status", label: "状态", icon: ICONS.status, title: "采集与对账", sub: "守护进程 · G0-A · schema" },
];

function parseHash(): { view: View; param: string | null } {
  const h = location.hash.replace(/^#\/?/, "");
  const idx = h.indexOf("/");
  const head = idx === -1 ? h : h.slice(0, idx);
  // day 视图的 param 为 "<日期>/<线程ID>"（任务详情浮层），不能按 "/" 截断
  const view = NAV.some((n) => n.key === head) ? (head as View) : "today";
  return { view, param: idx === -1 ? null : h.slice(idx + 1) || null };
}

export function App() {
  const [{ view, param }, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const isDay = view === "day";
  // day 视图的 param 为 "<日期>" 或 "<日期>/<线程ID>"（后者打开任务详情浮层）
  const dayDate = isDay && param ? param.split("/")[0] : null;
  const taskId = isDay ? param?.split("/")[1] ?? null : param;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && taskId) go("");
      // day 视图 ← → 切换日期（与空态提示一致）；浮层打开时不响应
      if (isDay && !taskId && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // 不劫持日期输入框自带的方向键
        const cur = dayDate ?? todayStr();
        if (e.key === "ArrowLeft") openDay(shiftDate(cur, -1));
        else if (cur !== todayStr()) openDay(shiftDate(cur, 1)); // 今天按 → 无操作，与"后一天"按钮禁用一致
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const go = (fragment: string) => {
    location.hash = fragment
      ? `#/${fragment}`
      : `#/${view}${isDay && dayDate ? `/${dayDate}` : ""}`;
    if (!fragment) setRoute({ view, param: isDay ? dayDate : null });
  };

  const openTask = (id: string) => {
    const frag = isDay ? `day/${dayDate ?? todayStr()}/${id}` : `${view}/${id}`;
    location.hash = `#/${frag}`;
    setRoute({ view, param: isDay ? `${dayDate ?? todayStr()}/${id}` : id });
  };

  const openDay = (date: string) => {
    location.hash = `#/day/${date}`;
    setRoute({ view: "day", param: date });
  };

  const nav = NAV.find((n) => n.key === view)!;
  // 任务详情的日上下文：从「今日」打开 → 当天；从「日用量」打开 → 该日；其他入口 → null（仅总计）
  const taskDay = taskId ? (isDay ? dayDate : view === "today" ? todayStr() : null) : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <svg width="30" height="30" viewBox="0 0 32 32">
            <defs>
              <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5b9dff" />
                <stop offset="1" stopColor="#8b7cff" />
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg)" />
            <path d="M9 20 L14 12 L18 17 L23 9" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="23" cy="9" r="2.4" fill="#fff" />
          </svg>
          <div>
            <div className="t1">Harness Stats</div>
            <div className="t2">Codex Task Ledger</div>
          </div>
        </div>

        {NAV.map((n) => (
          <div
            key={n.key}
            className={`nav-item ${view === n.key ? "active" : ""}`}
            onClick={() => {
              location.hash = `#/${n.key}`;
              setRoute({ view: n.key, param: null });
            }}
          >
            <Icon d={n.icon} />
            {n.label}
          </div>
        ))}

        <div className="foot">
          <span><b>TS 轨</b> · G1 Golden 全等</span>
          <span>Python oracle 冻结参照</span>
          <span style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}>
            <span className="dot-status possibly_active" style={{ width: 6, height: 6 }} />
            零侵入 · 只读 ~/.codex
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{taskId ? "任务详情" : nav.title}</h1>
          <span className="sub">{taskId ? "Turn / Token / 子代理拆解" : nav.sub}</span>
          <span className="spacer" />
          <div className="live">
            <span className="dot" />
            实时 · 5s
          </div>
        </header>
        <section className="content">
          {view === "today" && <TodayView onOpen={openTask} />}
          {isDay && <DayView date={dayDate ?? todayStr()} onOpenTask={openTask} onNavigate={openDay} />}
          {view === "tasks" && <TasksView onOpen={openTask} />}
          {view === "projects" && <ProjectsView />}
          {view === "trend" && <TrendView onOpenDay={openDay} />}
          {view === "status" && <StatusView onOpenTask={openTask} />}
        </section>
      </main>

      {taskId && <TaskDetailView id={taskId} day={taskDay} onClose={() => go("")} />}
    </div>
  );
}

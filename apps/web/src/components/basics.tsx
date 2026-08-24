import type { CSSProperties, ReactNode } from "react";

export function Icon(props: { d: string; size?: number }) {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={props.d} />
    </svg>
  );
}

export const ICONS = {
  today: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  tasks: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
  trend: "M3 3v18h18M7 14l4-4 3 3 5-6",
  status: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  close: "M18 6L6 18M6 6l12 12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  bolt: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  db: "M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3",
  fork: "M6 3v12a3 3 0 0 0 3 3h6M18 21v-3M15 15l6 6M15 21l6-6",
};

export function StatCard(props: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon?: string;
  accent?: string;
}) {
  return (
    <div className="card statcard">
      <div className="label">
        {props.icon && <span style={{ color: props.accent ?? "var(--dim)" }}><Icon d={props.icon} size={14} /></span>}
        {props.label}
      </div>
      <div className="value" style={props.accent ? { color: props.accent } : undefined}>{props.value}</div>
      {props.foot && <div className="foot">{props.foot}</div>}
    </div>
  );
}

export function Loading(props: { text?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <span>{props.text ?? "加载中…"}</span>
    </div>
  );
}

export function Empty(props: { title: string; sub?: string }) {
  return (
    <div className="empty">
      <div className="big">{props.title}</div>
      {props.sub && <div>{props.sub}</div>}
    </div>
  );
}

export function SectionTitle(props: { children: ReactNode; style?: React.CSSProperties }) {
  return <div className="section-title" style={props.style}>{props.children}</div>;
}

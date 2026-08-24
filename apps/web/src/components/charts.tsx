import { useState } from "react";
import { fmtTok } from "../format.ts";

/** 分段条：root/sub 双色（或任意段）。 */
export function SplitBar(props: { segs: Array<{ v: number; cls: string }>; height?: number }) {
  const total = props.segs.reduce((a, s) => a + s.v, 0) || 1;
  return (
    <div className="splitbar" style={{ height: props.height ?? 6 }}>
      {props.segs.map((s, i) =>
        s.v > 0 ? (
          <div key={i} className={s.cls} style={{ width: `${(s.v / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

export interface StackDatum {
  label: string;
  parts: Array<{ v: number; name: string; color: string }>;
  tip?: Array<[string, string]>;
}

/** 堆叠柱状图（纯 SVG，hover tooltip，可点击柱子）。 */
export function StackedBars(props: {
  data: StackDatum[];
  height?: number;
  fmt?: (n: number) => string;
  tipRows?: (d: StackDatum) => Array<[string, string]>;
  onBarClick?: (label: string) => void;
}) {
  const H = props.height ?? 240;
  const W = 980;
  const padL = 56;
  const padB = 26;
  const padT = 14;
  const [tip, setTip] = useState<{ x: number; y: number; rows: Array<[string, string]>; title: string } | null>(null);
  const fmt = props.fmt ?? fmtTok;
  const max = Math.max(1, ...props.data.map((d) => d.parts.reduce((a, p) => a + p.v, 0)));
  // y 轴友好刻度
  const pow = 10 ** Math.floor(Math.log10(max));
  const stepCandidates = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  const yStep = stepCandidates.find((s) => max / s <= 4.5) ?? pow * 10;
  const yMax = Math.ceil(max / yStep) * yStep;
  const innerW = W - padL - 12;
  const innerH = H - padB - padT;
  const bw = Math.max(6, (innerW / Math.max(props.data.length, 1)) * 0.56);

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        {Array.from({ length: Math.round(yMax / yStep) + 1 }, (_, i) => {
          const y = padT + innerH - (i * yStep / yMax) * innerH;
          return (
            <g key={i}>
              <line x1={padL} x2={W - 12} y1={y} y2={y} stroke="#1d2637" strokeWidth="1" />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" className="axis-label">
                {fmt(i * yStep)}
              </text>
            </g>
          );
        })}
        {props.data.map((d, i) => {
          const cx = padL + (i + 0.5) * (innerW / Math.max(props.data.length, 1));
          let acc = 0;
          const totalV = d.parts.reduce((a, p) => a + p.v, 0);
          return (
            <g
              key={d.label}
              style={{ cursor: props.onBarClick ? "pointer" : "default" }}
              onClick={() => props.onBarClick?.(d.label)}
              onMouseMove={(e) => {
                const rows = (props.tipRows ? props.tipRows(d) : d.parts.map((p) => [p.name, fmt(p.v)] as [string, string]));
                setTip({ x: e.clientX, y: e.clientY, rows, title: d.label });
              }}
              onMouseLeave={() => setTip(null)}
            >
              <rect x={cx - (innerW / props.data.length) / 2} y={padT} width={innerW / props.data.length} height={innerH} fill="transparent" />
              {d.parts.map((p, j) => {
                const h = (p.v / yMax) * innerH;
                const y = padT + innerH - acc - h;
                acc += h;
                if (p.v <= 0) return null;
                return (
                  <rect
                    key={j}
                    x={cx - bw / 2}
                    y={y}
                    width={bw}
                    height={Math.max(h, 1)}
                    rx={j === d.parts.length - 1 ? Math.min(3, bw / 3) : 0}
                    fill={p.color}
                    opacity={tip && tip.title === d.label ? 1 : 0.88}
                  />
                );
              })}
              {i % Math.ceil(props.data.length / 12) === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" className="axis-label">
                  {d.label}
                </text>
              )}
              {totalV === max && max > 0 && (
                <text x={cx} y={padT + innerH - acc - 5} textAnchor="middle" className="axis-label" fill="#93a1b8">
                  {fmt(totalV)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div
          className="chart-tip"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 200), top: tip.y + 14 }}
        >
          <div style={{ color: "#e8eef8", fontWeight: 600, marginBottom: 2 }}>{tip.title}</div>
          {tip.rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 18 }}>
              <span style={{ color: "#93a1b8" }}>{k}</span>
              <span className="num">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface DonutSeg {
  name: string;
  v: number;
  color: string;
}

/** 环形图（SVG stroke-dasharray）。 */
export function Donut(props: { segs: DonutSeg[]; size?: number; center: [string, string] }) {
  const size = props.size ?? 148;
  const r = 54;
  const c = 2 * Math.PI * r;
  const total = props.segs.reduce((a, s) => a + s.v, 0) || 1;
  let acc = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <svg width={size} height={size} viewBox="0 0 140 140" style={{ flex: "none", transform: "rotate(-90deg)" }}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="#1a2233" strokeWidth="16" />
        {props.segs.map((s, i) => {
          const frac = s.v / total;
          const el = (
            <circle
              key={i}
              cx="70" cy="70" r={r} fill="none"
              stroke={s.color} strokeWidth="16"
              strokeDasharray={`${frac * c} ${c}`}
              strokeDashoffset={-acc * c}
              strokeLinecap="butt"
            />
          );
          acc += frac;
          return s.v > 0 ? el : null;
        })}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 120 }}>
        <div>
          <div className="num" style={{ fontSize: 21, fontWeight: 650 }}>{props.center[0]}</div>
          <div style={{ fontSize: 11, color: "var(--dim)" }}>{props.center[1]}</div>
        </div>
        {props.segs.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--muted)" }}>
            <span className="swatch" style={{ background: s.color, width: 9, height: 9, borderRadius: 3, display: "inline-block" }} />
            {s.name}
            <span className="num" style={{ marginLeft: "auto", color: "var(--text)" }}>{fmtTok(s.v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


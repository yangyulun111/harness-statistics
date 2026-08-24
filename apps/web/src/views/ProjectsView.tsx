import { useMemo, useState } from "react";
import { usePoll, type ProjectRow } from "../api.ts";
import { fmtTok, fmtDt, fmtPct, fmtFull } from "../format.ts";
import { Loading, Empty } from "../components/basics.tsx";

export function ProjectsView(props: { onOpen?: (id: string) => void }) {
  const [days, setDays] = useState(0);
  const { data } = usePoll<ProjectRow[]>(`/api/projects${days ? `?days=${days}` : ""}`, 8000);
  const sorted = useMemo(() => [...(data ?? [])].sort((a, b) => b.total_tokens - a.total_tokens), [data]);
  const maxTok = Math.max(1, ...sorted.map((p) => p.total_tokens));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="controls">
        <div className="seg">
          {[30, 90, 0].map((d) => (
            <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
              {d === 0 ? "全部" : `近 ${d} 天`}
            </button>
          ))}
        </div>
        <span className="dim" style={{ fontSize: 12, marginLeft: "auto" }}>{sorted.length} 个项目 · 按 Token 总量排序</span>
      </div>
      {!data ? (
        <Loading />
      ) : sorted.length === 0 ? (
        <Empty title="暂无项目数据" />
      ) : (
        <div className="tablewrap" style={{ maxHeight: "none" }}>
          <table className="table">
            <thead>
              <tr>
                <th>项目</th>
                <th>Token 构成</th>
                <th className="r">总 Token</th>
                <th className="r">主 / 子代理</th>
                <th className="r">任务</th>
                <th className="r">子代理数</th>
                <th className="r">采样 / wait</th>
                <th className="r">未命中</th>
                <th>模型</th>
                <th className="r">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.project + p.cwd}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.project}</div>
                    <div className="dim" style={{ fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.cwd}>{p.cwd || "–"}</div>
                  </td>
                  <td style={{ minWidth: 160 }}>
                    <div className="projbar">
                      <div className="root" style={{ width: `${(p.root_tokens / Math.max(p.total_tokens, 1)) * 100}%` }} />
                      <div className="sub" style={{ width: `${(p.subagent_tokens / Math.max(p.total_tokens, 1)) * 100}%` }} />
                    </div>
                    <div className="dim" style={{ fontSize: 10.5, marginTop: 3 }}>
                      占全局 {((p.total_tokens / maxTok) * 100).toFixed(0)}%
                    </div>
                  </td>
                  <td className="r num" style={{ fontWeight: 600 }}>{fmtTok(p.total_tokens)}</td>
                  <td className="r num" style={{ fontSize: 12 }}>
                    <span style={{ color: "var(--accent)" }}>{fmtTok(p.root_tokens)}</span>
                    {" / "}
                    <span style={{ color: "var(--accent2)" }}>{fmtTok(p.subagent_tokens)}</span>
                  </td>
                  <td className="r num">{p.tasks}</td>
                  <td className="r num">{p.subagents}</td>
                  <td className="r num dim">{fmtFull(p.samples)}{p.wait ? ` / ${Math.round((p.wait / Math.max(p.samples, 1)) * 100)}%` : ""}</td>
                  <td className="r num dim" title={`缓存命中率 ${fmtPct(p.total_tokens - p.uncached_tokens - p.output_tokens, p.total_tokens - p.output_tokens, 1)}`}>
                    {fmtTok(p.uncached_tokens)}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{p.models.slice(0, 3).join(", ")}{p.models.length > 3 ? "…" : ""}</td>
                  <td className="r num dim">{fmtDt(p.last_active_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

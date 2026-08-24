import { useMemo, useState } from "react";
import { usePoll, type TaskRow } from "../api.ts";
import { fmtTok, fmtHm, fmtMd, fmtDuration, fmtFull, STATUS_LABEL, STATUS_CLASS } from "../format.ts";
import { Loading, Empty } from "../components/basics.tsx";

export function TasksView(props: { onOpen: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const [q, setQ] = useState("");
  const [onlySchemaIssue, setOnlySchemaIssue] = useState(false);
  // days=0（全部）时省略 days 参数，与服务端"缺省=不限"语义对齐（同 ProjectsView）
  const { data } = usePoll<TaskRow[]>(`/api/tasks?limit=500${days ? `&days=${days}` : ""}`, 5000);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.filter((r) => {
      if (onlySchemaIssue && r.schema_ok) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        r.project.toLowerCase().includes(needle) ||
        r.model.toLowerCase().includes(needle) ||
        r.thread_id.startsWith(needle)
      );
    });
  }, [data, q, onlySchemaIssue]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="controls">
        <input className="input" placeholder="搜索任务 / 项目 / 模型 / thread id…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {[7, 30, 0].map((d) => (
            <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>
              {d === 0 ? "全部" : `近 ${d} 天`}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={onlySchemaIssue} onChange={(e) => setOnlySchemaIssue(e.target.checked)} />
          仅看 schema 异常
        </label>
        <span className="dim" style={{ fontSize: 12, marginLeft: "auto" }}>{rows.length} 个任务</span>
      </div>

      {!data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="没有匹配的任务" />
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>项目</th>
                <th>模型</th>
                <th className="r">Turns</th>
                <th className="r">主 Token</th>
                <th className="r">子代理</th>
                <th className="r">总 Token</th>
                <th>构成</th>
                <th className="r">采样/wait</th>
                <th className="r">失败</th>
                <th>状态</th>
                <th className="r">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.thread_id} className="clickable" onClick={() => props.onOpen(r.thread_id)}>
                  <td style={{ maxWidth: 300 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className={`dot-status ${r.status}`} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={r.name}>
                        {r.name}
                      </span>
                    </div>
                  </td>
                  <td className="muted">{r.project}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.model}</td>
                  <td className="r num">{r.turns}</td>
                  <td className="r num" style={{ color: "var(--accent)" }}>{fmtTok(r.root_tokens)}</td>
                  <td
                    className="r num"
                    style={{ color: r.subagent_tokens > 0 ? "var(--accent2)" : "var(--dim)" }}
                    title={(r.sub_models ?? []).map((m) => `${m.model}：${fmtTok(m.tokens)}${m.threads > 1 ? ` ×${m.threads}` : ""}`).join("\n")}
                  >
                    {r.subagents ? (
                      <>
                        {fmtTok(r.subagent_tokens)} <span className="dim">({r.subagents}{r.sub_models?.[0] ? ` · ${r.sub_models[0].model}` : ""})</span>
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="r num" style={{ fontWeight: 600 }}>{fmtTok(r.total_tokens)}</td>
                  <td>
                    <div className="minibar" title={`主 ${fmtTok(r.root_tokens)} / 子 ${fmtTok(r.subagent_tokens)}`}>
                      <div className="a" style={{ width: `${(r.root_tokens / Math.max(r.total_tokens, 1)) * 100}%`, background: "var(--accent)" }} />
                      <div className="b" style={{ width: `${(r.subagent_tokens / Math.max(r.total_tokens, 1)) * 100}%`, background: "var(--accent2)" }} />
                    </div>
                  </td>
                  <td className="r num dim">{r.samples ? `${fmtFull(r.samples)}${r.wait ? ` / ${Math.round((r.wait / r.samples) * 100)}%` : ""}` : "–"}</td>
                  <td className="r num">
                    {r.shell_failures + r.mcp_failures > 0 ? (
                      <span className="badge warn" title={`shell 失败 ${r.shell_failures} · MCP 失败 ${r.mcp_failures}（点击行查看失败明细）`}>
                        ✗ {r.shell_failures + r.mcp_failures}
                      </span>
                    ) : (
                      <span className="dim">–</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[r.status] ?? "dim"}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    {!r.schema_ok && <span className="badge err" style={{ marginLeft: 4 }}>schema</span>}
                  </td>
                  <td className="r num dim">{fmtMd(r.activity_ms)} {fmtHm(r.activity_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

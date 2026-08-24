/**
 * 时间戳归一化 —— 与 Python oracle ledger/timeutil.py to_ms 行为一致：
 * ISO 字符串（无时区按 UTC）/ epoch 秒 / epoch 毫秒 -> epoch 毫秒；无法解析返回 null。
 * 注意：JS Date.parse 对无时区 ISO 按本地时区，这里显式补 Z 对齐 Python fromisoformat + UTC 语义。
 */

export function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    const v = value;
    if (v <= 0) return null;
    // 1e12 ms ≈ 2001-09；大于它按已是毫秒处理
    return v >= 1e12 ? Math.trunc(v) : Math.trunc(v * 1000);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    let t = s;
    if (t.endsWith("Z") || t.endsWith("z")) {
      t = t.slice(0, -1) + "+00:00";
    } else if (!/[+-]\d{2}:?\d{2}$/.test(t)) {
      t = t + "Z"; // Python fromisoformat 无时区按 UTC
    }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function localDate(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtHm(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "--:--";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.trunc(s);
  let m = Math.floor(total / 60);
  const s2 = total % 60;
  if (m < 60) return `${m}m${pad2(s2)}s`;
  const h = Math.floor(m / 60);
  m = m % 60;
  return `${h}h${pad2(m)}m`;
}

export function fmtTok(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

export function fmtFull(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export function fmtPct(a: number, b: number, digits = 0): string {
  if (!b) return "–";
  return ((a / b) * 100).toFixed(digits) + "%";
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const s2 = Math.floor(s % 60);
  if (m < 60) return `${m}m${String(s2).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}

/** 成本（estimated）：小数位随量级收缩，>1000 用千分位。 */
export function fmtCost(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined) return "–";
  const sym = currency === "USD" ? "$" : currency + " ";
  if (n >= 1000) return sym + n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return sym + n.toFixed(2);
  return sym + n.toFixed(4);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function fmtHm(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtMd(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtDt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const STATUS_LABEL: Record<string, string> = {
  completed: "已完成",
  interrupted: "已中断",
  possibly_active: "进行中",
  unknown: "未知",
  idle: "空闲",
};

export const STATUS_CLASS: Record<string, string> = {
  completed: "ok",
  interrupted: "warn",
  possibly_active: "live",
  unknown: "dim",
  idle: "dim",
};

/**
 * 路径工具 —— normcase 与 Python oracle collector.normcase 行为一致
 * （去掉 \\?\ 前缀；<240 字符走 resolve→posix→lower，超长仅 lower）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normcase(p?: string | null): string | null {
  if (!p) return null;
  let s = String(p);
  const BS = String.fromCharCode(92); // 反斜杠，避免源文件转义歧义
  if (s.startsWith(BS + "?\\")) s = s.slice(4);
  if (s.length < 240) {
    return path.resolve(s).split(path.sep).join("/").toLowerCase();
  }
  return s.toLowerCase();
}

/** rollout-2026-07-15T23-29-05-<uuid>.jsonl -> <uuid>（session_meta.id 缺失时的兜底）。 */
export function uuidFromName(name: string): string | null {
  const m = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/** 仓库根（packages/shared/src -> 上三级）。 */
export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const DEFAULT_TS_DB = () => path.join(projectRoot(), "data", "ts", "collector.sqlite");

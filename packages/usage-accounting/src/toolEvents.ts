/**
 * 工具事件提取（v1.3，TS-only 扩展，estimated 分类）：
 *   - 分桶：shell / file / mcp / web / collab / other（分类基于事件形态与工具名，heuristic）；
 *   - per-call 时长 = 同 call_id 的 call↔output 顶层 timestamp 差（MCP 用结构化 duration）；
 *   - shell 成败：输出文本解析 JSON 风格 exit_code 与纯文本 "Exit code: N" 双口径（比契约列
 *     shell_failures 更准——该契约列仅 JSON 风格，真实 rollout 多为纯文本；两表口径差异已注明）；
 *   - 文件行为：patch_apply_end 的 unified_diff 统计 ± 行（add 类数 content 行，estimated）；
 *     读检测从 exec 命令文本启发式识别（cat/rg/grep…），一律 estimated、fail-closed 不猜。
 * 本模块同时服务于 processLine（增量）与 refoldToolEvents（全量回填），保证两路口径一致。
 */
import { WAIT_ACTIONS, type Json } from "@hs/shared";

export type ToolBucket = "shell" | "file" | "mcp" | "web" | "collab" | "other";

export interface PendingToolCall {
  command: string | null;
  ts_ms: number | null;
  name: string;
  bucket: ToolBucket;
  consumed: boolean;
}

/** 工具分桶（heuristic）：协作/wait 优先，exec/bash=shell，web_search=web，其余 other。 */
export function toolBucketOf(payloadType: string, name: string, namespace: string | null): ToolBucket {
  if (namespace === "collaboration" || WAIT_ACTIONS.has(name)) return "collab";
  if (payloadType === "local_shell_call" || name === "exec" || name === "bash" || name === "shell") return "shell";
  if (payloadType === "web_search_call" || name === "web_search") return "web";
  return "other";
}

const EXIT_TEXT_RE = /Exit code:\s*(-?\d+)/;

/** shell 退出码双口径：JSON 风格 "exit_code":N 优先，其次纯文本 "Exit code: N"（均可无 → null，不猜）。 */
export function shellExitCodeOf(text: string): number | null {
  if (text.includes("exit_code")) {
    const re = /"exit_code"\s*:\s*(-?\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (Number(m[1]) !== 0) return Number(m[1]);
      if (m[1] === "0") return 0;
    }
  }
  const t = text.match(EXIT_TEXT_RE);
  return t ? Number(t[1]) : null;
}

/** 从 exec 的 JS 包装代码里提取 command 字符串（"..." 与 `...` 两种引号，含转义还原；heuristic）。 */
export function extractShellCommands(input: string): string[] {
  const out: string[] = [];
  const re = /(?:command|cmd)\s*:\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const isDq = m[2] !== undefined;
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    if (!raw) continue;
    if (isDq) {
      try {
        out.push(JSON.parse(`"${raw}"`));
        continue;
      } catch { /* 转义异常按原文 */ }
    }
    out.push(raw.replace(/\\(["'`])/g, "$1").replace(/\\\\/g, "\\").replace(/\\\$\{/g, "${"));
  }
  return out;
}

const READ_CMD_HEAD_RE = /^(?:cat|head|tail|nl|less|more|rg|grep|ag|ack|find|ls|type|wc|du|df|file|stat|Get-Content|gc|Select-String|where)(?:\.exe)?\b/i;

function isReadCommand(s: string): boolean {
  const trimmed = s.trim();
  if (/^git\b/.test(trimmed)) return /\b(log|show|diff|blame|status)\b/.test(trimmed);
  return READ_CMD_HEAD_RE.test(trimmed);
}

/** 读行为（estimated）：按 &&/||/;/| 拆分命令段，读类命令计 reads；路径样 token（含分隔符、非旗标）入 files。 */
export function readStatsOf(commands: string[]): { reads: number; files: string[] } {
  let reads = 0;
  const files: string[] = [];
  for (const cmd of commands) {
    for (const part of cmd.split(/&&|\|\||;|\|/)) {
      const s = part.trim();
      if (!s || !isReadCommand(s)) continue;
      reads += 1;
      for (const tok of s.split(/\s+/).slice(1)) {
        const t = tok.replace(/^["'`]+|["'`]+$/g, "").replace(/[:*"]+$/, "");
        // 路径样 token：含分隔符、非旗标、非重定向（2>/dev/null 等）/通配/设备文件
        if ((t.includes("/") || t.includes("\\")) && !t.startsWith("-") && !/[<>]/.test(t)
          && !t.includes("*") && !/\/dev\/(null|tty|zero|random)/.test(t)
          && t.length > 2 && !t.includes("=") && !files.includes(t)) {
          files.push(t);
        }
      }
    }
  }
  return { reads, files: files.slice(0, 50) };
}

/** patch changes 的 ± 行统计：update 类数 unified_diff 的 +/- 行（排除 +++/--- 文件头），add 类数 content 行（estimated）。 */
export function patchLinesOf(changes: unknown): { files: number; linesPlus: number; linesMinus: number } {
  let linesPlus = 0;
  let linesMinus = 0;
  let files = 0;
  if (changes !== null && typeof changes === "object" && !Array.isArray(changes)) {
    for (const v of Object.values(changes as Record<string, unknown>)) {
      if (v === null || typeof v !== "object") continue;
      files += 1;
      const e = v as Record<string, unknown>;
      const diff = e["unified_diff"];
      if (typeof diff === "string" && diff) {
        for (const ln of diff.split("\n")) {
          if (ln.startsWith("+") && !ln.startsWith("+++")) linesPlus += 1;
          else if (ln.startsWith("-") && !ln.startsWith("---")) linesMinus += 1;
        }
      } else {
        const content = e["content"];
        if (typeof content === "string" && content) linesPlus += content.split("\n").length;
      }
    }
  }
  return { files, linesPlus, linesMinus };
}

/** MCP 结构化 duration {secs, nanos} → 毫秒。 */
export function mcpDurationMs(payload: Json): number | null {
  const d = payload["duration"];
  if (d === null || typeof d !== "object") return null;
  const secs = Number((d as Record<string, unknown>)["secs"]);
  const nanos = Number((d as Record<string, unknown>)["nanos"]);
  if (!Number.isFinite(secs)) return null;
  return Math.round(secs * 1000 + (Number.isFinite(nanos) ? nanos : 0) / 1e6);
}

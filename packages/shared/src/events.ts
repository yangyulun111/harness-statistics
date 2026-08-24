/**
 * Rollout 事件契约（Zod）：一般字段 ignore（passthrough），关键字段 fail-closed。
 * fail-closed 判定函数（isTokenCountMalformed / sessionMetaIdentity）与 Python oracle
 * process_line 的 isinstance 检查逐条对应 —— Golden 测试（G1）守护该等价性。
 */
import { z } from "zod";

export type Json = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** token_count.info / .total_token_usage 必须是对象（Python: isinstance(x, dict)）。 */
const DictShape = z.record(z.unknown());

export const TokenUsageShape = z
  .object({
    input_tokens: z.number().optional(),
    cached_input_tokens: z.number().optional(),
    cache_write_input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    reasoning_output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();
export type TokenUsage = z.infer<typeof TokenUsageShape>;

export const TokenCountInfoShape = z
  .object({
    total_token_usage: TokenUsageShape,
    last_token_usage: TokenUsageShape.optional(),
    model_context_window: z.number().optional(),
  })
  .passthrough();
export type TokenCountInfo = z.infer<typeof TokenCountInfoShape>;

export const SessionMetaPayloadShape = z
  .object({
    id: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().nullable().optional(),
    cli_version: z.string().nullable().optional(),
    originator: z.string().nullable().optional(),
    thread_source: z.string().nullable().optional(),
    agent_nickname: z.string().nullable().optional(),
    agent_path: z.string().nullable().optional(),
    forked_from_id: z.string().nullable().optional(),
    parent_thread_id: z.string().nullable().optional(),
    source: z.union([z.string(), z.record(z.unknown())]).nullable().optional(),
  })
  .passthrough();
export type SessionMetaPayload = z.infer<typeof SessionMetaPayloadShape>;

/** fail-closed：token_count 的 info / total_token_usage 缺失或变型。 */
export function isTokenCountMalformed(info: unknown): boolean {
  if (!isPlainObject(info)) return true;
  return !isPlainObject(info["total_token_usage"]);
}

/** fail-closed：session_meta 身份（id / session_id 均缺失或空）。 */
export function sessionMetaIdentity(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const id = payload["id"];
  const sid = payload["session_id"];
  const pick = (v: unknown) => (typeof v === "string" && v ? v : null);
  return pick(id) ?? pick(sid);
}

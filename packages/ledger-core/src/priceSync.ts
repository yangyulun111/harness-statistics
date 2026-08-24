/**
 * 官网价格同步（v1.3）。
 *
 * 背景：OpenAI 无官方机读价格 API（community.openai.com 多帖与 openai-python#2074 确认），
 * 官网 developers.openai.com/api/docs/pricing 为 Next.js 页面。双源策略：
 *   ① openai：抓官网页面 → 提取 __NEXT_DATA__ 内嵌 JSON → 容错深遍历定价行（页面改版即解析失败 → fail-closed 降级）；
 *   ② litellm：BerriAI/litellm 的 model_prices_and_context_window.json（社区事实标准，raw.githubusercontent）。
 *
 * 写入 model_prices.synced.json（滚动时间窗：旧开放条目封 effective_to=now，新条目 effective_from=now，
 * 保留历史窗口→跨期成本仍按时点计价）。用户文件 model_prices.json 永不被同步触碰；
 * 合并解析时用户条目优先（cost.ts resolvePrice 用户层先行）。
 */
import fs from "node:fs";
import path from "node:path";
import { loadCatalogFile, type PriceEntry } from "./cost.ts";

export interface SyncedPrice {
  model: string;
  input: number;
  cached: number | null;
  output: number;
}

export interface SyncOutcome {
  source: "openai" | "litellm";
  fetched_at: number;
  models: number;
  written: number;
  rotated: number;
  dry_run: boolean;
  warnings: string[];
  error?: string;
}

export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
export const LITELLM_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const MODEL_RE = /^(gpt|o\d|codex|chatgpt)[-a-z0-9._]*$/i;

/** 官网页面解析（heuristic）：__NEXT_DATA__ → 深遍历收集"模型行"（含每百万价三元组，键名多形态容忍）。失败 → null。 */
export function parseOpenaiPricingHtml(html: string): SyncedPrice[] | null {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  const out: SyncedPrice[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const modelRaw = o["model"] ?? o["slug"] ?? o["name"] ?? o["id"];
    if (typeof modelRaw === "string" && MODEL_RE.test(modelRaw) && !seen.has(modelRaw)) {
      const pick = (...keys: string[]): number | null => {
        for (const k of keys) {
          const v = o[k];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10000) return v;
          if (typeof v === "string") {
            const n = Number(v.replace(/[$,\s]/g, ""));
            if (Number.isFinite(n) && n >= 0 && n < 10000) return n;
          }
        }
        return null;
      };
      const input = pick("input_per_mtok", "inputPrice", "input_price", "input", "standardInputPrice", "inputPerMillion");
      const output = pick("output_per_mtok", "outputPrice", "output_price", "output", "standardOutputPrice", "outputPerMillion");
      const cached = pick("cached_input_per_mtok", "cachedInputPrice", "cache_read_input_price", "cachedPrice", "cached_input", "cached");
      if (input !== null && output !== null && input > 0) {
        seen.add(modelRaw);
        out.push({ model: modelRaw, input, cached, output });
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(data);
  return out.length ? out : null;
}

/** LiteLLM JSON 解析：openai/ 前缀条目，per-token 价 ×1e6 转每百万。 */
export function parseLitellmJson(raw: unknown): SyncedPrice[] {
  const out: SyncedPrice[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith("openai/")) continue;
    const model = key.slice("openai/".length);
    if (!MODEL_RE.test(model)) continue;
    if (v === null || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const numv = (k: string): number | null => {
      const n = Number(o[k]);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const inTok = numv("input_cost_per_token");
    const outTok = numv("output_cost_per_token");
    if (inTok === null || outTok === null) continue;
    const cacheTok = numv("cache_read_input_cost") ?? numv("cached_input_cost_per_token");
    out.push({ model, input: inTok * 1e6, cached: cacheTok !== null ? cacheTok * 1e6 : null, output: outTok * 1e6 });
  }
  return out;
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "harness-stats price-sync" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function entryToRaw(e: PriceEntry): Record<string, unknown> {
  return {
    model: e.model,
    effective_from: new Date(e.effective_from_ms).toISOString(),
    effective_to: e.effective_to_ms === null ? null : new Date(e.effective_to_ms).toISOString(),
    currency: e.currency,
    input_per_mtok: e.input_per_mtok,
    cached_input_per_mtok: e.cached_input_per_mtok,
    output_per_mtok: e.output_per_mtok,
    ...(e.cache_write_per_mtok !== undefined ? { cache_write_per_mtok: e.cache_write_per_mtok } : {}),
    ...(e.promo ? { promo: true } : {}),
    ...(e.source ? { source: e.source } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

/** 执行同步（网络在 server/CLI 进程内发起，显式用户动作）。失败 fail-closed：不写半截文件。 */
export async function syncPrices(opts: {
  syncedPath: string;
  source?: "auto" | "openai" | "litellm";
  dryRun?: boolean;
}): Promise<SyncOutcome> {
  const warnings: string[] = [];
  const now = Date.now();
  let source: "openai" | "litellm" = opts.source === "litellm" ? "litellm" : "openai";
  let prices: SyncedPrice[] | null = null;
  if (source === "openai") {
    try {
      const html = await fetchText(OPENAI_PRICING_URL);
      prices = parseOpenaiPricingHtml(html);
      if (!prices) warnings.push("官网页面解析失败（疑似改版）→ 降级 LiteLLM 社区源");
    } catch (e) {
      warnings.push(`官网拉取失败（${e instanceof Error ? e.message : String(e)}）→ 降级 LiteLLM 社区源`);
    }
    if (!prices) source = "litellm";
  }
  if (!prices) {
    try {
      prices = parseLitellmJson(JSON.parse(await fetchText(LITELLM_PRICES_URL)));
    } catch (e) {
      return { source, fetched_at: now, models: 0, written: 0, rotated: 0, dry_run: opts.dryRun === true, warnings, error: `两个源均失败（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (!prices.length) {
      return { source, fetched_at: now, models: 0, written: 0, rotated: 0, dry_run: opts.dryRun === true, warnings, error: "社区源未解析出 openai 系价格" };
    }
  }
  // 滚动窗口：既有开放条目封窗（保留历史），新条目生效自 now
  const existing = loadCatalogFile(opts.syncedPath);
  const rotated = existing ? existing.entries.filter((e) => e.effective_to_ms === null).length : 0;
  const entries: PriceEntry[] = [
    ...(existing ? existing.entries.map((e) => (e.effective_to_ms === null ? { ...e, effective_to_ms: now } : e)) : []),
    ...prices.map((p): PriceEntry => ({
      model: p.model,
      effective_from_ms: now,
      effective_to_ms: null,
      currency: "USD",
      input_per_mtok: p.input,
      cached_input_per_mtok: p.cached ?? p.input, // cached 价未获取 → 按 input 全价计（保守高估，note 注明）
      output_per_mtok: p.output,
      source: source === "openai"
        ? `OpenAI 官网同步 ${new Date(now).toISOString().slice(0, 10)}（heuristic 解析）`
        : `LiteLLM 社区源 ${new Date(now).toISOString().slice(0, 10)}`,
      ...(p.cached === null ? { note: "cached 价未获取，按 input 全价计（保守）" } : {}),
    })),
  ];
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(opts.syncedPath), { recursive: true });
    fs.writeFileSync(
      opts.syncedPath,
      JSON.stringify({ version: 1, updated: now, source, notes: "自动同步产物（可被下次同步覆盖）；用户条目在 model_prices.json，优先级更高", entries: entries.map(entryToRaw) }, null, 2),
      "utf8",
    );
  }
  return { source, fetched_at: now, models: prices.length, written: prices.length, rotated, dry_run: opts.dryRun === true, warnings };
}

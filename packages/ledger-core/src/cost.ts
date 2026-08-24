/**
 * 时变模型价格目录与成本估算（查询层派生，零 schema 影响，G1 Golden 不受牵连）。
 *
 * 目录为手工维护的 JSON（默认仓库根 model_prices.json，serve 可用 --prices 覆盖）。
 * 价格随时间变动（促销/调价，如 sol 半价期）以独立条目表达：
 *   取价规则 = 满足 effective_from ≤ 事件时点 < effective_to 的最新 effective_from 条目。
 * 主口径始终是 Token；成本一律 cost_est（estimated）。价格缺失 → null（fail-closed，绝不猜价）。
 * 计价口径：cache_write 未单独配置时按 input 价计；reasoning 计入 output（与上游计费一致）。
 */
import fs from "node:fs";

export interface PriceEntry {
  model: string;
  effective_from_ms: number;
  effective_to_ms: number | null;
  currency: string;
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok?: number;
  promo?: boolean;
  source?: string;
  note?: string;
  /** 条目层级：用户手工（默认/最高优先）或官网同步（可被覆盖）。resolvePrice 用户层先于同步层。 */
  origin?: "user" | "synced";
}

export interface PriceCatalog {
  version: number;
  updated_ms: number | null;
  notes: string;
  entries: PriceEntry[];
  path: string;
}

export interface CostEst {
  currency: string;
  input: number;
  cached: number;
  cache_write: number;
  output: number;
  total: number;
  /** 未配置价格的模型（部分计价时非空，UI 需提示口径不完整） */
  missing_models: string[];
  /** 用到的价格条目 source（去重，用于可信度标注） */
  sources: string[];
}

export function parseTime(v: unknown, field: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  throw new Error(`价格目录字段 ${field} 时间无效：${String(v)}`);
}

function num(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`价格目录字段 ${field} 数值无效：${String(v)}`);
  return n;
}

export function parseCatalog(raw: unknown, path: string): PriceCatalog {
  if (typeof raw !== "object" || raw === null) throw new Error("价格目录根必须是对象");
  const o = raw as Record<string, unknown>;
  const entriesRaw = Array.isArray(o["entries"]) ? o["entries"] : [];
  const entries: PriceEntry[] = entriesRaw.map((e, i) => {
    if (typeof e !== "object" || e === null) throw new Error(`entries[${i}] 必须是对象`);
    const it = e as Record<string, unknown>;
    const model = String(it["model"] ?? "").trim();
    if (!model) throw new Error(`entries[${i}].model 不能为空`);
    return {
      model,
      effective_from_ms: parseTime(it["effective_from"], `entries[${i}].effective_from`),
      effective_to_ms: it["effective_to"] == null ? null : parseTime(it["effective_to"], `entries[${i}].effective_to`),
      currency: String(it["currency"] ?? "USD"),
      input_per_mtok: num(it["input_per_mtok"], `entries[${i}].input_per_mtok`),
      cached_input_per_mtok: num(it["cached_input_per_mtok"], `entries[${i}].cached_input_per_mtok`),
      output_per_mtok: num(it["output_per_mtok"], `entries[${i}].output_per_mtok`),
      cache_write_per_mtok: it["cache_write_per_mtok"] == null ? undefined : num(it["cache_write_per_mtok"], `entries[${i}].cache_write_per_mtok`),
      promo: it["promo"] === true,
      source: it["source"] == null ? undefined : String(it["source"]),
      note: it["note"] == null ? undefined : String(it["note"]),
    };
  });
  return {
    version: Number(o["version"] ?? 1),
    updated_ms: o["updated"] == null ? null : parseTime(o["updated"], "updated"),
    notes: o["notes"] == null ? "" : String(o["notes"]),
    entries,
    path,
  };
}

const catalogCache = new Map<string, { mtimeMs: number; size: number; cat: PriceCatalog }>();

/** 读取价格目录（mtime 缓存；文件缺失 → null；解析失败 → console.error 后 null，fail-closed）。 */
export function loadCatalogFile(path: string): PriceCatalog | null {
  try {
    const st = fs.statSync(path);
    const cached = catalogCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.cat;
    const cat = parseCatalog(JSON.parse(fs.readFileSync(path, "utf8")), path);
    catalogCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, cat });
    return cat;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(`[prices] 目录解析失败（忽略，成本按未配置处理）：${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export interface MergedCatalog extends PriceCatalog {
  entries: Array<PriceEntry & { origin: "user" | "synced" }>;
}

/** 双层目录合并：用户条目（origin=user，最高优先）+ 同步条目（origin=synced）。解析优先级见 resolvePrice。 */
export function mergeCatalogs(user: PriceCatalog | null, synced: PriceCatalog | null): MergedCatalog | null {
  if (!user && !synced) return null;
  return {
    version: Math.max(user?.version ?? 1, synced?.version ?? 1),
    updated_ms: synced?.updated_ms ?? user?.updated_ms ?? null,
    notes: user?.notes ?? "",
    path: user?.path ?? synced?.path ?? "",
    entries: [
      ...(user ? user.entries.map((e) => ({ ...e, origin: "user" as const })) : []),
      ...(synced ? synced.entries.map((e) => ({ ...e, origin: "synced" as const })) : []),
    ],
  };
}

/** 读取双层合并目录：model_prices.json（用户）+ model_prices.synced.json（同步）。两者皆缺 → null。 */
export function loadMergedCatalog(userPath: string, syncedPath: string): MergedCatalog | null {
  return mergeCatalogs(loadCatalogFile(userPath), loadCatalogFile(syncedPath));
}

/** 取某模型在时点 tsMs 的价格条目；用户层（origin!=="synced"）先于同步层，层内取最新 effective_from；
 * 精确匹配优先，其次最长前缀（模型日期后缀变体）。无 → null。 */
export function resolvePrice(cat: PriceCatalog, model: string, tsMs: number | null): PriceEntry | null {
  const ts = tsMs ?? Date.now();
  const pickLayer = (m: string, syncedLayer: boolean): PriceEntry | null => {
    let best: PriceEntry | null = null;
    for (const e of cat.entries) {
      const isSynced = e.origin === "synced";
      if (isSynced !== syncedLayer) continue;
      if (e.model !== m) continue;
      if (e.effective_from_ms > ts) continue;
      if (e.effective_to_ms !== null && e.effective_to_ms <= ts) continue;
      if (!best || e.effective_from_ms > best.effective_from_ms) best = e;
    }
    return best;
  };
  const pick = (m: string): PriceEntry | null => pickLayer(m, false) ?? pickLayer(m, true);
  const exact = pick(model);
  if (exact) return exact;
  let bestPrefix: PriceEntry | null = null;
  for (const e of cat.entries) {
    if (!model.startsWith(e.model) || e.model === model) continue;
    const cand = pick(e.model);
    if (cand && (!bestPrefix || e.model.length > bestPrefix.model.length)) bestPrefix = cand;
  }
  return bestPrefix;
}

/** 对一组 (模型, 时点, token 分量) 聚合成本；目录为空或全部未配置 → null（部分未配置时仍返回并列出缺失模型）。 */
export function costAggregate(
  cat: PriceCatalog | null,
  items: Array<{ model: string; ts_ms: number | null; input: number; cached: number; cache_write: number; output: number }>,
): CostEst | null {
  if (!cat || cat.entries.length === 0) return null;
  const acc: CostEst = { currency: "USD", input: 0, cached: 0, cache_write: 0, output: 0, total: 0, missing_models: [], sources: [] };
  for (const it of items) {
    if (it.input + it.cached + it.cache_write + it.output <= 0) continue;
    const e = resolvePrice(cat, it.model, it.ts_ms);
    if (!e) {
      if (!acc.missing_models.includes(it.model)) acc.missing_models.push(it.model);
      continue;
    }
    acc.currency = e.currency;
    acc.input += (it.input * e.input_per_mtok) / 1e6;
    acc.cached += (it.cached * e.cached_input_per_mtok) / 1e6;
    acc.cache_write += (it.cache_write * (e.cache_write_per_mtok ?? e.input_per_mtok)) / 1e6;
    acc.output += (it.output * e.output_per_mtok) / 1e6;
    if (e.source && !acc.sources.includes(e.source)) acc.sources.push(e.source);
  }
  const priced = acc.input + acc.cached + acc.cache_write + acc.output;
  if (priced <= 0) return null;
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  acc.input = r4(acc.input);
  acc.cached = r4(acc.cached);
  acc.cache_write = r4(acc.cache_write);
  acc.output = r4(acc.output);
  acc.total = r4(priced);
  return acc;
}

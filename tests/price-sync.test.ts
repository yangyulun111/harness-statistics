/**
 * 价格同步与双层目录（v1.3）单元测试：双源解析函数喂本地字符串（不依赖网络）、
 * 合并优先级（用户 > 同步）、滚动窗口语义、fail-closed。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOpenaiPricingHtml, parseLitellmJson } from "@hs/ledger-core";
import { parseCatalog, resolvePrice, mergeCatalogs } from "@hs/ledger-core";

test("官网 __NEXT_DATA__ 解析：嵌套定价行（多键名形态）；无结构 → null（fail-closed）", () => {
  const next = {
    props: {
      pageProps: {
        pricing: [
          { model: "gpt-5.6-sol", inputPrice: "1.25", cachedInputPrice: "0.125", outputPrice: 10 },
          { slug: "gpt-5.6-terra", input: 2, cached: 0.2, output: 20 },
          { name: "non-model-thing", input: 1, output: 1 }, // 命名不符 → 忽略
        ],
      },
    },
  };
  const html = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
  const r = parseOpenaiPricingHtml(html)!;
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { model: "gpt-5.6-sol", input: 1.25, cached: 0.125, output: 10 });
  assert.deepEqual(r[1], { model: "gpt-5.6-terra", input: 2, cached: 0.2, output: 20 });
  assert.equal(parseOpenaiPricingHtml("<html>改版后无内嵌数据</html>"), null);
  assert.equal(parseOpenaiPricingHtml('<script id="__NEXT_DATA__" type="application/json">{"a":1}</script>'), null);
});

test("LiteLLM 解析：openai/ 前缀、per-token ×1e6、cached 价可选", () => {
  const raw = {
    "openai/gpt-5.6-sol": { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001, cache_read_input_cost: 0.000000125, max_tokens: 8192 },
    "openai/gpt-5.6-terra": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00002 },
    "anthropic/claude-sonnet-4": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
    "openai/gpt-bad": { input_cost_per_token: 0 },
  };
  const r = parseLitellmJson(raw);
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0]!.input - 1.25) < 1e-9);
  assert.ok(Math.abs(r[0]!.cached! - 0.125) < 1e-9);
  assert.equal(r[1]!.cached, null);
});

test("双层合并：同模型同时窗用户条目赢；同步条目单独覆盖其余时点", () => {
  const now = Date.now();
  const user = parseCatalog({
    version: 1,
    entries: [
      { model: "gpt-5.6-sol", effective_from: "2026-08-01", effective_to: null, currency: "USD", input_per_mtok: 0.5, cached_input_per_mtok: 0.05, output_per_mtok: 5, source: "用户促销价" },
    ],
  }, "(user)");
  const synced = parseCatalog({
    version: 1,
    updated: now,
    entries: [
      { model: "gpt-5.6-sol", effective_from: now - 1000, effective_to: null, currency: "USD", input_per_mtok: 1.25, cached_input_per_mtok: 0.125, output_per_mtok: 10 },
      { model: "gpt-5.6-terra", effective_from: now - 1000, effective_to: null, currency: "USD", input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 20 },
    ],
  }, "(synced)");
  const merged = mergeCatalogs(user, synced)!;
  assert.equal(merged.entries.length, 3);
  // sol：同步层 from 更新，但用户层优先 → 用户价
  assert.equal(resolvePrice(merged, "gpt-5.6-sol", now)!.input_per_mtok, 0.5);
  // terra：仅同步层
  assert.equal(resolvePrice(merged, "gpt-5.6-terra", now)!.input_per_mtok, 2);
  // 用户窗口之前（8 月前）→ 同步层也不覆盖（from=now-1000 晚于该时点）→ null
  assert.equal(resolvePrice(merged, "gpt-5.6-sol", Date.parse("2026-07-01")), null);
  // 仅用户目录：origin 默认用户层，解析不受影响
  assert.equal(resolvePrice(user, "gpt-5.6-sol", now)!.input_per_mtok, 0.5);
});

test("滚动窗口：同步产物旧开放条目被封窗（文件级校验）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-prices-"));
  const userPath = path.join(dir, "model_prices.json");
  const syncedPath = path.join(dir, "model_prices.synced.json");
  fs.writeFileSync(userPath, JSON.stringify({
    version: 1,
    entries: [{ model: "gpt-5.6-sol", effective_from: "2026-08-01", effective_to: null, currency: "USD", input_per_mtok: 0.5, cached_input_per_mtok: 0.05, output_per_mtok: 5 }],
  }), "utf8");
  fs.writeFileSync(syncedPath, JSON.stringify({
    version: 1, updated: Date.now(),
    entries: [{ model: "gpt-5.6-terra", effective_from: "2026-08-10", effective_to: null, currency: "USD", input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 20 }],
  }), "utf8");
  const { loadMergedCatalog } = await import("@hs/ledger-core");
  const merged = loadMergedCatalog(userPath, syncedPath)!;
  assert.equal(merged.entries.filter((e) => e.origin === "user").length, 1);
  assert.equal(merged.entries.filter((e) => e.origin === "synced").length, 1);
  assert.equal(mergeCatalogs(null, null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

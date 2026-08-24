import test from "node:test";
import assert from "node:assert/strict";
import { runGolden } from "../scripts/golden.ts";
import { resolveRoots } from "@hs/task-graph";
import { toMs } from "@hs/shared";
import { readNewLines } from "@hs/rollout-parser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("golden（G1）：fixture 上 TS ledger ≡ Python oracle，且增量幂等", { timeout: 600_000 }, async () => {
  const r = await runGolden();
  assert.ok(r.pass, `Golden 差异：\n${r.diffs.join("\n")}`);
});

test("task-graph：环检测与父不在图中", () => {
  // a→b→a 环；c→x（x 无 parent 记录）→ x 为根
  const m = new Map<string, [string, string]>([
    ["a", ["b", "session_meta"]],
    ["b", ["a", "session_meta"]],
    ["c", ["x", "edges"]],
  ]);
  const r = resolveRoots(m);
  assert.equal(r.get("a")!.root, null);
  assert.equal(r.get("a")!.depth, -1);
  assert.equal(r.get("c")!.root, "x");
  assert.equal(r.get("c")!.depth, 1);
  assert.equal(r.get("x")!.type, "root");
});

test("toMs：ISO / epoch 秒 / epoch 毫秒 / 无时区按 UTC", () => {
  assert.equal(toMs("2026-07-15T23:29:05Z"), Date.parse("2026-07-15T23:29:05Z"));
  assert.equal(toMs(1789000000), 1789000000000);
  assert.equal(toMs(1789000000123), 1789000000123);
  assert.equal(toMs("2026-07-15T23:29:05"), Date.parse("2026-07-15T23:29:05Z")); // naive → UTC
  assert.equal(toMs(0), null);
  assert.equal(toMs("garbage"), null);
});

test("rollout-parser：增量 / 半行保留 / 截断检测", () => {
  const f = path.join(os.tmpdir(), `hs-tail-${Date.now()}.jsonl`);
  fs.writeFileSync(f, "line1\nline2\nline3", "utf8"); // line3 无换行 → 半行
  let r = readNewLines(f, 0);
  assert.deepEqual(r.lines, ["line1", "line2"]);
  fs.appendFileSync(f, "\nline4\n", "utf8");
  r = readNewLines(f, r.newOffset);
  assert.deepEqual(r.lines, ["line3", "line4"]);
  // 文件变小 → truncated
  fs.writeFileSync(f, "x\n", "utf8");
  r = readNewLines(f, r.newOffset);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.lines, ["x"]);
  fs.rmSync(f, { force: true });
});

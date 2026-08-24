/**
 * Fork 分类器（fork-v2）矩阵 golden：
 *   1) 两阶段（迟到父 refold）：phase1 无 parentX → legacy 降级；补入 parentX 后 refold 为
 *      结构化 parent_prefix。双轨 EXACT + 期望标注 sidecar + 幂等。
 *   2) 增量断点：childA 文件在 replay 中途截断→续读，账目与一次性 ingest 完全一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "@hs/ledger-core";
import { deepDiff, dumpGolden, pyDump, pyIngest, type Dump } from "../scripts/golden.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_HOME = path.join(ROOT, "tests", "fixtures", "fork-home");
const STASH_HOME = path.join(ROOT, "tests", "fixtures", "fork-home-stash");

interface ExpectThread {
  method: string | null;
  status: string | null;
  baseline: number | null;
  baseline_verified: number;
  prefix_events: number | null;
  replay_input: number;
  replay_cached: number;
  replay_output: number;
  replay_total: number;
  replay_events: number;
  native_total: number;
  daily: Record<string, { tokens: number; replay_total: number; samples: number }>;
}

function rmDb(p: string): void {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(p + s, { force: true });
    } catch { /* ignore */ }
  }
}

function assertExpected(label: string, dump: Dump, exp: Record<string, ExpectThread>): void {
  for (const [tid, e] of Object.entries(exp)) {
    const th = dump.threads.find((r) => r["thread_id"] === tid);
    const dg = dump.threads_diag.find((r) => r["thread_id"] === tid);
    assert.ok(th, `${label}: threads 缺 ${tid}`);
    assert.ok(dg, `${label}: threads_diag 缺 ${tid}`);
    assert.equal(th!["baseline_method"] ?? null, e.method, `${label} ${tid} baseline_method`);
    assert.equal(th!["verification_status"] ?? null, e.status, `${label} ${tid} verification_status`);
    assert.equal(th!["inherited_baseline"] ?? null, e.baseline, `${label} ${tid} inherited_baseline`);
    assert.equal(th!["baseline_verified"], e.baseline_verified, `${label} ${tid} baseline_verified`);
    assert.equal(dg!["baseline_prefix_events"] ?? null, e.prefix_events, `${label} ${tid} prefix_events`);
    assert.equal(dg!["replay_input_tokens"], e.replay_input, `${label} ${tid} replay_input`);
    assert.equal(dg!["replay_cached_tokens"], e.replay_cached, `${label} ${tid} replay_cached`);
    assert.equal(dg!["replay_output_tokens"], e.replay_output, `${label} ${tid} replay_output`);
    assert.equal(dg!["replay_total_tokens"], e.replay_total, `${label} ${tid} replay_total`);
    assert.equal(dg!["replay_events"], e.replay_events, `${label} ${tid} replay_events`);
    assert.equal(dg!["native_total"], e.native_total, `${label} ${tid} native_total`);
    for (const [day, d] of Object.entries(e.daily)) {
      const row = dump.daily_usage.find((r) => r["thread_id"] === tid && r["day"] === day);
      assert.ok(row, `${label}: daily_usage 缺 ${tid} ${day}`);
      assert.equal(row!["tokens"], d.tokens, `${label} ${tid} ${day} tokens`);
      assert.equal(row!["replay_total_tokens"], d.replay_total, `${label} ${tid} ${day} replay_total`);
      assert.equal(row!["samples"], d.samples, `${label} ${tid} ${day} samples`);
    }
  }
}

test("fork 矩阵 golden：两阶段（迟到父 refold）双轨 EXACT + 期望标注 + 幂等", { timeout: 300_000 }, async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_HOME, "expected.json"), "utf8"));
  const lateRel = path.join("sessions", "2026", "08", "01", expected["late_parent_file"]);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hs-fork-home-"));
  fs.cpSync(FIXTURE_HOME, tmpHome, { recursive: true });
  const pyDb = path.join(tmpHome, "py.sqlite");
  const tsDb = path.join(tmpHome, "ts.sqlite");
  rmDb(pyDb);
  rmDb(tsDb);

  // phase1：无 parentX → childE 走 legacy_time/parent_missing
  pyIngest(tmpHome, pyDb);
  await ingest({ dbPath: tsDb, envCodexHome: tmpHome, verbose: false });
  const p1py = pyDump(pyDb);
  const p1ts = dumpGolden(tsDb);
  const diffs1: string[] = [];
  for (const t of ["threads", "threads_diag", "turns", "daily_usage", "tool_failures"] as const) {
    deepDiff(p1py[t], p1ts[t], `phase1.${t}`, diffs1);
  }
  assert.deepEqual(diffs1, [], `phase1 双轨差异：\n${diffs1.join("\n")}`);
  assertExpected("phase1.py", p1py, expected["phase1"]);
  assertExpected("phase1.ts", p1ts, expected["phase1"]);

  // phase2：补入迟到父 parentX → refold 把 childE 升级为 parent_prefix/verified
  fs.copyFileSync(path.join(STASH_HOME, lateRel), path.join(tmpHome, lateRel));
  pyIngest(tmpHome, pyDb);
  await ingest({ dbPath: tsDb, envCodexHome: tmpHome, verbose: false });
  const p2py = pyDump(pyDb);
  const p2ts = dumpGolden(tsDb);
  const diffs2: string[] = [];
  for (const t of ["threads", "threads_diag", "turns", "daily_usage", "tool_failures"] as const) {
    deepDiff(p2py[t], p2ts[t], `phase2.${t}`, diffs2);
  }
  assert.deepEqual(diffs2, [], `phase2 双轨差异：\n${diffs2.join("\n")}`);
  assertExpected("phase2.py", p2py, expected["phase2"]);
  assertExpected("phase2.ts", p2ts, expected["phase2"]);

  // v1.2 契约列（caseM）：sandbox/approval 与 MCP/shell 失败计数（双轨各自的 dump 上断言）
  const v12 = expected["v12"];
  const assertV12 = (label: string, dump: Dump): void => {
    const th = dump.threads.find((r) => r["thread_id"] === v12["thread"]);
    const dg = dump.threads_diag.find((r) => r["thread_id"] === v12["thread"]);
    const turn = dump.turns.find((r) => r["thread_id"] === v12["thread"] && r["turn_index"] === 0);
    assert.ok(th && dg && turn, `${label}: caseM 行缺失`);
    assert.deepEqual(th!["sandbox_policy"] ?? null, v12["sandbox_policy"], `${label} sandbox_policy`);
    assert.equal(th!["approval_mode"] ?? null, v12["approval_mode"], `${label} approval_mode`);
    assert.equal(dg!["mcp_calls"], v12["mcp_calls"], `${label} diag mcp_calls`);
    assert.equal(dg!["mcp_failures"], v12["mcp_failures"], `${label} diag mcp_failures`);
    assert.equal(dg!["shell_failures"], v12["shell_failures"], `${label} diag shell_failures`);
    assert.equal(turn!["mcp_calls"], v12["turn"]["mcp_calls"], `${label} turn mcp_calls`);
    assert.equal(turn!["mcp_failures"], v12["turn"]["mcp_failures"], `${label} turn mcp_failures`);
    assert.equal(turn!["shell_failures"], v12["turn"]["shell_failures"], `${label} turn shell_failures`);
    assert.equal(turn!["patches"], v12["turn"]["patches"], `${label} turn patches`);
    // 事件级失败明细（tool_failures）：行数与关键字段逐条一致
    const fails = dump.tool_failures.filter((r) => r["thread_id"] === v12["thread"]);
    assert.equal(fails.length, v12["failures"].length, `${label} tool_failures 行数`);
    for (const exp of v12["failures"]) {
      const row = fails.find((r) => r["seq"] === exp["seq"]);
      assert.ok(row, `${label} tool_failures seq=${exp["seq"]} 缺失`);
      assert.equal(row!["kind"], exp["kind"], `${label} failure kind`);
      assert.equal(row!["exit_code"] ?? null, exp["exit_code"], `${label} failure exit_code`);
      assert.equal(row!["turn_index"] ?? null, exp["turn_index"], `${label} failure turn_index`);
      assert.equal(row!["command"] ?? null, exp["command"] ?? null, `${label} failure command`);
      assert.equal(row!["server"] ?? null, exp["server"] ?? null, `${label} failure server`);
      assert.equal(row!["tool"] ?? null, exp["tool"] ?? null, `${label} failure tool`);
      assert.equal(row!["detail"] ?? null, exp["detail"] ?? null, `${label} failure detail`);
    }
  };
  assertV12("phase1.py", p1py);
  assertV12("phase1.ts", p1ts);
  assertV12("phase2.py", p2py);
  assertV12("phase2.ts", p2ts);

  // 幂等：第三轮不得改变账目
  pyIngest(tmpHome, pyDb);
  await ingest({ dbPath: tsDb, envCodexHome: tmpHome, verbose: false });
  const idem: string[] = [];
  deepDiff(p2py, pyDump(pyDb), "py#3", idem);
  deepDiff(p2ts, dumpGolden(tsDb), "ts#3", idem);
  assert.deepEqual(idem, [], `第三轮不幂等：\n${idem.join("\n")}`);

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("增量断点：replay 中途截断续读 ≡ 一次性 ingest（TS）", { timeout: 120_000 }, async () => {
  const childAName = "rollout-2026-08-01T11-00-00-f1a0a000-0000-4000-8000-00000000000b.jsonl";
  const mkHome = (): string => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "hs-fork-break-"));
    fs.cpSync(FIXTURE_HOME, h, { recursive: true });
    return h;
  };
  const CA = "f1a0a000-0000-4000-8000-00000000000b";

  // 参考：一次性完整 ingest
  const fullHome = mkHome();
  const fullDb = path.join(fullHome, "ref.sqlite");
  await ingest({ dbPath: fullDb, envCodexHome: fullHome, verbose: false });
  const ref = dumpGolden(fullDb);

  // 断点：childA 截到第 6 行（replay 前缀中段）→ ingest → 补齐 → ingest
  const partHome = mkHome();
  const partDb = path.join(partHome, "part.sqlite");
  const childPath = path.join(partHome, "sessions", "2026", "08", "01", childAName);
  const fullText = fs.readFileSync(childPath, "utf8");
  const allLines = fullText.split("\n").filter((l) => l.trim());
  fs.writeFileSync(childPath, allLines.slice(0, 6).join("\n") + "\n", "utf8");
  await ingest({ dbPath: partDb, envCodexHome: partHome, verbose: false });
  fs.writeFileSync(childPath, fullText, "utf8");
  await ingest({ dbPath: partDb, envCodexHome: partHome, verbose: false });
  const part = dumpGolden(partDb);

  for (const table of ["threads", "threads_diag", "daily_usage", "tool_failures"] as const) {
    const strip = (rows: Record<string, any>[]): Record<string, any>[] =>
      rows.filter((r) => r["thread_id"] === CA).map((r) => {
        const c = { ...r };
        delete c["rollout_path"]; // 两个临时 home 的绝对路径必然不同
        if (c["fork_replay_json"] && typeof c["fork_replay_json"] === "object") {
          const fr = { ...c["fork_replay_json"] };
          delete fr["current_file"];
          if (fr["cursor"] && Array.isArray(fr["cursor"]["files"])) {
            fr["cursor"] = { ...fr["cursor"], files: fr["cursor"]["files"].map((f: string) => path.basename(f)) };
          }
          c["fork_replay_json"] = fr;
        }
        return c;
      });
    const out: string[] = [];
    deepDiff(strip(ref[table]), strip(part[table]), `break.${table}`, out);
    assert.deepEqual(out, [], `断点续读差异：\n${out.join("\n")}`);
  }

  fs.rmSync(fullHome, { recursive: true, force: true });
  fs.rmSync(partHome, { recursive: true, force: true });
});

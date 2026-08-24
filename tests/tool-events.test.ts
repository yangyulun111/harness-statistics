/**
 * 工具事件分桶 + 文件级行为（v1.3 TS-only tool_events）单元/集成测试。
 * 合成事件采用真实 rollout 形态（侦察结论）：顶层 {timestamp,type,payload}、call↔output 靠 call_id、
 * exec 输出纯文本 "Exit code: N / Wall time N seconds"、patch changes 双形态（unified_diff / content）、
 * MCP 结构化 duration、wait 为 function_call。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "@hs/shared";
import { taskDetail } from "@hs/ledger-core";
import { LedgerStore, newThreadCtx, processLine, closeEpoch } from "@hs/usage-accounting";
import {
  toolBucketOf, shellExitCodeOf, extractShellCommands, readStatsOf, patchLinesOf, mcpDurationMs,
} from "@hs/usage-accounting";

const T0 = "2026-08-20T10:00:00.000Z";
const at = (i: number) => new Date(Date.parse(T0) + i * 1000).toISOString();
const ev = (ts: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: ts, type, payload });

test("分桶与退出码解析", () => {
  assert.equal(toolBucketOf("custom_tool_call", "exec", null), "shell");
  assert.equal(toolBucketOf("custom_tool_call", "bash", null), "shell");
  assert.equal(toolBucketOf("function_call", "wait", null), "collab");
  assert.equal(toolBucketOf("function_call", "send_message", "collaboration"), "collab");
  assert.equal(toolBucketOf("web_search_call", "web_search", null), "web");
  assert.equal(toolBucketOf("custom_tool_call", "codex_app__load", null), "other");
  assert.equal(shellExitCodeOf('{"exit_code":1}'), 1);
  assert.equal(shellExitCodeOf("Exit code: 0\nWall time 2.2 seconds"), 0);
  assert.equal(shellExitCodeOf("Exit code: 3"), 3);
  assert.equal(shellExitCodeOf("no code here"), null);
});

test("读检测（heuristic）：命令提取 + 读类命令 + 路径", () => {
  const input = 'const r = await tools.shell_command({command:"cat src/a.ts && rg foo lib/b.ts; npm test"});';
  const cmds = extractShellCommands(input);
  assert.deepEqual(cmds, ["cat src/a.ts && rg foo lib/b.ts; npm test"]);
  const rs = readStatsOf(cmds);
  assert.equal(rs.reads, 2); // cat + rg（npm test 非读类）
  assert.ok(rs.files.includes("src/a.ts"));
  assert.ok(rs.files.includes("lib/b.ts"));
  assert.equal(readStatsOf(["npm test", "echo hi"]).reads, 0);
  assert.ok(readStatsOf(["git log --oneline"]).reads === 1);
  assert.ok(readStatsOf(["git push origin main"]).reads === 0);
});

test("patch ± 行统计：update 用 unified_diff，add 数 content 行", () => {
  const r = patchLinesOf({
    "src/a.ts": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n-old line\n+new line\n+extra\n--- a/src/a.ts\n+++ b/src/a.ts\n" },
    "docs/b.md": { type: "add", content: "l1\nl2\nl3" },
  });
  assert.equal(r.files, 2);
  assert.equal(r.linesPlus, 2 + 3); // new line + extra（排除 +++ 头）+ add 全文 3 行
  assert.equal(r.linesMinus, 1); // old line（排除 --- 头）
  assert.equal(mcpDurationMs({ duration: { secs: 2, nanos: 500000000 } }), 2500);
  assert.equal(mcpDurationMs({}), null);
});

test("processLine → tool_events：配对时长/双口径成败/读检测/文件行为/各桶", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const store = new LedgerStore(db);
  const ctx = newThreadCtx("th1");

  processLine(store, ctx, ev(at(0), "event_msg", { type: "task_started", turn_id: "t1", started_at: Math.floor(Date.parse(at(0)) / 1000) }));
  processLine(store, ctx, ev(at(1), "response_item", {
    type: "custom_tool_call", id: "ctc_1", call_id: "c1", name: "exec", status: "completed",
    input: 'const r = await tools.shell_command({command:"cat src/a.ts; npm test"});',
  }));
  processLine(store, ctx, ev(at(4), "response_item", {
    type: "custom_tool_call_output", call_id: "c1",
    output: [{ type: "input_text", text: "Script error:\nExit code: 1\nWall time 2.9 seconds\nOutput:\n..." }],
  }));
  processLine(store, ctx, ev(at(6), "response_item", {
    type: "function_call", id: "fc_1", call_id: "c2", name: "wait",
    arguments: '{"cell_id":"4","yield_time_ms":30000}',
  }));
  processLine(store, ctx, ev(at(8), "response_item", { type: "function_call_output", call_id: "c2", output: "" }));
  // apply_patch 走 exec 通道：call(exec-p1) → patch_apply_end(exec-p1) → output(exec-p1)
  // v1.4：patch 行时长 = call↔patch_apply_end 差（peek 不 consume，shell 行仍由 output 配对）
  processLine(store, ctx, ev(at(7), "response_item", {
    type: "custom_tool_call", id: "ctc_p1", call_id: "exec-p1", name: "exec",
    input: 'await tools.shell_command({command:"apply_patch <<PATCH"});',
  }));
  processLine(store, ctx, ev(at(9), "event_msg", {
    type: "patch_apply_end", call_id: "exec-p1", turn_id: "t1", success: true, stdout: "Success", stderr: "",
    changes: {
      "src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n+added" },
      "docs/b.md": { type: "add", content: "x\ny" },
    },
  }));
  processLine(store, ctx, ev(at(10), "response_item", {
    type: "custom_tool_call_output", call_id: "exec-p1",
    output: [{ type: "input_text", text: "Success. Updated the following files:\nM src/a.ts" }],
  }));
  // 无 pending 的 patch（fork/重放剥离 call 事件）→ duration NULL 不猜
  processLine(store, ctx, ev(at(10), "event_msg", {
    type: "patch_apply_end", call_id: "exec-p2", turn_id: "t1", success: true, stdout: "Success", stderr: "",
    changes: { "docs/c.md": { type: "add", content: "z" } },
  }));
  processLine(store, ctx, ev(at(11), "event_msg", {
    type: "mcp_tool_call_end", call_id: "exec-m1", invocation: { server: "fs", tool: "list_dir", arguments: {} },
    duration: { secs: 1, nanos: 500000000 }, result: { Ok: { content: [] } },
  }));
  processLine(store, ctx, ev(at(12), "event_msg", { type: "web_search_end", call_id: "exec-w1", query: "q" }));
  processLine(store, ctx, ev(at(13), "event_msg", { type: "sub_agent_activity", event_id: "sa1", occurred_at_ms: Date.parse(at(13)), agent_thread_id: "sub1", agent_path: "/root", kind: "interacted" }));
  // 孤儿 call：无 output，closeEpoch 时应落行 ok=NULL
  processLine(store, ctx, ev(at(14), "response_item", { type: "custom_tool_call", id: "ctc_9", call_id: "c9", name: "bash", input: "ls /" }));
  processLine(store, ctx, ev(at(15), "event_msg", { type: "task_complete", turn_id: "t1", completed_at: Math.floor(Date.parse(at(15)) / 1000), duration_ms: 15000 }));
  closeEpoch(ctx, store);
  store.flushThread(ctx);

  const rows = (db.prepare("SELECT * FROM tool_events ORDER BY seq").all() as Array<Record<string, unknown>>);
  const by = (b: string) => rows.filter((r) => r["bucket"] === b);

  assert.equal(by("shell").length, 3, "shell：配对 2（含 apply_patch 的 exec 调用）+ 孤儿 1");
  const sh = by("shell").find((r) => r["call_id"] === "c1")!;
  assert.equal(sh["duration_ms"], 3000); // at(4)-at(1)
  assert.equal(sh["exit_code"], 1);
  assert.equal(sh["ok"], 0);
  assert.equal(sh["reads"], 1); // cat（npm test 不计）
  assert.deepEqual(JSON.parse(String(sh["read_files"])), ["src/a.ts"]);
  assert.equal(sh["turn_index"], 0);
  const shPatch = by("shell").find((r) => r["call_id"] === "exec-p1")!;
  assert.equal(shPatch["duration_ms"], 3000, "patch peek 不 consume：shell 行仍按 call↔output 计时长");
  const orphan = by("shell").find((r) => r["call_id"] === "c9")!;
  assert.equal(orphan["ok"], null);
  assert.equal(orphan["duration_ms"], null);

  assert.equal(by("collab").length, 2, "wait 配对 + sub_agent_activity");
  assert.equal(by("collab").find((r) => r["call_id"] === "c2")!["duration_ms"], 2000);

  assert.equal(by("file").length, 2);
  const f = by("file").find((r) => r["call_id"] === "exec-p1")!;
  assert.equal(f["duration_ms"], 2000, "file 行时长 = call↔patch_apply_end 差（at(9)-at(7)）");
  assert.equal(f["files_touched"], 2);
  assert.equal(f["lines_plus"], 4); // new + added + add 类 x,y 两行
  assert.equal(f["lines_minus"], 1);
  assert.equal(f["ok"], 1);
  const f2 = by("file").find((r) => r["call_id"] === "exec-p2")!;
  assert.equal(f2["duration_ms"], null, "无 pending 匹配 → NULL 不猜");

  const m = by("mcp")[0]!;
  assert.equal(m["duration_ms"], 1500);
  assert.equal(m["ok"], 1);
  assert.equal(m["detail"], "server=fs");

  assert.equal(by("web").length, 1);
});

test("taskDetail：任务域工具行为聚合（含 repeated reads）", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const store = new LedgerStore(db);
  const root = newThreadCtx("r1");
  const sub = newThreadCtx("s1");
  db.prepare("INSERT INTO threads(thread_id, thread_type, root_thread_id, model, cwd) VALUES('r1','root',NULL,'m','c:/p')").run();
  db.prepare("INSERT INTO threads(thread_id, thread_type, root_thread_id, model, cwd) VALUES('s1','subagent','r1','m','c:/p')").run();
  db.prepare("INSERT OR REPLACE INTO threads_diag(thread_id, final_total, native_total, schema_compat) VALUES('r1', 100, 100, 'ok')").run();
  db.prepare("INSERT OR REPLACE INTO threads_diag(thread_id, final_total, native_total, schema_compat) VALUES('s1', 50, 50, 'ok')").run();
  for (const [ctx, cidBase] of [[root, "a"], [sub, "b"]] as const) {
    processLine(store, ctx, ev(at(0), "event_msg", { type: "task_started", turn_id: `${cidBase}-t1` }));
    for (let i = 0; i < 2; i++) {
      processLine(store, ctx, ev(at(1 + i * 2), "response_item", {
        type: "custom_tool_call", id: `ctc_${cidBase}${i}`, call_id: `${cidBase}${i}`, name: "exec",
        input: `await tools.shell_command({command:"cat shared/x.ts"});`,
      }));
      processLine(store, ctx, ev(at(2 + i * 2), "response_item", {
        type: "custom_tool_call_output", call_id: `${cidBase}${i}`, output: [{ type: "input_text", text: "Exit code: 0" }],
      }));
    }
    processLine(store, ctx, ev(at(9), "event_msg", { type: "task_complete", turn_id: `${cidBase}-t1` }));
    closeEpoch(ctx, store);
    store.flushThread(ctx);
  }
  const det = taskDetail(db, "r1") as Record<string, any>;
  const shell = det.tool_behavior.buckets.find((b: Record<string, unknown>) => b["bucket"] === "shell");
  assert.equal(shell.calls, 4);
  assert.equal(shell.failures, 0);
  assert.equal(shell.reads, 4);
  const rep = det.tool_behavior.file_behavior.repeated_reads as Array<{ file: string; n: number }>;
  assert.equal(rep[0]!.file, "shared/x.ts");
  assert.equal(rep[0]!.n, 4);
});

test("taskDetail day 切片（v1.4）：tokens/turns/工具行为/wait 实测按日过滤 + NULL 语义", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const store = new LedgerStore(db);
  const ctx = newThreadCtx("r2");
  db.prepare("INSERT INTO threads(thread_id, thread_type, root_thread_id, model, cwd) VALUES('r2','root',NULL,'m','c:/p')").run();
  // 两天各一轮（started_at 秒级时间戳）
  const D0 = Date.parse("2026-08-19T10:00:00.000Z");
  const D1 = Date.parse("2026-08-20T10:00:00.000Z");
  const evAt = (ms: number, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload });
  processLine(store, ctx, evAt(D0, "event_msg", { type: "task_started", turn_id: "d0" }));
  processLine(store, ctx, evAt(D0 + 60_000, "event_msg", { type: "task_complete", turn_id: "d0", duration_ms: 60_000 }));
  processLine(store, ctx, evAt(D1, "event_msg", { type: "task_started", turn_id: "d1" }));
  // D1：exec 配对 + wait 调用（wait_call 实测）+ 无 pending 的 patch（duration NULL）
  processLine(store, ctx, evAt(D1 + 1000, "response_item", {
    type: "custom_tool_call", id: "x1", call_id: "d1c1", name: "exec",
    input: 'await tools.shell_command({command:"cat a.ts"});',
  }));
  processLine(store, ctx, evAt(D1 + 4000, "response_item", {
    type: "custom_tool_call_output", call_id: "d1c1", output: [{ type: "input_text", text: "Exit code: 0" }],
  }));
  processLine(store, ctx, evAt(D1 + 5000, "response_item", {
    type: "function_call", id: "x2", call_id: "d1w1", name: "wait", arguments: "{}",
  }));
  processLine(store, ctx, evAt(D1 + 7000, "response_item", { type: "function_call_output", call_id: "d1w1", output: "" }));
  processLine(store, ctx, evAt(D1 + 8000, "event_msg", {
    type: "patch_apply_end", call_id: "exec-nope", turn_id: "d1", success: true,
    changes: { "a.ts": { type: "add", content: "hi" } },
  }));
  // D0 也来一条 wait（应被 day 过滤掉）
  processLine(store, ctx, evAt(D0 + 5000, "response_item", {
    type: "function_call", id: "x3", call_id: "d0w1", name: "status", arguments: "{}",
  }));
  processLine(store, ctx, evAt(D0 + 6000, "response_item", { type: "function_call_output", call_id: "d0w1", output: "" }));
  processLine(store, ctx, evAt(D1 + 120_000, "event_msg", { type: "task_complete", turn_id: "d1", duration_ms: 120_000 }));
  closeEpoch(ctx, store);
  store.flushThread(ctx);
  // flush 后手工落账（flush 会以采集态覆写 threads_diag，这里显式给定参照值）
  db.prepare("INSERT OR REPLACE INTO threads_diag(thread_id, final_total, native_total, schema_compat, model_context_window) VALUES('r2', 1500, 1500, 'ok', 258400)").run();
  // daily_usage（native 口径）：两天各一行
  db.prepare("INSERT INTO daily_usage(thread_id, day, tokens, input_tokens, cached_input_tokens, output_tokens, samples, wait) VALUES('r2','2026-08-19',1000,800,700,50,10,1)").run();
  db.prepare("INSERT INTO daily_usage(thread_id, day, tokens, input_tokens, cached_input_tokens, output_tokens, samples, wait) VALUES('r2','2026-08-20',400,300,250,20,5,2)").run();

  const total = taskDetail(db, "r2") as Record<string, any>;
  const day = taskDetail(db, "r2", null, "2026-08-20") as Record<string, any>;

  // scope 标识
  assert.equal(total.scope.day, null);
  assert.equal(day.scope.day, "2026-08-20");

  // 总计：两轮；当日：一轮（按 started 归日）
  assert.equal(total.turns.length, 2);
  assert.equal(day.turns.length, 1);
  assert.equal(day.turns[0].turn_index, 1);

  // 任务 Token：总计 = native_total；当日 = daily_usage 当日行
  assert.equal(total.task_totals.total_tokens, 1500);
  assert.equal(day.task_totals.total_tokens, 400);
  assert.equal(day.tokens.input, 300);
  assert.equal(day.tokens.cached, 250);
  assert.equal(day.diag.samples, 5);
  assert.equal(day.diag.wait, 2);
  assert.equal(day.diag.rebroadcast, null, "当日 rebroadcast 不入账 → null");
  assert.equal(day.diag.tool_output_bytes, null);
  assert.equal(day.header.ttfm_ms, null, "当日切片无 TTFM");

  // 工具行为：当日仅 D1 的 exec 1 次；file 行无 pending → duration_ms null（不误报 0）
  const dayShell = day.tool_behavior.buckets.find((b: Record<string, unknown>) => b["bucket"] === "shell");
  assert.equal(dayShell.calls, 1);
  const totalShell = total.tool_behavior.buckets.find((b: Record<string, unknown>) => b["bucket"] === "shell");
  assert.equal(totalShell.calls, 1, "r2 任务域仅 D1 这一条 exec 配对（D0 只有 wait 调用）");
  const dayFile = day.tool_behavior.buckets.find((b: Record<string, unknown>) => b["bucket"] === "file");
  assert.equal(dayFile.duration_ms, null);
  assert.equal(dayFile.duration_n, 0);
  assert.equal(dayFile.calls, 1);

  // wait 实测：当日仅 d1w1（2000ms）；D0 的 d0w1 被过滤
  assert.equal(day.orchestration.wait_call_n, 1);
  assert.equal(day.orchestration.wait_call_ms, 2000);
  assert.equal(total.orchestration.wait_call_n, 2);
  assert.equal(total.orchestration.wait_call_ms, 3000);

  // model_context_window 快照修复：diag 现在能拿到窗口值
  assert.equal(total.diag.model_context_window, 258400);
});

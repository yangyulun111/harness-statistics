/**
 * Golden harness（TS 侧，G1 回归）：
 *   1) 对同一 fixture home，Python oracle 与 TS 各做一次性 ingest（全新库）
 *   2) 双方 dump 规范化 JSON，逐字段深度对比（要求 EXACT 相等）
 *   3) 幂等性：第二轮 ingest 后 dump 必须与第一轮一致（增量续读不改变账目）
 * 依赖 conda 环境 harness-stats 中的 Python oracle（ledger/）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ingest } from "@hs/ledger-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONDA = process.env["CONDA_EXE"] ?? "C:\\Users\\Administrator\\miniconda3\\Scripts\\conda.exe";
const NORM_COLS = new Set(["patch_files", "file_usage_epochs", "source", "schema_issues", "sandbox_policy"]);

export interface GoldenResult {
  pass: boolean;
  diffs: string[];
  idempotentPy: boolean;
  idempotentTs: boolean;
  summary: string;
}

type Row = Record<string, any>;
export type Dump = { threads: Row[]; threads_diag: Row[]; turns: Row[]; daily_usage: Row[]; tool_failures: Row[]; rollout_files: Row[] };

function normVal(v: unknown, col: string): unknown {
  if (typeof v === "string" && (NORM_COLS.has(col) || col.endsWith("_json"))) {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch { /* keep raw */ }
    }
  }
  return v;
}

function dumpTable(db: DatabaseSync, table: string, order: string, cols?: Set<string>): Row[] {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[];
  return rows.map((r) => {
    const out: Row = {};
    for (const k of Object.keys(r)) {
      if (cols && !cols.has(k)) continue;
      out[k] = normVal(r[k], k);
    }
    return out;
  });
}

export function dumpGolden(dbPath: string): Dump {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      threads: dumpTable(db, "threads", "thread_id"),
      threads_diag: dumpTable(db, "threads_diag", "thread_id"),
      turns: dumpTable(db, "turns", "thread_id, turn_index"),
      daily_usage: dumpTable(db, "daily_usage", "thread_id, day"),
      tool_failures: dumpTable(db, "tool_failures", "thread_id, seq"),
      rollout_files: dumpTable(db, "rollout_files", "path",
        new Set(["path", "thread_id", "size", "last_offset", "status"])),
    };
  } finally {
    db.close();
  }
}

export function deepDiff(a: unknown, b: unknown, at: string, out: string[]): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    out.push(`${at}: py=${JSON.stringify(a)} ts=${JSON.stringify(b)}`);
    return false;
  }
  const an = a as Record<string, unknown>;
  const bn = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(an), ...Object.keys(bn)]);
  let ok = true;
  for (const k of keys) {
    if (!(k in an) || !(k in bn)) {
      out.push(`${at}.${k}: presence py=${k in an} ts=${k in bn}`);
      ok = false;
    } else if (!deepDiff(an[k], bn[k], `${at}.${k}`, out)) {
      ok = false;
      if (out.length > 60) return ok;
    }
  }
  return ok;
}

export function runPy(args: string[]): string {
  const r = spawnSync(CONDA, ["run", "-n", "harness-stats", "python", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`python ${args[0]} 失败：${r.stderr?.slice(-2000)}`);
  return r.stdout!;
}

/** Python oracle 对指定 home 做增量 ingest（fixture golden / fork 矩阵共用）。 */
export function pyIngest(home: string, db: string): void {
  runPy(["scripts/golden_ingest.py", home, db]);
}

/** Python oracle 规范化 dump（与 dumpGolden 同构）。 */
export function pyDump(db: string): Dump {
  return JSON.parse(runPy(["scripts/golden_dump.py", db]));
}

function rmDb(p: string): void {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(p + s, { force: true });
    } catch { /* ignore */ }
  }
}

export async function runGolden(): Promise<GoldenResult> {
  const home = path.join(ROOT, "tests", "fixtures", "codex-home");
  const dir = path.join(ROOT, "data", "golden");
  fs.mkdirSync(dir, { recursive: true });
  const pyDb = path.join(dir, "py.sqlite");
  const tsDb = path.join(dir, "ts.sqlite");
  rmDb(pyDb);
  rmDb(tsDb);

  runPy(["scripts/golden_ingest.py", home, pyDb]);
  await ingest({ dbPath: tsDb, envCodexHome: home, verbose: false });

  const pyDump1: Dump = JSON.parse(runPy(["scripts/golden_dump.py", pyDb]));
  const tsDump1 = dumpGolden(tsDb);

  const diffs: string[] = [];
  let pass = true;
  for (const table of Object.keys(pyDump1) as Array<keyof Dump>) {
    const a = pyDump1[table] as unknown;
    const b = tsDump1[table] as unknown;
    if (!deepDiff(a, b, table, diffs)) pass = false;
  }

  // 幂等：第二轮增量 ingest 不得改变账目
  runPy(["scripts/golden_ingest.py", home, pyDb]);
  await ingest({ dbPath: tsDb, envCodexHome: home, verbose: false });
  const pyDump2: Dump = JSON.parse(runPy(["scripts/golden_dump.py", pyDb]));
  const tsDump2 = dumpGolden(tsDb);
  const idemDiffs: string[] = [];
  const idempotentPy = deepDiff(pyDump1, pyDump2, "py#2", idemDiffs);
  const idempotentTs = deepDiff(tsDump1, tsDump2, "ts#2", idemDiffs);
  if (!idempotentPy) diffs.push(...idemDiffs.slice(0, 20));
  if (!idempotentTs) diffs.push(...idemDiffs.slice(0, 20));
  if (!idempotentPy || !idempotentTs) pass = false;

  const summary = `threads=${pyDump1.threads.length} diag=${pyDump1.threads_diag.length} ` +
    `turns=${pyDump1.turns.length} files=${pyDump1.rollout_files.length}` +
    (pass ? "  → EXACT 相等 + 幂等" : `  → ${diffs.length} 处差异`);
  return { pass, diffs, idempotentPy, idempotentTs, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGolden().then((r) => {
    console.log(`[golden] ${r.summary}`);
    for (const d of r.diffs.slice(0, 40)) console.log("  " + d);
    process.exitCode = r.pass ? 0 : 1;
  }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

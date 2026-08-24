/**
 * 发现 Codex 本地状态 —— Python oracle ledger/discovery.py 的 TS 移植。
 *
 * 优先 `codex doctor --json`（Codex 自己报告的路径，避免两套 sqlite home 歧义），失败回退约定路径。
 * 显式传入 envCodexHome（fixture / 测试）时跳过 doctor，只用该 home —— 与 Python 侧
 * discover(env_codex_home, use_doctor=False) 行为一致。绝不做任何写操作。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexPaths {
  codexHome: string;
  sqliteHome: string;
  stateDb: string | null;
  sessionsRoot: string;
  codexVersion: string | null;
  model: string | null;
  modelProvider: string | null;
  doctorUsed: boolean;
  notes: string[];
}

export function sessionFiles(root: string): string[] {
  /** sessions/YYYY/MM/DD/*.jsonl，按路径排序（即按时间有序）。 */
  const out: string[] = [];
  let years: string[] = [];
  try {
    years = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const y of years) {
    const yd = path.join(root, y);
    let months: fs.Dirent[] = [];
    try {
      months = fs.readdirSync(yd, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const m of months.filter((d) => d.isDirectory())) {
      const md = path.join(yd, m.name);
      let days: fs.Dirent[] = [];
      try {
        days = fs.readdirSync(md, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of days.filter((d) => d.isDirectory())) {
        const dd = path.join(md, d.name);
        let files: fs.Dirent[] = [];
        try {
          files = fs.readdirSync(dd, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.isFile() && f.name.endsWith(".jsonl")) out.push(path.join(dd, f.name));
        }
      }
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * session_index.jsonl —— 桌面端 app-server 维护的轻量会话索引（一行一 JSON：
 * {id, thread_name, updated_at}）。thread_name 是云端摘要标题的本地镜像，
 * 含活跃线程（state_5.threads.title 对活跃线程会被覆盖回首条消息原文，不可靠）。
 * 只读解析，容忍坏行。
 */
export function readSessionIndex(codexHome: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = path.join(codexHome, "session_index.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      const id = j?.["id"];
      const name = j?.["thread_name"];
      if (typeof id === "string" && typeof name === "string" && name) out.set(id, name);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

function findCodexExe(): string[] {
  const cands: string[] = [];
  const sandbox = path.join(os.homedir(), ".codex", ".sandbox-bin", process.platform === "win32" ? "codex.exe" : "codex");
  if (fs.existsSync(sandbox)) cands.push(sandbox);
  cands.push("codex");
  return cands;
}

function runDoctor(exe: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ["doctor", "--json"],
      { timeout: 60_000, encoding: "utf8", shell: process.platform === "win32", windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const v = JSON.parse(stdout);
          resolve(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function bestStateDb(dir: string): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const cands: [number, string][] = [];
  for (const name of entries) {
    const m = /state_(\d+)\.sqlite$/.exec(name);
    if (m || name.startsWith("state_")) {
      cands.push([m ? Number(m[1]) : -1, path.join(dir, name)]);
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b[0] - a[0]);
  return cands[0][1];
}

function pickStateDb(sqliteHome: string, codexHome: string, notes: string[]): string | null {
  let hit = bestStateDb(sqliteHome);
  if (hit === null && path.resolve(sqliteHome) !== path.resolve(codexHome)) {
    hit = bestStateDb(codexHome);
    if (hit !== null) notes.push(`state DB 不在 sqlite home，回退到 ${hit}`);
  }
  return hit;
}

export async function discover(envCodexHome?: string | null): Promise<CodexPaths> {
  const notes: string[] = [];
  const explicit = envCodexHome || process.env["CODEX_HOME"] || null;
  const envHome = explicit || path.join(os.homedir(), ".codex");
  const paths: CodexPaths = {
    codexHome: envHome,
    sqliteHome: envHome,
    stateDb: null,
    sessionsRoot: path.join(envHome, "sessions"),
    codexVersion: null,
    model: null,
    modelProvider: null,
    doctorUsed: false,
    notes,
  };
  // 显式 home（fixture/测试）时跳过 doctor，保证可复现
  if (envCodexHome) {
    paths.stateDb = pickStateDb(paths.sqliteHome, paths.codexHome, notes);
    return paths;
  }

  for (const exe of findCodexExe()) {
    const doc = await runDoctor(exe);
    if (!doc) continue;
    paths.doctorUsed = true;
    paths.codexVersion = typeof doc["codexVersion"] === "string" ? doc["codexVersion"] : null;
    const checks = (doc["checks"] ?? {}) as Record<string, unknown>;
    const cfgLoad = (checks["config.load"] ?? {}) as Record<string, unknown>;
    const cfg = (cfgLoad["details"] ?? {}) as Record<string, unknown>;
    const home = cfg["CODEX_HOME"];
    const sqhome = cfg["sqlite home"];
    if (typeof home === "string" && home) {
      paths.codexHome = home;
      paths.sessionsRoot = path.join(home, "sessions");
    }
    if (typeof sqhome === "string" && sqhome) paths.sqliteHome = sqhome;
    paths.model = typeof cfg["model"] === "string" ? cfg["model"] : null;
    paths.modelProvider = typeof cfg["model provider"] === "string" ? cfg["model provider"] : null;
    break;
  }
  if (!paths.doctorUsed) {
    notes.push("codex doctor --json 不可用，使用约定路径（CODEX_HOME 环境变量或 ~/.codex）");
  }
  paths.stateDb = pickStateDb(paths.sqliteHome, paths.codexHome, notes);
  if (paths.stateDb === null) {
    notes.push("未找到 state_*.sqlite，任务目录将仅来自 rollout session_meta");
  }
  return paths;
}

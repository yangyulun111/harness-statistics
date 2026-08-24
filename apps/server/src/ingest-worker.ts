/**
 * 采集 worker —— 在独立线程内运行同步 ingest 循环，绝不阻塞主线程 HTTP 服务。
 * node:sqlite 的同步 API 因此不进入 UI/网络关键路径（对应 P4 Electron utilityProcess 思路）。
 */
import { parentPort, workerData } from "node:worker_threads";
import { ingest } from "@hs/ledger-core";

const { db, envCodexHome, intervalSec } = workerData as {
  db: string;
  envCodexHome: string | null;
  intervalSec: number;
};

async function loop(): Promise<void> {
  // 首轮立即执行
  for (;;) {
    const t0 = Date.now();
    try {
      const stats = await ingest({ dbPath: db, envCodexHome, verbose: false });
      parentPort?.postMessage({ type: "ingest", at: Date.now(), elapsedMs: Date.now() - t0, stats, error: null });
    } catch (e) {
      parentPort?.postMessage({ type: "ingest", at: Date.now(), elapsedMs: Date.now() - t0, stats: null, error: String(e) });
    }
    await new Promise((r) => setTimeout(r, Math.max(1, intervalSec) * 1000));
  }
}

loop();

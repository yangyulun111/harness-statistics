/**
 * @hs/cli —— 命令行入口：update / serve / reconcile / env
 * 全部经 conda-free Node 运行（node:sqlite），零全局依赖。
 */
import { discover } from "@hs/codex-discovery";
import { ingest, reconcile } from "@hs/ledger-core";
import { DEFAULT_TS_DB } from "@hs/shared";
import path from "node:path";

interface Args {
  flags: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const str = (flags: Map<string, string | boolean>, k: string): string | undefined => {
  const v = flags.get(k);
  return typeof v === "string" ? v : undefined;
};
const numv = (flags: Map<string, string | boolean>, k: string): number | undefined => {
  const v = str(flags, k);
  return v !== undefined ? Number(v) : undefined;
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const db = str(flags, "db") ?? DEFAULT_TS_DB();
  const home = str(flags, "home") ?? null;

  switch (cmd) {
    case "update": {
      if (flags.has("refold-tools")) {
        // v1.3：tool_events（TS-only 分桶/文件行为表）全量回填，不动契约表与 offset，幂等
        const { refoldToolEvents } = await import("@hs/ledger-core");
        const r = refoldToolEvents(db);
        console.log(`[refold-tools] files=${r.files} events=${r.events}（tool_events 已全量重建）`);
        break;
      }
      const stats = await ingest({
        dbPath: db,
        envCodexHome: home,
        recentDays: numv(flags, "recent-days") ?? null,
        verbose: !flags.has("quiet"),
      });
      if (flags.has("quiet")) console.log(JSON.stringify(stats));
      break;
    }
    case "serve": {
      const port = numv(flags, "port") ?? 8766;
      const interval = numv(flags, "interval") ?? 5;
      const prices = str(flags, "prices");
      const { serve } = await import("@hs/server");
      await serve({ db, envCodexHome: home, port, intervalSec: interval, pricesPath: prices });
      break;
    }
    case "reconcile": {
      const r = reconcile(db);
      console.log(`[G0-A] threads=${r.threads} matched=${r.matched} mismatched=${r.mismatched}`);
      console.log(`[G0-A] state Σ=${r.sum_state.toLocaleString("en-US")} ledger Σ=${r.sum_ledger.toLocaleString("en-US")} ratio=${(r.ratio * 100).toFixed(3)}%`);
      for (const d of r.diffs) {
        console.log(`  diff ${d.thread_id.slice(0, 8)} state=${d.state.toLocaleString("en-US")} ledger=${d.ledger.toLocaleString("en-US")} (${d.diff > 0 ? "+" : ""}${d.diff.toLocaleString("en-US")})`);
      }
      break;
    }
    case "prices": {
      const { syncPrices, loadMergedCatalog } = await import("@hs/ledger-core");
      const pricesPath = str(flags, "prices") ?? path.join(process.cwd(), "model_prices.json");
      const syncedPath = path.join(path.dirname(pricesPath), "model_prices.synced.json");
      if (flags.has("sync")) {
        const src = str(flags, "source");
        const r = await syncPrices({
          syncedPath,
          source: src === "openai" || src === "litellm" ? src : "auto",
          dryRun: flags.has("dry-run"),
        });
        console.log(JSON.stringify(r, null, 2));
        if (r.error) process.exitCode = 1;
      } else {
        const merged = loadMergedCatalog(pricesPath, syncedPath);
        if (!merged) {
          console.log(`价格目录未配置：${pricesPath}（与 ${syncedPath}）`);
          break;
        }
        for (const e of merged.entries) {
          console.log(
            `${e.origin === "user" ? "[用户]" : "[同步]"} ${e.model}  ` +
            `${new Date(e.effective_from_ms).toISOString().slice(0, 10)} → ${e.effective_to_ms ? new Date(e.effective_to_ms).toISOString().slice(0, 10) : "开放"}  ` +
            `in=${e.input_per_mtok} cached=${e.cached_input_per_mtok} out=${e.output_per_mtok}` +
            `${e.promo ? " [促销]" : ""}  ${e.source ?? ""}`,
          );
        }
        const u = merged.entries.filter((e) => e.origin === "user").length;
        console.log(`共 ${merged.entries.length} 条（用户 ${u} / 同步 ${merged.entries.length - u}）`);
      }
      break;
    }
    case "env": {
      const p = await discover(home);
      console.log(JSON.stringify(p, null, 2));
      break;
    }
    default:
      console.log(`用法：npm run <update|serve|reconcile|env|prices> [--db path] [--home dir] [--port n] [--interval s] [--recent-days n] [--prices model_prices.json] [--refold-tools] [--quiet]`);
      console.log(`  prices --sync [--source auto|openai|litellm] [--dry-run]  同步官网/社区价格（写入 model_prices.synced.json，用户文件不动）`);
      process.exitCode = cmd ? 1 : 0;
      break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Source execution uses the existing Vitest/Vite dependency. Every workspace
// package resolves to this checkout, independent of shared node_modules links.
const root = fileURLToPath(new URL("../", import.meta.url));
let cache;
let server;
try {
  if (process.argv.length !== 2) throw new TypeError("CLI overrides are not allowed for the locked diagnostic");
  cache = await mkdtemp(join(tmpdir(), "mms-actions-v2-vite-"));
  server = await createServer({
    root,
    configFile: false,
    cacheDir: cache,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: Object.fromEntries([
      "contracts", "execution-gateway", "research-kernel", "experiment-registry",
      "research-runner", "strategy-simulator", "paper-trading",
    ].map((name) => [`@mms/${name}`, resolve(root, `packages/${name}/src/index.ts`)])) },
  });
  const module = await server.ssrLoadModule("/packages/paper-trading/src/historicalActionCostDiagnostic.ts");
  const result = await module.runHistoricalActionCostDiagnosticFiles(root);
  process.stdout.write(`${JSON.stringify({
    status: "RETROSPECTIVE_DIAGNOSTIC_ONLY", outputPath: resolve(root, module.HISTORICAL_ACTION_COST_OUTPUT),
    sourceRowCount: result.sourceRowCount, evaluationRowCount: result.evaluationRowCount, warmupRowCount: result.warmupRowCount,
    windows: result.results.map((window) => ({
      id: window.id, rowCount: window.rowCount,
      candidateCompletedTrades: window.candidate.completedTradeCount, candidateOpenQuantity: window.candidate.openPositionQuantity,
      candidateReturn: window.candidate.netReturnBeforePersonalDividendTaxFraction,
      benchmarkReturn: window.costMatchedBenchmark.netReturnBeforePersonalDividendTaxFraction,
      candidateDrawdown: window.candidate.maximumDrawdownBeforePersonalDividendTaxFraction,
      relativeOutcome: window.relativeOutcome,
    })),
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "ERROR", code: "HISTORICAL_DIAGNOSTIC_FAILED", reason: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (cache) await rm(cache, { recursive: true, force: true });
}

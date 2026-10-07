import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const protocolPath = "packages/paper-trading/experiments/cost-covered-zscore-exit-v1/protocol.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
function git(...args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
async function exclusive(path, bytes) {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); return "CREATED"; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw new Error(`immutable attempt collision: ${path}`);
    return "REUSED_SAME_ATTEMPT";
  }
}

let server, cache;
try {
  const args = process.argv.slice(2);
  const availability = args.length === 1 && args[0] === "--availability";
  if (!availability && (args.length !== 4 || args[0] !== "--input" || args[2] !== "--output-dir")) {
    throw new TypeError("Usage: --availability OR --input <JSON> --output-dir <isolated directory>; no strategy/cost/risk overrides");
  }
  // The first addition freezes this protocol identity. Later edits cannot silently
  // re-register the same hypothesis or move the unseen-data boundary backwards.
  const commits = git("log", "--diff-filter=A", "--format=%H", "--", protocolPath).split("\n").filter(Boolean);
  if (commits.length !== 1) throw new Error("protocol must have exactly one committed registration");
  const freezeCommit = commits[0];
  const bytes = await readFile(resolve(root, protocolPath));
  const frozenBytes = execFileSync("git", ["-C", root, "show", `${freezeCommit}:${protocolPath}`]);
  if (!bytes.equals(frozenBytes)) throw new Error("protocol differs from original committed registration");
  const protocol = JSON.parse(bytes);
  const freezeTimestamp = Date.parse(git("show", "-s", "--format=%cI", freezeCommit));
  if (!Number.isSafeInteger(freezeTimestamp) || freezeTimestamp > Date.now()) throw new Error("invalid/future protocol freeze time");
  for (const [path, expected] of Object.entries(protocol.implementationSha256)) {
    if (digest(await readFile(resolve(root, path))) !== expected) throw new Error(`frozen implementation changed: ${path}`);
  }
  const freeze = { freezeCommit, freezeTimestamp, freezeTimeUtc: new Date(freezeTimestamp).toISOString(), protocolSha256: digest(bytes) };
  if (availability) {
    process.stdout.write(encode({
      status: "AWAITING_GENUINELY_FUTURE_DATA", ...freeze,
      frozenInventoryRealDataThrough: protocol.availability.storedRealDataThrough,
      certifiedUnseenRowsInFrozenInventory: 0,
      reason: "The frozen inventory predates protocol registration. This is a registration-time inventory, not a live source scan. Unfetched past data remain development data; no source fetch or market experiment is run.",
      minimumEligibility: protocol.minimumEligibility,
    }));
  } else {
    const inputPath = resolve(args[1]), outputDir = resolve(args[3]);
    // A dedicated namespace keeps writes away from the accumulator/journal and
    // existing frozen artifacts. Every attempt, including rejection, is immutable.
    const attemptDir = join(outputDir, "cost-covered-zscore-exit-v1");
    await mkdir(attemptDir, { recursive: true });
    if ((await stat(inputPath)).size > 1_048_576) throw new TypeError("input exceeds lightweight 1 MiB limit");
    const inputBytes = await readFile(inputPath), inputSha256 = digest(inputBytes);
    await exclusive(join(attemptDir, `${inputSha256}.input.json`), inputBytes);
    const outputPath = join(attemptDir, `${inputSha256}.result.json`);
    let report, existing = false;
    try {
      report = JSON.parse(await readFile(outputPath, "utf8"));
      if (report.inputSha256 !== inputSha256 || report.protocolSha256 !== freeze.protocolSha256 || report.freezeCommit !== freezeCommit) throw new Error("existing attempt identity mismatch");
      existing = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!existing) try {
      cache = await mkdtemp(join(tmpdir(), "mms-cost-covered-v1-"));
      server = await createServer({
        root, configFile: false, cacheDir: cache,
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        optimizeDeps: { noDiscovery: true },
      });
      const module = await server.ssrLoadModule("/packages/paper-trading/src/costCoveredExitExperiment.ts");
      const input = module.parseCostCoveredExitInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)), freezeTimestamp, Date.now());
      report = { ...module.runCostCoveredExitExperiment(input, inputSha256, freezeTimestamp), ...freeze };
    } catch (error) {
      report = { status: "REJECTED_INPUT_OR_EXECUTION", code: "COST_COVERED_EXPERIMENT_REJECTED", reason: error instanceof Error ? error.message : String(error), inputSha256, ...freeze };
      process.exitCode = 1;
    }
    if (report.status === "REJECTED_INPUT_OR_EXECUTION") process.exitCode = 1;
    const persistence = await exclusive(outputPath, encode(report));
    process.stdout.write(encode({
      status: report.status, classification: report.classification, code: report.code, reason: report.reason,
      outputPath, persistence, ...freeze,
      eligibility: report.eligibility,
      results: report.results?.map((row) => ({
        symbol: row.symbol,
        baselineCompletedTrades: row.baseline.completeTradeCount, candidateCompletedTrades: row.candidate.completeTradeCount,
        candidateOpenQuantity: row.candidate.openPositionQuantity, candidatePendingOrder: row.candidate.pendingOrder,
        candidateWinRate: row.candidate.netWinRate, candidateWilson95: row.candidate.netWinRateWilson95,
        candidateNetReturn: row.candidate.netReturnAfterModeledCostsFraction,
        benchmarkNetReturn: row.costMatchedBenchmark.netReturnAfterModeledCostsFraction,
        candidateMaximumDrawdown: row.candidate.maximumDrawdownFraction,
        candidateExitDiagnostics: row.candidate.exitDiagnostics,
      })),
      nonDeterminationReasons: report.nonDeterminationReasons,
    }));
  }
} catch (error) {
  process.stdout.write(encode({ status: "ERROR", code: "COST_COVERED_PROTOCOL_OR_IO_FAILURE", reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (cache) await rm(cache, { recursive: true, force: true });
}

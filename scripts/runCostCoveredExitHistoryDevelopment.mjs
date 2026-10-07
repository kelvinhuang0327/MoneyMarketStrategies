import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { aggregateIndependentSummaries, compareSameEntryTrades, summarizeHistoricalReplay } from "./costCoveredExitHistoryMetrics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const planPath = "packages/paper-trading/experiments/cost-covered-exit-history-development-v1/plan.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
const compactAggregate = (aggregate) => Object.fromEntries(Object.entries(aggregate).map(([arm, metrics]) => [arm, Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== "equityAndExposureCurve"))]));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function optionalJson(path) { try { return await readJson(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function exclusive(path, bytes) {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw new Error(`immutable artifact collision: ${path}`);
  }
}

let server, cache, lockPath, ownsLock = false;
try {
  if (process.argv.length !== 3 || !["--check-inputs", "--run"].includes(process.argv[2])) throw new TypeError("Usage: --check-inputs OR --run; no symbol/window/parameter/cost overrides");
  const planBytes = await readFile(resolve(root, planPath)), plan = JSON.parse(planBytes), planSha256 = digest(planBytes);
  const added = git("log", "--diff-filter=A", "--format=%H", "--", planPath).split("\n").filter(Boolean);
  if (added.length !== 1 || !execFileSync("git", ["-C", root, "show", `${added[0]}:${planPath}`]).equals(planBytes)) throw new Error("development plan must match its first committed registration");
  for (const [path, expected] of Object.entries(plan.sourceSha256)) if (digest(await readFile(resolve(root, path))) !== expected) throw new Error(`registered source changed: ${path}`);
  const protocol = await readJson(resolve(root, plan.frozenProtocol.path));
  for (const [path, expected] of Object.entries(protocol.implementationSha256)) if (digest(await readFile(resolve(root, path))) !== expected) throw new Error(`frozen candidate changed: ${path}`);
  if (JSON.stringify(plan.symbols) !== JSON.stringify(protocol.symbols)) throw new Error("development symbols differ from frozen candidate");
  const freezeTimestamp = Date.parse(git("show", "-s", "--format=%cI", plan.frozenProtocol.commit));
  const window = {
    startTimestamp: Date.parse(`${plan.window.startDate}T13:30:00+08:00`),
    endTimestamp: Date.parse(`${plan.window.endDate}T13:30:00+08:00`),
  };
  if (!Number.isSafeInteger(window.startTimestamp) || !Number.isSafeInteger(window.endTimestamp) || window.endTimestamp >= freezeTimestamp) throw new Error("development window must strictly predate original candidate freeze");
  const sourceBytes = await readFile(resolve(root, plan.csv.path));
  if (digest(sourceBytes) !== plan.csv.sha256) throw new Error("historical cache hash differs from registered source");
  const outputDir = resolve(root, plan.outputDirectory);
  await mkdir(outputDir, { recursive: true });
  lockPath = join(outputDir, ".run.lock");
  try { await mkdir(lockPath); ownsLock = true; }
  catch (error) { if (error.code === "EEXIST") throw new Error("EXPERIMENT_LOCK_EXISTS: another run or unresolved prior run owns this experiment; no process inspection/retry performed"); throw error; }
  await writeFile(join(lockPath, "owner.json"), encode({ pid: process.pid, startedAtUtc: new Date().toISOString(), planSha256, head: git("rev-parse", "HEAD") }), { flag: "wx" });
  cache = await mkdtemp(join(tmpdir(), "mms-exit-history-dev-v1-"));
  server = await createServer({ root, configFile: false, cacheDir: cache, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } });
  const history = await server.ssrLoadModule("/packages/paper-trading/src/historicalBaseline.ts");
  const sessionRunner = await server.ssrLoadModule("/packages/paper-trading/src/sessionRunner.ts");
  const original = await server.ssrLoadModule("/packages/paper-trading/src/zscoreStrategy.ts");
  const candidateModule = await server.ssrLoadModule("/packages/paper-trading/src/costCoveredZScoreExit.ts");
  const experiment = await server.ssrLoadModule("/packages/paper-trading/src/costCoveredExitExperiment.ts");
  const money = await server.ssrLoadModule("/packages/paper-trading/src/money.ts");
  const { CROSS_SYMBOL_RESEARCH_RISK_V1: risk } = await server.ssrLoadModule("/packages/paper-trading/src/crossSymbolResearchRisk.ts");
  const csv = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const datasets = plan.symbols.map((symbol) => {
    const parsed = history.parseHistoricalCsv(csv, symbol, plan.csv.path, "twse-daily-ohlcv-close-v1");
    const before = parsed.session.events.filter((event) => event.timestamp < window.startTimestamp).slice(-plan.warmupRowsPerSymbol);
    const evaluation = parsed.session.events.filter((event) => event.timestamp >= window.startTimestamp && event.timestamp <= window.endTimestamp);
    if (before.length !== plan.warmupRowsPerSymbol || evaluation.length === 0 || before.length + evaluation.length > plan.maximumRowsPerSymbol) throw new Error(`registered row budget/warmup violated for ${symbol}`);
    if (evaluation.some((event) => event.timestamp >= freezeTimestamp)) throw new Error("post-freeze row cannot enter this development study");
    const events = [...before, ...evaluation];
    const selectedTimes = new Set(events.map((event) => new Date(event.timestamp).toISOString().slice(0, 10)));
    const sourceRows = parsed.sourceRows.filter((row) => selectedTimes.has(row.date));
    const dates = evaluation.map((event) => new Date(event.timestamp).toISOString().slice(0, 10));
    return { symbol, parsed, session: { ...parsed.session, events }, input: { symbol, warmupRows: before.length, evaluationRows: evaluation.length, evaluationDates: dates, events, sourceRows } };
  });
  const allDates = [...new Set(datasets.flatMap((data) => data.input.evaluationDates))].sort();
  const input = {
    classification: "RETROSPECTIVE_DEVELOPMENT_INPUT_NOT_FORWARD", planSha256,
    originalFrozenProtocolCommit: plan.frozenProtocol.commit, originalFreezeTimestamp: freezeTimestamp,
    window: { ...plan.window, ...window }, csvSha256: plan.csv.sha256,
    calendarCoverage: { officialExchangeCalendarVerified: false, alignment: "UNION_OF_OBSERVED_DATES_NO_ROW_FILTERING", missingObservedPeerDates: Object.fromEntries(datasets.map((data) => [data.symbol, allDates.filter((date) => !data.input.evaluationDates.includes(date))])) },
    datasets: datasets.map((data) => data.input),
  };
  const inputBytes = encode(input), inputSha256 = digest(inputBytes);
  await exclusive(join(outputDir, `${planSha256}.plan.json`), planBytes);
  await exclusive(join(outputDir, `${inputSha256}.input.json`), inputBytes);
  const resultPath = join(outputDir, `${inputSha256}.result.json`);
  if (process.argv[2] === "--check-inputs") {
    process.stdout.write(encode({ status: "INPUTS_REGISTERED_NO_REPLAY", classification: input.classification, planSha256, inputSha256, originalFreezeTimestamp: freezeTimestamp, window: input.window, datasets: input.datasets.map(({ symbol, warmupRows, evaluationRows, evaluationDates }) => ({ symbol, warmupRows, evaluationRows, firstDate: evaluationDates[0], lastDate: evaluationDates.at(-1) })), resultPath, sourceSha256: plan.csv.sha256 }));
  } else {
    const existing = await optionalJson(resultPath);
    if (existing) {
      if (existing.planSha256 !== planSha256 || existing.inputSha256 !== inputSha256) throw new Error("existing development attempt identity differs");
      process.stdout.write(encode({ status: existing.status, classification: existing.classification, persistence: "REUSED_SAME_DEVELOPMENT_ATTEMPT", resultPath, aggregate: compactAggregate(existing.aggregate), sideEffects: existing.sideEffects }));
    } else {
      const results = [];
      for (const data of datasets) {
        const arms = {};
        for (const arm of ["baseline", "candidate", "costMatchedBenchmark"]) {
          const replayPath = join(outputDir, `${inputSha256}.${data.symbol}.${arm}.replay.json`);
          let saved = await optionalJson(replayPath);
          if (!saved) {
            const config = { ...experiment.COST_COVERED_EXIT_PARAMETERS, activeFromTimestamp: window.startTimestamp };
            const strategy = arm === "baseline" ? new original.RollingZScoreMeanReversionV1Strategy(config)
              : arm === "candidate" ? new candidateModule.CostCoveredZScoreExitV1Strategy({ ...config, ...experiment.COST_COVERED_EXIT_TERMS })
                : { strategyVersion: "fixed-quantity-hold-first-eligible-next-event-v1", decide: (event) => event.current.timestamp >= window.startTimestamp ? 3 : 0 };
            const observations = [], exitAudit = [];
            const wrapped = { strategyVersion: strategy.strategyVersion, strategyParameters: strategy.strategyParameters ?? {}, decide(event) {
              const before = arm === "candidate" ? strategy.getDiagnostics() : null;
              const target = strategy.decide(event);
              if (event.current.timestamp >= window.startTimestamp) {
                observations.push({ sourceEventId: event.current.eventId, timestamp: event.current.timestamp, priceMinor: event.current.priceMinor, positionQuantity: event.positionQuantity, positionCostBasisMinor: event.positionCostBasisMinor });
                if (before) {
                  const after = strategy.getDiagnostics();
                  const kind = after.forcedExits > before.forcedExits ? "FORCED_EXIT" : after.costCovered > before.costCovered ? "COST_COVERED_EXIT" : after.belowCost > before.belowCost ? "BELOW_COST_BLOCK" : after.unknownCost > before.unknownCost ? "UNKNOWN_COST_BLOCK" : null;
                  if (kind) {
                    const price = money.executionPriceMinor("sell", event.current.priceMinor, experiment.COST_COVERED_EXIT_TERMS.slippageBps);
                    exitAudit.push({ kind, sourceEventId: event.current.eventId, timestamp: event.current.timestamp, targetQuantity: target, positionQuantity: event.positionQuantity, actualEntryCostBasisMinor: event.positionCostBasisMinor ?? null, estimatedNetSaleMinor: price * BigInt(event.positionQuantity) - money.feeMinorForFill(price, event.positionQuantity, experiment.COST_COVERED_EXIT_TERMS.feeBps) });
                  }
                }
              }
              return target;
            } };
            const replay = sessionRunner.runPaperSession(data.session, inputSha256, undefined, wrapped, risk, { captureEquityCurve: true });
            saved = { replay, observations, exitAudit, candidateExitDiagnostics: arm === "candidate" ? strategy.getDiagnostics() : null };
            await exclusive(replayPath, encode(saved));
          }
          const account = saved.replay.accountSummary, quantity = account.positionQuantity;
          let liquidation = BigInt(account.equityMinor);
          if (quantity > 0 && account.markPriceMinor !== null) {
            const price = money.executionPriceMinor("sell", BigInt(account.markPriceMinor), experiment.COST_COVERED_EXIT_TERMS.slippageBps);
            liquidation = BigInt(account.cashMinor) + price * BigInt(quantity) - money.feeMinorForFill(price, quantity, experiment.COST_COVERED_EXIT_TERMS.feeBps);
          }
          const summary = summarizeHistoricalReplay(saved.replay, saved.observations, saved.exitAudit, window, risk.initialCapitalMinor, liquidation);
          summary.winRateWilson95 = experiment.descriptiveWilson95(summary.wins, summary.completedTradeCount);
          summary.candidateExitDiagnostics = saved.candidateExitDiagnostics;
          summary.exitAudit = saved.exitAudit;
          arms[arm] = summary;
        }
        const mechanism = compareSameEntryTrades(arms.baseline, arms.candidate);
        results.push({ symbol: data.symbol, evaluationRows: data.input.evaluationRows, warmupRows: data.input.warmupRows, ...arms, mechanism });
      }
      const aggregate = Object.fromEntries(["baseline", "candidate", "costMatchedBenchmark"].map((arm) => {
        const combined = aggregateIndependentSummaries(results.map((row) => row[arm]), window);
        combined.winRateWilson95 = experiment.descriptiveWilson95(combined.wins, combined.completedTradeCount);
        return [arm, combined];
      }));
      const differences = {
        candidateMinusBaselineReturnFraction: aggregate.candidate.netReturnAfterModeledCostsFraction - aggregate.baseline.netReturnAfterModeledCostsFraction,
        candidateMinusBenchmarkReturnFraction: aggregate.candidate.netReturnAfterModeledCostsFraction - aggregate.costMatchedBenchmark.netReturnAfterModeledCostsFraction,
        candidateMinusBaselineMaximumDrawdownFraction: aggregate.candidate.maximumDrawdownFraction - aggregate.baseline.maximumDrawdownFraction,
        candidateMinusBaselineCalendarExposureFraction: aggregate.candidate.calendarWeightedExposureFractionOfInitialCapital - aggregate.baseline.calendarWeightedExposureFractionOfInitialCapital,
        candidateMinusBaselineAverageHoldingCalendarDays: aggregate.candidate.averageCompletedHoldingCalendarDays === null || aggregate.baseline.averageCompletedHoldingCalendarDays === null ? null : aggregate.candidate.averageCompletedHoldingCalendarDays - aggregate.baseline.averageCompletedHoldingCalendarDays,
      };
      const sideEffects = {
        ...differences,
        candidateBlockedThenForcedLossCount: results.reduce((sum, row) => sum + row.mechanism.candidateBlockedThenForcedLossCount, 0),
        candidateBlockedThenForcedLossNetPnlMinor: results.reduce((sum, row) => sum + row.mechanism.candidateBlockedThenForcedLossNetPnlMinor, 0n),
        matchedClosedPairsWithWorseNetPnl: results.reduce((sum, row) => sum + row.mechanism.matchedClosedPairsWithWorseNetPnl, 0),
        matchedClosedPairsWithBetterNetPnl: results.reduce((sum, row) => sum + row.mechanism.matchedClosedPairsWithBetterNetPnl, 0),
        matchedPairsWithLongerHolding: results.reduce((sum, row) => sum + row.mechanism.matchedPairsWithLongerHolding, 0),
        symbolsWithWorseReturnThanBaseline: results.filter((row) => row.candidate.netReturnAfterModeledCostsFraction < row.baseline.netReturnAfterModeledCostsFraction).map((row) => row.symbol),
        symbolsWithLargerMaximumDrawdownThanBaseline: results.filter((row) => row.candidate.maximumDrawdownFraction > row.baseline.maximumDrawdownFraction).map((row) => row.symbol),
      };
      const report = {
        schemaVersion: 1, status: "DEVELOPMENT_DIAGNOSTIC_COMPLETE_NOT_PROMOTION", classification: "RETROSPECTIVE_DEVELOPMENT_NOT_UNSEEN_FORWARD",
        hypothesisId: protocol.hypothesisId, planSha256, inputSha256, originalFrozenProtocolCommit: plan.frozenProtocol.commit, originalFreezeTimestamp: freezeTimestamp,
        developmentActivationTimestamp: window.startTimestamp, planRegistrationCommit: added[0], window: input.window, source: { ...plan.csv, fetchedAtUtc: plan.csv.fetchedAtUtc, knownLimitations: plan.limitations },
        dataAvailability: { certifiedUnseenRows: 0, allEvaluationRowsPredateOriginalFreeze: true, allEvaluationRowsAlreadyInInspectedDevelopmentArchive: true },
        calendarCoverage: input.calendarCoverage, results, aggregate, sideEffects,
        uncertainty: { winIntervals: "Two-sided descriptive Wilson 95%; selected-development multiplicity and temporal/cross-symbol dependence invalidate an efficacy interpretation", economicEffectInterval: null, economicEffectIntervalReason: "One already-inspected historical window is not independent effect evidence", openTradeHandling: "Excluded from completed-trade win-rate; included in marked equity/exposure; terminal liquidation is only a separate estimate" },
        disposition: "NO_PROMOTION_OR_PARAMETER_TUNING_FROM_THIS_DEVELOPMENT_CHECK",
      };
      await exclusive(resultPath, encode(report));
      process.stdout.write(encode({ status: report.status, classification: report.classification, resultPath, inputSha256, planSha256, aggregate: compactAggregate(aggregate), sideEffects }));
    }
  }
} catch (error) {
  process.stdout.write(encode({ status: "ERROR", code: "HISTORICAL_DEVELOPMENT_CHECK_FAILED", reason: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (cache) await rm(cache, { recursive: true, force: true });
  if (ownsLock) await rm(lockPath, { recursive: true });
}

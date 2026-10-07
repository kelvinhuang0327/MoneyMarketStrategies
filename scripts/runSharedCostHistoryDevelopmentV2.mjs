import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { aggregateIndependentSummaries, summarizeHistoricalReplay } from "./costCoveredExitHistoryMetrics.mjs";
import { explainSharedCostPairsV2 } from "./sharedCostHistoryPairingV2.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const planPath = "packages/paper-trading/experiments/shared-cost-history-development-v2/plan.json";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, (_key, x) => typeof x === "bigint" ? x.toString() : x, 2)}\n`;
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const compact = aggregate => Object.fromEntries(Object.entries(aggregate).map(([arm, summary]) => [arm,
  Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "equityAndExposureCurve"))]));
async function verifyPins(pins) {
  for (const [path, sha] of Object.entries(pins)) if (digest(await readFile(resolve(root, path))) !== sha) throw new Error(`SOURCE_HASH_MISMATCH: ${path}`);
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
let server;
try {
  if (process.argv.length !== 3 || !["--check-inputs", "--run"].includes(process.argv[2])) throw new Error("Usage: --check-inputs or --run, no overrides");
  const planBytes = await readFile(resolve(root, planPath)), plan = JSON.parse(planBytes), planSha256 = digest(planBytes);
  const added = git("log", "--diff-filter=A", "--format=%H", "--", planPath).split("\n").filter(Boolean);
  if (added.length !== 1 || !execFileSync("git", ["-C", root, "show", `${added[0]}:${planPath}`]).equals(planBytes)) throw new Error("PLAN_MUST_MATCH_FIRST_REGISTRATION_COMMIT");
  await verifyPins(plan.sourceSha256);
  const protocolBytes = await readFile(resolve(root, plan.protocol.path));
  if (digest(protocolBytes) !== plan.protocol.sha256) throw new Error("FROZEN_PROTOCOL_HASH_MISMATCH");
  const protocol = JSON.parse(protocolBytes);
  await verifyPins(protocol.sourceSha256);
  await verifyPins(plan.originalEvidenceSha256);
  const sourceInputBytes = await readFile(resolve(root, plan.originalInput.path));
  if (digest(sourceInputBytes) !== plan.originalInput.sha256) throw new Error("ORIGINAL_INPUT_HASH_MISMATCH");
  const originalInput = JSON.parse(sourceInputBytes), window = originalInput.window;
  if (JSON.stringify(originalInput.datasets.map(d => d.symbol)) !== JSON.stringify(plan.symbols)
    || window.startDate !== plan.window.startDate || window.endDate !== plan.window.endDate
    || window.endTimestamp >= Date.parse(protocol.frozenAtUtc)) throw new Error("FIXED_WINDOW_OR_SYMBOLS_MISMATCH");
  const csvBytes = await readFile(resolve(root, plan.csv.path));
  if (digest(csvBytes) !== plan.csv.sha256 || originalInput.csvSha256 !== plan.csv.sha256) throw new Error("CSV_HASH_MISMATCH");
  // Local cache only; no original output locks, durable sessions, rm/unlink or process inspection.
  const cache = await mkdtemp(join(tmpdir(), "mms-shared-cost-v2-"));
  server = await createServer({ root, configFile: false, cacheDir: cache,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } });
  const history = await server.ssrLoadModule("/packages/paper-trading/src/historicalBaseline.ts");
  const runner = await server.ssrLoadModule("/packages/paper-trading/src/sessionRunner.ts");
  const baselineModule = await server.ssrLoadModule("/packages/paper-trading/src/zscoreStrategy.ts");
  const candidateModule = await server.ssrLoadModule("/packages/paper-trading/src/costCoveredZScoreExitV2.ts");
  const costsModule = await server.ssrLoadModule("/packages/paper-trading/src/paperCostModelV2.ts");
  const money = await server.ssrLoadModule("/packages/paper-trading/src/money.ts");
  const experiment = await server.ssrLoadModule("/packages/paper-trading/src/costCoveredExitExperiment.ts");
  const { CROSS_SYMBOL_RESEARCH_RISK_V1: risk } = await server.ssrLoadModule("/packages/paper-trading/src/crossSymbolResearchRisk.ts");
  if (risk.initialCapitalMinor !== BigInt(protocol.initialCashMinorPerIndependentSymbol)
    || risk.maxExposureMinor !== BigInt(protocol.risk.maxExposureMinor)) throw new Error("FROZEN_RISK_PROFILE_MISMATCH");
  const csv = new TextDecoder("utf-8", { fatal: true }).decode(csvBytes);
  const datasets = plan.symbols.map((symbol, i) => {
    const parsed = history.parseHistoricalCsv(csv, symbol, plan.csv.path, "twse-daily-ohlcv-close-v1");
    const before = parsed.session.events.filter(e => e.timestamp < window.startTimestamp).slice(-plan.warmupRowsPerSymbol);
    const evaluation = parsed.session.events.filter(e => e.timestamp >= window.startTimestamp && e.timestamp <= window.endTimestamp);
    const events = [...before, ...evaluation], previous = originalInput.datasets[i];
    if (before.length !== 39 || evaluation.length !== 145 || encode(events) !== encode(previous.events.map(e => ({ ...e, priceMinor: BigInt(e.priceMinor) })))) throw new Error(`EXACT_184_INPUT_ROWS_DIFFER_FOR_${symbol}`);
    const model = protocol.costModelsBySymbol[symbol];
    const costModel = costsModule.freezePaperCostModelV2({ ...model,
      minimumCommissionMinor: BigInt(model.minimumCommissionMinor), roundingIncrementMinor: BigInt(model.roundingIncrementMinor) });
    const terms = Object.freeze({ label: "SYNTHETIC_ONLY", feeBps: 0, slippageBps: protocol.slippageBps, costModel });
    return { symbol, previous, terms, session: { ...parsed.session, events,
      simulation: { ...parsed.session.simulation, initialCashMinor: BigInt(protocol.initialCashMinorPerIndependentSymbol),
        risk: { ...protocol.risk, maxExposureMinor: BigInt(protocol.risk.maxExposureMinor) }, terms } } };
  });
  const studyInput = { classification: plan.classification, planSha256, protocolSha256: plan.protocol.sha256,
    originalInputSha256: plan.originalInput.sha256, csvSha256: plan.csv.sha256, window,
    datasets: originalInput.datasets, developmentActivationTimestamp: window.startTimestamp,
    activationReason: plan.developmentActivationReason, calendarCoverage: originalInput.calendarCoverage };
  const studyInputBytes = encode(studyInput), inputSha256 = digest(studyInputBytes);
  const output = resolve(root, plan.outputDirectory), resultPath = join(output, `${inputSha256}.result.json`);
  const check = { status: "FIXED_V2_INPUTS_VERIFIED_NO_REPLAY", inputSha256, planSha256, protocolSha256: plan.protocol.sha256,
    sourceInputSha256: plan.originalInput.sha256, csvSha256: plan.csv.sha256, symbols: plan.symbols,
    warmupRowsPerSymbol: 39, evaluationRowsPerSymbol: 145, totalReplayMarketEvents: 2208,
    classification: plan.classification, resultPath };
  if (process.argv[2] === "--check-inputs") {
    process.stdout.write(encode(check));
  } else {
    await mkdir(output, { recursive: true });
    let existing = null;
    try { existing = await readJson(resultPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (existing) {
      if (existing.planSha256 !== planSha256 || existing.inputSha256 !== inputSha256) throw new Error("RESULT_IDENTITY_MISMATCH");
      await verifyPins(existing.rawReplaySha256);
      process.stdout.write(encode({ status: "REUSED_EXISTING_V2_RESULT_NO_REPLAY", resultPath, aggregate: compact(existing.aggregate) }));
    } else {
      // Append-only attempt evidence, exclusively created and retained; never an old lock or a lock cleanup.
      await writeFile(join(output, "attempt.json"), encode({ classification: plan.classification, planSha256, inputSha256,
        startedAtUtc: new Date().toISOString(), head: git("rev-parse", "HEAD"), maximumReplays: 12 }), { flag: "wx", mode: 0o600 });
      await writeFile(join(output, `${planSha256}.plan.json`), planBytes, { flag: "wx", mode: 0o600 });
      await writeFile(join(output, `${inputSha256}.input.json`), studyInputBytes, { flag: "wx", mode: 0o600 });
      const results = [], rawReplaySha256 = {}, started = performance.now();
      for (const data of datasets) {
        const arms = {}, rawObservations = {};
        for (const arm of ["baseline", "candidate", "costMatchedBenchmark"]) {
          // Explicit registered retrospective activation only; frozen forward protocol remains untouched.
          const config = { ...protocol.strategyConfig, activeFromTimestamp: window.startTimestamp };
          const strategy = arm === "baseline" ? new baselineModule.RollingZScoreMeanReversionV1Strategy(config)
            : arm === "candidate" ? new candidateModule.CostCoveredZScoreExitV2Strategy(config)
              : { strategyVersion: "fixed-quantity-hold-first-eligible-shared-cost-v2", decide: input => input.current.timestamp >= window.startTimestamp ? protocol.targetQuantity : 0 };
          const observations = [], exitAudit = [];
          const wrapped = { strategyVersion: strategy.strategyVersion, strategyParameters: strategy.strategyParameters ?? {}, decide(input) {
            const before = arm === "candidate" ? strategy.getDiagnostics() : null;
            const target = strategy.decide(input);
            if (input.current.timestamp >= window.startTimestamp) {
              observations.push({ sourceEventId: input.current.eventId, timestamp: input.current.timestamp,
                priceMinor: input.current.priceMinor, positionQuantity: input.positionQuantity, positionCostBasisMinor: input.positionCostBasisMinor });
              if (before) {
                const after = strategy.getDiagnostics();
                const kind = after.forcedExits > before.forcedExits ? "FORCED_EXIT" : after.costCovered > before.costCovered ? "COST_COVERED_EXIT"
                  : after.belowCost > before.belowCost ? "BELOW_COST_BLOCK" : after.unknownCost > before.unknownCost ? "UNKNOWN_COST_BLOCK" : null;
                if (kind) {
                  const price = money.executionPriceMinor("sell", input.current.priceMinor, data.terms.slippageBps);
                  const fees = costsModule.paperFillCostsV2("sell", price, input.positionQuantity, data.terms.costModel);
                  exitAudit.push({ kind, sourceEventId: input.current.eventId, timestamp: input.current.timestamp,
                    targetQuantity: target, positionQuantity: input.positionQuantity, actualEntryCostBasisMinor: input.positionCostBasisMinor ?? null,
                    estimatedNetSaleMinor: fees.notionalMinor - fees.totalFeeMinor, estimatedCommissionMinor: fees.commissionMinor, estimatedSellTaxMinor: fees.sellTaxMinor });
                }
              }
            }
            return target;
          } };
          // Programmatic runPaperSession calls the isolated PaperTradingEngine directly.
          // Does not call parsePaperSession, CLI runSessionFile, durable or gateway entrypoints.
          const replay = runner.runPaperSession(data.session, inputSha256, undefined, wrapped, risk, { captureEquityCurve: true });
          if (replay.eventProcessingResults.length !== 184 || replay.eventProcessingResults.some(r => r.status !== "accepted")) throw new Error("EVENT_PROCESSING_GAP");
          if (!replay.accountReconciliation.fillFeesMatch || !replay.accountReconciliation.positionsMatch
            || !replay.accountReconciliation.realizedPnlMatches || !replay.accountReconciliation.equityMatches) throw new Error("ACCOUNT_RECONCILIATION_FAILURE");
          for (const fill of replay.journal.filter(e => e.kind === "fill")) {
            const fee = costsModule.paperFillCostsV2(fill.side, fill.executionPriceMinor, fill.quantity, data.terms.costModel);
            if (fee.totalFeeMinor !== fill.feeMinor || fill.quantity !== 3) throw new Error("FULL_FILL_COST_RECONCILIATION_FAILURE");
          }
          const saved = { replay, observations, exitAudit, candidateExitDiagnostics: arm === "candidate" ? strategy.getDiagnostics() : null };
          const path = join(output, `${inputSha256}.${data.symbol}.${arm}.replay.json`), bytes = encode(saved);
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); rawReplaySha256[path.slice(root.length)] = digest(bytes);
          const account = replay.accountSummary, quantity = account.positionQuantity;
          let liquidation = account.equityMinor;
          if (quantity > 0 && account.markPriceMinor !== null) {
            const price = money.executionPriceMinor("sell", account.markPriceMinor, data.terms.slippageBps);
            const fee = costsModule.paperFillCostsV2("sell", price, quantity, data.terms.costModel);
            liquidation = account.cashMinor + fee.notionalMinor - fee.totalFeeMinor;
          }
          const summary = summarizeHistoricalReplay(replay, observations, exitAudit, window, risk.initialCapitalMinor, liquidation);
          summary.winRateWilson95 = experiment.descriptiveWilson95(summary.wins, summary.completedTradeCount);
          summary.candidateExitDiagnostics = saved.candidateExitDiagnostics; summary.exitAudit = exitAudit;
          summary.perFillCostComponents = replay.journal.filter(e => e.kind === "fill").map(fill => ({
            fillId: fill.fillId, side: fill.side, quantity: fill.quantity,
            ...costsModule.paperFillCostsV2(fill.side, fill.executionPriceMinor, fill.quantity, data.terms.costModel) }));
          arms[arm] = summary; rawObservations[arm] = observations;
        }
        results.push({ symbol: data.symbol, warmupRows: 39, evaluationRows: 145, ...arms,
          mechanism: explainSharedCostPairsV2(arms.baseline, arms.candidate, rawObservations.candidate) });
      }
      const aggregate = Object.fromEntries(["baseline", "candidate", "costMatchedBenchmark"].map(arm => {
        const combined = aggregateIndependentSummaries(results.map(r => r[arm]), window);
        combined.winRateWilson95 = experiment.descriptiveWilson95(combined.wins, combined.completedTradeCount); return [arm, combined];
      }));
      const sideEffects = { candidateMinusBaselineReturnFraction: aggregate.candidate.netReturnAfterModeledCostsFraction - aggregate.baseline.netReturnAfterModeledCostsFraction,
        candidateMinusBenchmarkReturnFraction: aggregate.candidate.netReturnAfterModeledCostsFraction - aggregate.costMatchedBenchmark.netReturnAfterModeledCostsFraction,
        candidateMinusBaselineDrawdownFraction: aggregate.candidate.maximumDrawdownFraction - aggregate.baseline.maximumDrawdownFraction,
        candidateBlockedThenForcedLossCount: results.reduce((n, r) => n + r.mechanism.candidateBlockedThenForcedLossCount, 0),
        candidateBlockedThenForcedLossNetPnlMinor: results.reduce((n, r) => n + r.mechanism.candidateBlockedThenForcedLossNetPnlMinor, 0n),
        exactClosedEntryPairCount: results.reduce((n, r) => n + r.mechanism.matchedBothClosed, 0),
        candidateBelowCostSignalCount: results.reduce((n, r) => n + r.candidate.candidateExitDiagnostics.belowCost, 0),
        candidateForcedExitCount: results.reduce((n, r) => n + r.candidate.candidateExitDiagnostics.forcedExits, 0) };
      await verifyPins(plan.originalEvidenceSha256);
      const report = { schemaVersion: 2, status: "FIXED_V2_DEVELOPMENT_COMPARISON_COMPLETE_NOT_PROMOTION", classification: plan.classification,
        planSha256, inputSha256, originalInputSha256: plan.originalInput.sha256, protocolSha256: plan.protocol.sha256,
        planRegistrationCommit: added[0], frozenSourceCommit: protocol.implementationCommit,
        source: plan.csv, window, developmentActivationTimestamp: window.startTimestamp,
        activationReason: plan.developmentActivationReason, originalForwardFreezeTimestamp: protocol.strategyConfig.activeFromTimestamp,
        calendarCoverage: originalInput.calendarCoverage, results, aggregate, sideEffects, rawReplaySha256,
        resources: { historicalReplayCount: 12, totalMarketEvents: 2208, serial: true, measuredReplayWallSeconds: (performance.now() - started) / 1000,
          fullBuild: false, fullSuite: false, gridSearch: false, newDataFetch: false, durableOrGatewayEntry: false, oldLockAccess: false },
        checks: { original12RawEvidenceHashesUnchanged: true, frozenSourceHashesVerified: true, exactOriginal736RowsVerified: true,
          twelveAccountsReconciled: true, actualCommissionAndTaxReconciledPerFill: true },
        limitations: plan.limitations, certifiedUnseenForwardRows: 0, disposition: plan.disposition };
      await writeFile(resultPath, encode(report), { flag: "wx", mode: 0o600 });
      process.stdout.write(encode({ status: report.status, classification: report.classification, inputSha256, resultPath,
        aggregate: compact(aggregate), sideEffects, resources: report.resources }));
    }
  }
} catch (error) {
  process.stdout.write(encode({ status: "ERROR", code: "SHARED_COST_HISTORY_V2_CHECK_FAILED", reason: error.message ?? String(error) }));
  process.exitCode = 1;
} finally {
  if (server) await server.close();
}

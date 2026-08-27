#!/usr/bin/env node
// Frozen, network-free, stdout-only MI_QFIIS multi-symbol OOS study.
// This runner intentionally writes no result artifact and performs no promotion,
// allocation, symbol selection, sizing, order execution, or investment advice.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CANONICAL_TRANSACTION_COST_BPS,
  canonicalStringify,
  hashValue,
  parseTwStrategyResearchCsvText,
  parseTwseMiQfiisCsvText,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
  TWSE_MI_QFIIS_STRICT_PIT_RULE,
  validateTwStrategyResearchRows,
} from "@mms/research-kernel";
import {
  evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate,
  MI_QFIIS_GENERALIZATION_OOS_SYMBOLS,
  MI_QFIIS_GENERALIZATION_POOLED_METRICS_ROLE,
  runPerSymbolMiQfiisForeignOwnershipLogisticChallengerTemporal,
  toMultiSymbolMiQfiisSymbolVerdict,
} from "@mms/strategy-simulator";

const OHLCV_PATH =
  "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System/outputs/retraining/p194_twstock_ohlcv_export.csv";
const OHLCV_SHA256 = "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7";
const MI_QFIIS_PATH = path.resolve(
  "outputs/retraining/p199_0050_2317_2330_2454_twse_mi_qfiis_foreign_ownership.csv",
);
const MI_QFIIS_SHA256 = "fa827bd325df16ee6eeda0c5b94b01663a595bbc2812fd4c89f84ef3b4892693";
const MI_QFIIS_MANIFEST_PATH = path.resolve(
  "outputs/retraining/p199_0050_2317_2330_2454_twse_mi_qfiis_foreign_ownership.manifest.json",
);
const MI_QFIIS_MANIFEST_SHA256 = "f6c885ef708cfa1360a27c2a44382459a3da96454d4e3dbce0da198885b21685";
const DATA_END_DATE = "2026-08-11";
const REVIEW_DATE = "2026-08-27";
const INITIAL_CAPITAL = 1_000_000;
const OOS_SYMBOLS = Object.freeze([...MI_QFIIS_GENERALIZATION_OOS_SYMBOLS]);
const SCOPE_CAVEAT =
  "This is fixed-panel diagnostic historical research only. The four OOS symbols are not claimed to be statistically independent or representative of the full Taiwan equity universe. No promotion or investment advice is authorized.";

function fail(token, detail) {
  throw new Error(`${token}:${detail}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPinnedBytes(filePath, expectedSha256, mismatchToken) {
  const bytes = readFileSync(filePath);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    fail(mismatchToken, `expected=${expectedSha256}:actual=${actualSha256}:path=${filePath}`);
  }
  return bytes;
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function requireExactSymbolSet(actualSymbols, context) {
  const actual = sortedUnique(actualSymbols);
  const expected = [...OOS_SYMBOLS].sort();
  if (!sameOrderedValues(actual, expected)) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", `${context}:expected=${expected.join(",")}:actual=${actual.join(",")}`);
  }
}

function parseAndValidateManifest(bytes, recordCount) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", "p199 manifest is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", "p199 manifest root is not an object");
  }
  if (!sameOrderedValues(manifest.symbols ?? [], OOS_SYMBOLS)) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", "p199 manifest symbols differ from the frozen OOS panel");
  }
  if (
    manifest.csvSha256 !== MI_QFIIS_SHA256
    || manifest.totalRowCount !== recordCount
    || manifest.overallQualification !== "PASS"
    || manifest.qualificationClassification
      !== "MMS_MULTI_SYMBOL_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED"
    || manifest.pitRule !== TWSE_MI_QFIIS_STRICT_PIT_RULE
    || manifest.strictPitRule !== TWSE_MI_QFIIS_STRICT_PIT_RULE
    || manifest.sameDayEligibility !== false
    || manifest.exactHistoricalPublicationMinuteUsed !== false
    || manifest.dataQualityMetrics?.chronologicalOrdering !== "PASS"
  ) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", "p199 manifest qualification or PIT contract failed");
  }
  if (!Array.isArray(manifest.perSymbolQualifications)) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", "p199 per-symbol qualifications are missing");
  }
  requireExactSymbolSet(
    manifest.perSymbolQualifications.map((qualification) => qualification.symbol),
    "p199 manifest per-symbol qualifications",
  );
  for (const symbol of OOS_SYMBOLS) {
    const qualification = manifest.perSymbolQualifications.find((candidate) => candidate.symbol === symbol);
    if (
      qualification?.qualificationClassification !== "MMS_SYMBOL_TWSE_MI_QFIIS_SOURCE_QUALIFIED"
      || qualification.pitRule !== TWSE_MI_QFIIS_STRICT_PIT_RULE
      || !Array.isArray(qualification.cutoffCoverage)
      || qualification.cutoffCoverage.length !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES.length
      || qualification.cutoffCoverage.some((coverage, index) =>
        coverage.cutoff !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES[index]
        || coverage.priorEligibleObservationCount < 21)
    ) {
      fail("STOP_SOURCE_COVERAGE_MISMATCH", `${symbol}: p199 qualification is incomplete`);
    }
  }
  return manifest;
}

function assertCutoffInvariants(result) {
  if (
    result.cutoffRuns.length !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES.length
    || result.cutoffRuns.some((run, index) => run.cutoff !== SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES[index])
  ) {
    fail("STOP_TEMPORAL_SPLIT_DRIFT", `${result.symbol}: canonical cutoff set changed`);
  }
  if (result.controlReproduction.status !== "NOT_APPLICABLE") {
    fail("STOP_CONTROL_REPRODUCTION_FAILURE", `${result.symbol}: 0056 control was applied to OOS`);
  }
  if (
    result.nextRoute !== "MULTI_SYMBOL_GENERALIZATION_GATE_ONLY"
    || result.promotionDecision !== "do_not_promote"
    || result.guardrails.supportsAutomaticPromotion !== false
    || result.guardrails.supportsSymbolSelection !== false
  ) {
    fail("STOP_FROZEN_GATE_CHANGE_REQUIRED", `${result.symbol}: diagnostic guardrail drifted`);
  }

  for (const run of result.cutoffRuns) {
    if (
      run.symbol !== result.symbol
      || run.miQfiisContext.targetSymbol !== result.symbol
      || run.miQfiisContext.strictPitRule !== TWSE_MI_QFIIS_STRICT_PIT_RULE
      || run.miQfiisContext.miQfiisDataAsOf > run.asOf
      || run.challenger.finalTestEconomicEvidence.rows.some((row) => row.targetDate > run.asOf)
    ) {
      fail("STOP_PIT_LEAK", `${result.symbol}:${run.cutoff}`);
    }
    if (
      run.controlMetrics.trainingRows !== run.challengerMetrics.trainingRows
      || run.controlMetrics.validationRows !== run.challengerMetrics.validationRows
      || run.controlMetrics.finalTestRows !== run.challengerMetrics.finalTestRows
      || run.control.trainEndDate !== run.challenger.trainEndDate
      || run.control.validationStartDate !== run.challenger.validationStartDate
      || run.control.validationEndDate !== run.challenger.validationEndDate
      || run.control.finalTestStartDate !== run.challenger.finalTestStartDate
    ) {
      fail("STOP_CONTROL_CHALLENGER_POPULATION_DRIFT", `${result.symbol}:${run.cutoff}`);
    }
    if (
      run.control.fit.fitPartition !== "TRAINING"
      || run.challenger.fit.fitPartition !== "TRAINING"
      || run.control.thresholdSelection.selectionPartition !== "VALIDATION"
      || run.challenger.thresholdSelection.selectionPartition !== "VALIDATION"
      || run.control.finalTest.evaluationPartition !== "FINAL_TEST"
      || run.challenger.finalTest.evaluationPartition !== "FINAL_TEST"
      || run.control.finalTest.evaluatorExecutionCount !== 1
      || run.challenger.finalTest.evaluatorExecutionCount !== 1
    ) {
      fail("STOP_TEMPORAL_SPLIT_DRIFT", `${result.symbol}:${run.cutoff}: fitted-state partition drift`);
    }
    if (
      run.controlEconomic.transactionCostBps !== CANONICAL_TRANSACTION_COST_BPS
      || run.challengerEconomic.transactionCostBps !== CANONICAL_TRANSACTION_COST_BPS
      || run.controlEconomic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH"
      || run.challengerEconomic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH"
      || run.controlEconomic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK"
      || run.challengerEconomic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK"
    ) {
      fail("STOP_TEMPORAL_SPLIT_DRIFT", `${result.symbol}:${run.cutoff}: economic policy drift`);
    }
  }
}

function round8(value) {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function mean(values) {
  return round8(values.reduce((sum, value) => sum + value, 0) / values.length);
}

if (!sameOrderedValues(OOS_SYMBOLS, TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS)) {
  fail("STOP_SOURCE_COVERAGE_MISMATCH", "research-kernel and gate OOS symbol constants differ");
}

const ohlcvBytes = readPinnedBytes(OHLCV_PATH, OHLCV_SHA256, "STOP_P194_HASH_MISMATCH");
const miQfiisBytes = readPinnedBytes(MI_QFIIS_PATH, MI_QFIIS_SHA256, "STOP_P199_HASH_MISMATCH");
const manifestBytes = readPinnedBytes(
  MI_QFIIS_MANIFEST_PATH,
  MI_QFIIS_MANIFEST_SHA256,
  "STOP_P199_HASH_MISMATCH",
);

const validatedOhlcv = validateTwStrategyResearchRows(
  parseTwStrategyResearchCsvText(ohlcvBytes.toString("utf8")),
  { dataEndDate: DATA_END_DATE, requiredSymbols: OOS_SYMBOLS },
);
const miQfiisRecords = parseTwseMiQfiisCsvText(miQfiisBytes.toString("utf8"), {
  allowedSymbols: OOS_SYMBOLS,
});
requireExactSymbolSet(miQfiisRecords.map((record) => record.symbol), "p199 parsed records");
const manifest = parseAndValidateManifest(manifestBytes, miQfiisRecords.length);

const fitContainers = [];
const thresholdContainers = [];
const symbolSummaries = [];
const symbolVerdicts = {};
for (const symbol of OOS_SYMBOLS) {
  const rawRows = Object.freeze(validatedOhlcv.rows.filter((row) => row.symbol === symbol));
  const symbolMiQfiisRecords = Object.freeze(miQfiisRecords.filter((record) => record.symbol === symbol));
  if (rawRows.length === 0 || symbolMiQfiisRecords.length === 0) {
    fail("STOP_SOURCE_COVERAGE_MISMATCH", `${symbol}: missing OHLCV or MI_QFIIS records`);
  }
  if (symbolMiQfiisRecords.some((record) => record.symbol !== symbol)) {
    fail("STOP_MIXED_SYMBOL_INPUT", symbol);
  }

  const result = runPerSymbolMiQfiisForeignOwnershipLogisticChallengerTemporal({
    targetSymbol: symbol,
    rawRows,
    miQfiisRecords: symbolMiQfiisRecords,
    cutoffDates: SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    source: {
      ohlcvPath: OHLCV_PATH,
      ohlcvSha256: OHLCV_SHA256,
      miQfiisPath: MI_QFIIS_PATH,
      miQfiisSha256: MI_QFIIS_SHA256,
    },
    datasetVersion: {
      datasetId: "p199_0050_2317_2330_2454_twse_mi_qfiis_foreign_ownership",
      version: "FROZEN_OOS_V1",
      source: "TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT",
    },
    reviewDate: REVIEW_DATE,
    candidateDataQualityBasis: "SOURCE_QUALIFIED_TWSE_MI_QFIIS_AND_OHLCV",
    roundTripCostBps: CANONICAL_TRANSACTION_COST_BPS,
    initialCapital: INITIAL_CAPITAL,
  });
  assertCutoffInvariants(result);

  for (const run of result.cutoffRuns) {
    fitContainers.push(run.control.fit, run.challenger.fit);
    thresholdContainers.push(run.control.thresholdSelection, run.challenger.thresholdSelection);
  }
  const symbolVerdict = toMultiSymbolMiQfiisSymbolVerdict(result.decision);
  symbolVerdicts[symbol] = symbolVerdict;
  symbolSummaries.push(Object.freeze({
    symbol,
    stratum: symbol === "0050" ? "MANDATORY_ETF_REPLICATION_GUARD" : "EQUITY_REPLICATION_STRATUM",
    directionalWinsOutOf4: result.comparisonSummaryVsControl.directionalWins,
    calibrationWinsOutOf4: result.comparisonSummaryVsControl.calibrationWins,
    economicWinsOutOf4: result.comparisonSummaryVsControl.economicWins,
    symbolVerdict,
    normalizedSymbolResultSha256: result.normalizedResultSha256,
    cutoffRuns: Object.freeze(result.cutoffRuns.map((run) => Object.freeze({
      cutoff: run.cutoff,
      asOf: run.asOf,
      accuracyDeltaVsControl: run.deltasVsControl.accuracyDelta,
      balancedAccuracyDeltaVsControl: run.deltasVsControl.balancedAccuracyDelta,
      logLossDeltaVsControl: run.deltasVsControl.logLossDelta,
      brierDeltaVsControl: run.deltasVsControl.brierDelta,
      excessReturnDeltaVsControl: run.deltasVsControl.excessReturnDelta,
      maxDrawdownDeltaVsControl: run.deltasVsControl.maxDrawdownDelta,
      normalizedCutoffResultSha256: run.normalizedResultSha256,
    }))),
  }));
}

if (
  new Set(fitContainers).size !== fitContainers.length
  || new Set(thresholdContainers).size !== thresholdContainers.length
) {
  fail("STOP_TEMPORAL_SPLIT_DRIFT", "fitted state or threshold container was reused");
}

const gate = evaluateMultiSymbolMiQfiisForeignOwnershipGeneralizationGate({ symbolVerdicts });
const cutoffDeltas = symbolSummaries.flatMap((summary) => summary.cutoffRuns);
const pooledDiagnosticMetrics = Object.freeze({
  role: MI_QFIIS_GENERALIZATION_POOLED_METRICS_ROLE,
  cutoffObservationCount: cutoffDeltas.length,
  meanAccuracyDeltaVsControl: mean(cutoffDeltas.map((run) => run.accuracyDeltaVsControl)),
  meanBalancedAccuracyDeltaVsControl: mean(
    cutoffDeltas.map((run) => run.balancedAccuracyDeltaVsControl),
  ),
  meanLogLossDeltaVsControl: mean(cutoffDeltas.map((run) => run.logLossDeltaVsControl)),
  meanBrierDeltaVsControl: mean(cutoffDeltas.map((run) => run.brierDeltaVsControl)),
  meanExcessReturnDeltaVsControl: mean(cutoffDeltas.map((run) => run.excessReturnDeltaVsControl)),
  meanMaxDrawdownDeltaVsControl: mean(cutoffDeltas.map((run) => run.maxDrawdownDeltaVsControl)),
});

const normalized = Object.freeze({
  schemaVersion: "MMS_MI_QFIIS_MULTI_SYMBOL_GENERALIZATION_RESULT_V1",
  dataClassification: "HISTORICAL_RESEARCH_STUDY",
  reviewDate: REVIEW_DATE,
  fixedPanel: Object.freeze({
    etfReplicationGuard: "0050",
    equityReplicationStratum: Object.freeze(["2317", "2330", "2454"]),
    symbolsClaimedStatisticallyIndependent: false,
    representativeOfFullTaiwanEquityUniverse: false,
  }),
  requestedCutoffDates: Object.freeze([...SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES]),
  source: Object.freeze({
    ohlcvPath: OHLCV_PATH,
    ohlcvSha256: OHLCV_SHA256,
    miQfiisPath: MI_QFIIS_PATH,
    miQfiisSha256: MI_QFIIS_SHA256,
    miQfiisManifestPath: MI_QFIIS_MANIFEST_PATH,
    miQfiisManifestSha256: MI_QFIIS_MANIFEST_SHA256,
    miQfiisManifestQualification: manifest.qualificationClassification,
  }),
  symbolSummaries: Object.freeze(symbolSummaries),
  pooledDiagnosticMetrics,
  gate,
  aggregateLabel: gate.aggregateLabel,
  invariants: Object.freeze({
    pit: "PASS",
    populationEquivalence: "PASS",
    splitEquivalence: "PASS",
    fittedStateIsolation: "PASS",
    canonicalTransactionCostBps: CANONICAL_TRANSACTION_COST_BPS,
    resultArtifactWritten: false,
  }),
  guardrails: Object.freeze({
    providesInvestmentAdvice: false,
    supportsPromotion: false,
    supportsAllocation: false,
    supportsSymbolSelection: false,
    supportsKellySizing: false,
    supportsOrderExecution: false,
  }),
  scopeCaveat: SCOPE_CAVEAT,
});

const output = Object.freeze({
  ...normalized,
  normalizedResultSha256: hashValue(normalized),
});
process.stdout.write(`${canonicalStringify(output)}\n`);

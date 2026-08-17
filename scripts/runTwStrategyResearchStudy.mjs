#!/usr/bin/env node
// Thin CLI: owns every Node-specific concern (reading the pinned git blob,
// verifying its SHA-256 pin, hashing fixture payload text) and composes
// @mms/research-kernel's pure TW strategy research runner primitives with
// @mms/strategy-simulator's walk-forward/threshold evaluation and stability
// gate to produce the three required scenarios (2330_RAW_CONTROL, 0050_RAW,
// 0050_SOURCE_QUALIFIED_ADJUSTED) as deterministic JSON and Markdown, plus a
// fail-closed MMS_PREDICTION_RETRAINING_RESULT_V1 artifact for the same run.
// Diagnostic-only: no investment advice, no promotion, no execution, no network
// access, no writes to the legacy repository.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPredictionRetrainingResultV1 } from "@mms/contracts";
import {
  ADJUSTMENT_COVERAGE,
  applyBoundedAdjustment,
  buildScenarioFoldInputs,
  buildTwseQualificationSnapshotFromFixture,
  buildHistoricalFeatureRows,
  CANDIDATE_THRESHOLDS,
  CURRENT_DATE_PREDICTION_CLAIM,
  FEATURE_LOOKBACK_ROWS,
  fitModelOnFeatureRows,
  INITIAL_CAPITAL,
  LEGACY_TECHNICAL_FEATURE_FAMILY,
  LEGACY_ML_RETRAINING_STATUS,
  parseCommittedQualificationObservationsFromText,
  parseTwStrategyResearchCsvText,
  PROMOTION_DECISION,
  PROMOTION_REASON,
  qualifyTwseSnapshot,
  ROUND_TRIP_COST_BPS,
  runResearchEvidenceKernel,
  runTwStrategyTemporalRobustnessStudy,
  runTwStrategyTransactionCostSensitivityStudy,
  toMarketRows,
  TARGET_HORIZON_ROWS,
  TWSE_QUALIFICATION_FIXTURE_PAYLOADS,
  validateCutoffDates,
  validateRoundTripCostBpsGrid,
  SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
  validateTwStrategyResearchRows,
  VOLUME_ADJUSTMENT_STATUS,
} from "@mms/research-kernel";
import {
  analyzeThresholdParetoFrontier,
  analyzeThresholdParetoStability,
  buildFinalTestPerSymbolEconomicEdge,
  buildPerSymbolLogisticChallengerEvaluation,
  buildPerSymbolLogisticFeatureChallengerEvaluation,
  evaluateWalkForwardStabilityGate,
  runPerSymbolLogisticChallengerTemporalConfirmation,
  runPerSymbolLogisticClassBalancedChallengerTemporal,
  runPerSymbolGaussianNaiveBayesChallengerTemporal,
  runPerSymbolReturnHurdleLogisticChallengerTemporal,
  runThresholdParameterSensitivity,
  runWalkForwardThresholdEvaluation,
  reconcileFinalTestEconomicEdge,
  summarizeLongCashReplay,
  summarizeWalkForwardStability,
  TW_STABILITY_RESEARCH_POLICY_V1,
  validateLongCashReplay,
} from "@mms/strategy-simulator";

const DEFAULTS = Object.freeze({
  legacyRepo: "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System",
  ref: "WORKTREE",
  csvPath: "outputs/retraining/p194_twstock_ohlcv_export.csv",
  refitReportPath: "outputs/retraining/p193_real_ohlcv_refit_report.json",
  expectedSha256: "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7",
  dataEndDate: "2026-08-11",
  reviewDate: "2026-08-12",
  qualificationAsOf: "2025-06-18T10:00:00.000Z",
  outDir: "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1",
  cutoffs: null,
  roundTripCostBps: null,
  challengerTemporal: false,
  balancedLogisticChallenger: false,
  gnbChallenger: false,
  returnHurdleLogisticChallenger: false,
});

const SUPPORTED_SYMBOLS = Object.freeze(["0050", "0056", "2317", "2330", "2454"]);

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  let customOutDir = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    if (key === "challenger-temporal") {
      args.challengerTemporal = true;
      continue;
    }
    if (key === "balanced-logistic-challenger") {
      args.balancedLogisticChallenger = true;
      continue;
    }
    if (key === "gaussian-naive-bayes-challenger" || key === "gnb-challenger") {
      args.gnbChallenger = true;
      continue;
    }
    if (
      key === "return-hurdle-logistic-challenger"
      || key === "return-hurdle-challenger"
      || key === "hurdle-challenger"
    ) {
      args.returnHurdleLogisticChallenger = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (key === "legacy-repo") args.legacyRepo = value;
    else if (key === "ref") args.ref = value;
    else if (key === "csv-path") args.csvPath = value;
    else if (key === "refit-report-path") args.refitReportPath = value;
    else if (key === "expected-sha256") args.expectedSha256 = value;
    else if (key === "data-end-date") args.dataEndDate = value;
    else if (key === "review-date") args.reviewDate = value;
    else if (key === "out-dir") {
      args.outDir = value;
      customOutDir = true;
    } else if (key === "cutoffs") {
      args.cutoffs = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (key === "round-trip-cost-bps") {
      args.roundTripCostBps = value.split(",").map((s) => Number(s.trim()));
    } else throw new Error(`unrecognized flag --${key}`);
    index += 1;
  }

  if (args.roundTripCostBps && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-cost-sensitivity-v1/sensitivity-run1";
  } else if (args.cutoffs && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-temporal-robustness-v1";
  } else if (args.returnHurdleLogisticChallenger && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1/return-hurdle-logistic-v1";
  } else if (args.gnbChallenger && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1/gnb-challenger-v1";
  } else if (args.balancedLogisticChallenger && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1/balanced-logistic-challenger-v1";
  } else if (args.challengerTemporal && !customOutDir) {
    args.outDir = "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1/temporal-challenger-v1";
  }

  return args;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads the canonical refreshed worktree or a pinned git blob without checkout, network, or writes. */
function readPinnedGitBlob(repoPath, ref, relativePath) {
  if (ref === "WORKTREE") return readFileSync(path.resolve(repoPath, relativePath));
  return execFileSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function round8(value) {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DAY_MILLISECONDS = 86_400_000;

function deriveFutureTradingDate(featureDate, horizonRows) {
  const cursor = new Date(`${featureDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime())) {
    throw new Error(`STOP_MMS_CURRENT_PREDICTION_INVALID_FEATURE_DATE:${featureDate}`);
  }
  let remaining = horizonRows;
  while (remaining > 0) {
    cursor.setTime(cursor.getTime() + DAY_MILLISECONDS);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return cursor.toISOString().slice(0, 10);
}

function buildCurrentFeatureVector(rows, index) {
  if (index < FEATURE_LOOKBACK_ROWS || index >= rows.length) {
    throw new Error(`STOP_MMS_CURRENT_PREDICTION_INSUFFICIENT_LOOKBACK:${index}`);
  }
  const current = rows[index];
  if (current === undefined) throw new Error("STOP_MMS_CURRENT_PREDICTION_MISSING_CURRENT_ROW");

  const returns10 = [];
  for (let offset = index - 9; offset <= index; offset += 1) {
    const row = rows[offset];
    const previous = rows[offset - 1];
    if (row === undefined || previous === undefined) {
      throw new Error("STOP_MMS_CURRENT_PREDICTION_INCOMPLETE_RETURN_WINDOW");
    }
    returns10.push(row.close / previous.close - 1);
  }
  const averageReturn = returns10.reduce((sum, value) => sum + value, 0) / returns10.length;
  const variance = returns10.reduce((sum, value) => sum + (value - averageReturn) ** 2, 0) / returns10.length;
  const historicalVolumes = rows
    .slice(index - FEATURE_LOOKBACK_ROWS, index)
    .map((row) => row.volume);
  const averageVolume20 = historicalVolumes.reduce((sum, value) => sum + value, 0) / historicalVolumes.length;
  if (averageVolume20 <= 0) {
    throw new Error(`STOP_MMS_CURRENT_PREDICTION_ZERO_VOLUME_MEAN:${current.symbol}:${current.date}`);
  }

  const historicalCloses20 = rows
    .slice(index - FEATURE_LOOKBACK_ROWS + 1, index + 1)
    .map((row) => row.close);
  const firstHistoricalClose = historicalCloses20[0];
  if (firstHistoricalClose === undefined) {
    throw new Error("STOP_MMS_CURRENT_PREDICTION_INCOMPLETE_DRAWDOWN_WINDOW");
  }
  let peak = firstHistoricalClose;
  let maximumDrawdown = 0;
  for (const close of historicalCloses20.slice(1)) {
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = (close - peak) / peak;
      if (drawdown < maximumDrawdown) maximumDrawdown = drawdown;
    }
  }

  const row5 = rows[index - 5];
  const row20 = rows[index - 20];
  if (row5 === undefined || row20 === undefined) {
    throw new Error("STOP_MMS_CURRENT_PREDICTION_INCOMPLETE_PRICE_WINDOW");
  }
  return [
    current.close / row5.close - 1,
    current.close / row20.close - 1,
    Math.sqrt(variance),
    current.volume / averageVolume20,
    maximumDrawdown,
  ];
}

function predictCurrentProbability(features, fitted) {
  const standardized = features.map((value, index) => {
    const mean = fitted.scaler.means[index];
    const deviation = fitted.scaler.standardDeviations[index];
    if (mean === undefined || deviation === undefined) {
      throw new Error("STOP_MMS_CURRENT_PREDICTION_INCOMPLETE_SCALER");
    }
    return (value - mean) / deviation;
  });
  const inputs = [1, ...standardized];
  const linear = fitted.model.weights.reduce((sum, weight, index) => {
    const input = inputs[index];
    if (input === undefined) throw new Error("STOP_MMS_CURRENT_PREDICTION_INCOMPLETE_MODEL_INPUT");
    return sum + weight * input;
  }, 0);
  return linear >= 0
    ? 1 / (1 + Math.exp(-linear))
    : Math.exp(linear) / (1 + Math.exp(linear));
}

export function buildCurrentUnresolvedSignal(marketRows, operativeThreshold) {
  const rows = [...marketRows].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0);
  const currentRow = rows.at(-1);
  if (currentRow === undefined) {
    throw new Error("STOP_MMS_CURRENT_PREDICTION_NO_CANONICAL_ROWS");
  }
  const historicalFeatureRows = buildHistoricalFeatureRows(rows);
  const trainingRows = historicalFeatureRows.filter((row) => row.targetDate < currentRow.date);
  if (trainingRows.length === 0) {
    throw new Error(`STOP_MMS_CURRENT_PREDICTION_NO_PRIOR_TRAINING_ROWS:${currentRow.symbol}`);
  }
  if (trainingRows.some((row) => row.targetDate >= currentRow.date)) {
    throw new Error("STOP_MMS_CURRENT_PREDICTION_FUTURE_LABEL_IN_TRAINING");
  }
  const fitted = fitModelOnFeatureRows(trainingRows);
  const probabilityUp = predictCurrentProbability(
    buildCurrentFeatureVector(rows, rows.length - 1),
    fitted,
  );
  const targetDate = deriveFutureTradingDate(currentRow.date, TARGET_HORIZON_ROWS);
  return {
    signalAsOfFeatureDate: currentRow.date,
    signalAsOfTargetDate: targetDate,
    probabilityUp,
    trainedOnRowCount: trainingRows.length,
    predictionHorizonRows: TARGET_HORIZON_ROWS,
    operativeThreshold,
    position: probabilityUp >= operativeThreshold ? "LONG" : "CASH",
  };
}

export function serializeProfitFactorForResearchOutput(value) {
  if (Number.isFinite(value)) return value;
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  throw new Error(
    `STOP_MMS_REPLAY_DIAGNOSTICS_UNEXPECTED_NONFINITE_VALUE:field=strategyProfitFactor:value=${String(value)}`,
  );
}

function serializeReplaySummaryForResearchOutput(summary) {
  return {
    ...summary,
    strategyProfitFactor: serializeProfitFactorForResearchOutput(summary.strategyProfitFactor),
  };
}

function serializeScenarioForResearchOutput(scenario) {
  return {
    ...scenario,
    validationReplaySummaries: scenario.validationReplaySummaries.map(
      serializeReplaySummaryForResearchOutput,
    ),
  };
}

function serializeScenarioRecordForResearchOutput(scenarios) {
  return Object.fromEntries(
    Object.entries(scenarios).map(([scenarioId, scenario]) => [
      scenarioId,
      serializeScenarioForResearchOutput(scenario),
    ]),
  );
}

export function serializeResearchOutputForJson(output) {
  if (isRecord(output.scenarios)) {
    return {
      ...output,
      scenarios: serializeScenarioRecordForResearchOutput(output.scenarios),
    };
  }

  if (Array.isArray(output.cutoffRuns)) {
    return {
      ...output,
      cutoffRuns: output.cutoffRuns.map((cutoffRun) => ({
        ...cutoffRun,
        scenarios: serializeScenarioRecordForResearchOutput(cutoffRun.scenarios),
      })),
    };
  }

  if (isRecord(output.temporalStudiesByCost)) {
    return {
      ...output,
      temporalStudiesByCost: Object.fromEntries(
        Object.entries(output.temporalStudiesByCost).map(([cost, study]) => [
          cost,
          serializeResearchOutputForJson(study),
        ]),
      ),
    };
  }

  throw new Error("STOP_MMS_REPLAY_DIAGNOSTICS_OUTPUT_CONSUMER_UNRESOLVED");
}

export function formatProfitFactorForResearchMarkdown(value) {
  return String(serializeProfitFactorForResearchOutput(value));
}

function failMissingSensitivityValue(fieldName, costKey, cutoffDate, reason) {
  throw new Error(
    `STOP_MMS_TW_COST_SENSITIVITY_REPORT_MISSING_REQUIRED_VALUE:field=${fieldName}:cost=${costKey}:cutoff=${cutoffDate}:reason=${reason}`,
  );
}

function requireNestedSensitivityValue(summary, fieldName, costKey, cutoffDate) {
  if (!isRecord(summary)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "summary_not_object");
  }
  const byCost = summary[fieldName];
  if (!isRecord(byCost)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "cost_map_not_object");
  }
  if (!Object.prototype.hasOwnProperty.call(byCost, costKey)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "cost_key_missing");
  }
  const byCutoff = byCost[costKey];
  if (!isRecord(byCutoff)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "cutoff_map_not_object");
  }
  if (!Object.prototype.hasOwnProperty.call(byCutoff, cutoffDate)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "cutoff_key_missing");
  }
  const value = byCutoff[cutoffDate];
  if (value === undefined || value === null) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "value_missing");
  }
  return value;
}

function requireSensitivityString(value, fieldName, costKey, cutoffDate) {
  if (typeof value !== "string") {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "value_not_string");
  }
  return value;
}

function requireSensitivityNumber(value, fieldName, costKey, cutoffDate) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failMissingSensitivityValue(fieldName, costKey, cutoffDate, "value_not_finite_number");
  }
  return value;
}

export function buildValidationThresholdParetoResearchOutput(thresholdParameterSensitivity) {
  const comparableFoldResults = thresholdParameterSensitivity.foldResults.filter(
    ({ candidateThresholdResults }) => candidateThresholdResults.length >= 2,
  );

  return {
    validationThresholdParetoFrontier: comparableFoldResults.map((fold) => ({
      foldId: fold.foldId,
      candidateThresholds: fold.candidateThresholdResults.map(({ threshold }) => threshold),
      ...analyzeThresholdParetoFrontier(fold),
    })),
    validationThresholdParetoStability: analyzeThresholdParetoStability({
      foldResults: comparableFoldResults,
    }),
  };
}

function runScenario(
  symbol,
  marketRows,
  policy = TW_STABILITY_RESEARCH_POLICY_V1,
  roundTripCostBps = ROUND_TRIP_COST_BPS,
) {
  const prep = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
  const walkForward = runWalkForwardThresholdEvaluation({
    symbol,
    roundTripCostBps,
    initialCapital: INITIAL_CAPITAL,
    folds: prep.foldInputs,
  });
  const thresholdParameterSensitivity = runThresholdParameterSensitivity({
    symbol,
    roundTripCostBps,
    initialCapital: INITIAL_CAPITAL,
    folds: prep.foldInputs,
  });
  const validationThresholdPareto = buildValidationThresholdParetoResearchOutput(
    thresholdParameterSensitivity,
  );
  const validationReplaySummaries = walkForward.foldResults.map((fold) => ({
    foldId: fold.foldId,
    ...summarizeLongCashReplay(fold.calibrationResult.validationResult),
  }));
  const validationReplayIntegrityReports = walkForward.foldResults.map((fold) => ({
    foldId: fold.foldId,
    ...validateLongCashReplay(fold.calibrationResult.validationResult),
  }));
  const stability = summarizeWalkForwardStability(walkForward);
  const stabilityGate = evaluateWalkForwardStabilityGate({ policy, diagnostics: stability });
  const operativeThreshold = walkForward.foldResults.at(-1).selectedThreshold;
  const position = prep.latestSignal.probabilityUp >= operativeThreshold ? "LONG" : "CASH";
  const currentSignal = buildCurrentUnresolvedSignal(marketRows, operativeThreshold);
  return {
    dataQualityFindings: prep.dataQualityFindings,
    featureRowCount: prep.featureRowCount,
    foldBoundaries: prep.foldBoundaries,
    walkForward,
    thresholdParameterSensitivity,
    ...validationThresholdPareto,
    validationReplaySummaries,
    validationReplayIntegrityReports,
    stability,
    stabilityGate,
    latestSignal: {
      ...prep.latestSignal,
      operativeThreshold,
      position,
    },
    currentSignal,
  };
}

function scenarioOutput(symbol, scenarioId, result, extra) {
  return {
    symbol,
    scenarioId,
    adjustmentApplied: extra.adjustmentApplied,
    pointInTimeStatus: extra.pointInTimeStatus,
    dataQualityFindings: result.dataQualityFindings,
    featureRowCount: result.featureRowCount,
    foldBoundaries: result.foldBoundaries,
    walkForward: result.walkForward,
    thresholdParameterSensitivity: result.thresholdParameterSensitivity,
    validationThresholdParetoFrontier: result.validationThresholdParetoFrontier,
    validationThresholdParetoStability: result.validationThresholdParetoStability,
    validationReplaySummaries: result.validationReplaySummaries,
    validationReplayIntegrityReports: result.validationReplayIntegrityReports,
    stability: result.stability,
    stabilityGate: result.stabilityGate,
    latestSignal: result.latestSignal,
    currentSignal: result.currentSignal,
  };
}

const CONTRACT_SCENARIO_IDS = Object.freeze([
  "2330_RAW_CONTROL",
  "0050_RAW",
  "0050_SOURCE_QUALIFIED_ADJUSTED",
]);

function contractLatestPrediction(scenarioId, scenario) {
  const signal = scenario?.latestSignal;
  if (signal === undefined) return undefined;
  return {
    scenario: scenarioId,
    symbol: scenario.symbol,
    featureDate: signal.signalAsOfFeatureDate,
    probabilityUp: signal.probabilityUp,
    predictedDirection: signal.probabilityUp >= 0.5 ? "up" : "down",
    operativeThreshold: signal.operativeThreshold,
    position: signal.position,
    targetDate: signal.signalAsOfTargetDate,
    predictionRole: "resolved_historical",
    resolutionStatus: "resolved",
  };
}

function contractCurrentUnresolvedPrediction(scenarioId, scenario) {
  const signal = scenario?.currentSignal;
  if (signal === undefined) return undefined;
  return {
    scenario: scenarioId,
    symbol: scenario.symbol,
    featureDate: signal.signalAsOfFeatureDate,
    probabilityUp: signal.probabilityUp,
    predictedDirection: signal.probabilityUp >= 0.5 ? "up" : "down",
    operativeThreshold: signal.operativeThreshold,
    position: signal.position,
    targetDate: signal.signalAsOfTargetDate,
    predictionRole: "current_unresolved",
    resolutionStatus: "unresolved",
    predictionHorizon: {
      unit: "trading_rows",
      rows: signal.predictionHorizonRows,
    },
  };
}

function contractSimulation(scenarioId, scenario) {
  const fold = scenario?.walkForward?.foldResults?.at(-1);
  const replay = fold?.calibrationResult?.validationResult;
  if (replay === undefined) return undefined;
  return {
    scenario: scenarioId,
    schemaVersion: replay.schemaVersion,
    symbol: replay.symbol,
    validationThreshold: replay.validationThreshold,
    roundTripCostBps: replay.roundTripCostBps,
    initialCapital: replay.initialCapital,
    strategy: replay.strategy,
    benchmark: replay.benchmark,
    excessReturn: replay.excessReturn,
    normalizedResultSha256: replay.normalizedResultSha256,
  };
}

function toCanonicalMarketRows(rawRows) {
  const symbols = [...new Set(rawRows.map((row) => row.symbol))].sort();
  return symbols.flatMap((symbol) => toMarketRows(rawRows, symbol));
}

function assertFinalTestEconomicBoundary(
  label,
  evidenceResult,
  currentUnresolvedKeys,
  sourceEndDate,
) {
  const finalTestEconomicEvidence = evidenceResult.finalTestEconomicEvidence;
  if (finalTestEconomicEvidence === undefined) return;
  if (finalTestEconomicEvidence.evaluationPartition !== "FINAL_TEST") {
    throw new Error(`STOP_MMS_${label}_FINAL_TEST_PARTITION_UNRESOLVED`);
  }
  if (finalTestEconomicEvidence.rows.some((row) => currentUnresolvedKeys.has(`${row.symbol}:${row.featureDate}`))) {
    throw new Error(`STOP_MMS_${label}_CURRENT_UNRESOLVED_PREDICTION_INCLUDED`);
  }
  if (finalTestEconomicEvidence.rows.some((row) => row.targetDate > sourceEndDate)) {
    throw new Error(`STOP_MMS_${label}_FUTURE_TARGET_INCLUDED`);
  }
  if (evidenceResult.evidence.thresholdSelection.validationRowsSha256
    === finalTestEconomicEvidence.finalTestRowsSha256) {
    throw new Error(`STOP_MMS_${label}_VALIDATION_ROWS_INCLUDED`);
  }
}

export function buildPredictionRetrainingResultV1FromFreshResearch({
  output,
  rawRows,
  generatedAt,
  researchEvidenceResult: suppliedResearchEvidenceResult,
  finalTestEconomicReconciliation,
  perSymbolLogisticChallenger: suppliedPerSymbolLogisticChallenger,
}) {
  const marketRows = toCanonicalMarketRows(rawRows);
  const evidenceResult = suppliedResearchEvidenceResult ?? runResearchEvidenceKernel({
    datasetVersion: {
      datasetId: "p194_twstock_ohlcv_export",
      version: output.repositories.legacyRepo.ref,
      source: "twstock/twse",
    },
    marketRows,
  });

  const latestPredictions = CONTRACT_SCENARIO_IDS
    .map((scenarioId) => contractLatestPrediction(scenarioId, output.scenarios[scenarioId]))
    .filter((prediction) => prediction !== undefined);
  const currentUnresolvedPredictions = CONTRACT_SCENARIO_IDS
    .map((scenarioId) => contractCurrentUnresolvedPrediction(scenarioId, output.scenarios[scenarioId]))
    .filter((prediction) => prediction !== undefined);
  const missingPredictionScenarios = CONTRACT_SCENARIO_IDS.filter(
    (scenarioId) => output.scenarios[scenarioId]?.currentSignal === undefined,
  );
  const currentPredictionUnavailable = missingPredictionScenarios.map((scenarioId) => ({
    scenario: scenarioId,
    reason: output.scenarios[scenarioId]?.currentSignalUnavailableReason
      ?? "The fresh scenario output did not expose a current unresolved signal.",
  }));
  const finalTestEconomicEvidence = evidenceResult.finalTestEconomicEvidence;
  const currentUnresolvedKeys = new Set(
    currentUnresolvedPredictions.map((prediction) => `${prediction.symbol}:${prediction.featureDate}`),
  );
  assertFinalTestEconomicBoundary(
    "SYMBOL_EDGE",
    evidenceResult,
    currentUnresolvedKeys,
    output.source.dateRange.max,
  );
  const finalTestEconomicEdge = finalTestEconomicEvidence === undefined
    ? undefined
    : buildFinalTestPerSymbolEconomicEdge({
      finalTestEvidence: finalTestEconomicEvidence,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    });
  const perSymbolLogisticChallenger = suppliedPerSymbolLogisticChallenger
    ?? (evidenceResult.perSymbolLogisticFeatureChallenger !== undefined
      && evidenceResult.perSymbolLogisticChallenger !== undefined
      ? buildPerSymbolLogisticFeatureChallengerEvaluation({
        control: evidenceResult.perSymbolLogisticChallenger,
        challenger: evidenceResult.perSymbolLogisticFeatureChallenger,
        candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
        roundTripCostBps: ROUND_TRIP_COST_BPS,
        initialCapital: INITIAL_CAPITAL,
      })
      : evidenceResult.perSymbolLogisticChallenger === undefined
      || finalTestEconomicEvidence === undefined
      ? undefined
      : buildPerSymbolLogisticChallengerEvaluation({
        challenger: evidenceResult.perSymbolLogisticChallenger,
        incumbentEvidence: evidenceResult.evidence,
        incumbentFinalTestEconomicEvidence: finalTestEconomicEvidence,
        candidateDataQualityBasis: "RAW_CONTROL_ONLY",
        roundTripCostBps: ROUND_TRIP_COST_BPS,
        initialCapital: INITIAL_CAPITAL,
      }));
  const simulationScenarioId = "0050_SOURCE_QUALIFIED_ADJUSTED";
  const simulation = contractSimulation(simulationScenarioId, output.scenarios[simulationScenarioId]);
  const warnings = [
    ...(output.limitations ?? []),
    "Fresh final-test evidence was computed by MMS_RESEARCH_EVIDENCE_V1 from the same pinned market-data blob.",
    "Resolved latest prediction records are preserved as historical signals from the TW strategy scenarios.",
    "Current unresolved prediction records use the latest canonical feature row and contain no target outcome.",
    `The representative simulation is the final walk-forward validation replay for ${simulationScenarioId}.`,
    ...(output.legacyMlRetraining?.interpretation === undefined
      ? []
      : [output.legacyMlRetraining.interpretation]),
    ...missingPredictionScenarios.map(
      (scenarioId) => `Current unresolved prediction unavailable for ${scenarioId}: ${output.scenarios[scenarioId]?.currentSignalUnavailableReason
        ?? "the fresh scenario output did not expose a current signal."}`,
    ),
    ...(simulation === undefined
      ? [`Simulation unavailable for ${simulationScenarioId}: the fresh scenario output did not expose a final validation replay.`]
      : []),
  ];
  const provenanceReferences = [
    {
      kind: "dataset",
      reference: `${output.repositories.legacyRepo.ref}:${output.source.path}`,
      sha256: output.source.sha256,
    },
    ...CONTRACT_SCENARIO_IDS
      .map((scenarioId) => {
        const scenario = output.scenarios[scenarioId];
        if (scenario?.walkForward?.normalizedResultSha256 === undefined) return undefined;
        return {
          kind: "latest_predictions",
          reference: `${output.schemaVersion}:${scenarioId}`,
          sha256: scenario.walkForward.normalizedResultSha256,
        };
      })
      .filter((reference) => reference !== undefined),
    ...currentUnresolvedPredictions.map((prediction) => ({
      kind: "current_predictions",
      reference: `${output.schemaVersion}:${prediction.scenario}:current-unresolved`,
      sha256: sha256Hex(Buffer.from(JSON.stringify(prediction), "utf8")),
    })),
    ...(simulation === undefined
      ? []
      : [{
        kind: "simulation",
        reference: `${simulation.schemaVersion}:${simulation.scenario}`,
        sha256: simulation.normalizedResultSha256,
      }]),
  ];

  return buildPredictionRetrainingResultV1({
    runId: `mms-fresh-retraining-${output.source.sha256.slice(0, 12)}-${output.source.dateRange.max}`,
    generatedAt,
    dataAsOf: output.source.dateRange.max,
    researchVersion: output.schemaVersion,
    modelAlgorithm: "binary_logistic_regression",
    evidence: evidenceResult.evidence,
    promotionDecision: evidenceResult.promotionDecision,
    ...(evidenceResult.finalTestReliability === undefined
      ? {}
      : { finalTestReliability: evidenceResult.finalTestReliability }),
    ...(finalTestEconomicEdge === undefined ? {} : { finalTestEconomicEdge }),
    ...(finalTestEconomicReconciliation === undefined ? {} : { finalTestEconomicReconciliation }),
    ...(perSymbolLogisticChallenger === undefined ? {} : { perSymbolLogisticChallenger }),
    ...(latestPredictions.length === 0 ? {} : { latestPredictions }),
    ...(currentUnresolvedPredictions.length === 0 ? {} : { currentUnresolvedPredictions }),
    currentPredictionUnavailable,
    ...(simulation === undefined ? {} : { simulation }),
    warnings,
    provenanceReferences,
  });
}

function appendReplayIntegrityDiagnostics(lines, entries) {
  lines.push(
    "## Replay Integrity Diagnostics (Research Integrity / Evidence Quality)",
    "",
    "Diagnostic-only output: PASS does not mean profitable or recommended, and trustScore does not indicate future-performance confidence.",
    "",
  );

  for (const { label, report } of entries) {
    lines.push(
      `### ${label}`,
      `- **Status**: **${report.passed ? "PASS" : "CAUTION"}**`,
      `- **Trust score**: ${report.trustScore}`,
    );
    if (report.warnings.length === 0) {
      lines.push("- **Warnings**: None detected.");
    } else {
      lines.push("- **Warnings**:");
      for (const warning of report.warnings) {
        lines.push(`  - **${warning.severity.toUpperCase()} — ${warning.code}**: ${warning.message}`);
      }
    }
    lines.push(`- **Summary**: ${report.summary}`, "");
  }
}

function appendThresholdParetoDiagnostics(lines, scenarios) {
  lines.push(
    "## Validation Threshold Pareto Analysis (Diagnostic Only)",
    "",
    "Pareto status is computed from validation threshold-sensitivity candidates only. It is descriptive and does not select or recommend a threshold.",
    "",
  );

  for (const [key, scenario] of Object.entries(scenarios)) {
    const stability = scenario.validationThresholdParetoStability;
    lines.push(
      `### ${key}`,
      `- **Stable frontier thresholds**: ${stability.stableFrontierThresholds.join(", ") || "None"}`,
      `- **Mixed thresholds**: ${stability.mixedThresholds.join(", ") || "None"}`,
      `- **Never-frontier thresholds**: ${stability.neverFrontierThresholds.join(", ") || "None"}`,
      `- **Partial-coverage thresholds**: ${stability.partialCoverageThresholds.join(", ") || "None"}`,
      "",
      "| Fold | Compared Thresholds | Frontier Thresholds | Dominated Threshold | Dominated By |",
      "| --- | --- | --- | --- | --- |",
    );

    for (const fold of scenario.validationThresholdParetoFrontier) {
      const frontierThresholds = fold.frontierCandidates.map(({ threshold }) => threshold).join(", ");
      if (fold.dominatedCandidates.length === 0) {
        lines.push(
          `| ${fold.foldId} | ${fold.candidateThresholds.join(", ")} | ${frontierThresholds} | None | None |`,
        );
        continue;
      }
      fold.dominatedCandidates.forEach((candidate, index) => {
        lines.push(
          `| ${fold.foldId} | ${index === 0 ? fold.candidateThresholds.join(", ") : ""} | `
          + `${index === 0 ? frontierThresholds : ""} | ${candidate.threshold} | `
          + `${candidate.dominatedByThresholds.join(", ")} |`,
        );
      });
    }
    lines.push("");
  }
}

function appendFinalTestEconomicReconciliation(lines, reconciliation) {
  const formatDelta = (value) => value === null ? "UNRESOLVED" : value.toFixed(8);
  lines.push(
    "## 0050 Raw vs Source-Qualified Adjusted FINAL_TEST Economic Edge",
    "",
    `- **Classification**: **${reconciliation.classification}**`,
    `- **Common Window Check**: **${reconciliation.commonWindowCheck.status}**`,
    `- **Promotion Decision**: **${reconciliation.promotionDecision}**`,
    `- **Reconciliation SHA256**: \`${reconciliation.normalizedResultSha256}\``,
    "",
    "| Scenario | Source/Data Quality | Window | FINAL_TEST Rows | Prediction Source | Position Source | Threshold | Cost (bps) | Strategy Gross | Strategy Net | Benchmark Gross | Benchmark Net | Excess | Strategy Max DD | Benchmark Max DD | Trades |",
    "| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const scenario of [reconciliation.raw, reconciliation.adjusted]) {
    lines.push(
      `| ${scenario.scenario} | ${scenario.sourceDataQualityClassification} | `
      + `${scenario.evaluationStartDate} to ${scenario.evaluationEndDate} | ${scenario.finalTestRowCount} | `
      + `${scenario.predictionSource} | ${scenario.positionSource} | ${scenario.operativeThreshold.toFixed(6)} | `
      + `${scenario.transactionCostBps} | ${scenario.strategyGrossReturn.toFixed(8)} | `
      + `${scenario.strategyNetReturn.toFixed(8)} | ${scenario.benchmarkGrossReturn.toFixed(8)} | `
      + `${scenario.benchmarkNetReturn.toFixed(8)} | ${scenario.excessReturn.toFixed(8)} | `
      + `${scenario.strategyMaximumDrawdown.toFixed(8)} | ${scenario.benchmarkMaximumDrawdown.toFixed(8)} | `
      + `${scenario.tradeCount} |`,
    );
  }
  lines.push(
    "",
    `- **RAW_VS_ADJUSTED_BENCHMARK_RETURN_DELTA**: ${formatDelta(reconciliation.rawVsAdjusted.benchmarkReturnDelta)}`,
    `- **RAW_VS_ADJUSTED_STRATEGY_RETURN_DELTA**: ${formatDelta(reconciliation.rawVsAdjusted.strategyReturnDelta)}`,
    `- **RAW_VS_ADJUSTED_EXCESS_RETURN_DELTA**: ${formatDelta(reconciliation.rawVsAdjusted.excessReturnDelta)}`,
    "",
  );
  for (const scenario of [reconciliation.raw, reconciliation.adjusted]) {
    lines.push(`### ${scenario.scenario} Existing Warnings`, "");
    for (const warning of [
      ...scenario.dataQualityWarnings,
      ...scenario.corporateActionWarnings,
      ...scenario.replayWarnings,
    ]) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
}

function appendPerSymbolLogisticChallenger(lines, challenger) {
  if (challenger === undefined) return;
  lines.push(
    "## Per-Symbol Logistic Challenger (Diagnostic Only)",
    "",
    `- **Candidate Data-Quality Basis**: ${challenger.candidateDataQualityBasis}`,
    `- **Directional Baseline Check**: **${challenger.doesAnyChallengerBeatDirectionalBaseline}**`,
    `- **Buy-and-Hold After Cost Check**: **${challenger.doesAnyChallengerBeatBuyAndHoldAfterCost}**`,
    `- **Both Directional and Economic Improvement Check**: **${challenger.doesAnyChallengerImproveBothDirectionalAndEconomicEvidence}**`,
    `- **Challenger Conclusion**: **${challenger.challengerConclusion}**`,
    `- **Promotion Decision**: **${challenger.promotionDecision}**`,
    "",
    "| Symbol | Train | Validation | Final Test | Threshold | Challenger Acc. | Majority Baseline | Incumbent Acc. | Acc. Delta | Challenger Net | Benchmark Net | Challenger Excess | Incumbent Excess | Excess Delta | Max DD | Trades | Warnings |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const group of challenger.groups) {
    const candidate = group.challenger;
    const comparison = group.incumbentVsChallenger;
    lines.push(
      `| ${group.symbol} | ${candidate.trainingRows} | ${candidate.validationRows} | ${candidate.finalTestRows} | `
      + `${candidate.thresholdSelection.selectedThreshold.toFixed(6)} | ${candidate.finalTestMetrics.accuracy.toFixed(6)} | `
      + `${candidate.majorityBaselineAccuracy.toFixed(6)} | ${comparison.incumbentAccuracy?.toFixed(6) ?? "UNAVAILABLE"} | `
      + `${comparison.accuracyDeltaChallengerMinusIncumbent?.toFixed(6) ?? "UNAVAILABLE"} | `
      + `${group.challengerEconomic.strategyNetReturn.toFixed(6)} | ${group.challengerEconomic.benchmarkNetReturn.toFixed(6)} | `
      + `${group.challengerEconomic.excessReturn.toFixed(6)} | ${comparison.incumbentExcessReturn?.toFixed(6) ?? "UNAVAILABLE"} | `
      + `${comparison.excessDeltaChallengerMinusIncumbent?.toFixed(6) ?? "UNAVAILABLE"} | `
      + `${group.challengerEconomic.strategyMaximumDrawdown.toFixed(6)} | ${group.challengerEconomic.tradeCount} | `
      + `${group.warnings.join(" ")} |`,
    );
  }
  lines.push("");
}

function generateMarkdownReport(output) {
  const policy = TW_STABILITY_RESEARCH_POLICY_V1;
  const scenarios = output.scenarios;
  const lines = [
    "# Taiwan Strategy Research Study V1 Report",
    "",
    "## Executive Summary",
    `- **Schema Version**: ${output.schemaVersion}`,
    `- **Review Date**: ${output.reviewDate}`,
    `- **Research Mode**: ${output.researchMode}`,
    `- **Promotion Decision**: ${output.promotionDecision}`,
    `- **Promotion Reason**: \`${output.promotionReason}\``,
    `- **Source CSV SHA256**: \`${output.source.sha256}\``,
    `- **Source Row Count**: ${output.source.rowCount} (${output.source.dateRange.min} to ${output.source.dateRange.max})`,
    "",
    "## Walk-Forward Stability Gate Policy",
    `- **Policy ID**: \`${policy.policyId}\``,
    `- **Policy Version**: \`${policy.policyVersion}\``,
    `- **Minimum Fold Count**: ${policy.minimumFoldCount}`,
    `- **Minimum Positive Excess Return Fold Ratio**: ${policy.minimumPositiveExcessReturnFoldRatio}`,
    `- **Minimum Median Validation Excess Return**: ${policy.minimumMedianValidationExcessReturn}`,
    `- **Minimum Aggregate Excess Return**: ${policy.minimumAggregateExcessReturn}`,
    `- **Maximum Aggregate Drawdown**: ${policy.maximumAggregateDrawdown}`,
    `- **Maximum Dominant Threshold Ratio**: ${policy.maximumDominantThresholdRatio}`,
    "",
    "## Scenario Stability Gate Evaluation Results",
    "",
    "| Scenario | Symbol | Adj Applied | Gate Result | Agg Excess Return | Agg Max Drawdown | Dominant Thresh Ratio | Position |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const [key, sc] of Object.entries(scenarios)) {
    const gate = sc.stabilityGate;
    const aggExcess = sc.walkForward.aggregateExcessReturn.toFixed(6);
    const aggDrawdown = sc.walkForward.aggregateMaximumStrategyDrawdown.toFixed(6);
    const domRatio = sc.stability.dominantSelectedThresholdRatio.toFixed(6);
    lines.push(
      `| ${key} | ${sc.symbol} | ${sc.adjustmentApplied} | **${gate.overallPass ? "PASS" : "FAIL"}** | ${aggExcess} | ${aggDrawdown} | ${domRatio} | ${sc.latestSignal.position} |`,
    );
  }

  lines.push("", "## Gate Criteria Detail by Scenario", "");
  for (const [key, sc] of Object.entries(scenarios)) {
    const gate = sc.stabilityGate;
    lines.push(`### ${key} (Overall: ${gate.overallPass ? "PASS" : "FAIL"})`, "");
    lines.push("| Criterion ID | Pass | Observed | Threshold | Comparator |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of gate.criteria) {
      lines.push(`| \`${c.criterionId}\` | ${c.pass ? "PASS" : "FAIL"} | ${c.observedValue.toFixed(6)} | ${c.thresholdValue.toFixed(6)} | \`${c.comparator}\` |`);
    }
    lines.push("");
  }

  lines.push(
    "## Long/Cash Replay Performance Summary",
    "",
    "Rule: LONG when probability meets or exceeds the configured threshold; otherwise CASH.",
    "",
    "| Scenario | Fold | Threshold | Observations | LONG | CASH | Wins | Losses | Hit Rate | Strategy Return | Benchmark Return | Excess Return | Strategy Profit Factor | Strategy Ulcer Index | Benchmark Ulcer Index | Strategy Max Drawdown Duration | Benchmark Max Drawdown Duration |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [key, sc] of Object.entries(scenarios)) {
    for (const summary of sc.validationReplaySummaries) {
      lines.push(
        `| ${key} | ${summary.foldId} | ${summary.configuredThreshold.toFixed(6)} | `
        + `${summary.observations} | ${summary.longObservations} | ${summary.cashObservations} | `
        + `${summary.winningLongObservations} | ${summary.losingLongObservations} | `
        + `${summary.longHitRate.toFixed(6)} | ${summary.strategyTotalReturn.toFixed(6)} | `
        + `${summary.benchmarkTotalReturn.toFixed(6)} | ${summary.excessReturn.toFixed(6)} | `
        + `${formatProfitFactorForResearchMarkdown(summary.strategyProfitFactor)} | `
        + `${summary.strategyUlcerIndex} | ${summary.benchmarkUlcerIndex} | `
        + `${summary.strategyMaxDrawdownDuration} | ${summary.benchmarkMaxDrawdownDuration} |`,
      );
    }
  }

  lines.push(
    "## Threshold Parameter Sensitivity (Diagnostic Only)",
    "",
    "Calibration-selected thresholds are fixed before validation; every candidate threshold is replayed on validation rows only. This diagnostic does not promote or recommend a threshold.",
    "",
  );
  for (const [key, sc] of Object.entries(scenarios)) {
    const sensitivity = sc.thresholdParameterSensitivity;
    lines.push(
      `- **${key} aggregate fragility**: **${sensitivity.aggregateFragilityStatus}** (${sensitivity.foldSignFlipCount} fold(s) with an excess-return sign flip)`,
    );
  }
  lines.push(
    "",
    "| Scenario | Fold | Selected Threshold | Candidate Threshold | Strategy Return | Benchmark Return | Excess Return | Return Delta | Excess Delta | Return Degradation | Excess Degradation | Fragility |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const [key, sc] of Object.entries(scenarios)) {
    const sensitivity = sc.thresholdParameterSensitivity;
    for (const fold of sensitivity.foldResults) {
      for (const candidate of fold.candidateThresholdResults) {
        lines.push(
          `| ${key} | ${fold.foldId} | ${fold.selectedThreshold.toFixed(6)} | ${candidate.threshold.toFixed(6)} | `
          + `${candidate.validationStrategyReturn.toFixed(6)} | ${candidate.validationBenchmarkReturn.toFixed(6)} | `
          + `${candidate.validationExcessReturn.toFixed(6)} | ${candidate.returnDeltaVersusSelectedThreshold.toFixed(6)} | `
          + `${candidate.excessReturnDeltaVersusSelectedThreshold.toFixed(6)} | `
          + `${candidate.degradationVersusSelectedThreshold.toFixed(6)} | `
          + `${candidate.excessReturnDegradationVersusSelectedThreshold.toFixed(6)} | ${fold.fragilityStatus} |`,
        );
      }
    }
  }

  appendThresholdParetoDiagnostics(lines, scenarios);

  appendReplayIntegrityDiagnostics(
    lines,
    Object.entries(scenarios).flatMap(([key, sc]) =>
      sc.validationReplayIntegrityReports.map((report) => ({
        label: `${key} / Fold ${report.foldId}`,
        report,
      })),
    ),
  );

  if (output.rawVsAdjusted0050FinalTestEconomicReconciliation !== undefined) {
    appendFinalTestEconomicReconciliation(
      lines,
      output.rawVsAdjusted0050FinalTestEconomicReconciliation,
    );
  }
  appendPerSymbolLogisticChallenger(lines, output.perSymbolLogisticChallenger);

  lines.push(
    "## Research Limitations & Disclaimers",
    "",
  );
  for (const lim of output.limitations) {
    lines.push(`- ${lim}`);
  }
  lines.push("");
  return lines.join("\n");
}

function generateTemporalMarkdownReport(output) {
  const policy = TW_STABILITY_RESEARCH_POLICY_V1;
  const scenarios = output.temporalSummaries;
  const lines = [
    "# Taiwan Strategy Temporal Robustness Study V1 Report",
    "",
    "## Executive Summary",
    `- **Schema Version**: ${output.schemaVersion}`,
    `- **Review Date**: ${output.reviewDate}`,
    `- **Research Mode**: ${output.researchMode}`,
    `- **Source CSV SHA256**: \`${output.source.sha256}\``,
    `- **Source Date Range**: ${output.source.fullDateRange.min} to ${output.source.fullDateRange.max}`,
    `- **Source Full Row Count**: ${output.source.fullRowCount}`,
    `- **Requested Cutoff Dates**: ${output.requestedCutoffDates.join(", ")}`,
    `- **Walk-Forward Stability Gate Policy ID**: \`${policy.policyId}\``,
    `- **Policy SHA256**: \`${output.policySha256}\``,
    `- **Study SHA256**: \`${output.studySha256}\``,
    "",
    "## Temporal Robustness Summary by Scenario",
    "",
  ];

  for (const scenarioId of output.scenarioOrder) {
    const summary = scenarios[scenarioId];
    lines.push(`### Scenario: ${scenarioId}`);
    lines.push(`- **Temporal Classification**: **${summary.temporalAcceptanceClassification}**`);
    lines.push(`- **Pass Count**: ${summary.passCount} / ${summary.cutoffCount}`);
    lines.push(`- **Fail Count**: ${summary.failCount} / ${summary.cutoffCount}`);
    lines.push("");
    lines.push("| Requested Cutoff | Resolved Data End | Gate Result | Agg Excess Return | Agg Max Drawdown | Dominant Thresh Ratio | Position | Signal As Of |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

    for (const cutoffDate of output.requestedCutoffDates) {
      const resolvedDate = output.resolvedCutoffDates[cutoffDate];
      const gateStatus = summary.gateStatusByCutoff[cutoffDate];
      const aggExcess = summary.aggregateExcessReturnByCutoff[cutoffDate].toFixed(6);
      const aggDrawdown = summary.aggregateMaximumDrawdownByCutoff[cutoffDate].toFixed(6);
      const domRatio = summary.dominantThresholdRatioByCutoff[cutoffDate].toFixed(6);
      const position = summary.operativePositionByCutoff[cutoffDate];
      const signalAsOf = summary.latestSignalAsOfByCutoff[cutoffDate];

      lines.push(
        `| ${cutoffDate} | ${resolvedDate} | **${gateStatus}** | ${aggExcess} | ${aggDrawdown} | ${domRatio} | ${position} | ${signalAsOf} |`,
      );
    }
    lines.push("");
  }

  const integrityEntries = [];
  for (const cutoffRun of output.cutoffRuns) {
    for (const scenarioId of output.scenarioOrder) {
      const scenario = cutoffRun.scenarios[scenarioId];
      for (const report of scenario.validationReplayIntegrityReports) {
        integrityEntries.push({
          label: `${scenarioId} / Cutoff ${cutoffRun.requestedCutoffDate} / Fold ${report.foldId}`,
          report,
        });
      }
    }
  }
  appendReplayIntegrityDiagnostics(lines, integrityEntries);

  lines.push(
    "## Research Limitations & Disclaimers",
    "",
  );
  for (const lim of output.limitations) {
    lines.push(`- ${lim}`);
  }
  lines.push("");
  lines.push("Note: Temporal consistency across cutoffs is historical evidence only and does not guarantee future market behavior.");
  lines.push("");
  return lines.join("\n");
}

function generateSensitivityMarkdownReport(output) {
  const policy = TW_STABILITY_RESEARCH_POLICY_V1;
  const scenarios = output.sensitivitySummaries;
  const lines = [
    "# Taiwan Strategy Transaction Cost Sensitivity Study V1 Report",
    "",
    "## Executive Summary",
    `- **Schema Version**: ${output.schemaVersion}`,
    `- **Review Date**: ${output.reviewDate}`,
    `- **Research Mode**: ${output.researchMode}`,
    `- **Source CSV SHA256**: \`${output.source.sha256}\``,
    `- **Source Date Range**: ${output.source.fullDateRange.min} to ${output.source.fullDateRange.max}`,
    `- **Source Full Row Count**: ${output.source.fullRowCount}`,
    `- **Requested Cutoff Dates**: ${output.orderedCutoffDates.join(", ")}`,
    `- **Ordered Cost Grid (bps)**: ${output.orderedRoundTripCostBpsValues.join(", ")}`,
    `- **Walk-Forward Stability Gate Policy ID**: \`${policy.policyId}\``,
    `- **Policy SHA256**: \`${output.policySha256}\``,
    `- **Study SHA256**: \`${output.studySha256}\``,
    "",
    "## Cost-Sensitivity Summary by Scenario",
    "",
  ];

  for (const scenarioId of output.scenarioOrder) {
    const summary = scenarios[scenarioId];
    lines.push(`### Scenario: ${scenarioId}`);
    lines.push(`- **Cost Sensitivity Classification**: **${summary.costSensitivityClassification}**`);
    lines.push(`- **Pass Cell Count**: ${summary.passCountAcrossAllCells} / ${summary.costCount * summary.cutoffCount}`);
    lines.push(`- **Fail Cell Count**: ${summary.failCountAcrossAllCells} / ${summary.costCount * summary.cutoffCount}`);
    lines.push("");
    lines.push("| Round-Trip Cost (bps) | Requested Cutoff | Gate Result | Agg Excess Return | Agg Max Drawdown | Dominant Thresh Ratio | Position |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");

    for (const cost of output.orderedRoundTripCostBpsValues) {
      const costKey = String(cost);
      for (const cutoffDate of output.orderedCutoffDates) {
        const gateStatus = requireSensitivityString(
          requireNestedSensitivityValue(summary, "gateStatusByCostAndCutoff", costKey, cutoffDate),
          "gateStatusByCostAndCutoff",
          costKey,
          cutoffDate,
        );
        const aggExcess = requireSensitivityNumber(
          requireNestedSensitivityValue(summary, "aggregateExcessReturnByCostAndCutoff", costKey, cutoffDate),
          "aggregateExcessReturnByCostAndCutoff",
          costKey,
          cutoffDate,
        ).toFixed(6);
        const aggDrawdown = requireSensitivityNumber(
          requireNestedSensitivityValue(summary, "aggregateMaximumDrawdownByCostAndCutoff", costKey, cutoffDate),
          "aggregateMaximumDrawdownByCostAndCutoff",
          costKey,
          cutoffDate,
        ).toFixed(6);
        const domRatio = requireSensitivityNumber(
          requireNestedSensitivityValue(summary, "dominantThresholdRatioByCostAndCutoff", costKey, cutoffDate),
          "dominantThresholdRatioByCostAndCutoff",
          costKey,
          cutoffDate,
        ).toFixed(6);
        const position = requireSensitivityString(
          requireNestedSensitivityValue(summary, "operativePositionByCostAndCutoff", costKey, cutoffDate),
          "operativePositionByCostAndCutoff",
          costKey,
          cutoffDate,
        );

        lines.push(
          `| ${cost} | ${cutoffDate} | **${gateStatus}** | ${aggExcess} | ${aggDrawdown} | ${domRatio} | ${position} |`,
        );
      }
    }
    lines.push("");
  }

  const integrityEntries = [];
  for (const cost of output.orderedRoundTripCostBpsValues) {
    const study = output.temporalStudiesByCost[String(cost)];
    for (const cutoffRun of study.cutoffRuns) {
      for (const scenarioId of study.scenarioOrder) {
        const scenario = cutoffRun.scenarios[scenarioId];
        for (const report of scenario.validationReplayIntegrityReports) {
          integrityEntries.push({
            label: `${scenarioId} / ${cost} bps / Cutoff ${cutoffRun.requestedCutoffDate} / Fold ${report.foldId}`,
            report,
          });
        }
      }
    }
  }
  appendReplayIntegrityDiagnostics(lines, integrityEntries);

  lines.push(
    "## Research Limitations & Disclaimers",
    "",
  );
  for (const lim of output.limitations) {
    lines.push(`- ${lim}`);
  }
  lines.push("");
  lines.push("Note: Transaction cost sensitivity across synthetic cost assumptions is historical research evidence only and does not represent official trading fee schedules or investment advice.");
  lines.push("");
  return lines.join("\n");
}

function generatePerSymbolLogisticChallengerTemporalMarkdown(output) {
  const lines = [
    "# 0056 Per-Symbol Logistic Challenger Temporal Confirmation V1",
    "",
    "## Executive Summary",
    `- **Classification**: ${output.classification}`,
    `- **Review Date**: ${output.reviewDate}`,
    `- **Data As Of**: ${output.source.dataAsOf}`,
    `- **Symbol**: ${output.symbol}`,
    `- **Control Feature Set**: ${output.controlFeatureNames.join(", ")}`,
    `- **Challenger Feature Set**: ${output.featureNames.join(", ")}`,
    `- **Frozen Feature Family**: ${output.featureFamily.featureFamilyName}`,
    `- **Legacy Source**: ${output.featureFamily.legacySourcePath}`,
    `- **Legacy Formula**: ${output.featureFamily.legacySourceSymbolOrFormula}`,
    `- **Legacy Source SHA256**: ${output.legacyFeatureSource?.sha256 ?? "NOT_SUPPLIED"}`,
    `- **Round-Trip Cost (bps)**: ${output.roundTripCostBps}`,
    `- **Promotion Decision**: ${output.promotionDecision}`,
    `- **Does Economic Edge Repeat Across Time**: ${output.does0056EconomicEdgeRepeatAcrossTime}`,
    `- **Ever Beats Directional Baseline**: ${output.does0056EverBeatDirectionalBaseline}`,
    `- **CEO Next Route**: ${output.ceoNextRoute}`,
    "",
    "## Per-Cutoff Results",
    "",
    "| Cutoff | As Of | Train Rows | Train Purge | Validation Rows | Validation Purge | Final-Test Rows | Threshold | Accuracy | Majority Baseline | Accuracy Delta | Balanced Accuracy | Log Loss | Brier | Strategy Net | Benchmark Net | Excess | Strategy Max DD | Benchmark Max DD | Trades | Warnings |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const run of output.cutoffRuns) {
    const candidate = run.challenger;
    const economic = run.challengerEconomic;
    const warnings = run.warnings.length === 0 ? "None" : run.warnings.join("; ");
    lines.push(
      `| ${run.cutoff} | ${run.asOf} | ${candidate.trainingRows} | ${candidate.trainValidationPurgeRows} | `
      + `${candidate.validationRows} | ${candidate.validationFinalPurgeRows} | ${candidate.finalTestRows} | `
      + `${candidate.thresholdSelection.selectedThreshold.toFixed(6)} | ${candidate.finalTestMetrics.accuracy.toFixed(6)} | `
      + `${candidate.majorityBaselineAccuracy.toFixed(6)} | ${candidate.accuracyDelta.toFixed(6)} | `
      + `${candidate.finalTestMetrics.balancedAccuracy.toFixed(6)} | ${candidate.finalTestMetrics.logLoss.toFixed(6)} | `
      + `${candidate.finalTestMetrics.brierScore.toFixed(6)} | ${economic.strategyNetReturn.toFixed(6)} | `
      + `${economic.benchmarkNetReturn.toFixed(6)} | ${economic.excessReturn.toFixed(6)} | `
      + `${economic.strategyMaximumDrawdown.toFixed(6)} | ${economic.benchmarkMaximumDrawdown.toFixed(6)} | `
      + `${economic.tradeCount} | ${warnings} |`,
    );
  }

  lines.push(
    "",
    "## Control vs Challenger Directional and Economic Comparison",
    "",
    "| Cutoff | Control Accuracy | Challenger Accuracy | Accuracy Delta | Control Excess | Challenger Excess | Excess Delta |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const run of output.cutoffRuns) {
    const comparison = run.controlVsChallenger;
    lines.push(
      `| ${run.cutoff} | ${run.control.finalTestMetrics.accuracy.toFixed(8)} | ${run.challenger.finalTestMetrics.accuracy.toFixed(8)} | `
      + `${comparison.accuracyDeltaChallengerMinusIncumbent?.toFixed(8) ?? "UNAVAILABLE"} | `
      + `${run.controlEconomic.excessReturn.toFixed(8)} | ${run.challengerEconomic.excessReturn.toFixed(8)} | `
      + `${comparison.excessDeltaChallengerMinusIncumbent?.toFixed(8) ?? "UNAVAILABLE"} |`,
    );
  }

  const summary = output.temporalSummary;
  const controlSummary = output.controlTemporalSummary;
  const reproduction = output.controlReproduction;
  lines.push(
    "",
    "## Temporal Summary (Descriptive Only)",
    "",
    `- **Cutoff Count**: ${summary.temporalCutoffCount}`,
    `- **Positive Excess Cutoffs**: ${summary.positiveExcessCutoffCount}`,
    `- **Non-Positive Excess Cutoffs**: ${summary.nonPositiveExcessCutoffCount}`,
    `- **Positive Excess Fraction**: ${summary.positiveExcessFraction.toFixed(6)}`,
    `- **Median Excess Return**: ${summary.medianExcessReturn.toFixed(6)}`,
    `- **Minimum Excess Return**: ${summary.minimumExcessReturn.toFixed(6)}`,
    `- **Maximum Excess Return**: ${summary.maximumExcessReturn.toFixed(6)}`,
    `- **Latest Excess Return**: ${summary.latestExcessReturn.toFixed(6)}`,
    `- **Median Accuracy Delta vs Baseline**: ${summary.medianAccuracyDeltaVsBaseline.toFixed(6)}`,
    `- **Cutoffs Beating Directional Baseline**: ${summary.cutoffsBeatingDirectionalBaseline}`,
    `- **Observed Thresholds**: ${summary.observedThresholds.map((value) => value.toFixed(6)).join(", ")}`,
    `- **Threshold Range**: ${summary.thresholdRange.minimum.toFixed(6)} to ${summary.thresholdRange.maximum.toFixed(6)}`,
    "",
    "## Control Reproduction",
    "",
    `- **Status**: **${reproduction.status}**`,
    `- **Control Positive Excess Cutoffs**: ${controlSummary.positiveExcessCutoffCount}`,
    `- **Control Directional Baseline Wins**: ${controlSummary.numberOfCutoffsBeatingDirectionalBaseline}`,
    `- **Control Median Excess**: ${controlSummary.medianExcessReturn.toFixed(8)}`,
    `- **Control Latest Excess**: ${controlSummary.latestExcessReturn.toFixed(8)}`,
    `- **Challenger Accuracy Wins vs Control**: ${output.comparisonSummary.challengerAccuracyWinsVsControl}`,
    `- **Challenger Economic Wins vs Control**: ${output.comparisonSummary.challengerEconomicWinsVsControl}`,
    `- **Challenger Improves Both vs Control**: ${output.comparisonSummary.challengerImprovesBothVsControl}`,
    "",
    "## Contract Boundaries",
    "",
    "- Training-only scaler and logistic fit; validation-only threshold selection; untouched FINAL_TEST evaluation.",
    "- Canonical long/cash simulator with same-window ALWAYS_LONG buy-and-hold benchmark and canonical 10 bps costs.",
    "- No final-test-driven tuning; the control remains unchanged and the additive feature family was frozen before final-test inspection; no symbol selection, ranking, promotion, or execution.",
    "",
    "## Warnings",
    "",
  );
  for (const warning of output.warnings) lines.push(`- ${warning}`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const csvBytes = readPinnedGitBlob(args.legacyRepo, args.ref, args.csvPath);
  const actualSha256 = sha256Hex(csvBytes);
  if (actualSha256 !== args.expectedSha256) {
    throw new Error(`SOURCE_SHA256_MISMATCH:expected=${args.expectedSha256}:actual=${actualSha256}`);
  }
  const csvText = csvBytes.toString("utf8");
  const rawRows = parseTwStrategyResearchCsvText(csvText);

  if (args.returnHurdleLogisticChallenger) {
    if (args.challengerTemporal || args.balancedLogisticChallenger || args.gnbChallenger) {
      throw new Error("STOP_MMS_0056_RETURN_HURDLE_CHALLENGER_MODE_MIXED");
    }
    if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
      throw new Error("STOP_MMS_0056_RETURN_HURDLE_COST_OVERRIDE_UNSUPPORTED");
    }
    const validated = validateTwStrategyResearchRows(rawRows, {
      dataEndDate: args.dataEndDate,
      requiredSymbols: SUPPORTED_SYMBOLS,
    });
    if (validated.dateRange.max !== args.dataEndDate) {
      throw new Error(
        `STOP_MMS_0056_RETURN_HURDLE_TEMPORAL_DATA_AS_OF_MISMATCH:expected=${args.dataEndDate}:actual=${validated.dateRange.max}`,
      );
    }
    const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
    const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
      {
        splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
        stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
        stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
      },
      args.qualificationAsOf,
    );
    const qualification = qualifyTwseSnapshot(
      qualificationSnapshot,
      committedObservations,
      args.qualificationAsOf,
    );
    const reconciliation = qualification["0050Reconciliation"];
    const temporalRawRows = rawRows.map((row) => {
      if (row.symbol !== "0050") return row;
      const marketRow = toMarketRows([row], "0050")[0];
      if (marketRow === undefined) {
        throw new Error(`STOP_MMS_0056_RETURN_HURDLE_TEMPORAL_ADJUSTED_ROW_MISSING:${row.date}`);
      }
      const adjustedRow = applyBoundedAdjustment(
        [marketRow],
        reconciliation.effectiveDate,
        reconciliation.derivedAdjustmentFactor,
      )[0];
      if (adjustedRow === undefined) {
        throw new Error(`STOP_MMS_0056_RETURN_HURDLE_TEMPORAL_ADJUSTED_ROW_UNRESOLVED:${row.date}`);
      }
      return {
        ...row,
        open: adjustedRow.open,
        high: adjustedRow.high,
        low: adjustedRow.low,
        close: adjustedRow.close,
      };
    });
    const cutoffDates = validateCutoffDates(
      args.cutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    );
    const temporalResult = runPerSymbolReturnHurdleLogisticChallengerTemporal({
      rawRows: temporalRawRows,
      cutoffDates,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      datasetVersion: {
        datasetId: "p194_twstock_ohlcv_export",
        version: args.ref,
        source: "twstock/twse",
      },
      reviewDate: args.reviewDate,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    });
    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(temporalResult, null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(
      args.outDir,
      "mms_0056_cost_aware_return_hurdle_logistic_challenger_temporal_v1.json",
    );
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);
    console.log("CONTROL_REPRODUCTION=" + temporalResult.controlReproduction.status);
    console.log("PROMOTION_DECISION=" + temporalResult.promotionDecision);
    console.log("RETURN_HURDLE_CHALLENGER_CONCLUSION=" + temporalResult.returnHurdleChallengerConclusion);
    return;
  }

  if (args.gnbChallenger) {
    if (args.challengerTemporal || args.balancedLogisticChallenger) {
      throw new Error("STOP_MMS_0056_GNB_CHALLENGER_MODE_MIXED");
    }
    if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
      throw new Error("STOP_MMS_0056_GNB_TEMPORAL_COST_OVERRIDE_UNSUPPORTED");
    }
    const validated = validateTwStrategyResearchRows(rawRows, {
      dataEndDate: args.dataEndDate,
      requiredSymbols: SUPPORTED_SYMBOLS,
    });
    if (validated.dateRange.max !== args.dataEndDate) {
      throw new Error(
        `STOP_MMS_0056_GNB_TEMPORAL_DATA_AS_OF_MISMATCH:expected=${args.dataEndDate}:actual=${validated.dateRange.max}`,
      );
    }
    const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
    const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
      {
        splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
        stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
        stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
      },
      args.qualificationAsOf,
    );
    const qualification = qualifyTwseSnapshot(
      qualificationSnapshot,
      committedObservations,
      args.qualificationAsOf,
    );
    const reconciliation = qualification["0050Reconciliation"];
    const temporalRawRows = rawRows.map((row) => {
      if (row.symbol !== "0050") return row;
      const marketRow = toMarketRows([row], "0050")[0];
      if (marketRow === undefined) {
        throw new Error(`STOP_MMS_0056_GNB_TEMPORAL_ADJUSTED_ROW_MISSING:${row.date}`);
      }
      const adjustedRow = applyBoundedAdjustment(
        [marketRow],
        reconciliation.effectiveDate,
        reconciliation.derivedAdjustmentFactor,
      )[0];
      if (adjustedRow === undefined) {
        throw new Error(`STOP_MMS_0056_GNB_TEMPORAL_ADJUSTED_ROW_UNRESOLVED:${row.date}`);
      }
      return {
        ...row,
        open: adjustedRow.open,
        high: adjustedRow.high,
        low: adjustedRow.low,
        close: adjustedRow.close,
      };
    });
    const cutoffDates = validateCutoffDates(
      args.cutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    );
    const temporalResult = runPerSymbolGaussianNaiveBayesChallengerTemporal({
      rawRows: temporalRawRows,
      cutoffDates,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      datasetVersion: {
        datasetId: "p194_twstock_ohlcv_export",
        version: args.ref,
        source: "twstock/twse",
      },
      reviewDate: args.reviewDate,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    });
    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(temporalResult, null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(
      args.outDir,
      "mms_0056_gaussian_naive_bayes_challenger_temporal_v1.json",
    );
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);
    console.log("CONTROL_REPRODUCTION=" + temporalResult.controlReproduction.status);
    console.log("PROMOTION_DECISION=" + temporalResult.promotionDecision);
    console.log("GNB_CHALLENGER_CONCLUSION=" + temporalResult.gnbChallengerConclusion);
    return;
  }

  if (args.balancedLogisticChallenger) {
    if (args.challengerTemporal) {
      throw new Error("STOP_MMS_0056_BALANCED_LOGISTIC_FEATURE_CHALLENGER_MIXED");
    }
    if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
      throw new Error("STOP_MMS_0056_BALANCED_TEMPORAL_COST_OVERRIDE_UNSUPPORTED");
    }
    const validated = validateTwStrategyResearchRows(rawRows, {
      dataEndDate: args.dataEndDate,
      requiredSymbols: SUPPORTED_SYMBOLS,
    });
    if (validated.dateRange.max !== args.dataEndDate) {
      throw new Error(
        `STOP_MMS_0056_BALANCED_TEMPORAL_DATA_AS_OF_MISMATCH:expected=${args.dataEndDate}:actual=${validated.dateRange.max}`,
      );
    }
    const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
    const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
      {
        splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
        stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
        stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
      },
      args.qualificationAsOf,
    );
    const qualification = qualifyTwseSnapshot(
      qualificationSnapshot,
      committedObservations,
      args.qualificationAsOf,
    );
    const reconciliation = qualification["0050Reconciliation"];
    const temporalRawRows = rawRows.map((row) => {
      if (row.symbol !== "0050") return row;
      const marketRow = toMarketRows([row], "0050")[0];
      if (marketRow === undefined) {
        throw new Error(`STOP_MMS_0056_BALANCED_TEMPORAL_ADJUSTED_ROW_MISSING:${row.date}`);
      }
      const adjustedRow = applyBoundedAdjustment(
        [marketRow],
        reconciliation.effectiveDate,
        reconciliation.derivedAdjustmentFactor,
      )[0];
      if (adjustedRow === undefined) {
        throw new Error(`STOP_MMS_0056_BALANCED_TEMPORAL_ADJUSTED_ROW_UNRESOLVED:${row.date}`);
      }
      return {
        ...row,
        open: adjustedRow.open,
        high: adjustedRow.high,
        low: adjustedRow.low,
        close: adjustedRow.close,
      };
    });
    const cutoffDates = validateCutoffDates(
      args.cutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    );
    const temporalResult = runPerSymbolLogisticClassBalancedChallengerTemporal({
      rawRows: temporalRawRows,
      cutoffDates,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      datasetVersion: {
        datasetId: "p194_twstock_ohlcv_export",
        version: args.ref,
        source: "twstock/twse",
      },
      reviewDate: args.reviewDate,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    });

    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(temporalResult, null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(
      args.outDir,
      "mms_0056_class_balanced_logistic_challenger_temporal_v1.json",
    );
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);
    console.log("CONTROL_REPRODUCTION=" + temporalResult.controlReproduction.status);
    console.log("PROMOTION_DECISION=" + temporalResult.promotionDecision);
    console.log("CLASS_BALANCED_CHALLENGER_CONCLUSION=" + temporalResult.classBalancedChallengerConclusion);
    return;
  }

  if (args.challengerTemporal) {
    const legacyFeatureSourceBytes = readPinnedGitBlob(
      args.legacyRepo,
      args.ref,
      LEGACY_TECHNICAL_FEATURE_FAMILY.legacySourcePath,
    );
    const legacyFeatureSourceSha256 = sha256Hex(legacyFeatureSourceBytes);
    if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
      throw new Error("STOP_MMS_0056_TEMPORAL_COST_OVERRIDE_UNSUPPORTED");
    }
    const validated = validateTwStrategyResearchRows(rawRows, {
      dataEndDate: args.dataEndDate,
      requiredSymbols: SUPPORTED_SYMBOLS,
    });
    if (validated.dateRange.max !== args.dataEndDate) {
      throw new Error(
        `STOP_MMS_0056_TEMPORAL_DATA_AS_OF_MISMATCH:expected=${args.dataEndDate}:actual=${validated.dateRange.max}`,
      );
    }
    const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
    const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
      {
        splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
        stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
        stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
      },
      args.qualificationAsOf,
    );
    const qualification = qualifyTwseSnapshot(
      qualificationSnapshot,
      committedObservations,
      args.qualificationAsOf,
    );
    const reconciliation = qualification["0050Reconciliation"];
    const temporalRawRows = rawRows.map((row) => {
      if (row.symbol !== "0050") return row;
      const marketRow = toMarketRows([row], "0050")[0];
      if (marketRow === undefined) {
        throw new Error(`STOP_MMS_0056_TEMPORAL_ADJUSTED_ROW_MISSING:${row.date}`);
      }
      const adjustedRow = applyBoundedAdjustment(
        [marketRow],
        reconciliation.effectiveDate,
        reconciliation.derivedAdjustmentFactor,
      )[0];
      if (adjustedRow === undefined) {
        throw new Error(`STOP_MMS_0056_TEMPORAL_ADJUSTED_ROW_UNRESOLVED:${row.date}`);
      }
      return {
        ...row,
        open: adjustedRow.open,
        high: adjustedRow.high,
        low: adjustedRow.low,
        close: adjustedRow.close,
      };
    });
    const cutoffDates = validateCutoffDates(
      args.cutoffs ?? SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES,
    );
    const temporalResult = runPerSymbolLogisticChallengerTemporalConfirmation({
      rawRows: temporalRawRows,
      cutoffDates,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      datasetVersion: {
        datasetId: "p194_twstock_ohlcv_export",
        version: args.ref,
        source: "twstock/twse",
      },
      reviewDate: args.reviewDate,
      candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
      legacyFeatureSource: {
        path: LEGACY_TECHNICAL_FEATURE_FAMILY.legacySourcePath,
        sha256: legacyFeatureSourceSha256,
      },
    });

    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(temporalResult, null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(
      args.outDir,
      "mms_0056_per_symbol_logistic_challenger_temporal_confirmation_v1.json",
    );
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);

    const mdText = generatePerSymbolLogisticChallengerTemporalMarkdown(temporalResult);
    const mdSha256 = sha256Hex(Buffer.from(mdText, "utf8"));
    const mdFile = path.join(
      args.outDir,
      "mms_0056_per_symbol_logistic_challenger_temporal_confirmation_v1.md",
    );
    writeFileSync(mdFile, mdText);
    console.log("MARKDOWN_OUTPUT_SHA256=" + mdSha256);
    console.log("wrote " + mdFile);
    return;
  }

  if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
    // Transaction Cost Sensitivity Study Mode
    const validatedCutoffs = validateCutoffDates(args.cutoffs || SUPPORTED_TW_STRATEGY_TEMPORAL_CUTOFF_DATES);
    const validatedCosts = validateRoundTripCostBpsGrid(args.roundTripCostBps);

    const executeCutoffScenariosAtCost = ({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows, roundTripCostBps }) => {
      const validated = validateTwStrategyResearchRows(cutoffRawRows, {
        dataEndDate: resolvedDataEndDate,
        requiredSymbols: SUPPORTED_SYMBOLS,
      });

      const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
      const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
        {
          splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
          stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
          stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
        },
        args.qualificationAsOf,
      );
      const qualification = qualifyTwseSnapshot(qualificationSnapshot, committedObservations, args.qualificationAsOf);
      const reconciliation = qualification["0050Reconciliation"];

      const rows2330Raw = toMarketRows(validated.rows, "2330");
      const rows0050Raw = toMarketRows(validated.rows, "0050");

      const result2330RawControl = runScenario("2330", rows2330Raw, TW_STABILITY_RESEARCH_POLICY_V1, roundTripCostBps);
      const result0050Raw = runScenario("0050", rows0050Raw, TW_STABILITY_RESEARCH_POLICY_V1, roundTripCostBps);

      const adjustmentFactor = reconciliation.derivedAdjustmentFactor;
      const effectiveDate = reconciliation.effectiveDate;
      const rows0050Adjusted = applyBoundedAdjustment(rows0050Raw, effectiveDate, adjustmentFactor);
      const result0050Adjusted = runScenario("0050", rows0050Adjusted, TW_STABILITY_RESEARCH_POLICY_V1, roundTripCostBps);

      const scenarios = {
        "2330_RAW_CONTROL": scenarioOutput("2330", "RAW_CONTROL", result2330RawControl, {
          adjustmentApplied: false,
          pointInTimeStatus: "N/A_NO_CORPORATE_ACTION",
        }),
        "0050_RAW": scenarioOutput("0050", "RAW", result0050Raw, {
          adjustmentApplied: false,
          pointInTimeStatus: "N/A_UNADJUSTED_BY_DESIGN",
        }),
        "0050_SOURCE_QUALIFIED_ADJUSTED": scenarioOutput(
          "0050",
          "SOURCE_QUALIFIED_ADJUSTED",
          result0050Adjusted,
          {
            adjustmentApplied: true,
            pointInTimeStatus: qualification.pointInTimeStatus,
          },
        ),
      };

      const scenarioSummaryInputs = {
        "2330_RAW_CONTROL": {
          cutoffDate: requestedCutoffDate,
          overallPass: result2330RawControl.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result2330RawControl.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result2330RawControl.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result2330RawControl.stability.dominantSelectedThresholdRatio),
          operativePosition: result2330RawControl.latestSignal.position,
          latestSignalAsOf: result2330RawControl.latestSignal.signalAsOfFeatureDate,
        },
        "0050_RAW": {
          cutoffDate: requestedCutoffDate,
          overallPass: result0050Raw.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result0050Raw.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result0050Raw.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result0050Raw.stability.dominantSelectedThresholdRatio),
          operativePosition: result0050Raw.latestSignal.position,
          latestSignalAsOf: result0050Raw.latestSignal.signalAsOfFeatureDate,
        },
        "0050_SOURCE_QUALIFIED_ADJUSTED": {
          cutoffDate: requestedCutoffDate,
          overallPass: result0050Adjusted.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result0050Adjusted.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result0050Adjusted.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result0050Adjusted.stability.dominantSelectedThresholdRatio),
          operativePosition: result0050Adjusted.latestSignal.position,
          latestSignalAsOf: result0050Adjusted.latestSignal.signalAsOfFeatureDate,
        },
      };

      return { scenarios, scenarioSummaryInputs };
    };

    const sensitivityResult = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates: validatedCutoffs,
      roundTripCostBpsValues: validatedCosts,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      reviewDate: args.reviewDate,
      executeCutoffScenariosAtCost,
    });

    // Ten-Bps Invariance Gate Check:
    if (validatedCosts.includes(10)) {
      const executeCutoffScenarios10Bps = ({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows }) =>
        executeCutoffScenariosAtCost({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows, roundTripCostBps: 10 });
      const refTemporalStudy = runTwStrategyTemporalRobustnessStudy({
        rawRows,
        cutoffDates: validatedCutoffs,
        source: { path: args.csvPath, sha256: actualSha256 },
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        reviewDate: args.reviewDate,
        executeCutoffScenarios: executeCutoffScenarios10Bps,
      });

      const slice10Bps = sensitivityResult.temporalStudiesByCost["10"];
      if (!slice10Bps) {
        throw new Error("STOP_MMS_TW_COST_SENSITIVITY_TEN_BPS_DRIFT: 10 bps slice missing from study result");
      }

      const slice10BpsJson = JSON.stringify(slice10Bps);
      const refTemporalJson = JSON.stringify(refTemporalStudy);

      if (slice10BpsJson !== refTemporalJson) {
        throw new Error("STOP_MMS_TW_COST_SENSITIVITY_TEN_BPS_DRIFT: 10 bps slice differs from reference temporal robustness study");
      }
    }

    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(serializeResearchOutputForJson(sensitivityResult), null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(args.outDir, "tw_strategy_transaction_cost_sensitivity_study_v1.json");
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);

    const mdText = generateSensitivityMarkdownReport(sensitivityResult);
    const mdSha256 = sha256Hex(Buffer.from(mdText, "utf8"));
    const mdFile = path.join(args.outDir, "tw_strategy_transaction_cost_sensitivity_study_v1.md");
    writeFileSync(mdFile, mdText);
    console.log("MARKDOWN_OUTPUT_SHA256=" + mdSha256);
    console.log("wrote " + mdFile);
    return;
  }

  if (args.cutoffs && args.cutoffs.length > 0) {
    // Temporal Robustness Study Mode
    const validatedCutoffs = validateCutoffDates(args.cutoffs);

    const executeCutoffScenarios = ({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows }) => {
      const validated = validateTwStrategyResearchRows(cutoffRawRows, {
        dataEndDate: resolvedDataEndDate,
        requiredSymbols: SUPPORTED_SYMBOLS,
      });

      const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
      const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
        {
          splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
          stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
          stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
        },
        args.qualificationAsOf,
      );
      const qualification = qualifyTwseSnapshot(qualificationSnapshot, committedObservations, args.qualificationAsOf);
      const reconciliation = qualification["0050Reconciliation"];

      const rows2330Raw = toMarketRows(validated.rows, "2330");
      const rows0050Raw = toMarketRows(validated.rows, "0050");

      const result2330RawControl = runScenario("2330", rows2330Raw);
      const result0050Raw = runScenario("0050", rows0050Raw);

      const adjustmentFactor = reconciliation.derivedAdjustmentFactor;
      const effectiveDate = reconciliation.effectiveDate;
      const rows0050Adjusted = applyBoundedAdjustment(rows0050Raw, effectiveDate, adjustmentFactor);
      const result0050Adjusted = runScenario("0050", rows0050Adjusted);

      const scenarios = {
        "2330_RAW_CONTROL": scenarioOutput("2330", "RAW_CONTROL", result2330RawControl, {
          adjustmentApplied: false,
          pointInTimeStatus: "N/A_NO_CORPORATE_ACTION",
        }),
        "0050_RAW": scenarioOutput("0050", "RAW", result0050Raw, {
          adjustmentApplied: false,
          pointInTimeStatus: "N/A_UNADJUSTED_BY_DESIGN",
        }),
        "0050_SOURCE_QUALIFIED_ADJUSTED": scenarioOutput(
          "0050",
          "SOURCE_QUALIFIED_ADJUSTED",
          result0050Adjusted,
          {
            adjustmentApplied: true,
            pointInTimeStatus: qualification.pointInTimeStatus,
          },
        ),
      };

      const scenarioSummaryInputs = {
        "2330_RAW_CONTROL": {
          cutoffDate: requestedCutoffDate,
          overallPass: result2330RawControl.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result2330RawControl.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result2330RawControl.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result2330RawControl.stability.dominantSelectedThresholdRatio),
          operativePosition: result2330RawControl.latestSignal.position,
          latestSignalAsOf: result2330RawControl.latestSignal.signalAsOfFeatureDate,
        },
        "0050_RAW": {
          cutoffDate: requestedCutoffDate,
          overallPass: result0050Raw.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result0050Raw.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result0050Raw.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result0050Raw.stability.dominantSelectedThresholdRatio),
          operativePosition: result0050Raw.latestSignal.position,
          latestSignalAsOf: result0050Raw.latestSignal.signalAsOfFeatureDate,
        },
        "0050_SOURCE_QUALIFIED_ADJUSTED": {
          cutoffDate: requestedCutoffDate,
          overallPass: result0050Adjusted.stabilityGate.overallPass,
          aggregateExcessReturn: round8(result0050Adjusted.walkForward.aggregateExcessReturn),
          aggregateMaximumDrawdown: round8(result0050Adjusted.walkForward.aggregateMaximumStrategyDrawdown),
          dominantThresholdRatio: round8(result0050Adjusted.stability.dominantSelectedThresholdRatio),
          operativePosition: result0050Adjusted.latestSignal.position,
          latestSignalAsOf: result0050Adjusted.latestSignal.signalAsOfFeatureDate,
        },
      };

      return { scenarios, scenarioSummaryInputs };
    };

    const studyResult = runTwStrategyTemporalRobustnessStudy({
      rawRows,
      cutoffDates: validatedCutoffs,
      source: {
        path: args.csvPath,
        sha256: actualSha256,
      },
      policy: TW_STABILITY_RESEARCH_POLICY_V1,
      reviewDate: args.reviewDate,
      executeCutoffScenarios,
    });

    // Invariance Check for the final cutoff (2026-07-01):
    // Run single canonical study to verify exact match on load-bearing fields
    const finalCutoffDate = validatedCutoffs.at(-1);
    if (finalCutoffDate === "2026-07-01") {
      const canonicalValidated = validateTwStrategyResearchRows(rawRows, {
        dataEndDate: args.dataEndDate,
        requiredSymbols: SUPPORTED_SYMBOLS,
      });
      const canonical2330 = runScenario("2330", toMarketRows(canonicalValidated.rows, "2330"));
      const canonical0050Raw = runScenario("0050", toMarketRows(canonicalValidated.rows, "0050"));

      const committedObs = parseCommittedQualificationObservationsFromText(csvText);
      const qualSnapshot = buildTwseQualificationSnapshotFromFixture(
        {
          splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
          stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
          stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
        },
        args.qualificationAsOf,
      );
      const qual = qualifyTwseSnapshot(qualSnapshot, committedObs, args.qualificationAsOf);
      const canonical0050Adj = runScenario(
        "0050",
        applyBoundedAdjustment(
          toMarketRows(canonicalValidated.rows, "0050"),
          qual["0050Reconciliation"].effectiveDate,
          qual["0050Reconciliation"].derivedAdjustmentFactor,
        ),
      );

      const finalRun = studyResult.cutoffRuns.at(-1);
      const s2330 = finalRun.scenarios["2330_RAW_CONTROL"];
      const s0050Raw = finalRun.scenarios["0050_RAW"];
      const s0050Adj = finalRun.scenarios["0050_SOURCE_QUALIFIED_ADJUSTED"];

      const checks = [
        s2330.stabilityGate.overallPass === canonical2330.stabilityGate.overallPass,
        s0050Raw.stabilityGate.overallPass === canonical0050Raw.stabilityGate.overallPass,
        s0050Adj.stabilityGate.overallPass === canonical0050Adj.stabilityGate.overallPass,
        round8(s2330.walkForward.aggregateExcessReturn) === round8(canonical2330.walkForward.aggregateExcessReturn),
        round8(s0050Raw.walkForward.aggregateExcessReturn) === round8(canonical0050Raw.walkForward.aggregateExcessReturn),
        round8(s0050Adj.walkForward.aggregateExcessReturn) === round8(canonical0050Adj.walkForward.aggregateExcessReturn),
      ];

      if (checks.some((c) => !c)) {
        throw new Error("STOP_MMS_TW_TEMPORAL_ROBUSTNESS_SEMANTIC_DRIFT: final cutoff metrics drift from canonical baseline");
      }
    }

    mkdirSync(args.outDir, { recursive: true });
    const jsonText = JSON.stringify(serializeResearchOutputForJson(studyResult), null, 2) + "\n";
    const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
    const jsonFile = path.join(args.outDir, "tw_strategy_temporal_robustness_study_v1.json");
    writeFileSync(jsonFile, jsonText);
    console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
    console.log("wrote " + jsonFile);

    const mdText = generateTemporalMarkdownReport(studyResult);
    const mdSha256 = sha256Hex(Buffer.from(mdText, "utf8"));
    const mdFile = path.join(args.outDir, "tw_strategy_temporal_robustness_study_v1.md");
    writeFileSync(mdFile, mdText);
    console.log("MARKDOWN_OUTPUT_SHA256=" + mdSha256);
    console.log("wrote " + mdFile);
    return;
  }

  // Single Canonical Research Study Mode (Default)
  const validated = validateTwStrategyResearchRows(rawRows, {
    dataEndDate: args.dataEndDate,
    requiredSymbols: SUPPORTED_SYMBOLS,
  });

  const committedObservations = parseCommittedQualificationObservationsFromText(csvText);
  const qualificationSnapshot = buildTwseQualificationSnapshotFromFixture(
    {
      splitReference: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, "utf8")),
      stockDay0050: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, "utf8")),
      stockDay2330: sha256Hex(Buffer.from(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, "utf8")),
    },
    args.qualificationAsOf,
  );
  const qualification = qualifyTwseSnapshot(qualificationSnapshot, committedObservations, args.qualificationAsOf);
  const reconciliation = qualification["0050Reconciliation"];
  const control2330 = qualification["2330Control"];

  const rows2330Raw = toMarketRows(validated.rows, "2330");
  const rows0050Raw = toMarketRows(validated.rows, "0050");

  const result2330RawControl = runScenario("2330", rows2330Raw);
  const result0050Raw = runScenario("0050", rows0050Raw);

  const adjustmentFactor = reconciliation.derivedAdjustmentFactor;
  const effectiveDate = reconciliation.effectiveDate;
  const rows0050Adjusted = applyBoundedAdjustment(rows0050Raw, effectiveDate, adjustmentFactor);
  const result0050Adjusted = runScenario("0050", rows0050Adjusted);

  const scenarios = {
    "2330_RAW_CONTROL": scenarioOutput("2330", "RAW_CONTROL", result2330RawControl, {
      adjustmentApplied: false,
      pointInTimeStatus: "N/A_NO_CORPORATE_ACTION",
    }),
    "0050_RAW": scenarioOutput("0050", "RAW", result0050Raw, {
      adjustmentApplied: false,
      pointInTimeStatus: "N/A_UNADJUSTED_BY_DESIGN",
    }),
    "0050_SOURCE_QUALIFIED_ADJUSTED": scenarioOutput(
      "0050",
      "SOURCE_QUALIFIED_ADJUSTED",
      result0050Adjusted,
      {
        adjustmentApplied: true,
        pointInTimeStatus: qualification.pointInTimeStatus,
      },
    ),
  };

  const canonicalMarketRows = toCanonicalMarketRows(validated.rows);
  const adjusted0050ByDate = new Map(rows0050Adjusted.map((row) => [row.date, row]));
  const adjustedCanonicalMarketRows = canonicalMarketRows.map((row) => {
    if (row.symbol !== "0050") return row;
    const adjustedRow = adjusted0050ByDate.get(row.date);
    if (adjustedRow === undefined) {
      throw new Error(`STOP_MMS_0050_RECONCILIATION_ADJUSTED_ROW_MISSING:${row.date}`);
    }
    return adjustedRow;
  });
  const researchDatasetVersion = {
    datasetId: "p194_twstock_ohlcv_export",
    version: args.ref,
    source: "twstock/twse",
  };
  const rawResearchEvidenceResult = runResearchEvidenceKernel({
    datasetVersion: researchDatasetVersion,
    marketRows: canonicalMarketRows,
  });
  const adjustedResearchEvidenceResult = runResearchEvidenceKernel({
    datasetVersion: researchDatasetVersion,
    marketRows: adjustedCanonicalMarketRows,
  });
  const currentUnresolvedPredictionsForReconciliation = CONTRACT_SCENARIO_IDS
    .map((scenarioId) => contractCurrentUnresolvedPrediction(scenarioId, scenarios[scenarioId]))
    .filter((prediction) => prediction !== undefined);
  const currentUnresolvedKeysForReconciliation = new Set(
    currentUnresolvedPredictionsForReconciliation
      .map((prediction) => `${prediction.symbol}:${prediction.featureDate}`),
  );
  assertFinalTestEconomicBoundary(
    "MMS_0050_RECONCILIATION_RAW",
    rawResearchEvidenceResult,
    currentUnresolvedKeysForReconciliation,
    validated.dateRange.max,
  );
  assertFinalTestEconomicBoundary(
    "MMS_0050_RECONCILIATION_ADJUSTED",
    adjustedResearchEvidenceResult,
    currentUnresolvedKeysForReconciliation,
    validated.dateRange.max,
  );
  const corporateActionWarnings = [
    `corporateActionType=${reconciliation.corporateActionType}`,
    `effectiveDate=${reconciliation.effectiveDate}`,
    `adjustmentCoverage=${ADJUSTMENT_COVERAGE}`,
    `volumeAdjustmentStatus=${VOLUME_ADJUSTMENT_STATUS}`,
    ...qualification.remainingRisks,
  ];
  const finalTestEconomicReconciliation = reconcileFinalTestEconomicEdge({
    raw: {
      scenario: "0050_RAW",
      sourceDataQualityClassification: "RAW_UNADJUSTED_PRICE_PATH",
      sourceEvidenceReference: `${args.ref}:${args.csvPath}`,
      finalTestEvidence: rawResearchEvidenceResult.finalTestEconomicEvidence,
      dataQualityFindings: result0050Raw.dataQualityFindings,
      corporateActionWarnings,
    },
    adjusted: {
      scenario: "0050_SOURCE_QUALIFIED_ADJUSTED",
      sourceDataQualityClassification: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
      sourceEvidenceReference: `${args.ref}:${args.csvPath}:TWSE_0050_SOURCE_QUALIFIED_ADJUSTED`,
      finalTestEvidence: adjustedResearchEvidenceResult.finalTestEconomicEvidence,
      dataQualityFindings: result0050Adjusted.dataQualityFindings,
      corporateActionWarnings,
    },
    roundTripCostBps: ROUND_TRIP_COST_BPS,
    initialCapital: INITIAL_CAPITAL,
  });

  if (adjustedResearchEvidenceResult.perSymbolLogisticChallenger === undefined
    || adjustedResearchEvidenceResult.finalTestEconomicEvidence === undefined) {
    throw new Error("STOP_MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_EVIDENCE_UNRESOLVED");
  }
  const perSymbolLogisticChallenger = buildPerSymbolLogisticChallengerEvaluation({
    challenger: adjustedResearchEvidenceResult.perSymbolLogisticChallenger,
    incumbentEvidence: adjustedResearchEvidenceResult.evidence,
    incumbentFinalTestEconomicEvidence: adjustedResearchEvidenceResult.finalTestEconomicEvidence,
    candidateDataQualityBasis: "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    roundTripCostBps: ROUND_TRIP_COST_BPS,
    initialCapital: INITIAL_CAPITAL,
  });

  const rawVsAdjustedDeltas = {
    dataQualityFindingCountDelta:
      result0050Adjusted.dataQualityFindings.length - result0050Raw.dataQualityFindings.length,
    cumulativeAggregateStrategyReturnDelta: round8(
      result0050Adjusted.walkForward.cumulativeAggregateStrategyReturn
      - result0050Raw.walkForward.cumulativeAggregateStrategyReturn,
    ),
    cumulativeAggregateBenchmarkReturnDelta: round8(
      result0050Adjusted.walkForward.cumulativeAggregateBenchmarkReturn
      - result0050Raw.walkForward.cumulativeAggregateBenchmarkReturn,
    ),
    aggregateExcessReturnDelta: round8(
      result0050Adjusted.walkForward.aggregateExcessReturn
      - result0050Raw.walkForward.aggregateExcessReturn,
    ),
    latestSignalPositionRaw: result0050Raw.latestSignal.position,
    latestSignalPositionAdjusted: result0050Adjusted.latestSignal.position,
  };

  const legacyRefitReportBytes = readPinnedGitBlob(args.legacyRepo, args.ref, args.refitReportPath);
  const legacyRefitReport = JSON.parse(legacyRefitReportBytes.toString("utf8"));

  const output = {
    schemaVersion: "MMS_TW_STRATEGY_RESEARCH_RUNNER_V1",
    classification: "MMS_TW_STRATEGY_RESEARCH_RUNNER_V1_IMPLEMENTED_AWAITING_AUTHORIZATION",
    dataClassification: "HISTORICAL_RESEARCH_STUDY",
    reviewDate: args.reviewDate,
    researchMode: "diagnostic-only",
    providesInvestmentAdvice: false,
    currentDatePredictionClaim: CURRENT_DATE_PREDICTION_CLAIM,
    currentUnresolvedPredictionClaim: true,
    repositories: {
      legacyRepo: { path: args.legacyRepo, ref: args.ref },
    },
    source: {
      path: args.csvPath,
      sha256: actualSha256,
      dateRange: validated.dateRange,
      rowCount: validated.rows.length,
      symbolsPresent: validated.symbolsPresent,
      dataEndDate: args.dataEndDate,
    },
    legacyMlRetraining: {
      runId: legacyRefitReport.run.runId,
      holdoutAccuracy: legacyRefitReport.run.holdoutMetrics.accuracy,
      majorityBaselineAccuracy: legacyRefitReport.run.holdoutMetrics.majorityBaselineAccuracy,
      interpretation: legacyRefitReport.run.interpretation,
      legacyMlRetrainingStatus: LEGACY_ML_RETRAINING_STATUS,
    },
    strategyFamilyAndVersion: {
      name: "@mms/strategy-simulator long/cash validation-threshold replay",
      v1BenchmarkPolicy: "ALWAYS_LONG_BENCHMARK",
      v2CalibratedPolicy: "VALIDATION_THRESHOLD_LONG_CASH",
      probabilitySource:
        "@mms/research-kernel logistic regression over 5 features, fit per fold on strictly "
        + "earlier rows only (expanding window, no test-fold leakage)",
      candidateThresholds: CANDIDATE_THRESHOLDS,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
      stabilityGatePolicy: TW_STABILITY_RESEARCH_POLICY_V1,
    },
    scenarios,
    adjustmentQualification: {
      status: qualification.qualificationStatus,
      pointInTimeStatus: qualification.pointInTimeStatus,
      corporateActionType: reconciliation.corporateActionType,
      effectiveDate: reconciliation.effectiveDate,
      derivedAdjustmentFactor: reconciliation.derivedAdjustmentFactor,
      rawCloseToCloseReturn: reconciliation.rawCloseToCloseReturn,
      adjustedCloseToCloseReturn: reconciliation.adjustedCloseToCloseReturn,
      controlSymbol2330: {
        status: control2330.status,
        corporateActionReported: control2330.corporateActionReported,
        fabricatedEvent: control2330.fabricatedEvent,
      },
      adjustmentCoverage: ADJUSTMENT_COVERAGE,
      volumeAdjustmentStatus: VOLUME_ADJUSTMENT_STATUS,
      remainingRisks: qualification.remainingRisks,
    },
    rawVsAdjusted0050Deltas: rawVsAdjustedDeltas,
    rawVsAdjusted0050FinalTestEconomicReconciliation: finalTestEconomicReconciliation,
    perSymbolLogisticChallenger,
    legacyMlRetrainingStatus: LEGACY_ML_RETRAINING_STATUS,
    promotionDecision: PROMOTION_DECISION,
    promotionReason: PROMOTION_REASON,
    limitations: [
      "Single-symbol, non-overlapping replay only; no multi-symbol portfolio construction.",
      "roundTripCostBps=10 is an existing-test-fixture convention adopted for disclosure, not a "
        + "verified brokerage/tax fee schedule for TWSE-listed instruments.",
      "Volume was not adjusted for the 0050 split (volumeAdjustmentStatus=NOT_APPLIED); "
        + "volume-derived features remain raw across all scenarios.",
      "This is a historical research study (dataEndDate " + args.dataEndDate + "); resolved latest "
        + "signals use rows whose forward-return targets are available, while current unresolved "
        + "signals use the latest feature row with a future target date derived from the existing "
        + "five-trading-row horizon.",
      "No promotion, ranking, or investment-advice claim is made; stability diagnostics and gate "
        + "evaluations are reported for research review only.",
      "Per-symbol challenger evaluation uses SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH for 0050; RAW 0050 remains control provenance only.",
    ],
    blockedScenarios: [],
  };

  mkdirSync(args.outDir, { recursive: true });
  const jsonText = JSON.stringify(serializeResearchOutputForJson(output), null, 2) + "\n";
  const jsonSha256 = sha256Hex(Buffer.from(jsonText, "utf8"));
  const jsonFile = path.join(args.outDir, "tw_strategy_research_study_v1.json");
  writeFileSync(jsonFile, jsonText);
  console.log("JSON_OUTPUT_SHA256=" + jsonSha256);
  console.log("wrote " + jsonFile);

  const mdText = generateMarkdownReport(output);
  const mdSha256 = sha256Hex(Buffer.from(mdText, "utf8"));
  const mdFile = path.join(args.outDir, "tw_strategy_research_study_v1.md");
  writeFileSync(mdFile, mdText);
  console.log("MARKDOWN_OUTPUT_SHA256=" + mdSha256);
  console.log("wrote " + mdFile);

  const challengerJsonText = JSON.stringify(perSymbolLogisticChallenger, null, 2) + "\n";
  const challengerJsonSha256 = sha256Hex(Buffer.from(challengerJsonText, "utf8"));
  const challengerJsonFile = path.join(
    args.outDir,
    "mms_per_symbol_logistic_challenger_v1.json",
  );
  writeFileSync(challengerJsonFile, challengerJsonText);
  console.log("PER_SYMBOL_LOGISTIC_CHALLENGER_JSON_SHA256=" + challengerJsonSha256);
  console.log("wrote " + challengerJsonFile);

  const predictionRetrainingResult = buildPredictionRetrainingResultV1FromFreshResearch({
    output,
    rawRows,
    generatedAt: new Date().toISOString(),
    researchEvidenceResult: rawResearchEvidenceResult,
    finalTestEconomicReconciliation,
    perSymbolLogisticChallenger,
  });
  const predictionRetrainingJsonText = JSON.stringify(predictionRetrainingResult, null, 2) + "\n";
  const predictionRetrainingJsonSha256 = sha256Hex(Buffer.from(predictionRetrainingJsonText, "utf8"));
  const predictionRetrainingJsonFile = path.join(
    args.outDir,
    "mms_prediction_retraining_result_v1.json",
  );
  writeFileSync(predictionRetrainingJsonFile, predictionRetrainingJsonText);
  console.log("PREDICTION_RETRAINING_RESULT_JSON_SHA256=" + predictionRetrainingJsonSha256);
  console.log("wrote " + predictionRetrainingJsonFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

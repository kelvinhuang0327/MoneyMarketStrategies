#!/usr/bin/env node
// Thin CLI: owns every Node-specific concern (reading the pinned git blob,
// verifying its SHA-256 pin, hashing fixture payload text) and composes
// @mms/research-kernel's pure TW strategy research runner primitives with
// @mms/strategy-simulator's existing walk-forward/threshold evaluation to
// produce the three required scenarios (2330_RAW_CONTROL, 0050_RAW,
// 0050_SOURCE_QUALIFIED_ADJUSTED) as deterministic JSON. Diagnostic-only: no
// investment advice, no promotion, no execution, no network access, no
// writes to the legacy repository.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ADJUSTMENT_COVERAGE,
  applyBoundedAdjustment,
  buildScenarioFoldInputs,
  buildTwseQualificationSnapshotFromFixture,
  CANDIDATE_THRESHOLDS,
  CURRENT_DATE_PREDICTION_CLAIM,
  INITIAL_CAPITAL,
  LEGACY_ML_RETRAINING_STATUS,
  parseCommittedQualificationObservationsFromText,
  parseTwStrategyResearchCsvText,
  PROMOTION_DECISION,
  PROMOTION_REASON,
  qualifyTwseSnapshot,
  ROUND_TRIP_COST_BPS,
  toMarketRows,
  TWSE_QUALIFICATION_FIXTURE_PAYLOADS,
  validateTwStrategyResearchRows,
  VOLUME_ADJUSTMENT_STATUS,
} from "@mms/research-kernel";
import {
  runWalkForwardThresholdEvaluation,
  summarizeWalkForwardStability,
} from "@mms/strategy-simulator";

const DEFAULTS = Object.freeze({
  legacyRepo: "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System",
  ref: "2fc90673cd79b711108e3c7d92cbaa2b6dd461dc",
  csvPath: "outputs/retraining/p194_twstock_ohlcv_export.csv",
  refitReportPath: "outputs/retraining/p193_real_ohlcv_refit_report.json",
  expectedSha256: "2d1aaee13c11015b7d9619e7fe45901cf87283694679a32a410ac03e4854185f",
  dataEndDate: "2026-07-01",
  reviewDate: "2026-07-31",
  qualificationAsOf: "2025-06-18T10:00:00.000Z",
  outDir: "/Users/kelvin/VibeCoding-WorkSpace/_scratch/mms-tw-strategy-research-run-v1",
});

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (key === "legacy-repo") args.legacyRepo = value;
    else if (key === "ref") args.ref = value;
    else if (key === "csv-path") args.csvPath = value;
    else if (key === "refit-report-path") args.refitReportPath = value;
    else if (key === "expected-sha256") args.expectedSha256 = value;
    else if (key === "data-end-date") args.dataEndDate = value;
    else if (key === "review-date") args.reviewDate = value;
    else if (key === "out-dir") args.outDir = value;
    else throw new Error(`unrecognized flag --${key}`);
    index += 1;
  }
  return args;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a file's bytes at a pinned git ref via `git show` (no working-tree checkout, no network, no write to the referenced repository). */
function readPinnedGitBlob(repoPath, ref, relativePath) {
  return execFileSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function round8(value) {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function runScenario(symbol, marketRows) {
  const prep = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
  const walkForward = runWalkForwardThresholdEvaluation({
    symbol,
    roundTripCostBps: ROUND_TRIP_COST_BPS,
    initialCapital: INITIAL_CAPITAL,
    folds: prep.foldInputs,
  });
  const stability = summarizeWalkForwardStability(walkForward);
  const operativeThreshold = walkForward.foldResults.at(-1).selectedThreshold;
  const position = prep.latestSignal.probabilityUp >= operativeThreshold ? "LONG" : "CASH";
  return {
    dataQualityFindings: prep.dataQualityFindings,
    featureRowCount: prep.featureRowCount,
    foldBoundaries: prep.foldBoundaries,
    walkForward,
    stability,
    latestSignal: {
      ...prep.latestSignal,
      operativeThreshold,
      position,
    },
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
    stability: result.stability,
    latestSignal: result.latestSignal,
  };
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
  const validated = validateTwStrategyResearchRows(rawRows, {
    dataEndDate: args.dataEndDate,
    requiredSymbols: ["2330", "0050"],
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
    },
    scenarios: {
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
    },
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
    legacyMlRetrainingStatus: LEGACY_ML_RETRAINING_STATUS,
    promotionDecision: PROMOTION_DECISION,
    promotionReason: PROMOTION_REASON,
    limitations: [
      "Single-symbol, non-overlapping replay only; no multi-symbol portfolio construction.",
      "roundTripCostBps=10 is an existing-test-fixture convention adopted for disclosure, not a "
        + "verified brokerage/tax fee schedule for TWSE-listed instruments.",
      "Volume was not adjusted for the 0050 split (volumeAdjustmentStatus=NOT_APPLIED); "
        + "volume-derived features remain raw across all scenarios.",
      "This is a historical research study (dataEndDate " + args.dataEndDate + "); the 'latest "
        + "signal' is the most recent row whose forward-return target already resolved in the "
        + "pinned dataset, not a live/current call (currentDatePredictionClaim=false).",
      "No promotion, ranking, or investment-advice claim is made; stability diagnostics are "
        + "reported for research review only.",
    ],
    blockedScenarios: [],
  };

  mkdirSync(args.outDir, { recursive: true });
  const json = JSON.stringify(output, null, 2);
  writeFileSync(path.join(args.outDir, "tw_strategy_research_study_v1.json"), json + "\n");
  console.log("OUTPUT_SHA256=" + sha256Hex(Buffer.from(json + "\n", "utf8")));
  console.log("wrote " + path.join(args.outDir, "tw_strategy_research_study_v1.json"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

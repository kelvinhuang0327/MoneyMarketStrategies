#!/usr/bin/env node
// Thin CLI: owns every Node-specific concern (reading the pinned git blob,
// verifying its SHA-256 pin, hashing fixture payload text) and composes
// @mms/research-kernel's pure TW strategy research runner primitives with
// @mms/strategy-simulator's walk-forward/threshold evaluation and stability
// gate to produce the three required scenarios (2330_RAW_CONTROL, 0050_RAW,
// 0050_SOURCE_QUALIFIED_ADJUSTED) as deterministic JSON and Markdown.
// Diagnostic-only: no investment advice, no promotion, no execution, no network
// access, no writes to the legacy repository.
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
  runTwStrategyTemporalRobustnessStudy,
  runTwStrategyTransactionCostSensitivityStudy,
  toMarketRows,
  TWSE_QUALIFICATION_FIXTURE_PAYLOADS,
  validateCutoffDates,
  validateRoundTripCostBpsGrid,
  validateTwStrategyResearchRows,
  VOLUME_ADJUSTMENT_STATUS,
} from "@mms/research-kernel";
import {
  evaluateWalkForwardStabilityGate,
  runWalkForwardThresholdEvaluation,
  summarizeWalkForwardStability,
  TW_STABILITY_RESEARCH_POLICY_V1,
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
  cutoffs: null,
  roundTripCostBps: null,
});

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  let customOutDir = false;

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const stability = summarizeWalkForwardStability(walkForward);
  const stabilityGate = evaluateWalkForwardStabilityGate({ policy, diagnostics: stability });
  const operativeThreshold = walkForward.foldResults.at(-1).selectedThreshold;
  const position = prep.latestSignal.probabilityUp >= operativeThreshold ? "LONG" : "CASH";
  return {
    dataQualityFindings: prep.dataQualityFindings,
    featureRowCount: prep.featureRowCount,
    foldBoundaries: prep.foldBoundaries,
    walkForward,
    stability,
    stabilityGate,
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
    stabilityGate: result.stabilityGate,
    latestSignal: result.latestSignal,
  };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const csvBytes = readPinnedGitBlob(args.legacyRepo, args.ref, args.csvPath);
  const actualSha256 = sha256Hex(csvBytes);
  if (actualSha256 !== args.expectedSha256) {
    throw new Error(`SOURCE_SHA256_MISMATCH:expected=${args.expectedSha256}:actual=${actualSha256}`);
  }
  const csvText = csvBytes.toString("utf8");
  const rawRows = parseTwStrategyResearchCsvText(csvText);

  if (args.roundTripCostBps && args.roundTripCostBps.length > 0) {
    // Transaction Cost Sensitivity Study Mode
    const validatedCutoffs = validateCutoffDates(args.cutoffs || ["2025-09-30", "2025-12-31", "2026-03-31", "2026-07-01"]);
    const validatedCosts = validateRoundTripCostBpsGrid(args.roundTripCostBps);

    const executeCutoffScenariosAtCost = ({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows, roundTripCostBps }) => {
      const validated = validateTwStrategyResearchRows(cutoffRawRows, {
        dataEndDate: resolvedDataEndDate,
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
    const jsonText = JSON.stringify(sensitivityResult, null, 2) + "\n";
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
        requiredSymbols: ["2330", "0050"],
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
    const jsonText = JSON.stringify(studyResult, null, 2) + "\n";
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
      stabilityGatePolicy: TW_STABILITY_RESEARCH_POLICY_V1,
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
      "No promotion, ranking, or investment-advice claim is made; stability diagnostics and gate "
        + "evaluations are reported for research review only.",
    ],
    blockedScenarios: [],
  };

  mkdirSync(args.outDir, { recursive: true });
  const jsonText = JSON.stringify(output, null, 2) + "\n";
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

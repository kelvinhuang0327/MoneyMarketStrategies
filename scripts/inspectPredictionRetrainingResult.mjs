#!/usr/bin/env node
// Read-only CLI inspector for MMS_PREDICTION_RETRAINING_RESULT_V1 artifacts.
// Delegates artifact validation exclusively to @mms/contracts::readPredictionRetrainingResultArtifact.
// Performs zero research recomputation, creates no runtime files, and provides zero investment advice.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPredictionRetrainingResultArtifact } from "@mms/contracts";

/**
 * Formats a ResultContractField<T> value or unavailable reason.
 */
function formatField(field, formatter = (v) => String(v)) {
  if (!field) return "unavailable (not provided)";
  if (field.availability === "available") {
    return formatter(field.value);
  }
  return `unavailable: ${field.reason}`;
}

/**
 * Parses CLI arguments. Requires `--artifact <path>` and accepts `--summary`.
 */
export function parseArgs(argv) {
  let artifactPath = null;
  let summary = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--artifact") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("missing required value for --artifact <path>");
      }
      artifactPath = value;
      index += 1;
    } else if (flag.startsWith("--artifact=")) {
      const value = flag.slice("--artifact=".length);
      if (value.length === 0) {
        throw new Error("missing required value for --artifact <path>");
      }
      artifactPath = value;
    } else if (flag === "--summary") {
      summary = true;
    } else if (flag.startsWith("--")) {
      throw new Error(`unrecognized flag ${flag}`);
    } else {
      throw new Error(`unexpected positional argument: ${flag}`);
    }
  }

  if (!artifactPath) {
    throw new Error("missing required argument: --artifact <path>");
  }

  return { artifactPath, summary };
}

/**
 * Formats a validated PredictionRetrainingResultV1 artifact into deterministic text.
 */
export function formatPredictionRetrainingResult(result) {
  const lines = [];

  // ==========================================
  // 1. Artifact Identity & Schema
  // ==========================================
  lines.push("============================================================");
  lines.push("MMS PREDICTION & RETRAINING RESULT INSPECTION");
  lines.push("============================================================");
  lines.push(`Schema Version:       ${result.schemaVersion}`);
  lines.push(`Run ID:               ${result.runId}`);
  lines.push(`Generated At:         ${result.generatedAt}`);
  lines.push(`Data As Of:           ${formatField(result.dataAsOf)}`);
  lines.push("");

  // ==========================================
  // 2. Dataset Provenance
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("DATASET PROVENANCE");
  lines.push("------------------------------------------------------------");
  if (result.dataset.availability === "available") {
    const ds = result.dataset.value;
    lines.push(`Dataset ID:           ${ds.datasetId}`);
    lines.push(`Version:              ${ds.version}`);
    lines.push(`Source:               ${ds.source}`);
    lines.push(`Dataset SHA-256:      ${ds.datasetSha256}`);
    lines.push(`Feature Rows SHA-256: ${ds.featureRowsSha256}`);
  } else {
    lines.push(`Dataset:              unavailable: ${result.dataset.reason}`);
  }
  lines.push("");

  // ==========================================
  // 3. Model & Retraining Provenance
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("MODEL & RETRAINING PROVENANCE");
  lines.push("------------------------------------------------------------");
  lines.push(`Model Algorithm:      ${formatField(result.model.algorithm)}`);
  lines.push(`Research Version:     ${formatField(result.model.researchVersion)}`);
  lines.push(`Model Version:        ${formatField(result.model.modelVersion)}`);
  lines.push(`Fit Partition:        ${formatField(result.model.fitPartition)}`);
  lines.push(`Training Rows SHA256: ${formatField(result.model.trainingRowsSha256)}`);
  lines.push("");
  if (result.retraining.availability === "available") {
    const ret = result.retraining.value;
    lines.push(`Retraining Run ID:    ${ret.runId}`);
    lines.push(`Retraining Executed:  ${ret.executed}`);
    lines.push(`Fit Partition:        ${ret.fitPartition}`);
    lines.push(`Training Row Count:   ${ret.trainingRowCount}`);
    lines.push(`Training Rows SHA256: ${ret.trainingRowsSha256}`);
    lines.push(`Model State SHA-256:  ${formatField(ret.modelStateSha256)}`);
  } else {
    lines.push(`Retraining:           unavailable: ${result.retraining.reason}`);
  }
  lines.push("");

  // ==========================================
  // 4. Partition Boundaries & Threshold Selection
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("PARTITIONS & THRESHOLD SELECTION");
  lines.push("------------------------------------------------------------");
  lines.push("Training Partition:");
  lines.push(`  Start Date:         ${formatField(result.partitions.training.startDate)}`);
  lines.push(`  End Date:           ${formatField(result.partitions.training.endDate)}`);
  lines.push(`  Row Count:          ${formatField(result.partitions.training.rowCount)}`);
  lines.push(`  Rows SHA-256:       ${formatField(result.partitions.training.rowsSha256)}`);
  lines.push("Validation Partition:");
  lines.push(`  Start Date:         ${formatField(result.partitions.validation.startDate)}`);
  lines.push(`  End Date:           ${formatField(result.partitions.validation.endDate)}`);
  lines.push(`  Row Count:          ${formatField(result.partitions.validation.rowCount)}`);
  lines.push(`  Rows SHA-256:       ${formatField(result.partitions.validation.rowsSha256)}`);
  lines.push("Final-Test Partition:");
  lines.push(`  Start Date:         ${formatField(result.partitions.finalTest.startDate)}`);
  lines.push(`  End Date:           ${formatField(result.partitions.finalTest.endDate)}`);
  lines.push(`  Row Count:          ${formatField(result.partitions.finalTest.rowCount)}`);
  lines.push(`  Rows SHA-256:       ${formatField(result.partitions.finalTest.rowsSha256)}`);
  lines.push("Purge Row Counts:");
  lines.push(`  Train -> Validation: ${formatField(result.partitions.purgeRowCounts.trainValidation)}`);
  lines.push(`  Validation -> Final: ${formatField(result.partitions.purgeRowCounts.validationFinal)}`);
  lines.push("");
  if (result.thresholdSelection.availability === "available") {
    const ts = result.thresholdSelection.value;
    lines.push("Threshold Selection:");
    lines.push(`  Selected Threshold: ${ts.selectedThreshold}`);
    lines.push(`  Selection Source:   ${ts.selectionSource}`);
    lines.push(`  Selection SHA-256:  ${ts.selectionRowsSha256}`);
    lines.push(`  Candidates:         [${ts.candidateThresholds.join(", ")}]`);
    lines.push(`  Tie-Break Rule:     ${ts.tieBreakRule.join(" -> ")}`);
  } else {
    lines.push(`Threshold Selection:  unavailable: ${result.thresholdSelection.reason}`);
  }
  lines.push("");

  // ==========================================
  // 5. Final-Test Reliability & Calibration
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("FINAL-TEST RELIABILITY & CALIBRATION");
  lines.push("------------------------------------------------------------");
  if (result.finalTestMetrics.availability === "available") {
    const ftm = result.finalTestMetrics.value;
    lines.push("Overall Final-Test Metrics:");
    lines.push(`  Sample Count:       ${ftm.sampleCount}`);
    lines.push(`  Accuracy:           ${ftm.accuracy}`);
    lines.push(`  Balanced Accuracy:  ${ftm.balancedAccuracy}`);
    lines.push(`  Brier Score:        ${ftm.brierScore}`);
    lines.push(`  Cross Entropy:      ${ftm.crossEntropy}`);
    lines.push(`  Calibration Error:  ${ftm.calibrationError}`);
    lines.push(`  Positive Rate (Act):${ftm.positiveRate}`);
    lines.push(`  Predicted Pos Rate: ${ftm.predictedPositiveRate}`);
  } else {
    lines.push(`Final-Test Metrics:   unavailable: ${result.finalTestMetrics.reason}`);
  }
  if (result.baselineMetrics.availability === "available") {
    const bm = result.baselineMetrics.value;
    lines.push("Baseline Metrics:");
    lines.push(`  Metric:             ${bm.metricName}`);
    lines.push(`  Majority Accuracy:  ${bm.majorityClassAccuracy}`);
  } else {
    lines.push(`Baseline Metrics:     unavailable: ${result.baselineMetrics.reason}`);
  }
  lines.push("");
  if (result.finalTestReliability.availability === "available") {
    const ftr = result.finalTestReliability.value;
    lines.push(`Per-Symbol Reliability (${ftr.groupDimension}):`);
    lines.push(`  Total Rows:         ${ftr.finalTestRowCount}`);
    lines.push(`  Baseline Metric:    ${ftr.baselineMetricName}`);
    for (const group of ftr.groups) {
      lines.push(`  Symbol: ${group.symbol}`);
      lines.push(`    Rows:             ${group.finalTestRowCount}`);
      lines.push(`    Correct Count:    ${group.correctPredictionCount}`);
      lines.push(`    Accuracy:         ${group.accuracy}`);
      lines.push(`    Baseline Acc:     ${group.baselineAccuracy}`);
      lines.push(`    Accuracy Delta:   ${group.accuracyDelta}`);
      lines.push(`    Actual Up Rate:   ${group.actualUpRate}`);
      lines.push(`    Predicted Up Rate:${group.predictedUpRate}`);
      lines.push(`    Mean Prob Up:     ${group.meanProbabilityUp}`);
      lines.push(`    Calibration Gap:  ${group.calibrationGap}`);
      lines.push(`    Balanced Acc:     ${group.balancedAccuracy}`);
      lines.push(`    Brier Score:      ${group.brierScore}`);
      if (group.warnings.length > 0) {
        lines.push(`    Warnings:         ${group.warnings.join("; ")}`);
      }
    }
    if (ftr.warnings.length > 0) {
      lines.push(`  Reliability Warnings: ${ftr.warnings.join("; ")}`);
    }
  } else {
    lines.push(`Final-Test Reliability: unavailable: ${result.finalTestReliability.reason}`);
  }
  lines.push("");

  // ==========================================
  // 6. Economic Evidence & Simulation
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("ECONOMIC EVIDENCE & SIMULATION");
  lines.push("------------------------------------------------------------");
  if (result.finalTestEconomicEdge.availability === "available") {
    const fte = result.finalTestEconomicEdge.value;
    lines.push(`Final-Test Economic Edge (${fte.researchMode}):`);
    lines.push(`  Evaluation Partition: ${fte.evaluationPartition}`);
    lines.push(`  Final-Test Row Count: ${fte.finalTestRowCount}`);
    lines.push(`  Operative Threshold:  ${fte.operativeThreshold} (${fte.thresholdSelectionSource})`);
    lines.push(`  Transaction Cost Bps: ${fte.transactionCostBps}`);
    lines.push(`  Initial Capital:      ${fte.initialCapital}`);
    for (const group of fte.groups) {
      lines.push(`  Symbol: ${group.symbol}`);
      lines.push(`    Evaluation Period:  ${group.evaluationStartDate} to ${group.evaluationEndDate}`);
      lines.push(`    Strategy Policy:    ${group.strategyPolicy}`);
      lines.push(`    Benchmark Policy:   ${group.benchmarkPolicy}`);
      lines.push(`    Strategy Net Return:${group.strategyNetReturn}`);
      lines.push(`    Strategy Gross Ret: ${group.strategyGrossReturn}`);
      lines.push(`    Benchmark Net Return:${group.benchmarkNetReturn}`);
      lines.push(`    Benchmark Gross Ret:${group.benchmarkGrossReturn}`);
      lines.push(`    Excess Return:      ${group.excessReturn}`);
      lines.push(`    Strategy Max DD:    ${group.strategyMaximumDrawdown}`);
      lines.push(`    Benchmark Max DD:   ${group.benchmarkMaximumDrawdown}`);
      lines.push(`    Trade Count:        ${group.tradeCount}`);
      lines.push(`    Long / Cash Windows:${group.longWindowCount} / ${group.cashWindowCount}`);
      lines.push(`    Replay / Skipped:   ${group.replayWindowCount} / ${group.skippedOverlapCount}`);
      if (group.warnings.length > 0) {
        lines.push(`    Warnings:           ${group.warnings.join("; ")}`);
      }
    }
    if (fte.warnings.length > 0) {
      lines.push(`  Economic Edge Warnings: ${fte.warnings.join("; ")}`);
    }
  } else {
    lines.push(`Final-Test Economic Edge: unavailable: ${result.finalTestEconomicEdge.reason}`);
  }
  lines.push("");

  if (result.simulation.availability === "available") {
    const sim = result.simulation.value;
    lines.push("Representative Simulation Summary:");
    lines.push(`  Scenario:             ${sim.scenario ?? "none"}`);
    lines.push(`  Symbol:               ${sim.symbol}`);
    lines.push(`  Evaluated Threshold:  ${sim.evaluatedThreshold}`);
    lines.push(`  Round-Trip Cost Bps:  ${sim.roundTripCostBps}`);
    lines.push(`  Initial Capital:      ${sim.initialCapital}`);
    lines.push(`  Strategy Return:      ${sim.strategy.totalReturn}`);
    lines.push(`  Strategy Max DD:      ${sim.strategy.maximumDrawdown}`);
    lines.push(`  Strategy Cost:        ${sim.strategy.totalTransactionCost}`);
    lines.push(`  Benchmark Return:     ${sim.benchmark.totalReturn}`);
    lines.push(`  Benchmark Max DD:     ${sim.benchmark.maximumDrawdown}`);
    lines.push(`  Benchmark Cost:       ${sim.benchmark.totalTransactionCost}`);
    lines.push(`  Excess Return:        ${sim.excessReturn}`);
    lines.push(`  Source Result SHA-256:${formatField(sim.sourceResultSha256)}`);
  } else {
    lines.push(`Simulation Summary:         unavailable: ${result.simulation.reason}`);
  }
  lines.push("");

  if (result.perSymbolLogisticChallenger && result.perSymbolLogisticChallenger.availability === "available") {
    const ch = result.perSymbolLogisticChallenger.value;
    lines.push("Per-Symbol Logistic Challenger Evaluation:");
    lines.push(`  Challenger Conclusion:    ${ch.challengerConclusion}`);
    lines.push(`  Beat Directional Baseline:${ch.doesAnyChallengerBeatDirectionalBaseline}`);
    lines.push(`  Beat Buy & Hold Net:      ${ch.doesAnyChallengerBeatBuyAndHoldAfterCost}`);
    lines.push(`  Improved Both:            ${ch.doesAnyChallengerImproveBothDirectionalAndEconomicEvidence}`);
    lines.push(`  Promotion Decision:       ${ch.promotionDecision}`);
    lines.push("");
  } else if (result.perSymbolLogisticChallenger && result.perSymbolLogisticChallenger.availability === "unavailable") {
    lines.push(`Per-Symbol Logistic Challenger: unavailable: ${result.perSymbolLogisticChallenger.reason}`);
    lines.push("");
  }

  if (result.finalTestEconomicReconciliation) {
    const rec = result.finalTestEconomicReconciliation;
    lines.push("Economic Reconciliation (Raw vs Adjusted):");
    lines.push(`  Symbol:                   ${rec.symbol}`);
    lines.push(`  Classification:           ${rec.classification}`);
    lines.push(`  Excess Return Delta:      ${rec.rawVsAdjusted.excessReturnDelta}`);
    lines.push(`  Common Window Check:      ${rec.commonWindowCheck.status}`);
    lines.push(`  Promotion Decision:       ${rec.promotionDecision}`);
    lines.push("");
  }

  // ==========================================
  // 7. Predictions Summary
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("PREDICTIONS SUMMARY");
  lines.push("------------------------------------------------------------");
  if (result.latestPredictions.availability === "available") {
    const lp = result.latestPredictions.value;
    lines.push(`Resolved Historical Predictions (${lp.length}):`);
    for (const pred of lp) {
      const scen = pred.scenario ? `[${pred.scenario}] ` : "";
      const pos = pred.position ? ` position=${pred.position}` : "";
      const opThresh = pred.operativeThreshold.availability === "available"
        ? ` opThresh=${pred.operativeThreshold.value}`
        : "";
      const tgt = pred.targetDate.availability === "available"
        ? ` targetDate=${pred.targetDate.value}`
        : "";
      lines.push(`  ${scen}${pred.symbol} @ ${pred.featureDate}: probUp=${pred.probabilityUp} dir=${pred.predictedDirection}${opThresh}${pos}${tgt} (role=${pred.predictionRole}, status=${pred.resolutionStatus})`);
    }
  } else {
    lines.push(`Resolved Historical Predictions: unavailable: ${result.latestPredictions.reason}`);
  }
  lines.push("");

  if (result.currentUnresolvedPredictions.availability === "available") {
    const cp = result.currentUnresolvedPredictions.value;
    lines.push(`Current Unresolved Predictions (${cp.length}):`);
    for (const pred of cp) {
      const scen = pred.scenario ? `[${pred.scenario}] ` : "";
      const pos = pred.position ? ` position=${pred.position}` : "";
      const opThresh = pred.operativeThreshold.availability === "available"
        ? ` opThresh=${pred.operativeThreshold.value}`
        : "";
      const horizon = pred.predictionHorizon.availability === "available"
        ? ` horizon=${pred.predictionHorizon.value.rows}d`
        : "";
      const tgt = pred.targetDate.availability === "available"
        ? ` targetDate=${pred.targetDate.value}`
        : "";
      lines.push(`  ${scen}${pred.symbol} @ ${pred.featureDate}: probUp=${pred.probabilityUp} dir=${pred.predictedDirection}${opThresh}${pos}${horizon}${tgt} (role=${pred.predictionRole}, status=${pred.resolutionStatus})`);
    }
  } else {
    lines.push(`Current Unresolved Predictions:  unavailable: ${result.currentUnresolvedPredictions.reason}`);
  }
  if (result.currentPredictionUnavailable && result.currentPredictionUnavailable.length > 0) {
    lines.push("Current Predictions Unavailable Scenarios:");
    for (const item of result.currentPredictionUnavailable) {
      lines.push(`  Scenario ${item.scenario}: ${item.reason}`);
    }
  }
  lines.push("");

  // ==========================================
  // 8. Research Governance & Promotion Guardrails
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("RESEARCH GOVERNANCE & PROMOTION GUARDRAILS");
  lines.push("------------------------------------------------------------");
  lines.push(`Promotion Verdict:        ${result.promotion.verdict}`);
  lines.push(`Upstream Status:          ${result.promotion.upstreamStatus ?? "none"}`);
  lines.push(`Automatic Promotion:      ${result.promotion.automaticPromotion}`);
  lines.push(`Manual Approval Required: ${result.promotion.manualApprovalRequired}`);
  if (result.promotion.reasons.length > 0) {
    lines.push("Promotion Reasons:");
    for (const reason of result.promotion.reasons) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push("Research Guardrails (Non-Negotiable):");
  lines.push(`  Provides Investment Recommendation: ${result.guardrails.providesInvestmentRecommendation}`);
  lines.push(`  Supports Order Execution:          ${result.guardrails.supportsOrderExecution}`);
  lines.push(`  Supports Automatic Promotion:      ${result.guardrails.supportsAutomaticPromotion}`);
  lines.push("");

  // ==========================================
  // 9. Warnings & Unavailable Fields Summary
  // ==========================================
  lines.push("------------------------------------------------------------");
  lines.push("WARNINGS & UNAVAILABLE FIELDS");
  lines.push("------------------------------------------------------------");
  lines.push(`Warnings (${result.warnings.length}):`);
  if (result.warnings.length === 0) {
    lines.push("  None");
  } else {
    for (const warn of result.warnings) {
      lines.push(`  - ${warn}`);
    }
  }
  lines.push(`Unavailable Fields (${result.unavailableFields.length}):`);
  if (result.unavailableFields.length === 0) {
    lines.push("  None");
  } else {
    for (const un of result.unavailableFields) {
      lines.push(`  - ${un.path}: ${un.reason}`);
    }
  }
  lines.push(`Provenance References (${result.provenanceReferences.length}):`);
  for (const ref of result.provenanceReferences) {
    const sha = ref.sha256 ? ` (sha256: ${ref.sha256.slice(0, 12)}...)` : "";
    lines.push(`  - [${ref.kind}] ${ref.reference}${sha}`);
  }
  lines.push("============================================================\n");

  return lines.join("\n");
}

/**
 * Formats a validated PredictionRetrainingResultV1 artifact into concise deterministic text.
 */
export function formatPredictionRetrainingResultSummary(result) {
  const lines = [];

  lines.push("MMS PREDICTION & RETRAINING RESULT SUMMARY");
  lines.push("");

  lines.push("ARTIFACT IDENTITY");
  lines.push(`Schema Version: ${result.schemaVersion}`);
  lines.push(`Run ID: ${result.runId}`);
  lines.push(`Generated At: ${result.generatedAt}`);
  lines.push(`Data As Of: ${formatField(result.dataAsOf)}`);
  lines.push("");

  lines.push("DATASET / MODEL / RETRAINING PROVENANCE");
  if (result.dataset.availability === "available") {
    const dataset = result.dataset.value;
    lines.push(`Dataset ID: ${dataset.datasetId}`);
    lines.push(`Dataset Version: ${dataset.version}`);
    lines.push(`Dataset Source: ${dataset.source}`);
    lines.push(`Dataset SHA-256: ${dataset.datasetSha256}`);
    lines.push(`Feature Rows SHA-256: ${dataset.featureRowsSha256}`);
  } else {
    lines.push(`Dataset: ${formatField(result.dataset)}`);
  }
  lines.push(`Model Algorithm: ${formatField(result.model.algorithm)}`);
  lines.push(`Research Version: ${formatField(result.model.researchVersion)}`);
  lines.push(`Model Version: ${formatField(result.model.modelVersion)}`);
  lines.push(`Model Fit Partition: ${formatField(result.model.fitPartition)}`);
  lines.push(`Model Training Rows SHA-256: ${formatField(result.model.trainingRowsSha256)}`);
  if (result.retraining.availability === "available") {
    const retraining = result.retraining.value;
    lines.push(`Retraining Run ID: ${retraining.runId}`);
    lines.push(`Retraining Executed: ${retraining.executed}`);
    lines.push(`Retraining Fit Partition: ${retraining.fitPartition}`);
    lines.push(`Retraining Training Row Count: ${retraining.trainingRowCount}`);
    lines.push(`Retraining Training Rows SHA-256: ${retraining.trainingRowsSha256}`);
    lines.push(`Retraining Model State SHA-256: ${formatField(retraining.modelStateSha256)}`);
  } else {
    lines.push(`Retraining: ${formatField(result.retraining)}`);
  }
  lines.push("");

  lines.push("EVALUATION CONTRACT");
  for (const [label, partition] of [
    ["Training", result.partitions.training],
    ["Validation", result.partitions.validation],
    ["Final-Test", result.partitions.finalTest],
  ]) {
    lines.push(`${label} Partition:`);
    lines.push(`  Start Date: ${formatField(partition.startDate)}`);
    lines.push(`  End Date: ${formatField(partition.endDate)}`);
    lines.push(`  Row Count: ${formatField(partition.rowCount)}`);
    lines.push(`  Rows SHA-256: ${formatField(partition.rowsSha256)}`);
  }
  lines.push(`Purge Train -> Validation Rows: ${formatField(result.partitions.purgeRowCounts.trainValidation)}`);
  lines.push(`Purge Validation -> Final Rows: ${formatField(result.partitions.purgeRowCounts.validationFinal)}`);
  lines.push(`Fit Partition: ${formatField(result.model.fitPartition)}`);
  if (result.thresholdSelection.availability === "available") {
    const thresholdSelection = result.thresholdSelection.value;
    lines.push(`Selected Threshold: ${thresholdSelection.selectedThreshold}`);
    lines.push(`Threshold Selection Source: ${thresholdSelection.selectionSource}`);
    lines.push(`Threshold Selection Rows SHA-256: ${thresholdSelection.selectionRowsSha256}`);
  } else {
    lines.push(`Threshold Selection: ${formatField(result.thresholdSelection)}`);
  }
  lines.push("");

  lines.push("FINAL-TEST METRICS");
  if (result.finalTestMetrics.availability === "available") {
    const metrics = result.finalTestMetrics.value;
    lines.push(`Final-Test Sample Count: ${metrics.sampleCount}`);
    lines.push(`Accuracy: ${metrics.accuracy}`);
    lines.push(`Balanced Accuracy: ${metrics.balancedAccuracy}`);
    lines.push(`Brier Score: ${metrics.brierScore}`);
    lines.push(`Cross Entropy: ${metrics.crossEntropy}`);
    lines.push(`Calibration Error: ${metrics.calibrationError}`);
    lines.push(`Positive Rate (Actual): ${metrics.positiveRate}`);
    lines.push(`Predicted Positive Rate: ${metrics.predictedPositiveRate}`);
  } else {
    lines.push(`Final-Test Metrics: ${formatField(result.finalTestMetrics)}`);
  }
  if (result.baselineMetrics.availability === "available") {
    const baseline = result.baselineMetrics.value;
    lines.push(`Baseline Metric: ${baseline.metricName}`);
    lines.push(`Baseline Majority Accuracy: ${baseline.majorityClassAccuracy}`);
  } else {
    lines.push(`Baseline Metrics: ${formatField(result.baselineMetrics)}`);
  }
  if (result.finalTestReliability.availability === "available") {
    const reliability = result.finalTestReliability.value;
    lines.push(`Reliability Group Dimension: ${reliability.groupDimension}`);
    lines.push(`Reliability Final-Test Row Count: ${reliability.finalTestRowCount}`);
    for (const group of reliability.groups) {
      lines.push(
        `Reliability ${group.symbol}: rows=${group.finalTestRowCount}`
        + ` correct=${group.correctPredictionCount}`
        + ` accuracy=${group.accuracy}`
        + ` balancedAccuracy=${group.balancedAccuracy}`
        + ` actualUpRate=${group.actualUpRate}`
        + ` predictedUpRate=${group.predictedUpRate}`
        + ` meanProbabilityUp=${group.meanProbabilityUp}`
        + ` calibrationGap=${group.calibrationGap}`
        + ` brierScore=${group.brierScore}`,
      );
    }
  } else {
    lines.push(`Final-Test Reliability: ${formatField(result.finalTestReliability)}`);
  }
  lines.push("");

  lines.push("ECONOMIC EVIDENCE");
  if (result.finalTestEconomicEdge.availability === "available") {
    const economicEdge = result.finalTestEconomicEdge.value;
    lines.push(`Economic Edge Research Mode: ${economicEdge.researchMode}`);
    lines.push(`Economic Edge Evaluation Partition: ${economicEdge.evaluationPartition}`);
    lines.push(`Economic Edge Final-Test Row Count: ${economicEdge.finalTestRowCount}`);
    lines.push(`Economic Edge Operative Threshold: ${economicEdge.operativeThreshold}`);
    lines.push(`Economic Edge Transaction Cost Bps: ${economicEdge.transactionCostBps}`);
    for (const group of economicEdge.groups) {
      lines.push(
        `Economic Edge ${group.symbol}: rows=${group.finalTestRows}`
        + ` period=${group.evaluationStartDate}..${group.evaluationEndDate}`
        + ` strategyGrossReturn=${group.strategyGrossReturn}`
        + ` strategyNetReturn=${group.strategyNetReturn}`
        + ` benchmarkGrossReturn=${group.benchmarkGrossReturn}`
        + ` benchmarkNetReturn=${group.benchmarkNetReturn}`
        + ` excessReturn=${group.excessReturn}`
        + ` strategyMaxDrawdown=${group.strategyMaximumDrawdown}`
        + ` benchmarkMaxDrawdown=${group.benchmarkMaximumDrawdown}`
        + ` tradeCount=${group.tradeCount}`,
      );
    }
  } else {
    lines.push(`Final-Test Economic Edge: ${formatField(result.finalTestEconomicEdge)}`);
  }
  if (result.simulation.availability === "available") {
    const simulation = result.simulation.value;
    lines.push(
      `Simulation ${simulation.symbol}: strategyReturn=${simulation.strategy.totalReturn}`
      + ` strategyMaxDrawdown=${simulation.strategy.maximumDrawdown}`
      + ` benchmarkReturn=${simulation.benchmark.totalReturn}`
      + ` benchmarkMaxDrawdown=${simulation.benchmark.maximumDrawdown}`
      + ` excessReturn=${simulation.excessReturn}`,
    );
  } else {
    lines.push(`Simulation: ${formatField(result.simulation)}`);
  }
  lines.push("");

  lines.push("PREDICTIONS");
  if (result.latestPredictions.availability === "available") {
    lines.push(`Resolved Historical Prediction Count: ${result.latestPredictions.value.length}`);
  } else {
    lines.push(`Resolved Historical Prediction Count: ${formatField(result.latestPredictions)}`);
  }
  if (result.currentUnresolvedPredictions.availability === "available") {
    lines.push(`Current Unresolved Prediction Count: ${result.currentUnresolvedPredictions.value.length}`);
  } else {
    lines.push(`Current Unresolved Prediction Count: ${formatField(result.currentUnresolvedPredictions)}`);
  }
  lines.push(`Current Prediction Unavailable Count: ${result.currentPredictionUnavailable.length}`);
  for (const unavailable of result.currentPredictionUnavailable) {
    lines.push(`Current Prediction Unavailable: ${unavailable.scenario}: ${unavailable.reason}`);
  }
  lines.push("");

  lines.push("PROMOTION AND GUARDRAILS");
  lines.push(`Promotion Verdict: ${result.promotion.verdict}`);
  lines.push(`Upstream Status: ${result.promotion.upstreamStatus ?? "none"}`);
  lines.push(`Automatic Promotion: ${result.promotion.automaticPromotion}`);
  lines.push(`Manual Approval Required: ${result.promotion.manualApprovalRequired}`);
  for (const reason of result.promotion.reasons) {
    lines.push(`Promotion Reason: ${reason}`);
  }
  lines.push(`Provides Investment Recommendation: ${result.guardrails.providesInvestmentRecommendation}`);
  lines.push(`Supports Order Execution: ${result.guardrails.supportsOrderExecution}`);
  lines.push(`Supports Automatic Promotion: ${result.guardrails.supportsAutomaticPromotion}`);
  lines.push("");

  lines.push("WARNINGS / UNAVAILABLE EVIDENCE");
  lines.push(`Warnings (${result.warnings.length}):`);
  if (result.warnings.length === 0) {
    lines.push("  None");
  } else {
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push(`Unavailable Fields (${result.unavailableFields.length}):`);
  if (result.unavailableFields.length === 0) {
    lines.push("  None");
  } else {
    for (const unavailable of result.unavailableFields) {
      lines.push(`  - ${unavailable.path}: ${unavailable.reason}`);
    }
  }
  lines.push("");

  lines.push("PROVENANCE");
  lines.push(`Provenance Reference Count: ${result.provenanceReferences.length}`);

  return `${lines.join("\n")}\n`;
}

/**
 * Inspects a serialized artifact file by delegating validation to @mms/contracts.
 */
export function inspectPredictionRetrainingResultFile(artifactPath, options = {}) {
  let fileContent;
  try {
    fileContent = readFileSync(artifactPath, "utf8");
  } catch (error) {
    throw new Error(`failed to read artifact file at "${artifactPath}": ${error.message}`);
  }

  const result = readPredictionRetrainingResultArtifact(fileContent);
  const summary = options === true
    || (typeof options === "object" && options !== null && options.summary === true);
  return summary
    ? formatPredictionRetrainingResultSummary(result)
    : formatPredictionRetrainingResult(result);
}

/**
 * CLI main entrypoint.
 */
export async function main(argv = process.argv.slice(2)) {
  const { artifactPath, summary } = parseArgs(argv);
  const inspectionText = inspectPredictionRetrainingResultFile(artifactPath, { summary });
  process.stdout.write(inspectionText);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

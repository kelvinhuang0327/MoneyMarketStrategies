import { splitChronologically } from "./chronologicalSplit.js";
import {
  findPriceDiscontinuities,
  validateAndNormalizeMarketRows,
  validateDatasetVersion,
} from "./dataQuality.js";
import {
  buildExperimentRunEvidence,
  decidePromotion,
  hashFeatureRows,
  hashMarketRows,
} from "./evidence.js";
import { createFinalTestEvaluator, selectValidationThreshold } from "./evaluation.js";
import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import { fitLogisticRegression } from "./logisticRegression.js";
import { fitStandardScaler } from "./scaler.js";
import type {
  FinalTestEconomicEvidence,
  FinalTestScoredRow,
  FeatureRow,
  ResearchEvidenceKernelInput,
  ResearchEvidenceKernelResult,
} from "./types.js";
import { fail } from "./types.js";

function buildFinalTestEconomicEvidence(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
  frozenThreshold: number,
  finalTestRowsSha256: string,
  finalTestScoredRowsSha256: string,
): FinalTestEconomicEvidence {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test economic evidence rows and scored rows must have identical lengths");
  }
  const rows = finalTestRows.map((row, index) => {
    const scored = scoredRows[index];
    if (scored === undefined) fail("final-test economic evidence scored row is missing");
    if (
      row.symbol !== scored.symbol
      || row.featureDate !== scored.featureDate
      || row.targetDate !== scored.targetDate
      || row.target !== scored.target
    ) {
      fail("final-test economic evidence rows are not aligned with the scored pass");
    }
    return Object.freeze({
      symbol: row.symbol,
      featureDate: row.featureDate,
      targetDate: row.targetDate,
      target: row.target,
      forwardReturn: row.forwardReturn,
      probabilityUp: scored.probability,
      prediction: scored.prediction,
    });
  });
  return Object.freeze({
    evaluationPartition: "FINAL_TEST",
    finalTestRowsSha256,
    finalTestScoredRowsSha256,
    frozenThreshold,
    finalTestRowCount: finalTestRows.length,
    rows: Object.freeze(rows),
  });
}

export function runResearchEvidenceKernel(
  input: ResearchEvidenceKernelInput,
): ResearchEvidenceKernelResult {
  const datasetVersion = validateDatasetVersion(input.datasetVersion);
  const marketRows = validateAndNormalizeMarketRows(input.marketRows);
  const dataQualityFindings = findPriceDiscontinuities(
    marketRows,
    input.discontinuityThreshold,
  );
  const featureRows = buildHistoricalFeatureRows(marketRows);
  const split = splitChronologically(featureRows);
  const scaler = fitStandardScaler(split.training);
  const model = fitLogisticRegression(split.training, scaler, input.logisticRegression);
  const thresholdSelection = selectValidationThreshold(split.validation, scaler, model);
  const frozenThreshold = thresholdSelection.selectedThreshold;
  const finalTestEvaluator = createFinalTestEvaluator();
  const finalTestEvaluation = finalTestEvaluator.evaluate(
    split.finalTest,
    scaler,
    model,
    frozenThreshold,
  );
  finalTestEvaluator.assertExactlyOnce();
  const { finalTestReliability, scoredRows, ...finalTest } = finalTestEvaluation;

  const evidence = buildExperimentRunEvidence({
    datasetVersion,
    datasetSha256: hashMarketRows(marketRows),
    featureRowsSha256: hashFeatureRows(featureRows),
    featureNames: RESEARCH_FEATURE_NAMES,
    dataQualityFindings,
    split,
    scaler,
    model,
    thresholdSelection,
    finalTest,
  });
  return Object.freeze({
    evidence,
    promotionDecision: decidePromotion(evidence),
    finalTestReliability,
    finalTestEconomicEvidence: buildFinalTestEconomicEvidence(
      split.finalTest.rows,
      scoredRows,
      finalTest.frozenThreshold,
      finalTest.finalTestRowsSha256,
      finalTest.finalTestScoredRowsSha256,
    ),
  });
}

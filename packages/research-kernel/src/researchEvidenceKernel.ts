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
  ResearchEvidenceKernelInput,
  ResearchEvidenceKernelResult,
} from "./types.js";

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
  const finalTest = finalTestEvaluator.evaluate(
    split.finalTest,
    scaler,
    model,
    frozenThreshold,
  );
  finalTestEvaluator.assertExactlyOnce();

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
  });
}

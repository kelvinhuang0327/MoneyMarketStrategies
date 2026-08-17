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
import { buildFinalTestEconomicEvidence } from "./finalTestEconomicEvidence.js";
import { buildHistoricalFeatureRows, RESEARCH_FEATURE_NAMES } from "./features.js";
import {
  buildLegacyBreakoutFeatureRows,
  LEGACY_TECHNICAL_FEATURE_FAMILY,
} from "./legacyTechnicalFeatureChallenger.js";
import { fitLogisticRegression } from "./logisticRegression.js";
import { runPerSymbolLogisticChallenger } from "./perSymbolLogisticChallenger.js";
import { fitStandardScaler } from "./scaler.js";
import type {
  ResearchEvidenceKernelInput,
  ResearchEvidenceKernelResult,
} from "./types.js";
import { fail } from "./types.js";

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
  const legacyFeatureRows = buildLegacyBreakoutFeatureRows(marketRows);
  const legacyFeatureSplit = splitChronologically(legacyFeatureRows);
  if (
    split.trainEndDate !== legacyFeatureSplit.trainEndDate
    || split.validationEndDate !== legacyFeatureSplit.validationEndDate
    || split.finalTestStartDate !== legacyFeatureSplit.finalTestStartDate
  ) {
    fail("research evidence kernel incumbent and challenger split boundaries differ");
  }
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
  const promotionDecision = decidePromotion(evidence);
  const perSymbolLogisticChallenger = runPerSymbolLogisticChallenger({
    featureRows,
    split,
    featureNames: RESEARCH_FEATURE_NAMES,
    ...(input.logisticRegression === undefined
      ? {}
      : { logisticRegression: input.logisticRegression }),
  });
  const perSymbolLogisticFeatureChallenger = runPerSymbolLogisticChallenger({
    featureRows: legacyFeatureRows,
    split: legacyFeatureSplit,
    featureNames: Object.freeze([
      ...RESEARCH_FEATURE_NAMES,
      ...LEGACY_TECHNICAL_FEATURE_FAMILY.newFeatureFields,
    ]),
    featureFamily: LEGACY_TECHNICAL_FEATURE_FAMILY,
    ...(input.logisticRegression === undefined
      ? {}
      : { logisticRegression: input.logisticRegression }),
  });
  return Object.freeze({
    evidence,
    promotionDecision,
    finalTestReliability,
    finalTestEconomicEvidence: buildFinalTestEconomicEvidence(
      split.finalTest.rows,
      scoredRows,
      finalTest.frozenThreshold,
      finalTest.finalTestRowsSha256,
      finalTest.finalTestScoredRowsSha256,
    ),
    perSymbolLogisticChallenger,
    perSymbolLogisticFeatureChallenger,
  });
}

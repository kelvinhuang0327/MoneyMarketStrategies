import { hashValue } from "./evidence.js";
import { buildFinalTestReliabilityProfile } from "./buildFinalTestReliabilityProfile.js";
import { buildProbabilityCalibrationProfile } from "./buildProbabilityCalibrationProfile.js";
import { buildSymbolReliabilityProfile } from "./buildSymbolReliabilityProfile.js";
import { predictProbability } from "./logisticRegression.js";
import {
  fail,
  type EvaluationMetrics,
  type FinalTestReliabilityProfile,
  type FeatureDateErrorCohort,
  type FeatureDateErrorCohortProfile,
  type FeatureRow,
  type FinalTestEvidence,
  type FinalTestScoredRow,
  type LogisticRegressionFit,
  type PartitionKind,
  type RowPartition,
  type StandardScalerFit,
  type ThresholdCandidateEvidence,
  type ThresholdSelectionEvidence,
} from "./types.js";

export const VALIDATION_THRESHOLD_GRID = Object.freeze([
  0.45,
  0.475,
  0.5,
  0.525,
  0.55,
  0.575,
  0.6,
  0.625,
  0.65,
] as const);

export const THRESHOLD_TIE_BREAK_RULE = Object.freeze([
  "HIGHEST_VALIDATION_BALANCED_ACCURACY",
  "HIGHEST_VALIDATION_ACCURACY",
  "SMALLEST_ABSOLUTE_DISTANCE_FROM_0_500",
  "LOWER_NUMERIC_THRESHOLD",
] as const);

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertFitCompatibility(
  scaler: StandardScalerFit,
  model: LogisticRegressionFit,
): void {
  if (
    scaler.fitPartition !== "TRAINING"
    || model.fitPartition !== "TRAINING"
    || scaler.fitRowCount !== model.fitRowCount
    || scaler.fitRowIdentitySha256 !== model.fitRowIdentitySha256
  ) {
    fail("scaler and model do not share the same training-only fit identity");
  }
}

function scorePartition(
  partition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
  model: LogisticRegressionFit,
  threshold: number,
): {
  readonly metrics: EvaluationMetrics;
  readonly scoredRows: readonly FinalTestScoredRow[];
  readonly scoredRowsSha256: string;
} {
  if (partition.rows.length === 0) fail(`cannot evaluate empty ${partition.kind} rows`);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    fail(`threshold is outside [0, 1]: ${threshold}`);
  }
  assertFitCompatibility(scaler, model);
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let brierTotal = 0;
  let logLossTotal = 0;
  const scoredRows: FinalTestScoredRow[] = [];
  const epsilon = 1e-12;
  for (const row of partition.rows) {
    const probability = predictProbability(row.features, scaler, model);
    const prediction = probability >= threshold ? 1 : 0;
    if (prediction === 1 && row.target === 1) truePositive += 1;
    if (prediction === 0 && row.target === 0) trueNegative += 1;
    if (prediction === 1 && row.target === 0) falsePositive += 1;
    if (prediction === 0 && row.target === 1) falseNegative += 1;
    brierTotal += (probability - row.target) ** 2;
    logLossTotal += -(row.target * Math.log(probability + epsilon)
      + (1 - row.target) * Math.log(1 - probability + epsilon));
    scoredRows.push({
      symbol: row.symbol,
      featureDate: row.featureDate,
      targetDate: row.targetDate,
      target: row.target,
      probability,
      prediction,
    });
  }
  const positiveCount = truePositive + falseNegative;
  const negativeCount = trueNegative + falsePositive;
  const predictedPositiveCount = truePositive + falsePositive;
  const predictedNegativeCount = trueNegative + falseNegative;
  const sensitivity = positiveCount === 0 ? 0 : truePositive / positiveCount;
  const specificity = negativeCount === 0 ? 0 : trueNegative / negativeCount;
  const precision = predictedPositiveCount === 0 ? 0 : truePositive / predictedPositiveCount;
  const frozenScoredRows = Object.freeze(scoredRows.map((row) => Object.freeze(row)));
  return Object.freeze({
    metrics: Object.freeze({
      sampleCount: partition.rows.length,
      positiveCount,
      negativeCount,
      predictedPositiveCount,
      predictedNegativeCount,
      accuracy: round((truePositive + trueNegative) / partition.rows.length),
      balancedAccuracy: round((sensitivity + specificity) / 2),
      majorityBaseline: round(Math.max(positiveCount, negativeCount) / partition.rows.length),
      precision: round(precision),
      recall: round(sensitivity),
      specificity: round(specificity),
      brierScore: round(brierTotal / partition.rows.length),
      logLoss: round(logLossTotal / partition.rows.length),
      confusionMatrix: Object.freeze({
        truePositive,
        trueNegative,
        falsePositive,
        falseNegative,
      }),
    }),
    scoredRows: frozenScoredRows,
    scoredRowsSha256: hashValue(frozenScoredRows),
  });
}

interface FeatureDateErrorCohortStats {
  readonly featureDate: string;
  sampleCount: number;
  correctCount: number;
  errorCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  predictedPositiveCount: number;
  probabilityTotal: number;
  targetDates: string[];
  symbols: Set<string>;
}

function assertFeatureDateCohortAlignment(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
): void {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test rows and scored rows must have identical lengths");
  }
  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test cohort input row is missing");
    }
    if (
      row.symbol !== scored.symbol
      || row.featureDate !== scored.featureDate
      || row.targetDate !== scored.targetDate
      || row.target !== scored.target
    ) {
      fail("final-test cohort rows are not aligned with the scored pass");
    }
    if (!Number.isFinite(scored.probability)) {
      fail("final-test cohort probability is not finite");
    }
  }
}

export function buildFeatureDateErrorCohortProfile(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
): FeatureDateErrorCohortProfile {
  assertFeatureDateCohortAlignment(finalTestRows, scoredRows);
  const statsByFeatureDate = new Map<string, FeatureDateErrorCohortStats>();

  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test cohort input row is missing");
    }
    const current = statsByFeatureDate.get(row.featureDate) ?? {
      featureDate: row.featureDate,
      sampleCount: 0,
      correctCount: 0,
      errorCount: 0,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      predictedPositiveCount: 0,
      probabilityTotal: 0,
      targetDates: [],
      symbols: new Set<string>(),
    } satisfies FeatureDateErrorCohortStats;
    const correct = scored.prediction === row.target;
    current.sampleCount += 1;
    current.correctCount += correct ? 1 : 0;
    current.errorCount += correct ? 0 : 1;
    current.falsePositiveCount += scored.prediction === 1 && row.target === 0 ? 1 : 0;
    current.falseNegativeCount += scored.prediction === 0 && row.target === 1 ? 1 : 0;
    current.predictedPositiveCount += scored.prediction === 1 ? 1 : 0;
    current.probabilityTotal += scored.probability;
    current.targetDates.push(row.targetDate);
    current.symbols.add(row.symbol);
    statsByFeatureDate.set(row.featureDate, current);
  }

  const cohorts = [...statsByFeatureDate.values()]
    .map((stats): FeatureDateErrorCohort => {
      const targetDates = [...stats.targetDates].sort(lexicalCompare);
      const targetDateStart = targetDates[0];
      const targetDateEnd = targetDates[targetDates.length - 1];
      if (targetDateStart === undefined || targetDateEnd === undefined) {
        fail("final-test cohort target-date range is empty");
      }
      return Object.freeze({
        featureDate: stats.featureDate,
        sampleCount: stats.sampleCount,
        correctCount: stats.correctCount,
        errorCount: stats.errorCount,
        errorRate: round(stats.errorCount / stats.sampleCount),
        falsePositiveCount: stats.falsePositiveCount,
        falseNegativeCount: stats.falseNegativeCount,
        predictedPositiveCount: stats.predictedPositiveCount,
        meanProbabilityUp: round(stats.probabilityTotal / stats.sampleCount),
        targetDateStart,
        targetDateEnd,
        symbols: Object.freeze([...stats.symbols].sort(lexicalCompare)),
      });
    })
    .sort((left, right) =>
      right.errorCount - left.errorCount
      || right.errorRate - left.errorRate
      || lexicalCompare(left.featureDate, right.featureDate),
    );
  const totalErrorCount = cohorts.reduce((total, cohort) => total + cohort.errorCount, 0);
  const dominant = totalErrorCount > 0 ? cohorts[0] ?? null : null;

  return Object.freeze({
    cohortCount: cohorts.length,
    cohorts: Object.freeze(cohorts),
    totalErrorCount,
    dominantErrorCohort: dominant?.featureDate ?? null,
    dominantErrorShare: dominant === null ? null : round(dominant.errorCount / totalErrorCount),
    caveats: Object.freeze([
      "Uses only untouched final-test rows, their scored probabilities, and frozen-threshold predictions.",
      "Groups only by FeatureRow.featureDate; target dates and symbols are descriptive context.",
      "Research-only diagnostic evidence; it does not affect fitting, threshold selection, promotion, replay, or execution.",
    ]),
  });
}

function candidateIsBetter(
  candidate: ThresholdCandidateEvidence,
  incumbent: ThresholdCandidateEvidence,
): boolean {
  if (candidate.metrics.balancedAccuracy !== incumbent.metrics.balancedAccuracy) {
    return candidate.metrics.balancedAccuracy > incumbent.metrics.balancedAccuracy;
  }
  if (candidate.metrics.accuracy !== incumbent.metrics.accuracy) {
    return candidate.metrics.accuracy > incumbent.metrics.accuracy;
  }
  const candidateDistance = Math.abs(candidate.threshold - 0.5);
  const incumbentDistance = Math.abs(incumbent.threshold - 0.5);
  if (candidateDistance !== incumbentDistance) return candidateDistance < incumbentDistance;
  return candidate.threshold < incumbent.threshold;
}

export function selectValidationThreshold(
  untrustedPartition: RowPartition<PartitionKind>,
  scaler: StandardScalerFit,
  model: LogisticRegressionFit,
): ThresholdSelectionEvidence {
  if (untrustedPartition.kind !== "VALIDATION") {
    fail(`threshold selection requires VALIDATION rows, received ${untrustedPartition.kind}`);
  }
  const partition = untrustedPartition as RowPartition<"VALIDATION">;
  const candidates = VALIDATION_THRESHOLD_GRID.map((threshold) => Object.freeze({
    threshold,
    metrics: scorePartition(partition, scaler, model, threshold).metrics,
  }));
  const first = candidates[0];
  if (first === undefined) fail("fixed validation threshold grid is empty");
  const selected = candidates.slice(1).reduce(
    (incumbent, candidate) => candidateIsBetter(candidate, incumbent) ? candidate : incumbent,
    first,
  );
  return Object.freeze({
    selectionPartition: "VALIDATION",
    validationRowsSha256: partition.rowIdentitySha256,
    fixedThresholdGrid: VALIDATION_THRESHOLD_GRID,
    candidates: Object.freeze(candidates),
    selectedThreshold: selected.threshold,
    selectedValidationMetrics: selected.metrics,
    validationCandidateStateSha256: hashValue(candidates),
    tieBreakRule: THRESHOLD_TIE_BREAK_RULE,
  });
}

export interface FinalTestEvaluator {
  evaluate(
    partition: RowPartition<PartitionKind>,
    scaler: StandardScalerFit,
    model: LogisticRegressionFit,
    frozenThreshold: number,
  ): FinalTestEvaluation;
  assertExactlyOnce(): 1;
}

interface FinalTestEvaluation extends FinalTestEvidence {
  readonly finalTestReliability: FinalTestReliabilityProfile;
  readonly scoredRows: readonly FinalTestScoredRow[];
}

export function createFinalTestEvaluator(): FinalTestEvaluator {
  let executionCount = 0;
  return Object.freeze({
    evaluate(
      partition: RowPartition<PartitionKind>,
      scaler: StandardScalerFit,
      model: LogisticRegressionFit,
      frozenThreshold: number,
    ) {
      if (partition.kind !== "FINAL_TEST") {
        fail(`final-test evaluation requires FINAL_TEST rows, received ${partition.kind}`);
      }
      if (executionCount !== 0) fail("final-test evaluation was attempted more than once");
      executionCount += 1;
      const scored = scorePartition(partition, scaler, model, frozenThreshold);
      return Object.freeze({
        evaluationPartition: "FINAL_TEST",
        finalTestRowsSha256: partition.rowIdentitySha256,
        finalTestScoredRowsSha256: scored.scoredRowsSha256,
        frozenThreshold,
        evaluatorExecutionCount: 1,
        metrics: scored.metrics,
        scoredRows: scored.scoredRows,
        symbolReliability: buildSymbolReliabilityProfile(partition.rows, scored.scoredRows),
        probabilityCalibration: buildProbabilityCalibrationProfile(
          partition.rows,
          scored.scoredRows,
          scored.metrics.brierScore,
        ),
        featureDateErrorCohortProfile: buildFeatureDateErrorCohortProfile(
          partition.rows,
          scored.scoredRows,
        ),
        finalTestReliability: buildFinalTestReliabilityProfile(
          partition.rows,
          scored.scoredRows,
        ),
      });
    },
    assertExactlyOnce() {
      if (executionCount !== 1) {
        fail(`final-test evaluation count differs: expected 1, received ${executionCount}`);
      }
      return 1;
    },
  });
}

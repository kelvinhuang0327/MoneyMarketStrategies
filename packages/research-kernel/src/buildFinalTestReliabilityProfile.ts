import {
  fail,
  type FeatureRow,
  type FinalTestReliabilityGroup,
  type FinalTestReliabilityProfile,
  type FinalTestScoredRow,
} from "./types.js";

export const FINAL_TEST_RELIABILITY_LOW_SAMPLE_COUNT = 3;

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface GroupStats {
  readonly symbol: string;
  finalTestRowCount: number;
  correctPredictionCount: number;
  actualUpCount: number;
  predictedUpCount: number;
  probabilityTotal: number;
  brierTotal: number;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
}

function assertAlignedRows(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
): void {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test reliability rows and scored rows must have identical lengths");
  }
  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test reliability input row is missing");
    }
    if (
      row.symbol !== scored.symbol
      || row.featureDate !== scored.featureDate
      || row.targetDate !== scored.targetDate
      || row.target !== scored.target
    ) {
      fail("final-test reliability rows are not aligned with the scored pass");
    }
    if (!Number.isFinite(scored.probability) || scored.probability < 0 || scored.probability > 1) {
      fail("final-test reliability probability must be finite and within [0, 1]");
    }
    if (scored.prediction !== 0 && scored.prediction !== 1) {
      fail("final-test reliability prediction must be binary");
    }
  }
}

function buildGroup(stats: GroupStats): FinalTestReliabilityGroup {
  if (stats.finalTestRowCount === 0) {
    fail(`final-test reliability group ${stats.symbol} has zero observations`);
  }
  const actualDownCount = stats.finalTestRowCount - stats.actualUpCount;
  const accuracy = stats.correctPredictionCount / stats.finalTestRowCount;
  const baselineAccuracy = Math.max(stats.actualUpCount, actualDownCount) / stats.finalTestRowCount;
  const actualUpRate = stats.actualUpCount / stats.finalTestRowCount;
  const predictedUpRate = stats.predictedUpCount / stats.finalTestRowCount;
  const meanProbabilityUp = stats.probabilityTotal / stats.finalTestRowCount;
  const balancedAccuracy = stats.actualUpCount === 0 || actualDownCount === 0
    ? null
    : (
      stats.truePositive / stats.actualUpCount
      + stats.trueNegative / actualDownCount
    ) / 2;
  const warnings = [
    ...(stats.finalTestRowCount < FINAL_TEST_RELIABILITY_LOW_SAMPLE_COUNT
      ? [`low sample count: N=${stats.finalTestRowCount} final-test rows.`]
      : []),
    ...(balancedAccuracy === null
      ? ["balanced accuracy unavailable: final-test outcomes contain a single class."]
      : []),
  ];

  return Object.freeze({
    groupDimension: "symbol",
    symbol: stats.symbol,
    finalTestRowCount: stats.finalTestRowCount,
    correctPredictionCount: stats.correctPredictionCount,
    accuracy: round(accuracy),
    baselineAccuracy: round(baselineAccuracy),
    accuracyDelta: round(accuracy - baselineAccuracy),
    actualUpRate: round(actualUpRate),
    predictedUpRate: round(predictedUpRate),
    meanProbabilityUp: round(meanProbabilityUp),
    calibrationGap: round(meanProbabilityUp - actualUpRate),
    balancedAccuracy: balancedAccuracy === null ? null : round(balancedAccuracy),
    brierScore: round(stats.brierTotal / stats.finalTestRowCount),
    warnings: Object.freeze(warnings),
  });
}

export function buildFinalTestReliabilityProfile(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
): FinalTestReliabilityProfile {
  assertAlignedRows(finalTestRows, scoredRows);
  const statsBySymbol = new Map<string, GroupStats>();

  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test reliability input row is missing");
    }
    const current = statsBySymbol.get(row.symbol) ?? {
      symbol: row.symbol,
      finalTestRowCount: 0,
      correctPredictionCount: 0,
      actualUpCount: 0,
      predictedUpCount: 0,
      probabilityTotal: 0,
      brierTotal: 0,
      truePositive: 0,
      trueNegative: 0,
      falsePositive: 0,
      falseNegative: 0,
    } satisfies GroupStats;
    current.finalTestRowCount += 1;
    current.correctPredictionCount += scored.prediction === row.target ? 1 : 0;
    current.actualUpCount += row.target;
    current.predictedUpCount += scored.prediction;
    current.probabilityTotal += scored.probability;
    current.brierTotal += (scored.probability - row.target) ** 2;
    if (scored.prediction === 1 && row.target === 1) current.truePositive += 1;
    if (scored.prediction === 0 && row.target === 0) current.trueNegative += 1;
    if (scored.prediction === 1 && row.target === 0) current.falsePositive += 1;
    if (scored.prediction === 0 && row.target === 1) current.falseNegative += 1;
    statsBySymbol.set(row.symbol, current);
  }

  const groups = [...statsBySymbol.values()]
    .map(buildGroup)
    .sort((left, right) => lexicalCompare(left.symbol, right.symbol));

  return Object.freeze({
    groupDimension: "symbol",
    baselineMetricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY",
    finalTestRowCount: finalTestRows.length,
    groups: Object.freeze(groups),
    warnings: Object.freeze(
      finalTestRows.length === 0
        ? ["zero observations: no final-test rows were available."]
        : [],
    ),
  });
}

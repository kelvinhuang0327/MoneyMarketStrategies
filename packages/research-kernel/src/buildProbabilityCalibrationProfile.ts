import {
  fail,
  type FeatureRow,
  type FinalTestScoredRow,
  type ProbabilityCalibrationBin,
  type ProbabilityCalibrationProfile,
  type ProbabilityCalibrationStatus,
} from "./types.js";

const MIN_CALIBRATION_PAIR_COUNT = 20;
const MIN_NON_SPARSE_BIN_COUNT = 2;
const MIN_BIN_PAIR_COUNT = 3;

interface ProbabilityCalibrationBinDefinition {
  readonly lowerBound: number;
  readonly upperBound: number | null;
}

interface BinStats {
  readonly definition: ProbabilityCalibrationBinDefinition;
  resolvedPairCount: number;
  probabilityTotal: number;
  actualUpCount: number;
  rawCalibrationGap: number | null;
  actualPositiveCount: number;
  actualNegativeCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  errorCount: number;
}

export const FINAL_TEST_PROBABILITY_CALIBRATION_BINS = Object.freeze([
  Object.freeze({ lowerBound: 0.5, upperBound: 0.55 }),
  Object.freeze({ lowerBound: 0.55, upperBound: 0.6 }),
  Object.freeze({ lowerBound: 0.6, upperBound: 0.65 }),
  Object.freeze({ lowerBound: 0.65, upperBound: 0.7 }),
  Object.freeze({ lowerBound: 0.7, upperBound: 0.75 }),
  Object.freeze({ lowerBound: 0.75, upperBound: null }),
] as const satisfies readonly ProbabilityCalibrationBinDefinition[]);

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function binIndexForProbability(probability: number): number {
  return FINAL_TEST_PROBABILITY_CALIBRATION_BINS.findIndex((bin) =>
    probability >= bin.lowerBound
    && (bin.upperBound === null || probability < bin.upperBound),
  );
}

function emptyBin(definition: ProbabilityCalibrationBinDefinition): ProbabilityCalibrationBin {
  return Object.freeze({
    lowerBound: definition.lowerBound,
    upperBound: definition.upperBound,
    resolvedPairCount: 0,
    meanProbabilityUp: null,
    actualUpRate: null,
    calibrationGap: null,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    errorCount: 0,
    errorRate: null,
    falsePositiveRate: null,
    falseNegativeRate: null,
  });
}

function caveats(
  totalPairCount: number,
  resolvedPairCount: number,
  nonSparseBinCount: number,
): readonly string[] {
  return Object.freeze([
    ...(resolvedPairCount < MIN_CALIBRATION_PAIR_COUNT
      ? [`Small sample: N=${resolvedPairCount}; at least ${MIN_CALIBRATION_PAIR_COUNT} valid resolved pairs are required.`]
      : []),
    ...(nonSparseBinCount < MIN_NON_SPARSE_BIN_COUNT
      ? ["Sparse bins: calibration bins need broader support before drawing conclusions."]
      : []),
    ...(resolvedPairCount < totalPairCount
      ? ["Final-test probabilities below 0.5 are outside the pinned legacy calibration domain and are excluded as unresolved."]
      : []),
    "Uses only untouched final-test rows, their scored probabilities, and FeatureRow.target.",
    "Research-only diagnostic evidence; it does not affect fitting, threshold selection, promotion, replay, or execution.",
  ]);
}

export function buildProbabilityCalibrationProfile(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
  existingBrierScore: number,
): ProbabilityCalibrationProfile {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test rows and scored rows must have identical lengths");
  }
  if (!Number.isFinite(existingBrierScore)) {
    fail("final-test Brier score is not finite");
  }

  const statsByBin: BinStats[] = FINAL_TEST_PROBABILITY_CALIBRATION_BINS.map((definition) => ({
    definition,
    resolvedPairCount: 0,
    probabilityTotal: 0,
    actualUpCount: 0,
    rawCalibrationGap: null,
    actualPositiveCount: 0,
    actualNegativeCount: 0,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    errorCount: 0,
  }));
  let resolvedPairCount = 0;
  let probabilityTotal = 0;
  let actualUpCount = 0;

  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test calibration input row is missing");
    }
    if (
      row.symbol !== scored.symbol
      || row.featureDate !== scored.featureDate
      || row.targetDate !== scored.targetDate
      || row.target !== scored.target
    ) {
      fail("final-test calibration rows are not aligned with the scored pass");
    }
    if (!Number.isFinite(scored.probability)) {
      fail("final-test calibration probability is not finite");
    }

    const binIndex = binIndexForProbability(scored.probability);
    if (binIndex < 0) continue;
    const stats = statsByBin[binIndex];
    if (stats === undefined) fail("final-test calibration bin is missing");

    resolvedPairCount += 1;
    probabilityTotal += scored.probability;
    actualUpCount += row.target;
    stats.resolvedPairCount += 1;
    stats.probabilityTotal += scored.probability;
    stats.actualUpCount += row.target;
    if (row.target === 1) {
      stats.actualPositiveCount += 1;
    } else {
      stats.actualNegativeCount += 1;
    }
    if (scored.prediction === 1 && row.target === 0) {
      stats.falsePositiveCount += 1;
      stats.errorCount += 1;
    } else if (scored.prediction === 0 && row.target === 1) {
      stats.falseNegativeCount += 1;
      stats.errorCount += 1;
    }
  }

  const bins = statsByBin.map((stats): ProbabilityCalibrationBin => {
    if (stats.resolvedPairCount === 0) return emptyBin(stats.definition);
    const meanProbabilityUp = stats.probabilityTotal / stats.resolvedPairCount;
    const actualUpRate = stats.actualUpCount / stats.resolvedPairCount;
    stats.rawCalibrationGap = actualUpRate - meanProbabilityUp;
    return Object.freeze({
      lowerBound: stats.definition.lowerBound,
      upperBound: stats.definition.upperBound,
      resolvedPairCount: stats.resolvedPairCount,
      meanProbabilityUp: round(meanProbabilityUp),
      actualUpRate: round(actualUpRate),
      calibrationGap: round(stats.rawCalibrationGap),
      falsePositiveCount: stats.falsePositiveCount,
      falseNegativeCount: stats.falseNegativeCount,
      errorCount: stats.errorCount,
      errorRate: round(stats.errorCount / stats.resolvedPairCount),
      falsePositiveRate: stats.actualNegativeCount === 0
        ? null
        : round(stats.falsePositiveCount / stats.actualNegativeCount),
      falseNegativeRate: stats.actualPositiveCount === 0
        ? null
        : round(stats.falseNegativeCount / stats.actualPositiveCount),
    });
  });
  const populatedStats = statsByBin.filter((stats) => stats.resolvedPairCount > 0);
  const nonSparseBinCount = statsByBin.filter(
    (stats) => stats.resolvedPairCount >= MIN_BIN_PAIR_COUNT,
  ).length;
  const status: ProbabilityCalibrationStatus = finalTestRows.length === 0
    ? "missing"
    : resolvedPairCount < MIN_CALIBRATION_PAIR_COUNT
      || nonSparseBinCount < MIN_NON_SPARSE_BIN_COUNT
      ? "insufficient"
      : "ready";
  const allRowsResolved = resolvedPairCount === finalTestRows.length;
  const meanProbabilityUp = resolvedPairCount === 0 ? null : probabilityTotal / resolvedPairCount;
  const actualUpRate = resolvedPairCount === 0 ? null : actualUpCount / resolvedPairCount;
  const expectedCalibrationError = resolvedPairCount === 0
    ? null
    : populatedStats.reduce(
      (total, stats) => total + (stats.resolvedPairCount / resolvedPairCount)
        * Math.abs(stats.rawCalibrationGap ?? 0),
      0,
    );
  const maximumCalibrationGap = populatedStats.length === 0
    ? null
    : Math.max(...populatedStats.map((stats) => Math.abs(stats.rawCalibrationGap ?? 0)));

  return Object.freeze({
    resolvedPairCount,
    meanProbabilityUp: meanProbabilityUp === null ? null : round(meanProbabilityUp),
    actualUpRate: actualUpRate === null ? null : round(actualUpRate),
    brierScore: allRowsResolved && resolvedPairCount > 0 ? round(existingBrierScore) : null,
    expectedCalibrationError: expectedCalibrationError === null ? null : round(expectedCalibrationError),
    maximumCalibrationGap: maximumCalibrationGap === null ? null : round(maximumCalibrationGap),
    bins: Object.freeze(bins),
    status,
    caveats: caveats(finalTestRows.length, resolvedPairCount, nonSparseBinCount),
  });
}

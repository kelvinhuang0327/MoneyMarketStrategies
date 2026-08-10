import {
  fail,
  type FeatureRow,
  type FinalTestScoredRow,
  type SymbolReliabilityProfile,
  type SymbolReliabilityRow,
} from "./types.js";

export const SYMBOL_RELIABILITY_MIN_PAIR_COUNT = 3;
export const SYMBOL_RELIABILITY_POOR_CALIBRATION_GAP = 0.25;

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface SymbolStats {
  readonly symbol: string;
  resolvedPairCount: number;
  correctCount: number;
  actualUpCount: number;
  probabilityTotal: number;
  predictedUpCount: number;
}

interface RawSymbolMetrics {
  readonly calibrationGap: number;
  readonly correctRate: number;
}

function compareCalibration(
  left: SymbolReliabilityRow,
  right: SymbolReliabilityRow,
  rawMetricsBySymbol: ReadonlyMap<string, RawSymbolMetrics>,
): number {
  const leftGap = rawMetricsBySymbol.get(left.symbol)?.calibrationGap ?? left.calibrationGap;
  const rightGap = rawMetricsBySymbol.get(right.symbol)?.calibrationGap ?? right.calibrationGap;
  return Math.abs(rightGap) - Math.abs(leftGap)
    || lexicalCompare(left.symbol, right.symbol);
}

function compareHitRate(
  left: SymbolReliabilityRow,
  right: SymbolReliabilityRow,
  rawMetricsBySymbol: ReadonlyMap<string, RawSymbolMetrics>,
): number {
  const leftRate = rawMetricsBySymbol.get(left.symbol)?.correctRate ?? left.correctRate;
  const rightRate = rawMetricsBySymbol.get(right.symbol)?.correctRate ?? right.correctRate;
  return rightRate - leftRate
    || right.resolvedPairCount - left.resolvedPairCount
    || lexicalCompare(left.symbol, right.symbol);
}

export function buildSymbolReliabilityProfile(
  finalTestRows: readonly FeatureRow[],
  scoredRows: readonly FinalTestScoredRow[],
): SymbolReliabilityProfile {
  if (finalTestRows.length !== scoredRows.length) {
    fail("final-test rows and scored rows must have identical lengths");
  }

  const statsBySymbol = new Map<string, SymbolStats>();
  for (let index = 0; index < finalTestRows.length; index += 1) {
    const row = finalTestRows[index];
    const scored = scoredRows[index];
    if (row === undefined || scored === undefined) {
      fail("final-test reliability input row is missing");
    }
    if (
      row.symbol !== scored.symbol
      || row.target !== scored.target
    ) {
      fail("final-test reliability rows are not aligned with the scored pass");
    }
    if (!Number.isFinite(scored.probability)) {
      fail("final-test reliability probability is not finite");
    }

    const current = statsBySymbol.get(row.symbol) ?? {
      symbol: row.symbol,
      resolvedPairCount: 0,
      correctCount: 0,
      actualUpCount: 0,
      probabilityTotal: 0,
      predictedUpCount: 0,
    } satisfies SymbolStats;
    current.resolvedPairCount += 1;
    current.correctCount += scored.prediction === row.target ? 1 : 0;
    current.actualUpCount += row.target === 1 ? 1 : 0;
    current.probabilityTotal += scored.probability;
    current.predictedUpCount += scored.prediction === 1 ? 1 : 0;
    statsBySymbol.set(row.symbol, current);
  }

  const rawMetricsBySymbol = new Map<string, RawSymbolMetrics>();
  const rows = [...statsBySymbol.values()].map((stats): SymbolReliabilityRow => {
    const actualUpRate = stats.actualUpCount / stats.resolvedPairCount;
    const meanProbabilityUp = stats.probabilityTotal / stats.resolvedPairCount;
    const rawCalibrationGap = actualUpRate - meanProbabilityUp;
    const rawCorrectRate = stats.correctCount / stats.resolvedPairCount;
    rawMetricsBySymbol.set(stats.symbol, {
      calibrationGap: rawCalibrationGap,
      correctRate: rawCorrectRate,
    });
    const calibrationGap = round(rawCalibrationGap);
    return Object.freeze({
      symbol: stats.symbol,
      resolvedPairCount: stats.resolvedPairCount,
      correctRate: round(rawCorrectRate),
      actualUpRate: round(actualUpRate),
      meanProbabilityUp: round(meanProbabilityUp),
      calibrationGap,
      predictedUpCount: stats.predictedUpCount,
      warnings: Object.freeze({
        lowSample: stats.resolvedPairCount < SYMBOL_RELIABILITY_MIN_PAIR_COUNT,
        poorCalibration: Math.abs(rawCalibrationGap) >= SYMBOL_RELIABILITY_POOR_CALIBRATION_GAP,
      }),
    });
  }).sort((left, right) =>
    right.resolvedPairCount - left.resolvedPairCount || lexicalCompare(left.symbol, right.symbol),
  );

  const supportedRows = rows.filter(
    (row) => row.resolvedPairCount >= SYMBOL_RELIABILITY_MIN_PAIR_COUNT,
  );
  const worstCalibrationSymbol = [...rows]
    .sort((left, right) => compareCalibration(left, right, rawMetricsBySymbol))[0]?.symbol ?? null;
  const bestHitRateSymbol = [...rows]
    .sort((left, right) => compareHitRate(left, right, rawMetricsBySymbol))[0]?.symbol ?? null;

  return Object.freeze({
    rows: Object.freeze(rows),
    status: Object.freeze({
      enoughSymbols: supportedRows.length >= 2,
      minPairCount: SYMBOL_RELIABILITY_MIN_PAIR_COUNT,
      worstCalibrationSymbol,
      bestHitRateSymbol,
      caveats: Object.freeze([
        "Uses only untouched final-test rows, their scored probabilities, and frozen-threshold predictions.",
        ...(rows.some((row) => row.warnings.lowSample)
          ? [`At least one symbol has fewer than ${SYMBOL_RELIABILITY_MIN_PAIR_COUNT} resolved pairs.`]
          : []),
        "Research-only diagnostic evidence; it does not affect fitting, threshold selection, promotion, replay, or execution.",
      ]),
    }),
  });
}

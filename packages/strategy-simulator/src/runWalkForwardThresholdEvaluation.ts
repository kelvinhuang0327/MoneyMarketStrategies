import { hashValue } from "@mms/research-kernel";

import { calibrateLongCashThreshold } from "./calibrateLongCashThreshold.js";
import {
  LongCashReplayError,
  type LongCashReplayRow,
  type WalkForwardEquityCurvePoint,
  type WalkForwardThresholdEvaluationFoldInput,
  type WalkForwardThresholdEvaluationFoldResult,
  type WalkForwardThresholdEvaluationInput,
  type WalkForwardThresholdEvaluationResult,
  type WalkForwardThresholdFrequency,
} from "./types.js";

const SCHEMA_VERSION = "MMS_WALK_FORWARD_THRESHOLD_EVALUATION_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const DECIMAL_PLACES = 8;

interface NormalizedFold {
  readonly foldId: string;
  readonly candidateThresholds: readonly number[];
  readonly calibrationRows: readonly LongCashReplayRow[];
  readonly validationRows: readonly LongCashReplayRow[];
}

interface EvaluatedFold {
  readonly normalizedFold: NormalizedFold;
  readonly result: WalkForwardThresholdEvaluationFoldResult;
}

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function cloneRows(rows: readonly LongCashReplayRow[]): readonly LongCashReplayRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    entryDate: row.entryDate,
    exitDate: row.exitDate,
    probabilityUp: row.probabilityUp,
    realizedForwardReturn: row.realizedForwardReturn,
  })));
}

function cloneFold(fold: WalkForwardThresholdEvaluationFoldInput): NormalizedFold {
  return Object.freeze({
    foldId: fold.foldId.trim(),
    candidateThresholds: Object.freeze([...fold.candidateThresholds]),
    calibrationRows: cloneRows(fold.calibrationRows),
    validationRows: cloneRows(fold.validationRows),
  });
}

function minimumEntryDate(rows: readonly LongCashReplayRow[]): string {
  return rows.reduce(
    (minimum, row) => row.entryDate < minimum ? row.entryDate : minimum,
    rows[0]!.entryDate,
  );
}

function maximumExitDate(rows: readonly LongCashReplayRow[]): string {
  return rows.reduce(
    (maximum, row) => row.exitDate > maximum ? row.exitDate : maximum,
    rows[0]!.exitDate,
  );
}

function compareEvaluatedFolds(left: EvaluatedFold, right: EvaluatedFold): number {
  if (left.result.validationStartDate < right.result.validationStartDate) return -1;
  if (left.result.validationStartDate > right.result.validationStartDate) return 1;
  if (left.result.validationEndDate < right.result.validationEndDate) return -1;
  if (left.result.validationEndDate > right.result.validationEndDate) return 1;
  if (left.result.foldId < right.result.foldId) return -1;
  if (left.result.foldId > right.result.foldId) return 1;
  return 0;
}

function maximumDrawdown(curve: readonly WalkForwardEquityCurvePoint[]): number {
  let peak = curve[0]!.capital;
  let maximum = 0;
  curve.slice(1).forEach(({ capital }) => {
    peak = Math.max(peak, capital);
    maximum = Math.max(maximum, (peak - capital) / peak);
  });
  return round(maximum);
}

function buildThresholdFrequencies(
  foldResults: readonly WalkForwardThresholdEvaluationFoldResult[],
): readonly WalkForwardThresholdFrequency[] {
  const frequencies: Array<{ threshold: number; count: number }> = [];
  foldResults.forEach(({ selectedThreshold }) => {
    const existing = frequencies.find(({ threshold }) => threshold === selectedThreshold);
    if (existing === undefined) {
      frequencies.push({ threshold: selectedThreshold, count: 1 });
    } else {
      existing.count += 1;
    }
  });
  frequencies.sort((left, right) => left.threshold - right.threshold);
  return Object.freeze(frequencies.map((frequency) => Object.freeze({ ...frequency })));
}

export function runWalkForwardThresholdEvaluation(
  input: WalkForwardThresholdEvaluationInput,
): WalkForwardThresholdEvaluationResult {
  if (input.folds.length === 0) fail("folds must contain at least one fold");

  const foldIds = new Set<string>();
  const normalizedFolds = input.folds.map((fold, index) => {
    const normalized = cloneFold(fold);
    if (normalized.foldId.length === 0) fail(`folds[${index}].foldId must not be blank`);
    if (foldIds.has(normalized.foldId)) {
      fail(`folds contains duplicate foldId ${normalized.foldId}`);
    }
    foldIds.add(normalized.foldId);
    return normalized;
  });

  const evaluatedFolds = normalizedFolds.map((fold) => {
    const calibrationResult = calibrateLongCashThreshold({
      symbol: input.symbol,
      roundTripCostBps: input.roundTripCostBps,
      initialCapital: input.initialCapital,
      candidateThresholds: fold.candidateThresholds,
      calibrationRows: fold.calibrationRows,
      validationRows: fold.validationRows,
    });
    const result = Object.freeze({
      foldId: fold.foldId,
      validationStartDate: minimumEntryDate(fold.validationRows),
      validationEndDate: maximumExitDate(fold.validationRows),
      selectedThreshold: calibrationResult.selectedThreshold,
      calibrationResult,
    });
    return { normalizedFold: fold, result };
  });
  evaluatedFolds.sort(compareEvaluatedFolds);

  for (let index = 1; index < evaluatedFolds.length; index += 1) {
    const previous = evaluatedFolds[index - 1]!.result;
    const current = evaluatedFolds[index]!.result;
    if (previous.validationEndDate >= current.validationStartDate) {
      fail(
        `validation windows for folds ${previous.foldId} and ${current.foldId}`
        + " must be strictly non-overlapping",
      );
    }
  }

  const orderedNormalizedFolds = Object.freeze(
    evaluatedFolds.map(({ normalizedFold }) => normalizedFold),
  );
  const foldResults = Object.freeze(evaluatedFolds.map(({ result }) => result));
  const orderedFoldIds = Object.freeze(foldResults.map(({ foldId }) => foldId));
  const aggregateStrategyEquityCurve: WalkForwardEquityCurvePoint[] = [
    Object.freeze({ foldId: null, capital: input.initialCapital }),
  ];
  const aggregateBenchmarkEquityCurve: WalkForwardEquityCurvePoint[] = [
    Object.freeze({ foldId: null, capital: input.initialCapital }),
  ];
  let strategyCapital = input.initialCapital;
  let benchmarkCapital = input.initialCapital;
  foldResults.forEach(({ foldId, calibrationResult }) => {
    strategyCapital = round(
      strategyCapital * (1 + calibrationResult.validationResult.strategy.totalReturn),
    );
    benchmarkCapital = round(
      benchmarkCapital * (1 + calibrationResult.validationResult.benchmark.totalReturn),
    );
    aggregateStrategyEquityCurve.push(Object.freeze({ foldId, capital: strategyCapital }));
    aggregateBenchmarkEquityCurve.push(Object.freeze({ foldId, capital: benchmarkCapital }));
  });
  const frozenStrategyCurve = Object.freeze(aggregateStrategyEquityCurve);
  const frozenBenchmarkCurve = Object.freeze(aggregateBenchmarkEquityCurve);
  const thresholdFrequencies = buildThresholdFrequencies(foldResults);
  const normalized = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: foldResults[0]!.calibrationResult.symbol,
    roundTripCostBps: foldResults[0]!.calibrationResult.roundTripCostBps,
    initialCapital: foldResults[0]!.calibrationResult.initialCapital,
    foldCount: foldResults.length,
    orderedFoldIds,
    foldResults,
    aggregateStrategyEquityCurve: frozenStrategyCurve,
    aggregateBenchmarkEquityCurve: frozenBenchmarkCurve,
    cumulativeAggregateStrategyReturn: round(strategyCapital / input.initialCapital - 1),
    cumulativeAggregateBenchmarkReturn: round(benchmarkCapital / input.initialCapital - 1),
    aggregateExcessReturn: round(
      strategyCapital / input.initialCapital - benchmarkCapital / input.initialCapital,
    ),
    aggregateMaximumStrategyDrawdown: maximumDrawdown(frozenStrategyCurve),
    thresholdFrequencies,
    normalizedFoldsSha256: hashValue(orderedNormalizedFolds),
    foldResultsSha256: hashValue(foldResults),
    aggregateStrategyCurveSha256: hashValue(frozenStrategyCurve),
    aggregateBenchmarkCurveSha256: hashValue(frozenBenchmarkCurve),
  });
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

import { hashValue } from "@mms/research-kernel";

import {
  LongCashReplayError,
  type WalkForwardStabilityDiagnostics,
  type WalkForwardStabilityFoldDiagnostic,
  type WalkForwardThresholdEvaluationResult,
  type WalkForwardThresholdFrequency,
} from "./types.js";

const SCHEMA_VERSION = "MMS_WALK_FORWARD_STABILITY_DIAGNOSTICS_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) fail(`${name} must be finite`);
}

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function cloneFoldDiagnostic(
  diagnostic: WalkForwardStabilityFoldDiagnostic,
): WalkForwardStabilityFoldDiagnostic {
  return Object.freeze({ ...diagnostic });
}

function compareBestFold(
  left: WalkForwardStabilityFoldDiagnostic,
  right: WalkForwardStabilityFoldDiagnostic,
): WalkForwardStabilityFoldDiagnostic {
  if (right.validationExcessReturn > left.validationExcessReturn) return right;
  if (right.validationExcessReturn < left.validationExcessReturn) return left;
  return right.foldId < left.foldId ? right : left;
}

function compareWorstFold(
  left: WalkForwardStabilityFoldDiagnostic,
  right: WalkForwardStabilityFoldDiagnostic,
): WalkForwardStabilityFoldDiagnostic {
  if (right.validationExcessReturn < left.validationExcessReturn) return right;
  if (right.validationExcessReturn > left.validationExcessReturn) return left;
  return right.foldId < left.foldId ? right : left;
}

function buildThresholdFrequencies(
  foldDiagnostics: readonly WalkForwardStabilityFoldDiagnostic[],
): readonly WalkForwardThresholdFrequency[] {
  const counts = new Map<number, number>();
  foldDiagnostics.forEach(({ selectedThreshold }) => {
    counts.set(selectedThreshold, (counts.get(selectedThreshold) ?? 0) + 1);
  });
  return Object.freeze(
    [...counts]
      .sort(([left], [right]) => left - right)
      .map(([threshold, count]) => Object.freeze({ threshold, count })),
  );
}

export function summarizeWalkForwardStability(
  input: WalkForwardThresholdEvaluationResult,
): WalkForwardStabilityDiagnostics {
  if (!Number.isInteger(input.foldCount) || input.foldCount <= 0) {
    fail("foldCount must be a positive integer");
  }
  if (
    input.foldResults.length !== input.foldCount
    || input.orderedFoldIds.length !== input.foldCount
  ) {
    fail("foldCount must match foldResults and orderedFoldIds");
  }

  const seenFoldIds = new Set<string>();
  const foldDiagnostics = Object.freeze(input.foldResults.map((fold, index) => {
    if (fold.foldId.trim().length === 0) fail(`foldResults[${index}].foldId must not be blank`);
    if (seenFoldIds.has(fold.foldId)) {
      fail(`foldResults contains duplicate foldId ${fold.foldId}`);
    }
    seenFoldIds.add(fold.foldId);
    if (input.orderedFoldIds[index] !== fold.foldId) {
      fail(`orderedFoldIds[${index}] must match foldResults[${index}].foldId`);
    }

    const validation = fold.calibrationResult.validationResult;
    const prefix = `foldResults[${index}]`;
    assertFinite(`${prefix}.selectedThreshold`, fold.selectedThreshold);
    if (
      fold.calibrationResult.selectedThreshold !== fold.selectedThreshold
      || validation.validationThreshold !== fold.selectedThreshold
    ) {
      fail(`${prefix} selected threshold evidence is inconsistent`);
    }
    assertFinite(`${prefix}.validation strategy return`, validation.strategy.totalReturn);
    assertFinite(`${prefix}.validation benchmark return`, validation.benchmark.totalReturn);
    assertFinite(`${prefix}.validation excess return`, validation.excessReturn);
    assertFinite(
      `${prefix}.validation maximum drawdown`,
      validation.strategy.maximumDrawdown,
    );
    assertCount(
      `${prefix}.validation active LONG count`,
      validation.strategy.longWindowCount,
    );
    assertCount(`${prefix}.validation cash count`, validation.strategy.cashWindowCount);

    return Object.freeze({
      foldId: fold.foldId,
      validationStartDate: fold.validationStartDate,
      validationEndDate: fold.validationEndDate,
      selectedThreshold: fold.selectedThreshold,
      validationStrategyReturn: validation.strategy.totalReturn,
      validationBenchmarkReturn: validation.benchmark.totalReturn,
      validationExcessReturn: validation.excessReturn,
      validationMaximumDrawdown: validation.strategy.maximumDrawdown,
      validationActiveLongCount: validation.strategy.longWindowCount,
      validationCashCount: validation.strategy.cashWindowCount,
    });
  }));

  const validationStrategyReturns = foldDiagnostics.map(
    ({ validationStrategyReturn }) => validationStrategyReturn,
  );
  const validationBenchmarkReturns = foldDiagnostics.map(
    ({ validationBenchmarkReturn }) => validationBenchmarkReturn,
  );
  const validationExcessReturns = foldDiagnostics.map(
    ({ validationExcessReturn }) => validationExcessReturn,
  );
  const bestFold = foldDiagnostics.reduce(compareBestFold);
  const worstFold = foldDiagnostics.reduce(compareWorstFold);
  const selectedThresholdFrequencies = buildThresholdFrequencies(foldDiagnostics);
  const dominantThresholdFrequency = selectedThresholdFrequencies.reduce((best, candidate) => {
    if (candidate.count > best.count) return candidate;
    if (candidate.count < best.count) return best;
    return candidate.threshold < best.threshold ? candidate : best;
  });

  assertFinite(
    "cumulativeAggregateStrategyReturn",
    input.cumulativeAggregateStrategyReturn,
  );
  assertFinite(
    "cumulativeAggregateBenchmarkReturn",
    input.cumulativeAggregateBenchmarkReturn,
  );
  assertFinite("aggregateExcessReturn", input.aggregateExcessReturn);
  assertFinite(
    "aggregateMaximumStrategyDrawdown",
    input.aggregateMaximumStrategyDrawdown,
  );

  const normalized = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    foldCount: input.foldCount,
    foldDiagnostics,
    positiveStrategyReturnFoldCount: validationStrategyReturns.filter(
      (value) => value > 0,
    ).length,
    positiveExcessReturnFoldCount: validationExcessReturns.filter(
      (value) => value > 0,
    ).length,
    nonNegativeExcessReturnFoldCount: validationExcessReturns.filter(
      (value) => value >= 0,
    ).length,
    meanValidationStrategyReturn: mean(validationStrategyReturns),
    medianValidationStrategyReturn: median(validationStrategyReturns),
    meanValidationBenchmarkReturn: mean(validationBenchmarkReturns),
    medianValidationBenchmarkReturn: median(validationBenchmarkReturns),
    meanValidationExcessReturn: mean(validationExcessReturns),
    medianValidationExcessReturn: median(validationExcessReturns),
    bestFoldByExcessReturn: cloneFoldDiagnostic(bestFold),
    worstFoldByExcessReturn: cloneFoldDiagnostic(worstFold),
    maximumValidationDrawdownAcrossFolds: Math.max(
      ...foldDiagnostics.map(({ validationMaximumDrawdown }) => validationMaximumDrawdown),
    ),
    selectedThresholdFrequencies,
    uniqueSelectedThresholdCount: selectedThresholdFrequencies.length,
    dominantSelectedThreshold: dominantThresholdFrequency.threshold,
    dominantSelectedThresholdFrequency: dominantThresholdFrequency.count,
    dominantSelectedThresholdRatio: dominantThresholdFrequency.count / input.foldCount,
    aggregateStrategyReturn: input.cumulativeAggregateStrategyReturn,
    aggregateBenchmarkReturn: input.cumulativeAggregateBenchmarkReturn,
    aggregateExcessReturn: input.aggregateExcessReturn,
    aggregateMaximumDrawdown: input.aggregateMaximumStrategyDrawdown,
    foldDiagnosticsSha256: hashValue(foldDiagnostics),
    selectedThresholdFrequenciesSha256: hashValue(selectedThresholdFrequencies),
  });
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

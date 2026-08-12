import {
  hashValue,
  type FinalTestEconomicEvidence,
  type FinalTestEconomicReplayRow,
} from "@mms/research-kernel";

import { compareLongCashReplayWithBenchmark } from "./compareLongCashReplay.js";
import { simulateLongCashReplay } from "./simulateLongCashReplay.js";
import {
  LongCashReplayError,
  type LongCashReplayResult,
  type LongCashReplayRow,
} from "./types.js";

const SCHEMA_VERSION = "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const THRESHOLD_SELECTION_SOURCE = "VALIDATION" as const;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function minimumDate(rows: readonly FinalTestEconomicReplayRow[], field: "featureDate" | "targetDate"): string {
  const first = rows[0];
  if (first === undefined) fail("final-test economic group is empty");
  return rows.reduce(
    (minimum, row) => row[field] < minimum ? row[field] : minimum,
    first[field],
  );
}

function maximumDate(rows: readonly FinalTestEconomicReplayRow[], field: "featureDate" | "targetDate"): string {
  const first = rows[0];
  if (first === undefined) fail("final-test economic group is empty");
  return rows.reduce(
    (maximum, row) => row[field] > maximum ? row[field] : maximum,
    first[field],
  );
}

function toReplayRow(row: FinalTestEconomicReplayRow): LongCashReplayRow {
  return {
    entryDate: row.featureDate,
    exitDate: row.targetDate,
    probabilityUp: row.probabilityUp,
    realizedForwardReturn: row.forwardReturn,
  };
}

function compoundedGrossReturn(
  replay: LongCashReplayResult,
  field: "strategyGrossReturn" | "benchmarkGrossReturn",
): number {
  return round(replay.windows.reduce(
    (capitalFactor, window) => capitalFactor * (1 + window[field]),
    1,
  ) - 1);
}

function validateFinalTestEvidence(
  evidence: FinalTestEconomicEvidence,
): void {
  if (evidence.evaluationPartition !== "FINAL_TEST") {
    fail(`economic replay requires FINAL_TEST evidence, received ${evidence.evaluationPartition}`);
  }
  if (evidence.finalTestRowCount !== evidence.rows.length) {
    fail(
      `economic replay row count ${evidence.rows.length} differs from final-test row count ${evidence.finalTestRowCount}`,
    );
  }
  if (evidence.rows.length === 0) fail("economic replay requires at least one final-test row");
  if (!Number.isFinite(evidence.frozenThreshold)
    || evidence.frozenThreshold < 0
    || evidence.frozenThreshold > 1) {
    fail("economic replay frozen threshold must be within [0, 1]");
  }

  evidence.rows.forEach((row, index) => {
    if (row.target !== (row.forwardReturn > 0 ? 1 : 0)) {
      fail(`final-test economic row ${index} target does not match its realized forward return`);
    }
    const expectedPrediction = row.probabilityUp >= evidence.frozenThreshold ? 1 : 0;
    if (row.prediction !== expectedPrediction) {
      fail(`final-test economic row ${index} position does not match the frozen threshold decision`);
    }
  });
}

export interface FinalTestEconomicEdgeInput {
  readonly finalTestEvidence: FinalTestEconomicEvidence;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface FinalTestEconomicEdgeGroup {
  readonly symbol: string;
  readonly finalTestRows: number;
  readonly evaluationStartDate: string;
  readonly evaluationEndDate: string;
  readonly operativeThreshold: number;
  readonly thresholdSelectionSource: typeof THRESHOLD_SELECTION_SOURCE;
  readonly transactionCostBps: number;
  readonly strategyPolicy: "VALIDATION_THRESHOLD_LONG_CASH";
  readonly benchmarkPolicy: "ALWAYS_LONG_BENCHMARK";
  readonly strategyGrossReturn: number;
  readonly strategyNetReturn: number;
  readonly benchmarkGrossReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaximumDrawdown: number;
  readonly benchmarkMaximumDrawdown: number;
  readonly tradeCount: number;
  readonly longWindowCount: number;
  readonly cashWindowCount: number;
  readonly replayWindowCount: number;
  readonly skippedOverlapCount: number;
  readonly warnings: readonly string[];
}

export interface FinalTestEconomicEdgeResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly evaluationPartition: "FINAL_TEST";
  readonly finalTestRowCount: number;
  readonly finalTestRowsSha256: string;
  readonly finalTestScoredRowsSha256: string;
  readonly operativeThreshold: number;
  readonly thresholdSelectionSource: typeof THRESHOLD_SELECTION_SOURCE;
  readonly transactionCostBps: number;
  readonly initialCapital: number;
  readonly groups: readonly FinalTestEconomicEdgeGroup[];
  readonly warnings: readonly string[];
  readonly guardrails: {
    readonly providesInvestmentAdvice: false;
    readonly supportsOrderExecution: false;
    readonly supportsAutomaticPromotion: false;
    readonly supportsPortfolioOptimization: false;
    readonly supportsMultiSymbolAllocation: false;
    readonly supportsSymbolSelection: false;
  };
  readonly normalizedResultSha256: string;
}

function buildGroup(
  symbol: string,
  rows: readonly FinalTestEconomicReplayRow[],
  evidence: FinalTestEconomicEvidence,
  roundTripCostBps: number,
  initialCapital: number,
): FinalTestEconomicEdgeGroup {
  const replay = simulateLongCashReplay({
    symbol,
    validationThreshold: evidence.frozenThreshold,
    roundTripCostBps,
    initialCapital,
    rows: rows.map(toReplayRow),
  });
  const comparison = compareLongCashReplayWithBenchmark(replay);
  if (comparison.excessReturn !== replay.excessReturn) {
    fail(`canonical benchmark comparison drifted for ${symbol}`);
  }
  if (replay.strategy.policy !== "VALIDATION_THRESHOLD_LONG_CASH") {
    fail(`canonical strategy policy drifted for ${symbol}`);
  }
  if (replay.benchmark.policy !== "ALWAYS_LONG_BENCHMARK") {
    fail(`canonical benchmark policy drifted for ${symbol}`);
  }

  return Object.freeze({
    symbol,
    finalTestRows: rows.length,
    evaluationStartDate: minimumDate(rows, "featureDate"),
    evaluationEndDate: maximumDate(rows, "targetDate"),
    operativeThreshold: evidence.frozenThreshold,
    thresholdSelectionSource: THRESHOLD_SELECTION_SOURCE,
    transactionCostBps: replay.roundTripCostBps,
    strategyPolicy: "VALIDATION_THRESHOLD_LONG_CASH",
    benchmarkPolicy: "ALWAYS_LONG_BENCHMARK",
    strategyGrossReturn: compoundedGrossReturn(replay, "strategyGrossReturn"),
    strategyNetReturn: replay.strategy.totalReturn,
    benchmarkGrossReturn: compoundedGrossReturn(replay, "benchmarkGrossReturn"),
    benchmarkNetReturn: replay.benchmark.totalReturn,
    excessReturn: replay.excessReturn,
    strategyMaximumDrawdown: replay.strategy.maximumDrawdown,
    benchmarkMaximumDrawdown: replay.benchmark.maximumDrawdown,
    tradeCount: replay.strategy.roundTripCount,
    longWindowCount: replay.strategy.longWindowCount,
    cashWindowCount: replay.strategy.cashWindowCount,
    replayWindowCount: replay.replayWindowCount,
    skippedOverlapCount: replay.skippedOverlapCount,
    warnings: Object.freeze([
      "Benchmark is the canonical cost-matched ALWAYS_LONG_BENCHMARK replay on the identical selected windows.",
      "Exposure and turnover are unavailable because the canonical simulator does not define those metrics.",
      "Positive excess return is descriptive final-test evidence only; it does not select, promote, or recommend a symbol.",
    ]),
  });
}

export function buildFinalTestPerSymbolEconomicEdge(
  input: FinalTestEconomicEdgeInput,
): FinalTestEconomicEdgeResult {
  validateFinalTestEvidence(input.finalTestEvidence);
  const groupedRows = new Map<string, FinalTestEconomicReplayRow[]>();
  for (const row of input.finalTestEvidence.rows) {
    const rows = groupedRows.get(row.symbol) ?? [];
    rows.push(row);
    groupedRows.set(row.symbol, rows);
  }

  const groups = [...groupedRows.entries()]
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([symbol, rows]) => buildGroup(
      symbol,
      Object.freeze(rows),
      input.finalTestEvidence,
      input.roundTripCostBps,
      input.initialCapital,
    ));
  const groupedRowCount = groups.reduce((total, group) => total + group.finalTestRows, 0);
  if (groupedRowCount !== input.finalTestEvidence.finalTestRowCount) {
    fail("per-symbol economic group counts differ from final-test row count");
  }

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    evaluationPartition: "FINAL_TEST" as const,
    finalTestRowCount: input.finalTestEvidence.finalTestRowCount,
    finalTestRowsSha256: input.finalTestEvidence.finalTestRowsSha256,
    finalTestScoredRowsSha256: input.finalTestEvidence.finalTestScoredRowsSha256,
    operativeThreshold: input.finalTestEvidence.frozenThreshold,
    thresholdSelectionSource: THRESHOLD_SELECTION_SOURCE,
    transactionCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    groups: Object.freeze(groups),
    warnings: Object.freeze([
      "Only untouched FINAL_TEST rows and their already-scored frozen-threshold predictions were replayed.",
      "Validation, training, purge, and current unresolved prediction rows are outside this evaluation.",
      "No threshold, model, symbol, portfolio, promotion, or recommendation decision is made by this diagnostic.",
    ]),
    guardrails: Object.freeze({
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    } as const),
  };
  return deepFreeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

import { hashValue } from "./evidence.js";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";

export type TwStrategyTemporalRobustnessErrorCode =
  | "INVALID_CUTOFF_DATE"
  | "UNORDERED_CUTOFFS"
  | "DUPLICATE_CUTOFFS"
  | "INSUFFICIENT_HISTORY_FOR_CUTOFF"
  | "SEMANTIC_DRIFT";

export class TwStrategyTemporalRobustnessError extends Error {
  readonly code: TwStrategyTemporalRobustnessErrorCode;

  constructor(code: TwStrategyTemporalRobustnessErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwStrategyTemporalRobustnessError";
    this.code = code;
  }
}

function fail(code: TwStrategyTemporalRobustnessErrorCode, detail?: string): never {
  throw new TwStrategyTemporalRobustnessError(code, detail);
}

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCanonicalIsoDate(value: string): boolean {
  if (!CANONICAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateCutoffDates(cutoffDates: readonly string[]): readonly string[] {
  if (!Array.isArray(cutoffDates) || cutoffDates.length === 0) {
    fail("INVALID_CUTOFF_DATE", "cutoffDates must be a non-empty array");
  }
  const seen = new Set<string>();
  for (let i = 0; i < cutoffDates.length; i += 1) {
    const cutoff = cutoffDates[i]!;
    if (!isCanonicalIsoDate(cutoff)) {
      fail("INVALID_CUTOFF_DATE", `invalid ISO date format: ${cutoff}`);
    }
    if (seen.has(cutoff)) {
      fail("DUPLICATE_CUTOFFS", `duplicate cutoff date: ${cutoff}`);
    }
    seen.add(cutoff);
    if (i > 0 && cutoff <= cutoffDates[i - 1]!) {
      fail("UNORDERED_CUTOFFS", `cutoffs must be strictly ascending: ${cutoffDates[i - 1]} >= ${cutoff}`);
    }
  }
  return Object.freeze([...cutoffDates]);
}

export function filterRowsForCutoff(
  rows: readonly RawTwStrategyResearchRow[],
  cutoffDate: string,
): readonly RawTwStrategyResearchRow[] {
  return rows.filter((row) => row.date <= cutoffDate);
}

export function resolveDataEndDate(
  rows: readonly RawTwStrategyResearchRow[],
  cutoffDate: string,
): string {
  const included = rows.filter((row) => row.date <= cutoffDate);
  if (included.length === 0) {
    fail("INSUFFICIENT_HISTORY_FOR_CUTOFF", `no source rows found on or before cutoff date ${cutoffDate}`);
  }
  let maxDate = included[0]!.date;
  for (const row of included) {
    if (row.date > maxDate) {
      maxDate = row.date;
    }
  }
  return maxDate;
}

export type TemporalAcceptanceClassification = "ALWAYS_PASS" | "ALWAYS_FAIL" | "MIXED";

export interface TemporalScenarioSummary {
  readonly scenarioId: string;
  readonly cutoffCount: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly gateStatusByCutoff: Readonly<Record<string, "PASS" | "FAIL">>;
  readonly aggregateExcessReturnByCutoff: Readonly<Record<string, number>>;
  readonly aggregateMaximumDrawdownByCutoff: Readonly<Record<string, number>>;
  readonly dominantThresholdRatioByCutoff: Readonly<Record<string, number>>;
  readonly operativePositionByCutoff: Readonly<Record<string, "LONG" | "CASH">>;
  readonly latestSignalAsOfByCutoff: Readonly<Record<string, string>>;
  readonly temporalAcceptanceClassification: TemporalAcceptanceClassification;
}

export interface ScenarioCutoffSummaryInput {
  readonly cutoffDate: string;
  readonly overallPass: boolean;
  readonly aggregateExcessReturn: number;
  readonly aggregateMaximumDrawdown: number;
  readonly dominantThresholdRatio: number;
  readonly operativePosition: "LONG" | "CASH";
  readonly latestSignalAsOf: string;
}

export function summarizeTemporalScenarioResults(
  scenarioId: string,
  cutoffRuns: readonly ScenarioCutoffSummaryInput[],
): TemporalScenarioSummary {
  const cutoffCount = cutoffRuns.length;
  let passCount = 0;
  let failCount = 0;

  const gateStatusByCutoff: Record<string, "PASS" | "FAIL"> = {};
  const aggregateExcessReturnByCutoff: Record<string, number> = {};
  const aggregateMaximumDrawdownByCutoff: Record<string, number> = {};
  const dominantThresholdRatioByCutoff: Record<string, number> = {};
  const operativePositionByCutoff: Record<string, "LONG" | "CASH"> = {};
  const latestSignalAsOfByCutoff: Record<string, string> = {};

  for (const run of cutoffRuns) {
    const status = run.overallPass ? "PASS" : "FAIL";
    if (run.overallPass) passCount += 1;
    else failCount += 1;

    gateStatusByCutoff[run.cutoffDate] = status;
    aggregateExcessReturnByCutoff[run.cutoffDate] = run.aggregateExcessReturn;
    aggregateMaximumDrawdownByCutoff[run.cutoffDate] = run.aggregateMaximumDrawdown;
    dominantThresholdRatioByCutoff[run.cutoffDate] = run.dominantThresholdRatio;
    operativePositionByCutoff[run.cutoffDate] = run.operativePosition;
    latestSignalAsOfByCutoff[run.cutoffDate] = run.latestSignalAsOf;
  }

  let temporalAcceptanceClassification: TemporalAcceptanceClassification;
  if (passCount === cutoffCount) {
    temporalAcceptanceClassification = "ALWAYS_PASS";
  } else if (failCount === cutoffCount) {
    temporalAcceptanceClassification = "ALWAYS_FAIL";
  } else {
    temporalAcceptanceClassification = "MIXED";
  }

  return {
    scenarioId,
    cutoffCount,
    passCount,
    failCount,
    gateStatusByCutoff: Object.freeze(gateStatusByCutoff),
    aggregateExcessReturnByCutoff: Object.freeze(aggregateExcessReturnByCutoff),
    aggregateMaximumDrawdownByCutoff: Object.freeze(aggregateMaximumDrawdownByCutoff),
    dominantThresholdRatioByCutoff: Object.freeze(dominantThresholdRatioByCutoff),
    operativePositionByCutoff: Object.freeze(operativePositionByCutoff),
    latestSignalAsOfByCutoff: Object.freeze(latestSignalAsOfByCutoff),
    temporalAcceptanceClassification,
  };
}

export const REQUIRED_SCENARIO_KEYS = Object.freeze([
  "2330_RAW_CONTROL",
  "0050_RAW",
  "0050_SOURCE_QUALIFIED_ADJUSTED",
] as const);

export interface SingleCutoffRunResult<TScenario = unknown> {
  readonly requestedCutoffDate: string;
  readonly resolvedDataEndDate: string;
  readonly sourceRowCount: number;
  readonly scenarios: Readonly<Record<string, TScenario>>;
}

export interface RunTwStrategyTemporalRobustnessStudyInput<TScenario = unknown, TPolicy = unknown> {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly policy: TPolicy;
  readonly reviewDate: string;
  readonly executeCutoffScenarios: (args: {
    readonly requestedCutoffDate: string;
    readonly resolvedDataEndDate: string;
    readonly cutoffRawRows: readonly RawTwStrategyResearchRow[];
  }) => {
    readonly scenarios: Readonly<Record<string, TScenario>>;
    readonly scenarioSummaryInputs: Readonly<Record<string, ScenarioCutoffSummaryInput>>;
  };
}

export interface RunTwStrategyTemporalRobustnessStudyResult<TScenario = unknown, TPolicy = unknown> {
  readonly schemaVersion: "MMS_TW_STRATEGY_TEMPORAL_ROBUSTNESS_STUDY_V1";
  readonly classification: "MMS_TW_STRATEGY_TEMPORAL_ROBUSTNESS_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION";
  readonly dataClassification: "HISTORICAL_RESEARCH_STUDY";
  readonly reviewDate: string;
  readonly researchMode: "diagnostic-only";
  readonly providesInvestmentAdvice: false;
  readonly currentDatePredictionClaim: false;
  readonly requestedCutoffDates: readonly string[];
  readonly resolvedCutoffDates: Readonly<Record<string, string>>;
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
  };
  readonly policy: TPolicy;
  readonly policySha256: string;
  readonly scenarioOrder: readonly string[];
  readonly cutoffRuns: ReadonlyArray<SingleCutoffRunResult<TScenario>>;
  readonly temporalSummaries: Readonly<Record<string, TemporalScenarioSummary>>;
  readonly limitations: readonly string[];
  readonly blockedScenarios: readonly string[];
  readonly studySha256: string;
}

export function runTwStrategyTemporalRobustnessStudy<TScenario = unknown, TPolicy = unknown>(
  input: RunTwStrategyTemporalRobustnessStudyInput<TScenario, TPolicy>,
): RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy> {
  const validatedCutoffs = validateCutoffDates(input.cutoffDates);

  if (!input.rawRows || input.rawRows.length === 0) {
    fail("INSUFFICIENT_HISTORY_FOR_CUTOFF", "rawRows must not be empty");
  }

  const sortedDates = input.rawRows.map((r) => r.date).sort();
  const fullDateRange = { min: sortedDates[0]!, max: sortedDates.at(-1)! };

  const resolvedCutoffDates: Record<string, string> = {};
  const cutoffRuns: Array<SingleCutoffRunResult<TScenario>> = [];
  const scenarioCutoffSummaries: Record<string, ScenarioCutoffSummaryInput[]> = {
    "2330_RAW_CONTROL": [],
    "0050_RAW": [],
    "0050_SOURCE_QUALIFIED_ADJUSTED": [],
  };

  for (const cutoffDate of validatedCutoffs) {
    const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoffDate);
    const resolvedDataEndDate = resolveDataEndDate(cutoffRawRows, cutoffDate);
    resolvedCutoffDates[cutoffDate] = resolvedDataEndDate;

    let cutoffExec: ReturnType<typeof input.executeCutoffScenarios>;
    try {
      cutoffExec = input.executeCutoffScenarios({
        requestedCutoffDate: cutoffDate,
        resolvedDataEndDate,
        cutoffRawRows,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("MISSING_REQUIRED_FIELD")) {
        fail("INSUFFICIENT_HISTORY_FOR_CUTOFF", `cutoff date ${cutoffDate} lacks sufficient history: ${err.message}`);
      }
      throw err;
    }

    const { scenarios, scenarioSummaryInputs } = cutoffExec;
    for (const key of REQUIRED_SCENARIO_KEYS) {
      if (!scenarios[key] || !scenarioSummaryInputs[key]) {
        fail("INSUFFICIENT_HISTORY_FOR_CUTOFF", `missing scenario ${key} for cutoff ${cutoffDate}`);
      }
      scenarioCutoffSummaries[key]!.push(scenarioSummaryInputs[key]!);
    }

    cutoffRuns.push({
      requestedCutoffDate: cutoffDate,
      resolvedDataEndDate,
      sourceRowCount: cutoffRawRows.length,
      scenarios,
    });
  }

  const temporalSummaries: Record<string, TemporalScenarioSummary> = {};
  for (const key of REQUIRED_SCENARIO_KEYS) {
    temporalSummaries[key] = summarizeTemporalScenarioResults(key, scenarioCutoffSummaries[key]!);
  }

  const policySha256 = hashValue(input.policy);

  const limitations = Object.freeze([
    "Single-symbol, non-overlapping replay only; no multi-symbol portfolio construction.",
    "roundTripCostBps=10 is an existing-test-fixture convention adopted for disclosure, not a verified brokerage/tax fee schedule for TWSE-listed instruments.",
    "Volume was not adjusted for the 0050 split (volumeAdjustmentStatus=NOT_APPLIED); volume-derived features remain raw across all scenarios.",
    "This temporal robustness study evaluates historical performance across multiple cutoffs (" + validatedCutoffs.join(", ") + "); temporal consistency is historical evidence only and does not guarantee future stability.",
    "No promotion, ranking, or investment-advice claim is made; stability diagnostics and gate evaluations are reported for research review only.",
  ]);

  const outputCore = {
    schemaVersion: "MMS_TW_STRATEGY_TEMPORAL_ROBUSTNESS_STUDY_V1" as const,
    classification: "MMS_TW_STRATEGY_TEMPORAL_ROBUSTNESS_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION" as const,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: "diagnostic-only" as const,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    requestedCutoffDates: validatedCutoffs,
    resolvedCutoffDates: Object.freeze(resolvedCutoffDates),
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange,
      fullRowCount: input.rawRows.length,
    },
    policy: input.policy,
    policySha256,
    scenarioOrder: REQUIRED_SCENARIO_KEYS,
    cutoffRuns: Object.freeze(cutoffRuns),
    temporalSummaries: Object.freeze(temporalSummaries),
    limitations,
    blockedScenarios: Object.freeze([] as string[]),
  };

  const studySha256 = hashValue(outputCore);

  return Object.freeze({
    ...outputCore,
    studySha256,
  });
}

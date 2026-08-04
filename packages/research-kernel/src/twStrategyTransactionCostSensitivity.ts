import { hashValue } from "./evidence.js";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";
import {
  REQUIRED_SCENARIO_KEYS,
  runTwStrategyTemporalRobustnessStudy,
  type RunTwStrategyTemporalRobustnessStudyResult,
  type ScenarioCutoffSummaryInput,
  validateCutoffDates,
} from "./twStrategyTemporalRobustness.js";

export type TwStrategyTransactionCostSensitivityErrorCode =
  | "INVALID_ROUND_TRIP_COST_BPS"
  | "UNORDERED_COSTS"
  | "DUPLICATE_COSTS"
  | "EMPTY_COST_GRID"
  | "OVER_LIMIT_COST"
  | "SEMANTIC_DRIFT"
  | "TEN_BPS_DRIFT";

export class TwStrategyTransactionCostSensitivityError extends Error {
  readonly code: TwStrategyTransactionCostSensitivityErrorCode;

  constructor(code: TwStrategyTransactionCostSensitivityErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TwStrategyTransactionCostSensitivityError";
    this.code = code;
  }
}

function fail(code: TwStrategyTransactionCostSensitivityErrorCode, detail?: string): never {
  throw new TwStrategyTransactionCostSensitivityError(code, detail);
}

export function validateRoundTripCostBpsGrid(roundTripCostBpsValues: readonly number[]): readonly number[] {
  if (!Array.isArray(roundTripCostBpsValues) || roundTripCostBpsValues.length === 0) {
    fail("EMPTY_COST_GRID", "roundTripCostBpsValues must be a non-empty array");
  }
  const seen = new Set<number>();
  for (let i = 0; i < roundTripCostBpsValues.length; i += 1) {
    const cost = roundTripCostBpsValues[i]!;
    if (!Number.isFinite(cost) || !Number.isInteger(cost) || cost < 0) {
      fail("INVALID_ROUND_TRIP_COST_BPS", `roundTripCostBps must be a non-negative integer: ${cost}`);
    }
    if (cost > 10_000) {
      fail("OVER_LIMIT_COST", `roundTripCostBps must be <= 10000: ${cost}`);
    }
    if (seen.has(cost)) {
      fail("DUPLICATE_COSTS", `duplicate roundTripCostBps value: ${cost}`);
    }
    seen.add(cost);
    if (i > 0 && cost <= roundTripCostBpsValues[i - 1]!) {
      fail("UNORDERED_COSTS", `roundTripCostBpsValues must be strictly ascending: ${roundTripCostBpsValues[i - 1]} >= ${cost}`);
    }
  }
  return Object.freeze([...roundTripCostBpsValues]);
}

export type CostSensitivityClassification =
  | "PASS_AT_ALL_COSTS_AND_CUTOFFS"
  | "FAIL_AT_ALL_COSTS_AND_CUTOFFS"
  | "MIXED_ACROSS_COSTS_OR_CUTOFFS";

export interface TransactionCostSensitivityScenarioSummary {
  readonly scenarioId: string;
  readonly costCount: number;
  readonly cutoffCount: number;
  readonly gateStatusByCostAndCutoff: Readonly<Record<string, Readonly<Record<string, "PASS" | "FAIL">>>>;
  readonly aggregateExcessReturnByCostAndCutoff: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly aggregateMaximumDrawdownByCostAndCutoff: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly dominantThresholdRatioByCostAndCutoff: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly operativePositionByCostAndCutoff: Readonly<Record<string, Readonly<Record<string, "LONG" | "CASH">>>>;
  readonly passCountByCost: Readonly<Record<string, number>>;
  readonly failCountByCost: Readonly<Record<string, number>>;
  readonly passCountAcrossAllCells: number;
  readonly failCountAcrossAllCells: number;
  readonly costSensitivityClassification: CostSensitivityClassification;
}

export function summarizeTransactionCostSensitivityScenarioResults<TScenario = unknown, TPolicy = unknown>(
  scenarioId: string,
  orderedCosts: readonly number[],
  orderedCutoffs: readonly string[],
  temporalStudiesByCost: Readonly<Record<string, RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy>>>,
): TransactionCostSensitivityScenarioSummary {
  const costCount = orderedCosts.length;
  const cutoffCount = orderedCutoffs.length;

  const gateStatusByCostAndCutoff: Record<string, Record<string, "PASS" | "FAIL">> = {};
  const aggregateExcessReturnByCostAndCutoff: Record<string, Record<string, number>> = {};
  const aggregateMaximumDrawdownByCostAndCutoff: Record<string, Record<string, number>> = {};
  const dominantThresholdRatioByCostAndCutoff: Record<string, Record<string, number>> = {};
  const operativePositionByCostAndCutoff: Record<string, Record<string, "LONG" | "CASH">> = {};

  const passCountByCost: Record<string, number> = {};
  const failCountByCost: Record<string, number> = {};

  let passCountAcrossAllCells = 0;
  let failCountAcrossAllCells = 0;

  for (const cost of orderedCosts) {
    const costKey = String(cost);
    const study = temporalStudiesByCost[costKey];
    if (!study) {
      fail("SEMANTIC_DRIFT", `missing temporal study result for cost ${cost}`);
    }
    const tempSummary = study.temporalSummaries[scenarioId];
    if (!tempSummary) {
      fail("SEMANTIC_DRIFT", `missing temporal summary for scenario ${scenarioId} at cost ${cost}`);
    }

    gateStatusByCostAndCutoff[costKey] = {};
    aggregateExcessReturnByCostAndCutoff[costKey] = {};
    aggregateMaximumDrawdownByCostAndCutoff[costKey] = {};
    dominantThresholdRatioByCostAndCutoff[costKey] = {};
    operativePositionByCostAndCutoff[costKey] = {};

    let costPass = 0;
    let costFail = 0;

    for (const cutoff of orderedCutoffs) {
      const status = tempSummary.gateStatusByCutoff[cutoff]!;
      const aggExcess = tempSummary.aggregateExcessReturnByCutoff[cutoff]!;
      const aggDrawdown = tempSummary.aggregateMaximumDrawdownByCutoff[cutoff]!;
      const domRatio = tempSummary.dominantThresholdRatioByCutoff[cutoff]!;
      const position = tempSummary.operativePositionByCutoff[cutoff]!;

      gateStatusByCostAndCutoff[costKey]![cutoff] = status;
      aggregateExcessReturnByCostAndCutoff[costKey]![cutoff] = aggExcess;
      aggregateMaximumDrawdownByCostAndCutoff[costKey]![cutoff] = aggDrawdown;
      dominantThresholdRatioByCostAndCutoff[costKey]![cutoff] = domRatio;
      operativePositionByCostAndCutoff[costKey]![cutoff] = position;

      if (status === "PASS") {
        costPass += 1;
        passCountAcrossAllCells += 1;
      } else {
        costFail += 1;
        failCountAcrossAllCells += 1;
      }
    }

    passCountByCost[costKey] = costPass;
    failCountByCost[costKey] = costFail;

    Object.freeze(gateStatusByCostAndCutoff[costKey]);
    Object.freeze(aggregateExcessReturnByCostAndCutoff[costKey]);
    Object.freeze(aggregateMaximumDrawdownByCostAndCutoff[costKey]);
    Object.freeze(dominantThresholdRatioByCostAndCutoff[costKey]);
    Object.freeze(operativePositionByCostAndCutoff[costKey]);
  }

  const totalCells = costCount * cutoffCount;
  let costSensitivityClassification: CostSensitivityClassification;
  if (passCountAcrossAllCells === totalCells) {
    costSensitivityClassification = "PASS_AT_ALL_COSTS_AND_CUTOFFS";
  } else if (failCountAcrossAllCells === totalCells) {
    costSensitivityClassification = "FAIL_AT_ALL_COSTS_AND_CUTOFFS";
  } else {
    costSensitivityClassification = "MIXED_ACROSS_COSTS_OR_CUTOFFS";
  }

  return {
    scenarioId,
    costCount,
    cutoffCount,
    gateStatusByCostAndCutoff: Object.freeze(gateStatusByCostAndCutoff),
    aggregateExcessReturnByCostAndCutoff: Object.freeze(aggregateExcessReturnByCostAndCutoff),
    aggregateMaximumDrawdownByCostAndCutoff: Object.freeze(aggregateMaximumDrawdownByCostAndCutoff),
    dominantThresholdRatioByCostAndCutoff: Object.freeze(dominantThresholdRatioByCostAndCutoff),
    operativePositionByCostAndCutoff: Object.freeze(operativePositionByCostAndCutoff),
    passCountByCost: Object.freeze(passCountByCost),
    failCountByCost: Object.freeze(failCountByCost),
    passCountAcrossAllCells,
    failCountAcrossAllCells,
    costSensitivityClassification,
  };
}

export interface RunTwStrategyTransactionCostSensitivityStudyInput<TScenario = unknown, TPolicy = unknown> {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly roundTripCostBpsValues: readonly number[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly policy: TPolicy;
  readonly reviewDate: string;
  readonly executeCutoffScenariosAtCost: (args: {
    readonly requestedCutoffDate: string;
    readonly resolvedDataEndDate: string;
    readonly cutoffRawRows: readonly RawTwStrategyResearchRow[];
    readonly roundTripCostBps: number;
  }) => {
    readonly scenarios: Readonly<Record<string, TScenario>>;
    readonly scenarioSummaryInputs: Readonly<Record<string, ScenarioCutoffSummaryInput>>;
  };
}

export interface RunTwStrategyTransactionCostSensitivityStudyResult<TScenario = unknown, TPolicy = unknown> {
  readonly schemaVersion: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1";
  readonly classification: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION";
  readonly dataClassification: "HISTORICAL_RESEARCH_STUDY";
  readonly reviewDate: string;
  readonly researchMode: "diagnostic-only";
  readonly providesInvestmentAdvice: false;
  readonly currentDatePredictionClaim: false;
  readonly orderedCutoffDates: readonly string[];
  readonly orderedRoundTripCostBpsValues: readonly number[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
  };
  readonly policy: TPolicy;
  readonly policySha256: string;
  readonly scenarioOrder: readonly string[];
  readonly temporalStudiesByCost: Readonly<Record<string, RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy>>>;
  readonly sensitivitySummaries: Readonly<Record<string, TransactionCostSensitivityScenarioSummary>>;
  readonly limitations: readonly string[];
  readonly blockedScenarios: readonly string[];
  readonly studySha256: string;
}

export function runTwStrategyTransactionCostSensitivityStudy<TScenario = unknown, TPolicy = unknown>(
  input: RunTwStrategyTransactionCostSensitivityStudyInput<TScenario, TPolicy>,
): RunTwStrategyTransactionCostSensitivityStudyResult<TScenario, TPolicy> {
  const validatedCutoffs = validateCutoffDates(input.cutoffDates);
  const validatedCosts = validateRoundTripCostBpsGrid(input.roundTripCostBpsValues);

  if (!input.rawRows || input.rawRows.length === 0) {
    throw new Error("INSUFFICIENT_HISTORY_FOR_CUTOFF: rawRows must not be empty");
  }

  const sortedDates = input.rawRows.map((r) => r.date).sort();
  const fullDateRange = { min: sortedDates[0]!, max: sortedDates.at(-1)! };

  const temporalStudiesByCost: Record<string, RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy>> = {};

  for (const cost of validatedCosts) {
    const costKey = String(cost);
    const studyResult = runTwStrategyTemporalRobustnessStudy<TScenario, TPolicy>({
      rawRows: input.rawRows,
      cutoffDates: validatedCutoffs,
      source: input.source,
      policy: input.policy,
      reviewDate: input.reviewDate,
      executeCutoffScenarios: (args) =>
        input.executeCutoffScenariosAtCost({
          ...args,
          roundTripCostBps: cost,
        }),
    });
    temporalStudiesByCost[costKey] = studyResult;
  }

  const sensitivitySummaries: Record<string, TransactionCostSensitivityScenarioSummary> = {};
  for (const key of REQUIRED_SCENARIO_KEYS) {
    sensitivitySummaries[key] = summarizeTransactionCostSensitivityScenarioResults(
      key,
      validatedCosts,
      validatedCutoffs,
      temporalStudiesByCost,
    );
  }

  const policySha256 = hashValue(input.policy);

  const limitations = Object.freeze([
    "Single-symbol, non-overlapping replay only; no multi-symbol portfolio construction.",
    "Round-trip cost grid (" +
      validatedCosts.join(" bps, ") +
      " bps) comprises synthetic research sensitivity assumptions, not verified TWSE brokerage or tax schedules.",
    "Volume was not adjusted for the 0050 split (volumeAdjustmentStatus=NOT_APPLIED); volume-derived features remain raw across all scenarios.",
    "This transaction cost sensitivity study evaluates historical performance across multiple cutoffs (" +
      validatedCutoffs.join(", ") +
      ") and costs (" +
      validatedCosts.join(" bps, ") +
      " bps); cost sensitivity is historical evidence only and does not guarantee future market behavior.",
    "No promotion, ranking, cost optimization, strategy promotion, or investment-advice claim is made; stability diagnostics and sensitivity matrices are reported for research review only.",
  ]);

  const outputCore = {
    schemaVersion: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1" as const,
    classification: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION" as const,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: "diagnostic-only" as const,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    orderedCutoffDates: validatedCutoffs,
    orderedRoundTripCostBpsValues: validatedCosts,
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange,
      fullRowCount: input.rawRows.length,
    },
    policy: input.policy,
    policySha256,
    scenarioOrder: REQUIRED_SCENARIO_KEYS,
    temporalStudiesByCost: Object.freeze(temporalStudiesByCost),
    sensitivitySummaries: Object.freeze(sensitivitySummaries),
    limitations,
    blockedScenarios: Object.freeze([] as string[]),
  };

  const studySha256 = hashValue(outputCore);

  return Object.freeze({
    ...outputCore,
    studySha256,
  });
}

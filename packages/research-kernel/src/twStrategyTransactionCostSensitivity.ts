import { hashValue } from "./evidence.js";
import {
  REQUIRED_SCENARIO_KEYS,
  runTwStrategyTemporalRobustnessStudy,
  validateCutoffDates,
  type RunTwStrategyTemporalRobustnessStudyResult,
  type ScenarioCutoffSummaryInput,
} from "./twStrategyTemporalRobustness.js";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";

export type TwStrategyTransactionCostSensitivityErrorCode =
  | "INVALID_COST_GRID"
  | "UNORDERED_COST_GRID"
  | "DUPLICATE_COSTS"
  | "COST_OUT_OF_RANGE"
  | "INVALID_CUTOFF_DATE"
  | "UNORDERED_CUTOFFS"
  | "DUPLICATE_CUTOFFS"
  | "INSUFFICIENT_HISTORY_FOR_CUTOFF"
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

export function validateCostGridBps(roundTripCostBpsList: readonly number[]): readonly number[] {
  if (!Array.isArray(roundTripCostBpsList) || roundTripCostBpsList.length === 0) {
    fail("INVALID_COST_GRID", "roundTripCostBpsList must be a non-empty array");
  }
  const seen = new Set<number>();
  for (let i = 0; i < roundTripCostBpsList.length; i += 1) {
    const cost = roundTripCostBpsList[i]!;
    if (typeof cost !== "number" || !Number.isFinite(cost) || !Number.isInteger(cost) || cost < 0) {
      fail("INVALID_COST_GRID", `cost must be a non-negative integer: ${cost}`);
    }
    if (cost > 10000) {
      fail("COST_OUT_OF_RANGE", `cost exceeds maximum limit of 10000 bps: ${cost}`);
    }
    if (seen.has(cost)) {
      fail("DUPLICATE_COSTS", `duplicate cost in grid: ${cost}`);
    }
    seen.add(cost);
    if (i > 0 && cost <= roundTripCostBpsList[i - 1]!) {
      fail("UNORDERED_COST_GRID", `costs must be strictly ascending: ${roundTripCostBpsList[i - 1]} >= ${cost}`);
    }
  }
  return Object.freeze([...roundTripCostBpsList]);
}

export type CostSensitivityClassification =
  | "PASS_AT_ALL_COSTS_AND_CUTOFFS"
  | "FAIL_AT_ALL_COSTS_AND_CUTOFFS"
  | "MIXED_ACROSS_COSTS_OR_CUTOFFS";

export interface CostSensitivityScenarioSummary {
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

export interface RunTwStrategyTransactionCostSensitivityStudyInput<TScenario = unknown, TPolicy = unknown> {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly roundTripCostBpsList: readonly number[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly policy: TPolicy;
  readonly reviewDate: string;
  readonly executeCutoffCostScenarios: (args: {
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
  readonly requestedCutoffDates: readonly string[];
  readonly resolvedCutoffDates: Readonly<Record<string, string>>;
  readonly requestedCostGridBps: readonly number[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
  };
  readonly policy: TPolicy;
  readonly policySha256: string;
  readonly scenarioOrder: readonly string[];
  readonly temporalRunsByCost: Readonly<Record<string, RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy>>>;
  readonly sensitivitySummaries: Readonly<Record<string, CostSensitivityScenarioSummary>>;
  readonly limitations: readonly string[];
  readonly blockedScenarios: readonly string[];
  readonly studySha256: string;
}

export function runTwStrategyTransactionCostSensitivityStudy<TScenario = unknown, TPolicy = unknown>(
  input: RunTwStrategyTransactionCostSensitivityStudyInput<TScenario, TPolicy>,
): RunTwStrategyTransactionCostSensitivityStudyResult<TScenario, TPolicy> {
  const validatedCutoffs = validateCutoffDates(input.cutoffDates);
  const validatedCosts = validateCostGridBps(input.roundTripCostBpsList);

  if (!input.rawRows || input.rawRows.length === 0) {
    fail("INSUFFICIENT_HISTORY_FOR_CUTOFF", "rawRows must not be empty");
  }

  const temporalRunsByCost: Record<string, RunTwStrategyTemporalRobustnessStudyResult<TScenario, TPolicy>> = {};

  for (const cost of validatedCosts) {
    const costKey = String(cost);
    const temporalResult = runTwStrategyTemporalRobustnessStudy<TScenario, TPolicy>({
      rawRows: input.rawRows,
      cutoffDates: validatedCutoffs,
      source: input.source,
      policy: input.policy,
      reviewDate: input.reviewDate,
      executeCutoffScenarios: ({ requestedCutoffDate, resolvedDataEndDate, cutoffRawRows }) => {
        const rawExec = input.executeCutoffCostScenarios({
          requestedCutoffDate,
          resolvedDataEndDate,
          cutoffRawRows,
          roundTripCostBps: cost,
        });
        const sanitizedSummaryInputs: Record<string, ScenarioCutoffSummaryInput> = {};
        for (const [key, val] of Object.entries(rawExec.scenarioSummaryInputs)) {
          sanitizedSummaryInputs[key] = {
            ...val,
            overallPass: val.overallPass === true,
          };
        }
        return {
          scenarios: rawExec.scenarios,
          scenarioSummaryInputs: sanitizedSummaryInputs,
        };
      },
    });
    temporalRunsByCost[costKey] = temporalResult;
  }

  const costCount = validatedCosts.length;
  const cutoffCount = validatedCutoffs.length;
  const totalCellCount = costCount * cutoffCount;

  const sensitivitySummaries: Record<string, CostSensitivityScenarioSummary> = {};

  for (const scenarioId of REQUIRED_SCENARIO_KEYS) {
    const gateStatusByCostAndCutoff: Record<string, Record<string, "PASS" | "FAIL">> = {};
    const aggregateExcessReturnByCostAndCutoff: Record<string, Record<string, number>> = {};
    const aggregateMaximumDrawdownByCostAndCutoff: Record<string, Record<string, number>> = {};
    const dominantThresholdRatioByCostAndCutoff: Record<string, Record<string, number>> = {};
    const operativePositionByCostAndCutoff: Record<string, Record<string, "LONG" | "CASH">> = {};

    const passCountByCost: Record<string, number> = {};
    const failCountByCost: Record<string, number> = {};

    let passCountAcrossAllCells = 0;
    let failCountAcrossAllCells = 0;

    for (const cost of validatedCosts) {
      const costKey = String(cost);
      const temporalRun = temporalRunsByCost[costKey]!;
      const summary = temporalRun.temporalSummaries[scenarioId]!;

      let costPassCount = 0;
      let costFailCount = 0;
      const gateStatusMap: Record<string, "PASS" | "FAIL"> = {};

      for (const cutoffDate of validatedCutoffs) {
        const rawStatus = summary.gateStatusByCutoff[cutoffDate];
        const isPass = rawStatus === "PASS";
        gateStatusMap[cutoffDate] = isPass ? "PASS" : "FAIL";
        if (isPass) {
          costPassCount += 1;
        } else {
          costFailCount += 1;
        }
      }

      gateStatusByCostAndCutoff[costKey] = Object.freeze(gateStatusMap);
      aggregateExcessReturnByCostAndCutoff[costKey] = { ...summary.aggregateExcessReturnByCutoff };
      aggregateMaximumDrawdownByCostAndCutoff[costKey] = { ...summary.aggregateMaximumDrawdownByCutoff };
      dominantThresholdRatioByCostAndCutoff[costKey] = { ...summary.dominantThresholdRatioByCutoff };
      operativePositionByCostAndCutoff[costKey] = { ...summary.operativePositionByCutoff };

      passCountByCost[costKey] = costPassCount;
      failCountByCost[costKey] = costFailCount;

      passCountAcrossAllCells += costPassCount;
      failCountAcrossAllCells += costFailCount;
    }

    let costSensitivityClassification: CostSensitivityClassification;
    if (passCountAcrossAllCells === totalCellCount) {
      costSensitivityClassification = "PASS_AT_ALL_COSTS_AND_CUTOFFS";
    } else if (failCountAcrossAllCells === totalCellCount) {
      costSensitivityClassification = "FAIL_AT_ALL_COSTS_AND_CUTOFFS";
    } else {
      costSensitivityClassification = "MIXED_ACROSS_COSTS_OR_CUTOFFS";
    }

    sensitivitySummaries[scenarioId] = {
      scenarioId,
      costCount,
      cutoffCount,
      gateStatusByCostAndCutoff: Object.freeze(
        Object.fromEntries(
          Object.entries(gateStatusByCostAndCutoff).map(([k, v]) => [k, Object.freeze(v)]),
        ),
      ),
      aggregateExcessReturnByCostAndCutoff: Object.freeze(
        Object.fromEntries(
          Object.entries(aggregateExcessReturnByCostAndCutoff).map(([k, v]) => [k, Object.freeze(v)]),
        ),
      ),
      aggregateMaximumDrawdownByCostAndCutoff: Object.freeze(
        Object.fromEntries(
          Object.entries(aggregateMaximumDrawdownByCostAndCutoff).map(([k, v]) => [k, Object.freeze(v)]),
        ),
      ),
      dominantThresholdRatioByCostAndCutoff: Object.freeze(
        Object.fromEntries(
          Object.entries(dominantThresholdRatioByCostAndCutoff).map(([k, v]) => [k, Object.freeze(v)]),
        ),
      ),
      operativePositionByCostAndCutoff: Object.freeze(
        Object.fromEntries(
          Object.entries(operativePositionByCostAndCutoff).map(([k, v]) => [k, Object.freeze(v)]),
        ),
      ),
      passCountByCost: Object.freeze(passCountByCost),
      failCountByCost: Object.freeze(failCountByCost),
      passCountAcrossAllCells,
      failCountAcrossAllCells,
      costSensitivityClassification,
    };
  }

  const firstCostKey = String(validatedCosts[0]!);
  const firstTemporalRun = temporalRunsByCost[firstCostKey]!;
  const policySha256 = hashValue(input.policy);

  const limitations = Object.freeze([
    "Single-symbol, non-overlapping replay only; no multi-symbol portfolio construction.",
    "The synthetic cost grid (" +
      validatedCosts.join(", ") +
      " bps) represents research sensitivity assumptions, not official TWSE/brokerage fee schedules.",
    "Volume was not adjusted for the 0050 split (volumeAdjustmentStatus=NOT_APPLIED); volume-derived features remain raw across all scenarios.",
    "This transaction cost sensitivity study evaluates performance across explicit cost assumptions and cutoffs; cost sensitivity is historical evidence only and does not guarantee future stability under market friction.",
    "No promotion, ranking, cost optimization, or investment-advice claim is made; sensitivity diagnostics and gate evaluations are reported for research review only.",
  ]);

  const outputCore = {
    schemaVersion: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1" as const,
    classification: "MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION" as const,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: "diagnostic-only" as const,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    requestedCutoffDates: validatedCutoffs,
    resolvedCutoffDates: firstTemporalRun.resolvedCutoffDates,
    requestedCostGridBps: validatedCosts,
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange: firstTemporalRun.source.fullDateRange,
      fullRowCount: input.rawRows.length,
    },
    policy: input.policy,
    policySha256,
    scenarioOrder: REQUIRED_SCENARIO_KEYS,
    temporalRunsByCost: Object.freeze(temporalRunsByCost),
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

import {
  hashValue,
  type ExperimentRunEvidence,
  type FinalTestEconomicEvidence,
  type PerSymbolLogisticChallengerEvidence,
  type PerSymbolLogisticChallengerFeatureFamily,
  type PerSymbolLogisticChallengerSymbolEvidence,
} from "@mms/research-kernel";

import {
  buildFinalTestPerSymbolEconomicEdge,
  type FinalTestEconomicEdgeGroup,
} from "./finalTestEconomicEdge.js";
import { LongCashReplayError } from "./types.js";

const SCHEMA_VERSION = "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const MODEL_ALGORITHM = "binary_logistic_regression" as const;

export type ChallengerConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";
export type ChallengerAggregateAnswer = "YES" | "NO" | "MIXED";

export interface PerSymbolLogisticChallengerDirectionalComparison {
  readonly incumbentAccuracy: number | null;
  readonly challengerAccuracy: number;
  readonly accuracyDeltaChallengerMinusIncumbent: number | null;
  readonly majorityBaselineAccuracy: number;
  readonly incumbentExcessReturn: number | null;
  readonly challengerExcessReturn: number;
  readonly excessDeltaChallengerMinusIncumbent: number | null;
}

export interface PerSymbolLogisticChallengerIncumbentEvidence {
  readonly finalTestRows: number;
  readonly accuracy: number | null;
  readonly majorityBaselineAccuracy: number | null;
  readonly excessReturn: number | null;
  readonly strategyNetReturn: number | null;
  readonly benchmarkNetReturn: number | null;
  readonly strategyMaximumDrawdown: number | null;
  readonly benchmarkMaximumDrawdown: number | null;
  readonly tradeCount: number | null;
}

export interface PerSymbolLogisticChallengerComparisonGroup {
  readonly symbol: string;
  readonly challenger: PerSymbolLogisticChallengerSymbolEvidence;
  readonly incumbent: PerSymbolLogisticChallengerIncumbentEvidence;
  readonly challengerEconomic: FinalTestEconomicEdgeGroup;
  readonly incumbentEconomic: FinalTestEconomicEdgeGroup | null;
  readonly incumbentVsChallenger: PerSymbolLogisticChallengerDirectionalComparison;
  readonly warnings: readonly string[];
}

export interface PerSymbolLogisticChallengerEvaluationResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly comparisonBaseline: "POOLED_INCUMBENT" | "PER_SYMBOL_CONTROL";
  readonly candidateDataQualityBasis: string;
  readonly incumbentModelAlgorithm: typeof MODEL_ALGORITHM;
  readonly challengerModelAlgorithm: typeof MODEL_ALGORITHM;
  readonly featureNames: readonly string[];
  readonly symbols: readonly string[];
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureFamily?: PerSymbolLogisticChallengerFeatureFamily;
  readonly groups: readonly PerSymbolLogisticChallengerComparisonGroup[];
  readonly doesAnyChallengerBeatDirectionalBaseline: ChallengerAggregateAnswer;
  readonly doesAnyChallengerBeatBuyAndHoldAfterCost: ChallengerAggregateAnswer;
  readonly doesAnyChallengerImproveBothDirectionalAndEconomicEvidence: ChallengerAggregateAnswer;
  readonly challengerConclusion: ChallengerConclusion;
  readonly promotionDecision: "do_not_promote";
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

export interface BuildPerSymbolLogisticChallengerEvaluationInput {
  readonly challenger: PerSymbolLogisticChallengerEvidence;
  readonly incumbentEvidence: ExperimentRunEvidence;
  readonly incumbentFinalTestEconomicEvidence: FinalTestEconomicEvidence;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface BuildPerSymbolLogisticFeatureChallengerEvaluationInput {
  readonly control: PerSymbolLogisticChallengerEvidence;
  readonly challenger: PerSymbolLogisticChallengerEvidence;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function rowKey(row: { readonly featureDate: string; readonly targetDate: string }): string {
  return `${row.featureDate}:${row.targetDate}`;
}

function rowsForSymbol(
  evidence: FinalTestEconomicEvidence,
  symbol: string,
) {
  return evidence.rows.filter((row) => row.symbol === symbol);
}

function sameWindow(
  left: readonly { readonly featureDate: string; readonly targetDate: string }[],
  right: readonly { readonly featureDate: string; readonly targetDate: string }[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return other !== undefined && rowKey(row) === rowKey(other);
  });
}

function directionalMetrics(
  rows: readonly { readonly target: 0 | 1; readonly prediction: 0 | 1 }[],
): { readonly accuracy: number; readonly majorityBaselineAccuracy: number } | null {
  if (rows.length === 0) return null;
  const correct = rows.filter((row) => row.target === row.prediction).length;
  const positiveCount = rows.filter((row) => row.target === 1).length;
  return {
    accuracy: round(correct / rows.length),
    majorityBaselineAccuracy: round(Math.max(positiveCount, rows.length - positiveCount) / rows.length),
  };
}

function incumbentEvidenceFor(
  evidence: FinalTestEconomicEvidence,
  economic: FinalTestEconomicEdgeGroup | null,
  symbol: string,
): PerSymbolLogisticChallengerIncumbentEvidence {
  const rows = rowsForSymbol(evidence, symbol);
  const metrics = directionalMetrics(rows);
  return {
    finalTestRows: rows.length,
    accuracy: metrics?.accuracy ?? null,
    majorityBaselineAccuracy: metrics?.majorityBaselineAccuracy ?? null,
    excessReturn: economic?.excessReturn ?? null,
    strategyNetReturn: economic?.strategyNetReturn ?? null,
    benchmarkNetReturn: economic?.benchmarkNetReturn ?? null,
    strategyMaximumDrawdown: economic?.strategyMaximumDrawdown ?? null,
    benchmarkMaximumDrawdown: economic?.benchmarkMaximumDrawdown ?? null,
    tradeCount: economic?.tradeCount ?? null,
  };
}

function aggregateAny(values: readonly (boolean | null)[]): ChallengerAggregateAnswer {
  if (values.some((value) => value === true)) return "YES";
  if (values.every((value) => value === false)) return "NO";
  return "MIXED";
}

function buildGroup(
  challenger: PerSymbolLogisticChallengerSymbolEvidence,
  incumbentFinalTestEconomicEvidence: FinalTestEconomicEvidence,
  incumbentEconomic: FinalTestEconomicEdgeGroup | null,
  roundTripCostBps: number,
  initialCapital: number,
): PerSymbolLogisticChallengerComparisonGroup {
  const challengerEconomicResult = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: challenger.finalTestEconomicEvidence,
    roundTripCostBps,
    initialCapital,
  });
  const challengerEconomic = challengerEconomicResult.groups.find(
    (group) => group.symbol === challenger.symbol,
  );
  if (challengerEconomic === undefined) {
    fail(`challenger economic replay is missing ${challenger.symbol}`);
  }

  const incumbentRows = rowsForSymbol(incumbentFinalTestEconomicEvidence, challenger.symbol);
  const comparable = sameWindow(challenger.finalTestEconomicEvidence.rows, incumbentRows);
  const incumbent = incumbentEvidenceFor(
    incumbentFinalTestEconomicEvidence,
    incumbentEconomic,
    challenger.symbol,
  );
  const warnings = [
    ...challenger.warnings,
    ...challengerEconomic.warnings,
  ];
  if (!comparable) {
    warnings.push(
      "Incumbent and challenger FINAL_TEST windows are not identical; comparison deltas are unavailable.",
    );
  }

  return Object.freeze({
    symbol: challenger.symbol,
    challenger,
    incumbent,
    challengerEconomic,
    incumbentEconomic: comparable ? incumbentEconomic : null,
    incumbentVsChallenger: Object.freeze({
      incumbentAccuracy: comparable ? incumbent.accuracy : null,
      challengerAccuracy: challenger.finalTestMetrics.accuracy,
      accuracyDeltaChallengerMinusIncumbent: comparable && incumbent.accuracy !== null
        ? round(challenger.finalTestMetrics.accuracy - incumbent.accuracy)
        : null,
      majorityBaselineAccuracy: challenger.majorityBaselineAccuracy,
      incumbentExcessReturn: comparable ? incumbent.excessReturn : null,
      challengerExcessReturn: challengerEconomic.excessReturn,
      excessDeltaChallengerMinusIncumbent: comparable
        && incumbent.excessReturn !== null
        ? round(challengerEconomic.excessReturn - incumbent.excessReturn)
        : null,
    }),
    warnings: Object.freeze(warnings),
  });
}

export function buildPerSymbolLogisticChallengerEvaluation(
  input: BuildPerSymbolLogisticChallengerEvaluationInput,
): PerSymbolLogisticChallengerEvaluationResult {
  if (input.challenger.groups.length === 0) fail("challenger evidence has no symbol groups");
  if (input.incumbentEvidence.finalTest.evaluationPartition !== "FINAL_TEST") {
    fail("incumbent evidence must use the FINAL_TEST partition");
  }
  const incumbentEconomicResult = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: input.incumbentFinalTestEconomicEvidence,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
  });
  const groups = input.challenger.groups.map((challenger) => buildGroup(
    challenger,
    input.incumbentFinalTestEconomicEvidence,
    incumbentEconomicResult.groups.find((group) => group.symbol === challenger.symbol) ?? null,
    input.roundTripCostBps,
    input.initialCapital,
  ));

  const directionalBaseline = groups.map((group) =>
    group.challenger.finalTestMetrics.accuracy > group.challenger.majorityBaselineAccuracy);
  const buyAndHold = groups.map((group) => group.challengerEconomic.excessReturn > 0);
  const improveBoth = groups.map((group) =>
    group.incumbentVsChallenger.accuracyDeltaChallengerMinusIncumbent !== null
    && group.incumbentVsChallenger.accuracyDeltaChallengerMinusIncumbent > 0
    && group.incumbentVsChallenger.excessDeltaChallengerMinusIncumbent !== null
    && group.incumbentVsChallenger.excessDeltaChallengerMinusIncumbent > 0,
  );
  const supportedCount = improveBoth.filter(Boolean).length;
  const challengerConclusion: ChallengerConclusion = supportedCount === 0
    ? "NOT_SUPPORTED"
    : supportedCount === groups.length
      ? "SUPPORTED"
      : "MIXED";
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    comparisonBaseline: "POOLED_INCUMBENT" as const,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    incumbentModelAlgorithm: MODEL_ALGORITHM,
    challengerModelAlgorithm: MODEL_ALGORITHM,
    featureNames: Object.freeze([...input.challenger.featureNames]),
    symbols: Object.freeze(groups.map(({ symbol }) => symbol)),
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames: Object.freeze([...input.incumbentEvidence.featureNames]),
    groups: Object.freeze(groups),
    doesAnyChallengerBeatDirectionalBaseline: aggregateAny(directionalBaseline),
    doesAnyChallengerBeatBuyAndHoldAfterCost: aggregateAny(buyAndHold),
    doesAnyChallengerImproveBothDirectionalAndEconomicEvidence: aggregateAny(improveBoth),
    challengerConclusion,
    promotionDecision: "do_not_promote" as const,
    warnings: Object.freeze([
      "Incumbent is the pooled technical-only logistic regression evaluated on the same adjusted canonical evidence.",
      "Challenger thresholds are selected from VALIDATION only; FINAL_TEST results do not modify the challenger.",
      "Economic replay uses the canonical long/cash simulator, same-window ALWAYS_LONG benchmark, and the supplied transaction-cost assumption.",
      "This result is diagnostic-only and does not rank symbols, select symbols, promote a model, or provide investment recommendations.",
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
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function buildEconomicGroupForEvidence(
  evidence: FinalTestEconomicEvidence,
  symbol: string,
  roundTripCostBps: number,
  initialCapital: number,
): FinalTestEconomicEdgeGroup {
  const economic = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: evidence,
    roundTripCostBps,
    initialCapital,
  }).groups.find((group) => group.symbol === symbol);
  if (economic === undefined) fail(`economic replay is missing ${symbol}`);
  return economic;
}

function buildFeatureChallengerGroup(
  challenger: PerSymbolLogisticChallengerSymbolEvidence,
  control: PerSymbolLogisticChallengerSymbolEvidence,
  roundTripCostBps: number,
  initialCapital: number,
): PerSymbolLogisticChallengerComparisonGroup {
  const challengerEconomic = buildEconomicGroupForEvidence(
    challenger.finalTestEconomicEvidence,
    challenger.symbol,
    roundTripCostBps,
    initialCapital,
  );
  const controlEconomic = buildEconomicGroupForEvidence(
    control.finalTestEconomicEvidence,
    control.symbol,
    roundTripCostBps,
    initialCapital,
  );
  const comparable = sameWindow(
    challenger.finalTestEconomicEvidence.rows,
    control.finalTestEconomicEvidence.rows,
  );
  const controlSummary = incumbentEvidenceFor(
    control.finalTestEconomicEvidence,
    controlEconomic,
    control.symbol,
  );
  const warnings = [
    ...challenger.warnings,
    ...challengerEconomic.warnings,
    "Control is the unchanged live incumbent feature vector fitted independently per symbol with the same temporal partitions.",
  ];
  if (!comparable) {
    warnings.push(
      "Control and challenger FINAL_TEST windows are not identical; comparison deltas are unavailable.",
    );
  }

  return Object.freeze({
    symbol: challenger.symbol,
    challenger,
    incumbent: controlSummary,
    challengerEconomic,
    incumbentEconomic: comparable ? controlEconomic : null,
    incumbentVsChallenger: Object.freeze({
      incumbentAccuracy: comparable ? controlSummary.accuracy : null,
      challengerAccuracy: challenger.finalTestMetrics.accuracy,
      accuracyDeltaChallengerMinusIncumbent: comparable && controlSummary.accuracy !== null
        ? round(challenger.finalTestMetrics.accuracy - controlSummary.accuracy)
        : null,
      majorityBaselineAccuracy: challenger.majorityBaselineAccuracy,
      incumbentExcessReturn: comparable ? controlSummary.excessReturn : null,
      challengerExcessReturn: challengerEconomic.excessReturn,
      excessDeltaChallengerMinusIncumbent: comparable && controlSummary.excessReturn !== null
        ? round(challengerEconomic.excessReturn - controlSummary.excessReturn)
        : null,
    }),
    warnings: Object.freeze(warnings),
  });
}

export function buildPerSymbolLogisticFeatureChallengerEvaluation(
  input: BuildPerSymbolLogisticFeatureChallengerEvaluationInput,
): PerSymbolLogisticChallengerEvaluationResult {
  if (input.control.groups.length === 0) fail("control evidence has no symbol groups");
  if (input.challenger.groups.length === 0) fail("challenger evidence has no symbol groups");
  if (input.challenger.featureFamily === undefined) {
    fail("feature challenger evidence is missing its frozen feature family");
  }
  const controlBySymbol = new Map(input.control.groups.map((group) => [group.symbol, group]));
  const groups = input.challenger.groups.map((challenger) => {
    const control = controlBySymbol.get(challenger.symbol);
    if (control === undefined) fail(`control evidence is missing ${challenger.symbol}`);
    return buildFeatureChallengerGroup(
      challenger,
      control,
      input.roundTripCostBps,
      input.initialCapital,
    );
  });
  if (groups.length !== input.control.groups.length) {
    fail("control and feature challenger symbol sets differ");
  }

  const directionalBaseline = groups.map((group) =>
    group.challenger.finalTestMetrics.accuracy > group.challenger.majorityBaselineAccuracy);
  const buyAndHold = groups.map((group) => group.challengerEconomic.excessReturn > 0);
  const improveBoth = groups.map((group) =>
    group.incumbentVsChallenger.accuracyDeltaChallengerMinusIncumbent !== null
    && group.incumbentVsChallenger.accuracyDeltaChallengerMinusIncumbent > 0
    && group.incumbentVsChallenger.excessDeltaChallengerMinusIncumbent !== null
    && group.incumbentVsChallenger.excessDeltaChallengerMinusIncumbent > 0,
  );
  const supportedCount = improveBoth.filter(Boolean).length;
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    comparisonBaseline: "PER_SYMBOL_CONTROL" as const,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    incumbentModelAlgorithm: MODEL_ALGORITHM,
    challengerModelAlgorithm: MODEL_ALGORITHM,
    featureNames: Object.freeze([...input.challenger.featureNames]),
    symbols: Object.freeze(groups.map(({ symbol }) => symbol)),
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames: Object.freeze([...input.control.featureNames]),
    featureFamily: input.challenger.featureFamily,
    groups: Object.freeze(groups),
    doesAnyChallengerBeatDirectionalBaseline: aggregateAny(directionalBaseline),
    doesAnyChallengerBeatBuyAndHoldAfterCost: aggregateAny(buyAndHold),
    doesAnyChallengerImproveBothDirectionalAndEconomicEvidence: aggregateAny(improveBoth),
    challengerConclusion: supportedCount === 0
      ? "NOT_SUPPORTED" as const
      : supportedCount === groups.length
        ? "SUPPORTED" as const
        : "MIXED" as const,
    promotionDecision: "do_not_promote" as const,
    warnings: Object.freeze([
      "The control is the unchanged live incumbent feature vector; the challenger adds exactly one frozen legacy-derived OHLCV feature family.",
      "Control and challenger use the same canonical temporal boundaries, training-only fitting, validation-only threshold selection, and untouched FINAL_TEST rows.",
      "Economic replay uses the canonical long/cash simulator, same-window ALWAYS_LONG benchmark, and the supplied transaction-cost assumption.",
      "This result is diagnostic-only and does not rank symbols, select symbols, promote a model, or provide investment recommendations.",
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
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

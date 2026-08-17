import {
  filterRowsForCutoff,
  hashValue,
  isCanonicalIsoDate,
  resolveDataEndDate,
  runResearchEvidenceKernel,
  toMarketRows,
  validateCutoffDates,
  type DatasetVersion,
  type RawTwStrategyResearchRow,
  type PerSymbolLogisticChallengerFeatureFamily,
  type PerSymbolLogisticChallengerSymbolEvidence,
} from "@mms/research-kernel";

import {
  buildPerSymbolLogisticChallengerEvaluation,
  buildPerSymbolLogisticFeatureChallengerEvaluation,
  type PerSymbolLogisticChallengerComparisonGroup,
  type PerSymbolLogisticChallengerIncumbentEvidence,
} from "./perSymbolLogisticChallenger.js";
import {
  LongCashReplayError,
  type LongCashReplayGuardrails,
} from "./types.js";
import type { FinalTestEconomicEdgeGroup } from "./finalTestEconomicEdge.js";

const SCHEMA_VERSION = "MMS_0056_PER_SYMBOL_LOGISTIC_CHALLENGER_TEMPORAL_CONFIRMATION_V1" as const;
const CLASSIFICATION = "MMS_0056_LEGACY_TECHNICAL_FEATURE_CHALLENGER_V1_READY" as const;
const TARGET_SYMBOL = "0056" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

export interface PerSymbolLogisticChallengerTemporalSource {
  readonly path: string;
  readonly sha256: string;
}

export interface PerSymbolLogisticChallengerTemporalInput {
  readonly rawRows: readonly RawTwStrategyResearchRow[];
  readonly cutoffDates: readonly string[];
  readonly source: PerSymbolLogisticChallengerTemporalSource;
  readonly datasetVersion: DatasetVersion;
  readonly reviewDate: string;
  readonly candidateDataQualityBasis: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly legacyFeatureSource?: {
    readonly path: string;
    readonly sha256: string;
  };
}

export interface PerSymbolLogisticChallengerTemporalCutoffResult {
  readonly cutoff: string;
  readonly asOf: string;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly sourceRowsAsOf: number;
  readonly symbolRowsAsOf: number;
  readonly marketRowsSha256: string;
  readonly featureRowsSha256: string;
  readonly challengerFeatureRowsSha256: string;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly featureFamily: PerSymbolLogisticChallengerFeatureFamily;
  readonly finalTestEndDate: string;
  readonly dataQualityFindings: readonly string[];
  readonly control: PerSymbolLogisticChallengerSymbolEvidence;
  readonly challenger: PerSymbolLogisticChallengerSymbolEvidence;
  readonly pooledIncumbent: PerSymbolLogisticChallengerIncumbentEvidence;
  readonly controlEconomic: FinalTestEconomicEdgeGroup;
  readonly challengerEconomic: FinalTestEconomicEdgeGroup;
  readonly pooledIncumbentEconomic: FinalTestEconomicEdgeGroup | null;
  readonly controlVsChallenger: PerSymbolLogisticChallengerComparisonGroup["incumbentVsChallenger"];
  readonly incumbentVsChallenger: PerSymbolLogisticChallengerComparisonGroup["incumbentVsChallenger"];
  readonly warnings: readonly string[];
  readonly normalizedResultSha256: string;
}

export interface PerSymbolLogisticChallengerTemporalSummary {
  readonly temporalCutoffCount: number;
  readonly positiveExcessCutoffCount: number;
  readonly nonPositiveExcessCutoffCount: number;
  readonly positiveExcessFraction: number;
  readonly medianExcessReturn: number;
  readonly minimumExcessReturn: number;
  readonly maximumExcessReturn: number;
  readonly latestExcessReturn: number;
  readonly medianAccuracyDeltaVsBaseline: number;
  readonly numberOfCutoffsBeatingDirectionalBaseline: number;
  readonly cutoffsBeatingDirectionalBaseline: number;
  readonly observedThresholds: readonly number[];
  readonly thresholdRange: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly dataQualityWarnings: readonly string[];
}

export interface PerSymbolLogisticChallengerTemporalComparisonSummary {
  readonly cutoffCount: number;
  readonly challengerAccuracyWinsVsControl: number;
  readonly challengerEconomicWinsVsControl: number;
  readonly challengerImprovesBothVsControl: number;
  readonly controlPositiveExcessCutoffs: number;
  readonly challengerPositiveExcessCutoffs: number;
}

export interface PerSymbolLogisticChallengerControlReproduction {
  readonly status: "PASS" | "NOT_APPLICABLE";
  readonly expected: {
    readonly positiveExcessCutoffs: number;
    readonly directionalBaselineWins: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly threshold: number;
  };
  readonly observed: {
    readonly positiveExcessCutoffs: number;
    readonly directionalBaselineWins: number;
    readonly medianExcessReturn: number;
    readonly latestExcessReturn: number;
    readonly observedThresholds: readonly number[];
  };
}

export type PerSymbolLogisticChallengerTemporalAnswer = "YES" | "NO" | "MIXED";
export type PerSymbolLogisticChallengerTemporalNextRoute =
  | "SUPPORTED_SYMBOL_FURTHER_RESEARCH"
  | "FEATURE_CHALLENGER_V1";

export interface PerSymbolLogisticChallengerTemporalGuardrails extends LongCashReplayGuardrails {
  readonly supportsSymbolSelection: false;
}

export interface PerSymbolLogisticChallengerTemporalResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly classification: typeof CLASSIFICATION;
  readonly dataClassification: "HISTORICAL_RESEARCH_STUDY";
  readonly reviewDate: string;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly providesInvestmentAdvice: false;
  readonly currentDatePredictionClaim: false;
  readonly symbol: typeof TARGET_SYMBOL;
  readonly candidateDataQualityBasis: string;
  readonly datasetVersion: DatasetVersion;
  readonly requestedCutoffDates: readonly string[];
  readonly source: {
    readonly path: string;
    readonly sha256: string;
    readonly fullDateRange: { readonly min: string; readonly max: string };
    readonly fullRowCount: number;
    readonly symbolRowCount: number;
    readonly dataAsOf: string;
  };
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly controlFeatureNames: readonly string[];
  readonly featureNames: readonly string[];
  readonly featureFamily: PerSymbolLogisticChallengerFeatureFamily;
  readonly legacyFeatureSource?: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly cutoffRuns: readonly PerSymbolLogisticChallengerTemporalCutoffResult[];
  readonly controlTemporalSummary: PerSymbolLogisticChallengerTemporalSummary;
  readonly temporalSummary: PerSymbolLogisticChallengerTemporalSummary;
  readonly comparisonSummary: PerSymbolLogisticChallengerTemporalComparisonSummary;
  readonly controlReproduction: PerSymbolLogisticChallengerControlReproduction;
  readonly does0056EconomicEdgeRepeatAcrossTime: PerSymbolLogisticChallengerTemporalAnswer;
  readonly does0056EverBeatDirectionalBaseline: "YES" | "NO";
  readonly temporalConclusion: "DESCRIPTIVE_ONLY";
  readonly ceoNextRoute: PerSymbolLogisticChallengerTemporalNextRoute;
  readonly promotionDecision: "do_not_promote";
  readonly warnings: readonly string[];
  readonly guardrails: PerSymbolLogisticChallengerTemporalGuardrails;
  readonly normalizedResultSha256: string;
}

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function uniqueMessages(messages: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(messages.filter((message) => message.trim().length > 0))]);
}

function minimumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find minimum date in an empty collection");
  return values.reduce((minimum, value) => value < minimum ? value : minimum, first);
}

function maximumDate(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) fail("cannot find maximum date in an empty collection");
  return values.reduce((maximum, value) => value > maximum ? value : maximum, first);
}

function median(values: readonly number[]): number {
  if (values.length === 0) fail("cannot compute a median from zero values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - (sorted.length % 2 === 0 ? 1 : 0)];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) fail("median values are incomplete");
  return round((lower + upper) / 2);
}

function guardrails(): PerSymbolLogisticChallengerTemporalGuardrails {
  return Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
    supportsSymbolSelection: false,
  });
}

const CONTROL_EXPECTED_CUTOFFS = Object.freeze([
  { cutoff: "2025-09-30", accuracy: 0.57818182, majorityBaseline: 0.52, excessReturn: 0.09185705 },
  { cutoff: "2025-12-31", accuracy: 0.52961672, majorityBaseline: 0.50174216, excessReturn: 0.0023688 },
  { cutoff: "2026-03-31", accuracy: 0.51677852, majorityBaseline: 0.53355705, excessReturn: 0.20152868 },
  { cutoff: "2026-07-01", accuracy: 0.48874598, majorityBaseline: 0.56913183, excessReturn: -0.01025134 },
] as const);

function assertCutoffBoundaries(
  cutoff: string,
  asOf: string,
  challenger: PerSymbolLogisticChallengerSymbolEvidence,
): void {
  if (!isCanonicalIsoDate(cutoff) || !isCanonicalIsoDate(asOf)) {
    fail(`cutoff/asOf identity is not canonical: ${cutoff}/${asOf}`);
  }
  if (asOf > cutoff) fail(`resolved asOf ${asOf} exceeds requested cutoff ${cutoff}`);
  if (challenger.thresholdSelection.selectionPartition !== "VALIDATION") {
    fail(`0056 threshold selection did not use VALIDATION at cutoff ${cutoff}`);
  }
  if (challenger.fit.fitPartition !== "TRAINING") {
    fail(`0056 model fit did not use TRAINING at cutoff ${cutoff}`);
  }
  if (challenger.fit.trainingRowsSha256 !== challenger.trainingRowsSha256) {
    fail(`0056 model fit rows drifted at cutoff ${cutoff}`);
  }
  if (challenger.thresholdSelection.validationRowsSha256 === challenger.finalTestRowsSha256) {
    fail(`0056 validation and final-test rows are identical at cutoff ${cutoff}`);
  }
  if (challenger.finalTest.evaluationPartition !== "FINAL_TEST") {
    fail(`0056 final-test partition is unresolved at cutoff ${cutoff}`);
  }
  if (challenger.finalTestEconomicEvidence.rows.some((row) => row.targetDate > asOf)) {
    fail(`0056 final-test target exceeds asOf at cutoff ${cutoff}`);
  }
  if (challenger.finalTestEconomicEvidence.rows.some((row) => row.featureDate > asOf)) {
    fail(`0056 final-test feature exceeds asOf at cutoff ${cutoff}`);
  }
}

function evaluateCutoff(
  input: PerSymbolLogisticChallengerTemporalInput,
  cutoff: string,
): PerSymbolLogisticChallengerTemporalCutoffResult {
  const cutoffRawRows = filterRowsForCutoff(input.rawRows, cutoff);
  const asOf = resolveDataEndDate(cutoffRawRows, cutoff);
  const symbolRows = toMarketRows(cutoffRawRows, TARGET_SYMBOL);
  if (symbolRows.length === 0) fail(`0056 has no source rows at cutoff ${cutoff}`);
  if (symbolRows.some((row) => row.date > asOf)) {
    fail(`0056 source row exceeds resolved asOf at cutoff ${cutoff}`);
  }
  const pooledSymbols = [...new Set(cutoffRawRows.map(({ symbol }) => symbol))].sort();
  const pooledMarketRows = pooledSymbols.flatMap((symbol) => toMarketRows(cutoffRawRows, symbol));
  if (pooledMarketRows.length === 0) fail(`pooled incumbent has no source rows at cutoff ${cutoff}`);

  const evidenceResult = runResearchEvidenceKernel({
    datasetVersion: input.datasetVersion,
    marketRows: pooledMarketRows,
  });
  const controlEvidence = evidenceResult.perSymbolLogisticChallenger;
  const challengerEvidence = evidenceResult.perSymbolLogisticFeatureChallenger;
  const incumbentEconomicEvidence = evidenceResult.finalTestEconomicEvidence;
  if (
    controlEvidence === undefined
    || challengerEvidence === undefined
    || incumbentEconomicEvidence === undefined
  ) {
    fail(`0056 challenger continuation evidence is unavailable at cutoff ${cutoff}`);
  }
  if (!controlEvidence.symbols.includes(TARGET_SYMBOL) || !challengerEvidence.symbols.includes(TARGET_SYMBOL)) {
    fail(`0056 temporal replay omitted the target symbol at cutoff ${cutoff}`);
  }

  const controlEvaluation = buildPerSymbolLogisticChallengerEvaluation({
    challenger: controlEvidence,
    incumbentEvidence: evidenceResult.evidence,
    incumbentFinalTestEconomicEvidence: incumbentEconomicEvidence,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
  });
  const challengerEvaluation = buildPerSymbolLogisticFeatureChallengerEvaluation({
    control: controlEvidence,
    challenger: challengerEvidence,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
  });
  const controlGroup = controlEvaluation.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  const challengerGroup = challengerEvaluation.groups.find(({ symbol }) => symbol === TARGET_SYMBOL);
  if (controlGroup === undefined || challengerGroup === undefined) {
    fail(`0056 challenger evaluation group is missing at cutoff ${cutoff}`);
  }

  assertCutoffBoundaries(cutoff, asOf, controlGroup.challenger);
  assertCutoffBoundaries(cutoff, asOf, challengerGroup.challenger);
  if (controlGroup.challengerEconomic.transactionCostBps !== input.roundTripCostBps
    || challengerGroup.challengerEconomic.transactionCostBps !== input.roundTripCostBps) {
    fail(`0056 transaction cost drifted at cutoff ${cutoff}`);
  }
  if (controlGroup.challengerEconomic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH"
    || challengerGroup.challengerEconomic.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH") {
    fail(`0056 strategy policy drifted at cutoff ${cutoff}`);
  }
  if (controlGroup.challengerEconomic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK"
    || challengerGroup.challengerEconomic.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK") {
    fail(`0056 benchmark policy drifted at cutoff ${cutoff}`);
  }
  if (challengerEvidence.featureFamily === undefined) {
    fail(`0056 frozen feature family is missing at cutoff ${cutoff}`);
  }

  const dataQualityFindings = evidenceResult.evidence.dataQualityFindings.map(({ message }) => message);
  const warnings = uniqueMessages([
    ...dataQualityFindings,
    ...challengerGroup.warnings,
    ...controlGroup.warnings,
    `As-of boundary enforced at ${asOf}; source rows and FINAL_TEST target rows do not exceed this date.`,
    "This cutoff was fitted independently; no fitted model or threshold was reused from another cutoff.",
    "The unchanged control and additive feature challenger were both fitted independently; 0056 is the only reported challenger candidate.",
  ]);
  const normalized = {
    cutoff,
    asOf,
    symbol: TARGET_SYMBOL,
    sourceRowsAsOf: cutoffRawRows.length,
    symbolRowsAsOf: symbolRows.length,
    marketRowsSha256: evidenceResult.evidence.datasetSha256,
    featureRowsSha256: evidenceResult.evidence.featureRowsSha256,
    challengerFeatureRowsSha256: challengerEvidence.featureRowsSha256,
    controlFeatureNames: controlEvidence.featureNames,
    featureNames: challengerEvidence.featureNames,
    featureFamily: challengerEvidence.featureFamily,
    finalTestEndDate: maximumDate(
      challengerGroup.challenger.finalTestEconomicEvidence.rows.map(({ targetDate }) => targetDate),
    ),
    dataQualityFindings,
    control: controlGroup.challenger,
    challenger: challengerGroup.challenger,
    pooledIncumbent: challengerGroup.incumbent,
    controlEconomic: controlGroup.challengerEconomic,
    challengerEconomic: challengerGroup.challengerEconomic,
    pooledIncumbentEconomic: challengerGroup.incumbentEconomic,
    controlVsChallenger: challengerGroup.incumbentVsChallenger,
    incumbentVsChallenger: challengerGroup.incumbentVsChallenger,
    warnings,
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

function summarizeCutoffs(
  cutoffRuns: readonly PerSymbolLogisticChallengerTemporalCutoffResult[],
  select: (run: PerSymbolLogisticChallengerTemporalCutoffResult) => {
    readonly evidence: PerSymbolLogisticChallengerSymbolEvidence;
    readonly economic: FinalTestEconomicEdgeGroup;
  },
): PerSymbolLogisticChallengerTemporalSummary {
  if (cutoffRuns.length === 0) fail("0056 temporal replay produced no cutoff runs");
  const selected = cutoffRuns.map(select);
  const excessReturns = selected.map(({ economic }) => economic.excessReturn);
  const accuracyDeltas = selected.map(({ evidence }) => evidence.accuracyDelta);
  const thresholds = [...new Set(selected.map(({ evidence }) => evidence.thresholdSelection.selectedThreshold))]
    .sort((left, right) => left - right);
  const positiveExcessCutoffCount = excessReturns.filter((value) => value > 0).length;
  const numberOfCutoffsBeatingDirectionalBaseline = selected.filter(({ evidence }) =>
    evidence.finalTestMetrics.accuracy > evidence.majorityBaselineAccuracy,
  ).length;
  const dataQualityWarnings = uniqueMessages(cutoffRuns.flatMap(({ dataQualityFindings }) => dataQualityFindings));
  const minimumThreshold = thresholds[0];
  const maximumThreshold = thresholds.at(-1);
  if (minimumThreshold === undefined || maximumThreshold === undefined) {
    fail("0056 temporal threshold observations are missing");
  }
  return Object.freeze({
    temporalCutoffCount: cutoffRuns.length,
    positiveExcessCutoffCount,
    nonPositiveExcessCutoffCount: cutoffRuns.length - positiveExcessCutoffCount,
    positiveExcessFraction: round(positiveExcessCutoffCount / cutoffRuns.length),
    medianExcessReturn: median(excessReturns),
    minimumExcessReturn: round(Math.min(...excessReturns)),
    maximumExcessReturn: round(Math.max(...excessReturns)),
    latestExcessReturn: excessReturns.at(-1)!,
    medianAccuracyDeltaVsBaseline: median(accuracyDeltas),
    numberOfCutoffsBeatingDirectionalBaseline,
    cutoffsBeatingDirectionalBaseline: numberOfCutoffsBeatingDirectionalBaseline,
    observedThresholds: Object.freeze(thresholds),
    thresholdRange: Object.freeze({
      minimum: minimumThreshold,
      maximum: maximumThreshold,
    }),
    dataQualityWarnings,
  });
}

function assertControlReproduction(
  cutoffRuns: readonly PerSymbolLogisticChallengerTemporalCutoffResult[],
  controlSummary: PerSymbolLogisticChallengerTemporalSummary,
): PerSymbolLogisticChallengerControlReproduction {
  const observedCutoffs = cutoffRuns.map((run) => ({
    cutoff: run.cutoff,
    accuracy: run.control.finalTestMetrics.accuracy,
    majorityBaseline: run.control.majorityBaselineAccuracy,
    excessReturn: run.controlEconomic.excessReturn,
  }));
  const expectedDatesMatch = cutoffRuns.length === CONTROL_EXPECTED_CUTOFFS.length
    && CONTROL_EXPECTED_CUTOFFS.every((expected, index) => cutoffRuns[index]?.cutoff === expected.cutoff);
  const observed = {
    positiveExcessCutoffs: controlSummary.positiveExcessCutoffCount,
    directionalBaselineWins: controlSummary.numberOfCutoffsBeatingDirectionalBaseline,
    medianExcessReturn: controlSummary.medianExcessReturn,
    latestExcessReturn: controlSummary.latestExcessReturn,
    observedThresholds: controlSummary.observedThresholds,
  };
  if (!expectedDatesMatch) {
    return Object.freeze({
      status: "NOT_APPLICABLE",
      expected: {
        positiveExcessCutoffs: 3,
        directionalBaselineWins: 2,
        medianExcessReturn: 0.04711292,
        latestExcessReturn: -0.01025134,
        threshold: 0.575,
      },
      observed,
    });
  }
  const matches = CONTROL_EXPECTED_CUTOFFS.every((expected, index) => {
    const observed = observedCutoffs[index];
    return observed !== undefined
      && observed.cutoff === expected.cutoff
      && observed.accuracy === expected.accuracy
      && observed.majorityBaseline === expected.majorityBaseline
      && observed.excessReturn === expected.excessReturn;
  });
  const summaryMatches = controlSummary.positiveExcessCutoffCount === 3
    && controlSummary.numberOfCutoffsBeatingDirectionalBaseline === 2
    && controlSummary.medianExcessReturn === 0.04711292
    && controlSummary.latestExcessReturn === -0.01025134
    && controlSummary.observedThresholds.length === 1
    && controlSummary.observedThresholds[0] === 0.575;
  if (!matches || !summaryMatches) {
    fail("STOP_MMS_0056_FEATURE_CHALLENGER_CONTROL_DRIFT");
  }
  return Object.freeze({
    status: "PASS",
    expected: {
      positiveExcessCutoffs: 3,
      directionalBaselineWins: 2,
      medianExcessReturn: 0.04711292,
      latestExcessReturn: -0.01025134,
      threshold: 0.575,
    },
    observed,
  });
}

function summarizeComparisons(
  cutoffRuns: readonly PerSymbolLogisticChallengerTemporalCutoffResult[],
): PerSymbolLogisticChallengerTemporalComparisonSummary {
  return Object.freeze({
    cutoffCount: cutoffRuns.length,
    challengerAccuracyWinsVsControl: cutoffRuns.filter(({ controlVsChallenger }) =>
      controlVsChallenger.accuracyDeltaChallengerMinusIncumbent !== null
      && controlVsChallenger.accuracyDeltaChallengerMinusIncumbent > 0).length,
    challengerEconomicWinsVsControl: cutoffRuns.filter(({ controlVsChallenger }) =>
      controlVsChallenger.excessDeltaChallengerMinusIncumbent !== null
      && controlVsChallenger.excessDeltaChallengerMinusIncumbent > 0).length,
    challengerImprovesBothVsControl: cutoffRuns.filter(({ controlVsChallenger }) =>
      controlVsChallenger.accuracyDeltaChallengerMinusIncumbent !== null
      && controlVsChallenger.accuracyDeltaChallengerMinusIncumbent > 0
      && controlVsChallenger.excessDeltaChallengerMinusIncumbent !== null
      && controlVsChallenger.excessDeltaChallengerMinusIncumbent > 0).length,
    controlPositiveExcessCutoffs: cutoffRuns.filter(({ controlEconomic }) => controlEconomic.excessReturn > 0).length,
    challengerPositiveExcessCutoffs: cutoffRuns.filter(({ challengerEconomic }) => challengerEconomic.excessReturn > 0).length,
  });
}

export function runPerSymbolLogisticChallengerTemporalConfirmation(
  input: PerSymbolLogisticChallengerTemporalInput,
): PerSymbolLogisticChallengerTemporalResult {
  const cutoffDates = validateCutoffDates(input.cutoffDates);
  if (input.rawRows.length === 0) fail("0056 temporal replay requires source rows");
  if (!Number.isFinite(input.roundTripCostBps) || input.roundTripCostBps < 0) {
    fail(`roundTripCostBps is invalid: ${input.roundTripCostBps}`);
  }
  if (!Number.isFinite(input.initialCapital) || input.initialCapital <= 0) {
    fail(`initialCapital is invalid: ${input.initialCapital}`);
  }
  if (input.candidateDataQualityBasis.trim().length === 0) {
    fail("candidateDataQualityBasis must not be blank");
  }

  const symbolRows = input.rawRows.filter(({ symbol }) => symbol === TARGET_SYMBOL);
  if (symbolRows.length === 0) fail("0056 temporal replay requires 0056 source rows");
  const allDates = symbolRows.map(({ date }) => date);
  const cutoffRuns = cutoffDates.map((cutoff) => evaluateCutoff(input, cutoff));
  const controlTemporalSummary = summarizeCutoffs(cutoffRuns, ({ control, controlEconomic }) => ({
    evidence: control,
    economic: controlEconomic,
  }));
  const temporalSummary = summarizeCutoffs(cutoffRuns, ({ challenger, challengerEconomic }) => ({
    evidence: challenger,
    economic: challengerEconomic,
  }));
  const controlReproduction = assertControlReproduction(cutoffRuns, controlTemporalSummary);
  const comparisonSummary = summarizeComparisons(cutoffRuns);
  const featureFamily = cutoffRuns[0]?.featureFamily;
  if (featureFamily === undefined) fail("0056 frozen feature family is unavailable");
  const controlFeatureNames = cutoffRuns[0]?.controlFeatureNames;
  if (controlFeatureNames === undefined) fail("0056 control feature inventory is unavailable");
  const positiveAnswer: PerSymbolLogisticChallengerTemporalAnswer =
    temporalSummary.positiveExcessCutoffCount === temporalSummary.temporalCutoffCount
      ? "YES"
      : temporalSummary.positiveExcessCutoffCount === 0
        ? "NO"
        : "MIXED";
  const directionalAnswer: PerSymbolLogisticChallengerTemporalAnswer =
    temporalSummary.numberOfCutoffsBeatingDirectionalBaseline > 0 ? "YES" : "NO";
  const ceoNextRoute: PerSymbolLogisticChallengerTemporalNextRoute = positiveAnswer === "YES"
    ? "SUPPORTED_SYMBOL_FURTHER_RESEARCH"
    : "FEATURE_CHALLENGER_V1";
  const warnings = uniqueMessages([
    ...temporalSummary.dataQualityWarnings,
    "Only 0056 was evaluated; no other symbol was selected, ranked, optimized, or promoted.",
    "Each cutoff used source rows available on or before that cutoff and refit the scaler, logistic model, and validation threshold independently.",
    "Economic evidence is descriptive only and uses the canonical long/cash simulator, same-window buy-and-hold benchmark, and the supplied 10 bps cost assumption.",
    "Control reproduction passed before any feature-challenger conclusion was computed.",
    "No current unresolved prediction labels enter any historical replay.",
    "Promotion remains do_not_promote regardless of temporal result.",
  ]);
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    classification: CLASSIFICATION,
    dataClassification: "HISTORICAL_RESEARCH_STUDY" as const,
    reviewDate: input.reviewDate,
    researchMode: RESEARCH_MODE,
    providesInvestmentAdvice: false as const,
    currentDatePredictionClaim: false as const,
    symbol: TARGET_SYMBOL,
    candidateDataQualityBasis: input.candidateDataQualityBasis,
    datasetVersion: input.datasetVersion,
    requestedCutoffDates: cutoffDates,
    source: {
      path: input.source.path,
      sha256: input.source.sha256,
      fullDateRange: {
        min: minimumDate(allDates),
        max: maximumDate(allDates),
      },
      fullRowCount: input.rawRows.length,
      symbolRowCount: symbolRows.length,
      dataAsOf: maximumDate(allDates),
    },
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    controlFeatureNames,
    featureNames: cutoffRuns[0]!.featureNames,
    featureFamily,
    ...(input.legacyFeatureSource === undefined ? {} : { legacyFeatureSource: input.legacyFeatureSource }),
    cutoffRuns,
    controlTemporalSummary,
    temporalSummary,
    comparisonSummary,
    controlReproduction,
    does0056EconomicEdgeRepeatAcrossTime: positiveAnswer,
    does0056EverBeatDirectionalBaseline: directionalAnswer,
    temporalConclusion: "DESCRIPTIVE_ONLY" as const,
    ceoNextRoute,
    promotionDecision: "do_not_promote" as const,
    warnings,
    guardrails: guardrails(),
  };
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

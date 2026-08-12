import {
  hashValue,
  type DataQualityFinding,
  type FinalTestEconomicEvidence,
} from "@mms/research-kernel";

import {
  buildFinalTestPerSymbolEconomicEdge,
  type FinalTestEconomicEdgeGroup,
} from "./finalTestEconomicEdge.js";
import { LongCashReplayError } from "./types.js";

const SCHEMA_VERSION = "MMS_0050_RAW_ADJUSTED_ECONOMIC_EDGE_RECONCILIATION_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const SYMBOL = "0050" as const;
const RAW_SCENARIO = "0050_RAW" as const;
const ADJUSTED_SCENARIO = "0050_SOURCE_QUALIFIED_ADJUSTED" as const;
const RAW_CLASSIFICATION = "RAW_UNADJUSTED_PRICE_PATH" as const;
const ADJUSTED_CLASSIFICATION = "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH" as const;
const PREDICTION_SOURCE = "MMS_RESEARCH_EVIDENCE_V1_FINAL_TEST_SCORED_ROWS" as const;
const POSITION_SOURCE = "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1_FROZEN_THRESHOLD_DECISION" as const;
const THRESHOLD_SOURCE = "VALIDATION" as const;

export type FinalTestEconomicReconciliationClassification =
  | "DATA_QUALITY_ARTIFACT"
  | "EDGE_SURVIVES_ADJUSTMENT"
  | "UNRESOLVED_COMPARABILITY";

export type FinalTestEconomicReconciliationWindowStatus = "IDENTICAL" | "UNRESOLVED";

export interface FinalTestEconomicReconciliationScenarioInput {
  readonly scenario: typeof RAW_SCENARIO | typeof ADJUSTED_SCENARIO;
  readonly sourceDataQualityClassification:
    | typeof RAW_CLASSIFICATION
    | typeof ADJUSTED_CLASSIFICATION;
  readonly sourceEvidenceReference: string;
  readonly finalTestEvidence: FinalTestEconomicEvidence;
  readonly dataQualityFindings: readonly DataQualityFinding[];
  readonly corporateActionWarnings: readonly string[];
}

export interface FinalTestEconomicReconciliationInput {
  readonly raw: FinalTestEconomicReconciliationScenarioInput;
  readonly adjusted: FinalTestEconomicReconciliationScenarioInput;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
}

export interface FinalTestEconomicReconciliationScenario {
  readonly scenario: typeof RAW_SCENARIO | typeof ADJUSTED_SCENARIO;
  readonly symbol: typeof SYMBOL;
  readonly sourceDataQualityClassification:
    | typeof RAW_CLASSIFICATION
    | typeof ADJUSTED_CLASSIFICATION;
  readonly sourceEvidenceReference: string;
  readonly evaluationStartDate: string;
  readonly evaluationEndDate: string;
  readonly finalTestRowCount: number;
  readonly finalTestRowsSha256: string;
  readonly finalTestScoredRowsSha256: string;
  readonly predictionSource: typeof PREDICTION_SOURCE;
  readonly positionSource: typeof POSITION_SOURCE;
  readonly operativeThreshold: number;
  readonly operativeThresholdSource: typeof THRESHOLD_SOURCE;
  readonly transactionCostBps: number;
  readonly strategyGrossReturn: number;
  readonly strategyNetReturn: number;
  readonly benchmarkGrossReturn: number;
  readonly benchmarkNetReturn: number;
  readonly excessReturn: number;
  readonly strategyMaximumDrawdown: number;
  readonly benchmarkMaximumDrawdown: number;
  readonly tradeCount: number;
  readonly dataQualityWarnings: readonly string[];
  readonly corporateActionWarnings: readonly string[];
  readonly replayWarnings: readonly string[];
}

export interface FinalTestEconomicReconciliation {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly researchMode: typeof RESEARCH_MODE;
  readonly symbol: typeof SYMBOL;
  readonly classification: FinalTestEconomicReconciliationClassification;
  readonly raw: FinalTestEconomicReconciliationScenario;
  readonly adjusted: FinalTestEconomicReconciliationScenario;
  readonly rawVsAdjusted: {
    readonly benchmarkReturnDelta: number | null;
    readonly strategyReturnDelta: number | null;
    readonly excessReturnDelta: number | null;
  };
  readonly commonWindowCheck: {
    readonly status: FinalTestEconomicReconciliationWindowStatus;
    readonly rawWindowKeysSha256: string;
    readonly adjustedWindowKeysSha256: string;
    readonly reason?: string;
  };
  readonly warnings: readonly string[];
  readonly promotionDecision: "do_not_promote";
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

function uniqueMessages(messages: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(messages.map((message) => message.trim()).filter(Boolean))]);
}

function formatFinding(finding: DataQualityFinding): string {
  const location = [
    finding.symbol,
    finding.date,
    finding.priorDate === undefined ? undefined : `prior=${finding.priorDate}`,
  ].filter((value): value is string => value !== undefined).join(" ");
  const value = finding.value === undefined ? "" : ` value=${round(finding.value)}`;
  return `${finding.code}${location.length === 0 ? "" : ` [${location}]`}: ${finding.message}${value}`;
}

function rowKey(row: FinalTestEconomicEvidence["rows"][number]): string {
  return `${row.symbol}\u0000${row.featureDate}\u0000${row.targetDate}`;
}

function windowKeys(evidence: FinalTestEconomicEvidence): readonly string[] {
  const keys = evidence.rows
    .filter((row) => row.symbol === SYMBOL)
    .map(rowKey)
    .sort();
  if (keys.length === 0) fail("0050 final-test economic evidence is missing");
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index] === keys[index - 1]) fail(`0050 final-test economic evidence has duplicate row ${keys[index]}`);
  }
  return Object.freeze(keys);
}

function findGroup(
  groups: readonly FinalTestEconomicEdgeGroup[],
  scenario: string,
): FinalTestEconomicEdgeGroup {
  const group = groups.find(({ symbol }) => symbol === SYMBOL);
  if (group === undefined) fail(`${scenario} final-test economic evidence is missing 0050`);
  return group;
}

function buildScenario(
  input: FinalTestEconomicReconciliationScenarioInput,
  group: FinalTestEconomicEdgeGroup,
  evidence: FinalTestEconomicEvidence,
): FinalTestEconomicReconciliationScenario {
  if (input.sourceEvidenceReference.trim().length === 0) {
    fail(`${input.scenario} source evidence reference must not be blank`);
  }
  const dataQualityWarnings = input.dataQualityFindings
    .filter((finding) => finding.symbol === undefined || finding.symbol === SYMBOL)
    .map(formatFinding);
  return Object.freeze({
    scenario: input.scenario,
    symbol: SYMBOL,
    sourceDataQualityClassification: input.sourceDataQualityClassification,
    sourceEvidenceReference: input.sourceEvidenceReference,
    evaluationStartDate: group.evaluationStartDate,
    evaluationEndDate: group.evaluationEndDate,
    finalTestRowCount: group.finalTestRows,
    finalTestRowsSha256: evidence.finalTestRowsSha256,
    finalTestScoredRowsSha256: evidence.finalTestScoredRowsSha256,
    predictionSource: PREDICTION_SOURCE,
    positionSource: POSITION_SOURCE,
    operativeThreshold: group.operativeThreshold,
    operativeThresholdSource: THRESHOLD_SOURCE,
    transactionCostBps: group.transactionCostBps,
    strategyGrossReturn: group.strategyGrossReturn,
    strategyNetReturn: group.strategyNetReturn,
    benchmarkGrossReturn: group.benchmarkGrossReturn,
    benchmarkNetReturn: group.benchmarkNetReturn,
    excessReturn: group.excessReturn,
    strategyMaximumDrawdown: group.strategyMaximumDrawdown,
    benchmarkMaximumDrawdown: group.benchmarkMaximumDrawdown,
    tradeCount: group.tradeCount,
    dataQualityWarnings: Object.freeze(dataQualityWarnings),
    corporateActionWarnings: uniqueMessages(input.corporateActionWarnings),
    replayWarnings: group.warnings,
  });
}

function compareWindows(
  rawKeys: readonly string[],
  adjustedKeys: readonly string[],
  rawGroup: FinalTestEconomicEdgeGroup,
  adjustedGroup: FinalTestEconomicEdgeGroup,
): readonly string[] {
  const reasons: string[] = [];
  if (rawKeys.length !== adjustedKeys.length) {
    reasons.push(`0050 final-test row counts differ: raw=${rawKeys.length}, adjusted=${adjustedKeys.length}`);
  }
  if (rawKeys.some((key, index) => key !== adjustedKeys[index])) {
    reasons.push("0050 final-test feature/target date keys differ");
  }
  if (rawGroup.evaluationStartDate !== adjustedGroup.evaluationStartDate
    || rawGroup.evaluationEndDate !== adjustedGroup.evaluationEndDate) {
    reasons.push(
      `evaluation windows differ: raw=${rawGroup.evaluationStartDate}..${rawGroup.evaluationEndDate}, `
      + `adjusted=${adjustedGroup.evaluationStartDate}..${adjustedGroup.evaluationEndDate}`,
    );
  }
  if (rawGroup.operativeThreshold !== adjustedGroup.operativeThreshold) {
    reasons.push(
      `frozen thresholds differ: raw=${rawGroup.operativeThreshold}, adjusted=${adjustedGroup.operativeThreshold}`,
    );
  }
  if (rawGroup.transactionCostBps !== adjustedGroup.transactionCostBps) {
    reasons.push(
      `transaction costs differ: raw=${rawGroup.transactionCostBps}, adjusted=${adjustedGroup.transactionCostBps}`,
    );
  }
  return Object.freeze(reasons);
}

function classifyComparableEdge(
  raw: FinalTestEconomicReconciliationScenario,
  adjusted: FinalTestEconomicReconciliationScenario,
): FinalTestEconomicReconciliationClassification {
  if (raw.excessReturn > 0 && adjusted.excessReturn <= 0) return "DATA_QUALITY_ARTIFACT";
  if (adjusted.excessReturn > 0) return "EDGE_SURVIVES_ADJUSTMENT";
  return "DATA_QUALITY_ARTIFACT";
}

export function reconcileFinalTestEconomicEdge(
  input: FinalTestEconomicReconciliationInput,
): FinalTestEconomicReconciliation {
  if (input.raw.scenario !== RAW_SCENARIO) fail(`raw scenario must be ${RAW_SCENARIO}`);
  if (input.adjusted.scenario !== ADJUSTED_SCENARIO) {
    fail(`adjusted scenario must be ${ADJUSTED_SCENARIO}`);
  }
  if (input.raw.sourceDataQualityClassification !== RAW_CLASSIFICATION) {
    fail(`raw source classification must be ${RAW_CLASSIFICATION}`);
  }
  if (input.adjusted.sourceDataQualityClassification !== ADJUSTED_CLASSIFICATION) {
    fail(`adjusted source classification must be ${ADJUSTED_CLASSIFICATION}`);
  }

  const rawEdge = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: input.raw.finalTestEvidence,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
  });
  const adjustedEdge = buildFinalTestPerSymbolEconomicEdge({
    finalTestEvidence: input.adjusted.finalTestEvidence,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
  });
  const rawGroup = findGroup(rawEdge.groups, RAW_SCENARIO);
  const adjustedGroup = findGroup(adjustedEdge.groups, ADJUSTED_SCENARIO);
  const rawKeys = windowKeys(input.raw.finalTestEvidence);
  const adjustedKeys = windowKeys(input.adjusted.finalTestEvidence);
  const reasons = compareWindows(rawKeys, adjustedKeys, rawGroup, adjustedGroup);
  const rawWindowKeysSha256 = hashValue(rawKeys);
  const adjustedWindowKeysSha256 = hashValue(adjustedKeys);
  const raw = buildScenario(input.raw, rawGroup, input.raw.finalTestEvidence);
  const adjusted = buildScenario(input.adjusted, adjustedGroup, input.adjusted.finalTestEvidence);
  const comparable = reasons.length === 0;
  const commonWindowCheck = {
    status: comparable ? "IDENTICAL" as const : "UNRESOLVED" as const,
    rawWindowKeysSha256,
    adjustedWindowKeysSha256,
    ...(comparable ? {} : { reason: reasons.join("; ") }),
  };
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: SYMBOL,
    classification: comparable
      ? classifyComparableEdge(raw, adjusted)
      : "UNRESOLVED_COMPARABILITY" as const,
    raw,
    adjusted,
    rawVsAdjusted: comparable
      ? {
        benchmarkReturnDelta: round(adjusted.benchmarkNetReturn - raw.benchmarkNetReturn),
        strategyReturnDelta: round(adjusted.strategyNetReturn - raw.strategyNetReturn),
        excessReturnDelta: round(adjusted.excessReturn - raw.excessReturn),
      }
      : {
        benchmarkReturnDelta: null,
        strategyReturnDelta: null,
        excessReturnDelta: null,
      },
    commonWindowCheck,
    warnings: uniqueMessages([
      "This reconciliation compares diagnostic FINAL_TEST evidence only; it does not select, promote, or recommend 0050.",
      "Raw and source-qualified adjusted paths use the canonical validation-selected threshold and cost-matched benchmark.",
      ...(comparable ? [] : reasons),
    ]),
    promotionDecision: "do_not_promote" as const,
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

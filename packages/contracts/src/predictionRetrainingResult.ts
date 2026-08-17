import type {
  EvaluationMetrics,
  ExperimentRunEvidence,
  PromotionDecision,
  PromotionStatus,
} from "./researchEvidence.js";

export const PREDICTION_RETRAINING_RESULT_SCHEMA_VERSION =
  "MMS_PREDICTION_RETRAINING_RESULT_V1" as const;

export const PREDICTION_RETRAINING_RESULT_GUARDRAILS = Object.freeze({
  providesInvestmentRecommendation: false,
  supportsOrderExecution: false,
  supportsAutomaticPromotion: false,
} as const);

export type ResultContractAvailability = "available" | "unavailable";

export type ResultContractPredictionRole =
  | "resolved_historical"
  | "current_unresolved";

export type ResultContractResolutionStatus = "resolved" | "unresolved";

export interface ResultContractPredictionHorizon {
  readonly unit: "trading_rows";
  readonly rows: number;
}

export interface ResultContractAvailable<T> {
  readonly availability: "available";
  readonly value: T;
}

export interface ResultContractUnavailable {
  readonly availability: "unavailable";
  readonly reason: string;
}

export type ResultContractField<T> =
  | ResultContractAvailable<T>
  | ResultContractUnavailable;

export interface ResultContractUnavailableField {
  readonly path: string;
  readonly reason: string;
}

export interface ResultContractProvenanceReference {
  readonly kind:
    | "dataset"
    | "latest_predictions"
    | "current_predictions"
    | "research_evidence"
    | "retraining"
    | "simulation"
    | "economic_edge"
    | "challenger";
  readonly reference: string;
  readonly sha256?: string;
}

export interface ResultContractDatasetIdentity {
  readonly datasetId: string;
  readonly version: string;
  readonly source: string;
  readonly datasetSha256: string;
  readonly featureRowsSha256: string;
}

export interface ResultContractModelProvenance {
  readonly researchVersion: ResultContractField<string>;
  readonly modelVersion: ResultContractField<string>;
  readonly algorithm: ResultContractField<string>;
  readonly fitPartition: ResultContractField<"TRAINING">;
  readonly trainingRowsSha256: ResultContractField<string>;
}

export interface ResultContractRetrainingProvenance {
  readonly runId: string;
  readonly executed: true;
  readonly fitPartition: "TRAINING";
  readonly trainingRowCount: number;
  readonly trainingRowsSha256: string;
  readonly modelStateSha256: ResultContractField<string>;
}

export interface ResultContractPartitionEvidence {
  readonly startDate: ResultContractField<string>;
  readonly endDate: ResultContractField<string>;
  readonly rowCount: ResultContractField<number>;
  readonly rowsSha256: ResultContractField<string>;
}

export interface ResultContractPartitionBoundaries {
  readonly training: ResultContractPartitionEvidence;
  readonly validation: ResultContractPartitionEvidence;
  readonly finalTest: ResultContractPartitionEvidence;
  readonly purgeRowCounts: {
    readonly trainValidation: ResultContractField<number>;
    readonly validationFinal: ResultContractField<number>;
  };
}

export interface ResultContractThresholdSelection {
  readonly selectedThreshold: number;
  readonly selectionSource: "VALIDATION";
  readonly selectionRowsSha256: string;
  readonly candidateThresholds: readonly number[];
  readonly tieBreakRule: readonly string[];
}

export interface ResultContractBaselineMetrics {
  readonly metricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY";
  readonly majorityClassAccuracy: number;
}

export interface ResultContractFinalTestReliabilityGroup {
  readonly groupDimension: "symbol";
  readonly symbol: string;
  readonly finalTestRowCount: number;
  readonly correctPredictionCount: number;
  readonly accuracy: number | null;
  readonly baselineAccuracy: number | null;
  readonly accuracyDelta: number | null;
  readonly actualUpRate: number | null;
  readonly predictedUpRate: number | null;
  readonly meanProbabilityUp: number | null;
  readonly calibrationGap: number | null;
  readonly balancedAccuracy: number | null;
  readonly brierScore: number | null;
  readonly warnings: readonly string[];
}

export interface ResultContractFinalTestReliability {
  readonly groupDimension: "symbol";
  readonly baselineMetricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY";
  readonly finalTestRowCount: number;
  readonly groups: readonly ResultContractFinalTestReliabilityGroup[];
  readonly warnings: readonly string[];
}

export interface ResultContractFinalTestEconomicEdgeGroup {
  readonly symbol: string;
  readonly finalTestRows: number;
  readonly evaluationStartDate: string;
  readonly evaluationEndDate: string;
  readonly operativeThreshold: number;
  readonly thresholdSelectionSource: "VALIDATION";
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

export interface ResultContractFinalTestEconomicEdge {
  readonly schemaVersion: "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1";
  readonly researchMode: "diagnostic-only";
  readonly evaluationPartition: "FINAL_TEST";
  readonly finalTestRowCount: number;
  readonly finalTestRowsSha256: string;
  readonly finalTestScoredRowsSha256: string;
  readonly operativeThreshold: number;
  readonly thresholdSelectionSource: "VALIDATION";
  readonly transactionCostBps: number;
  readonly initialCapital: number;
  readonly groups: readonly ResultContractFinalTestEconomicEdgeGroup[];
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

export type ResultContractChallengerAggregateAnswer = "YES" | "NO" | "MIXED";
export type ResultContractChallengerConclusion = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED";

export interface ResultContractPerSymbolLogisticChallengerFit {
  readonly fitPartition: "TRAINING";
  readonly trainingRowsSha256: string;
  readonly scalerFitRowCount: number;
  readonly modelFitRowCount: number;
  readonly scalerStateSha256: string;
  readonly modelStateSha256: string;
  readonly iterations: number;
  readonly learningRate: number;
  readonly l2: number;
  readonly initialRegularizedLoss: number;
  readonly finalRegularizedLoss: number;
}

export interface ResultContractPerSymbolLogisticChallengerThresholdSelection {
  readonly selectionPartition: "VALIDATION";
  readonly validationRowsSha256: string;
  readonly fixedThresholdGrid: readonly number[];
  readonly selectedThreshold: number;
  readonly tieBreakRule: readonly string[];
}

export interface ResultContractPerSymbolLogisticChallengerSymbol {
  readonly symbol: string;
  readonly trainingRows: number;
  readonly trainValidationPurgeRows: number;
  readonly validationRows: number;
  readonly validationFinalPurgeRows: number;
  readonly finalTestRows: number;
  readonly trainEndDate: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly finalTestStartDate: string;
  readonly trainingRowsSha256: string;
  readonly validationRowsSha256: string;
  readonly finalTestRowsSha256: string;
  readonly fit: ResultContractPerSymbolLogisticChallengerFit;
  readonly thresholdSelection: ResultContractPerSymbolLogisticChallengerThresholdSelection;
  readonly finalTestMetrics: EvaluationMetrics;
  readonly majorityBaselineAccuracy: number;
  readonly accuracyDelta: number;
  readonly actualUpRate: number;
  readonly predictedUpRate: number;
  readonly meanProbabilityUp: number;
  readonly warnings: readonly string[];
}

export interface ResultContractPerSymbolLogisticChallengerIncumbent {
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

export interface ResultContractPerSymbolLogisticChallengerComparison {
  readonly incumbentAccuracy: number | null;
  readonly challengerAccuracy: number;
  readonly accuracyDeltaChallengerMinusIncumbent: number | null;
  readonly majorityBaselineAccuracy: number;
  readonly incumbentExcessReturn: number | null;
  readonly challengerExcessReturn: number;
  readonly excessDeltaChallengerMinusIncumbent: number | null;
}

export interface ResultContractPerSymbolLogisticChallengerFeatureFamily {
  readonly featureFamilyName: string;
  readonly legacySourcePath: string;
  readonly legacySourceSymbolOrFormula: string;
  readonly newFeatureFields: readonly string[];
  readonly currentIncumbentFeatureFields: readonly string[];
  readonly whyNotDuplicative: string;
  readonly lookbackRowsRequired: number;
  readonly availableAtRule: string;
  readonly missingValueRule: string;
}

export interface ResultContractPerSymbolLogisticChallengerGroup {
  readonly symbol: string;
  readonly challenger: ResultContractPerSymbolLogisticChallengerSymbol;
  readonly incumbent: ResultContractPerSymbolLogisticChallengerIncumbent;
  readonly challengerEconomic: ResultContractFinalTestEconomicEdgeGroup;
  readonly incumbentEconomic: ResultContractFinalTestEconomicEdgeGroup | null;
  readonly incumbentVsChallenger: ResultContractPerSymbolLogisticChallengerComparison;
  readonly warnings: readonly string[];
}

export interface ResultContractPerSymbolLogisticChallenger {
  readonly schemaVersion: "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1";
  readonly researchMode: "diagnostic-only";
  readonly comparisonBaseline: "POOLED_INCUMBENT" | "PER_SYMBOL_CONTROL";
  readonly candidateDataQualityBasis: string;
  readonly incumbentModelAlgorithm: "binary_logistic_regression";
  readonly challengerModelAlgorithm: "binary_logistic_regression";
  readonly featureNames: readonly string[];
  readonly controlFeatureNames: readonly string[];
  readonly featureFamily?: ResultContractPerSymbolLogisticChallengerFeatureFamily;
  readonly symbols: readonly string[];
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly groups: readonly ResultContractPerSymbolLogisticChallengerGroup[];
  readonly doesAnyChallengerBeatDirectionalBaseline: ResultContractChallengerAggregateAnswer;
  readonly doesAnyChallengerBeatBuyAndHoldAfterCost: ResultContractChallengerAggregateAnswer;
  readonly doesAnyChallengerImproveBothDirectionalAndEconomicEvidence: ResultContractChallengerAggregateAnswer;
  readonly challengerConclusion: ResultContractChallengerConclusion;
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

export type ResultContractFinalTestEconomicReconciliationClassification =
  | "DATA_QUALITY_ARTIFACT"
  | "EDGE_SURVIVES_ADJUSTMENT"
  | "UNRESOLVED_COMPARABILITY";

export interface ResultContractFinalTestEconomicReconciliationScenario {
  readonly scenario: "0050_RAW" | "0050_SOURCE_QUALIFIED_ADJUSTED";
  readonly symbol: "0050";
  readonly sourceDataQualityClassification:
    | "RAW_UNADJUSTED_PRICE_PATH"
    | "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH";
  readonly sourceEvidenceReference: string;
  readonly evaluationStartDate: string;
  readonly evaluationEndDate: string;
  readonly finalTestRowCount: number;
  readonly finalTestRowsSha256: string;
  readonly finalTestScoredRowsSha256: string;
  readonly predictionSource: string;
  readonly positionSource: string;
  readonly operativeThreshold: number;
  readonly operativeThresholdSource: "VALIDATION";
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

export interface ResultContractFinalTestEconomicReconciliation {
  readonly schemaVersion: "MMS_0050_RAW_ADJUSTED_ECONOMIC_EDGE_RECONCILIATION_V1";
  readonly researchMode: "diagnostic-only";
  readonly symbol: "0050";
  readonly classification: ResultContractFinalTestEconomicReconciliationClassification;
  readonly raw: ResultContractFinalTestEconomicReconciliationScenario;
  readonly adjusted: ResultContractFinalTestEconomicReconciliationScenario;
  readonly rawVsAdjusted: {
    readonly benchmarkReturnDelta: number | null;
    readonly strategyReturnDelta: number | null;
    readonly excessReturnDelta: number | null;
  };
  readonly commonWindowCheck: {
    readonly status: "IDENTICAL" | "UNRESOLVED";
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

export interface ResultContractLatestPredictionInput {
  /** Identifies the research scenario when one symbol has multiple paths. */
  readonly scenario?: string;
  readonly symbol: string;
  readonly featureDate: string;
  readonly probabilityUp: number;
  readonly predictedDirection: "up" | "down";
  /** Exact threshold used to derive the reported position, when available. */
  readonly operativeThreshold?: number;
  readonly position?: "LONG" | "CASH";
  readonly targetDate?: string;
  readonly close?: number;
  readonly predictionRole?: ResultContractPredictionRole;
  readonly resolutionStatus?: ResultContractResolutionStatus;
  readonly predictionHorizon?: ResultContractPredictionHorizon;
  readonly actualDirection?: "up" | "down";
  readonly realizedReturn?: number;
}

export interface ResultContractLatestPrediction {
  readonly scenario?: string;
  readonly symbol: string;
  readonly featureDate: string;
  readonly probabilityUp: number;
  readonly predictedDirection: "up" | "down";
  readonly operativeThreshold: ResultContractField<number>;
  readonly position?: "LONG" | "CASH";
  readonly targetDate: ResultContractField<string>;
  readonly close: ResultContractField<number>;
  readonly predictionRole: ResultContractPredictionRole;
  readonly resolutionStatus: ResultContractResolutionStatus;
  readonly predictionHorizon: ResultContractField<ResultContractPredictionHorizon>;
  readonly actualDirection: ResultContractField<"up" | "down">;
  readonly realizedReturn: ResultContractField<number>;
}

export interface ResultContractPredictionUnavailable {
  readonly scenario: string;
  readonly reason: string;
}

export interface LegacyLatestPredictionArtifact {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly sourceSha256: string;
  readonly dataEndDate: string;
  readonly openPredictions: readonly (ResultContractLatestPredictionInput & {
    readonly isLatest: boolean;
  })[];
}

export interface ResultContractSimulationPathSummary {
  readonly policy: string;
  readonly totalReturn: number;
  readonly maximumDrawdown: number;
  readonly totalTransactionCost: number;
}

export interface ResultContractSimulationInput {
  readonly schemaVersion: string;
  readonly scenario?: string;
  readonly symbol: string;
  readonly validationThreshold: number;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly strategy: ResultContractSimulationPathSummary;
  readonly benchmark: ResultContractSimulationPathSummary;
  readonly excessReturn: number;
  readonly normalizedResultSha256?: string;
}

export interface ResultContractSimulationSummary {
  readonly sourceSchemaVersion: string;
  readonly scenario?: string;
  readonly symbol: string;
  readonly evaluatedThreshold: number;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly strategy: ResultContractSimulationPathSummary;
  readonly benchmark: ResultContractSimulationPathSummary;
  readonly excessReturn: number;
  readonly sourceResultSha256: ResultContractField<string>;
}

export type ResultContractPromotionVerdict = "do_not_promote" | "research_only";

export interface ResultContractPromotion {
  readonly verdict: ResultContractPromotionVerdict;
  readonly upstreamStatus: PromotionStatus | null;
  readonly automaticPromotion: false;
  readonly manualApprovalRequired: true;
  readonly reasons: readonly string[];
}

export interface PredictionRetrainingResultV1 {
  readonly schemaVersion: typeof PREDICTION_RETRAINING_RESULT_SCHEMA_VERSION;
  readonly runId: string;
  readonly generatedAt: string;
  readonly dataAsOf: ResultContractField<string>;
  readonly dataset: ResultContractField<ResultContractDatasetIdentity>;
  readonly model: ResultContractModelProvenance;
  readonly retraining: ResultContractField<ResultContractRetrainingProvenance>;
  readonly partitions: ResultContractPartitionBoundaries;
  readonly thresholdSelection: ResultContractField<ResultContractThresholdSelection>;
  readonly finalTestMetrics: ResultContractField<EvaluationMetrics>;
  readonly baselineMetrics: ResultContractField<ResultContractBaselineMetrics>;
  readonly finalTestReliability: ResultContractField<ResultContractFinalTestReliability>;
  readonly finalTestEconomicEdge: ResultContractField<ResultContractFinalTestEconomicEdge>;
  readonly perSymbolLogisticChallenger: ResultContractField<ResultContractPerSymbolLogisticChallenger>;
  readonly finalTestEconomicReconciliation?: ResultContractFinalTestEconomicReconciliation;
  readonly latestPredictions: ResultContractField<readonly ResultContractLatestPrediction[]>;
  readonly currentUnresolvedPredictions: ResultContractField<readonly ResultContractLatestPrediction[]>;
  readonly currentPredictionUnavailable: readonly ResultContractPredictionUnavailable[];
  readonly simulation: ResultContractField<ResultContractSimulationSummary>;
  readonly promotion: ResultContractPromotion;
  readonly warnings: readonly string[];
  readonly unavailableFields: readonly ResultContractUnavailableField[];
  readonly provenanceReferences: readonly ResultContractProvenanceReference[];
  readonly guardrails: typeof PREDICTION_RETRAINING_RESULT_GUARDRAILS;
}

export interface BuildPredictionRetrainingResultV1Input {
  readonly runId: string;
  readonly generatedAt: string;
  readonly dataAsOf?: string;
  readonly researchVersion?: string;
  readonly modelVersion?: string;
  readonly modelAlgorithm?: string;
  readonly evidence?: ExperimentRunEvidence;
  readonly promotionDecision?: PromotionDecision;
  readonly finalTestReliability?: ResultContractFinalTestReliability;
  readonly finalTestEconomicEdge?: ResultContractFinalTestEconomicEdge;
  readonly perSymbolLogisticChallenger?: ResultContractPerSymbolLogisticChallenger;
  readonly finalTestEconomicReconciliation?: ResultContractFinalTestEconomicReconciliation;
  readonly latestPredictions?: readonly ResultContractLatestPredictionInput[];
  readonly currentUnresolvedPredictions?: readonly ResultContractLatestPredictionInput[];
  readonly currentPredictionUnavailable?: readonly ResultContractPredictionUnavailable[];
  readonly simulation?: ResultContractSimulationInput;
  readonly warnings?: readonly string[];
  readonly provenanceReferences?: readonly ResultContractProvenanceReference[];
}

export class PredictionRetrainingResultContractError extends Error {
  constructor(message: string) {
    super(`prediction/retraining result contract failed closed: ${message}`);
    this.name = "PredictionRetrainingResultContractError";
  }
}

function fail(message: string): never {
  throw new PredictionRetrainingResultContractError(message);
}

function assertNonBlank(name: string, value: string): void {
  if (value.trim().length === 0) fail(`${name} must not be blank`);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) fail(`${name} must be finite`);
}

function assertProbability(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) fail(`${name} must be within [0, 1]`);
}

function available<T>(value: T): ResultContractAvailable<T> {
  return { availability: "available", value };
}

function unavailable(reason: string): ResultContractUnavailable {
  return { availability: "unavailable", reason };
}

function deepFreezeClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item))) as T;
  }

  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    clone[key] = deepFreezeClone(source[key]);
  }
  return Object.freeze(clone) as T;
}

function fieldFromOptional<T>(
  value: T | undefined,
  path: string,
  reason: string,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractField<T> {
  if (value === undefined) {
    unavailableFields.push({ path, reason });
    return unavailable(reason);
  }
  return available(value);
}

function unavailableFor<T>(
  path: string,
  reason: string,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractField<T> {
  unavailableFields.push({ path, reason });
  return unavailable(reason);
}

function buildMissingPartition(
  prefix: string,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractPartitionEvidence {
  const reason = "No ExperimentRunEvidence was supplied.";
  return {
    startDate: unavailableFor(`${prefix}.startDate`, reason, unavailableFields),
    endDate: unavailableFor(`${prefix}.endDate`, reason, unavailableFields),
    rowCount: unavailableFor(`${prefix}.rowCount`, reason, unavailableFields),
    rowsSha256: unavailableFor(`${prefix}.rowsSha256`, reason, unavailableFields),
  };
}

function buildPartitionBoundaries(
  evidence: ExperimentRunEvidence | undefined,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractPartitionBoundaries {
  if (evidence === undefined) {
    return {
      training: buildMissingPartition("partitions.training", unavailableFields),
      validation: buildMissingPartition("partitions.validation", unavailableFields),
      finalTest: buildMissingPartition("partitions.finalTest", unavailableFields),
      purgeRowCounts: {
        trainValidation: unavailableFor(
          "partitions.purgeRowCounts.trainValidation",
          "No ExperimentRunEvidence was supplied.",
          unavailableFields,
        ),
        validationFinal: unavailableFor(
          "partitions.purgeRowCounts.validationFinal",
          "No ExperimentRunEvidence was supplied.",
          unavailableFields,
        ),
      },
    };
  }

  const split = evidence.split;
  return {
    training: {
      startDate: unavailableFor(
        "partitions.training.startDate",
        "The research evidence exposes the training end boundary but not its start date.",
        unavailableFields,
      ),
      endDate: available(split.trainEndDate),
      rowCount: available(split.trainingRowCount),
      rowsSha256: available(split.trainingRowsSha256),
    },
    validation: {
      startDate: available(split.validationStartDate),
      endDate: available(split.validationEndDate),
      rowCount: available(split.validationRowCount),
      rowsSha256: available(evidence.thresholdSelection.validationRowsSha256),
    },
    finalTest: {
      startDate: available(split.finalTestStartDate),
      endDate: unavailableFor(
        "partitions.finalTest.endDate",
        "The research evidence exposes the final-test start boundary but not its end date.",
        unavailableFields,
      ),
      rowCount: available(split.finalTestRowCount),
      rowsSha256: available(evidence.finalTest.finalTestRowsSha256),
    },
    purgeRowCounts: {
      trainValidation: available(split.trainValidationPurgeRowCount),
      validationFinal: available(split.validationFinalPurgeRowCount),
    },
  };
}

function comparePredictions(
  left: ResultContractLatestPredictionInput,
  right: ResultContractLatestPredictionInput,
): number {
  const leftKey = `${left.scenario ?? ""}\u0000${left.symbol}\u0000${left.featureDate}\u0000${left.targetDate ?? ""}`;
  const rightKey = `${right.scenario ?? ""}\u0000${right.symbol}\u0000${right.featureDate}\u0000${right.targetDate ?? ""}`;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return left.probabilityUp - right.probabilityUp;
}

function normalizePredictionHorizon(
  horizon: ResultContractPredictionHorizon,
  path: string,
): ResultContractPredictionHorizon {
  if (horizon.unit !== "trading_rows") fail(`${path}.unit must be trading_rows`);
  if (!Number.isInteger(horizon.rows) || horizon.rows <= 0) {
    fail(`${path}.rows must be a positive integer`);
  }
  return { unit: horizon.unit, rows: horizon.rows };
}

function normalizePredictions(
  predictions: readonly ResultContractLatestPredictionInput[],
  collectionPath: string,
  unavailableFields: ResultContractUnavailableField[],
  defaultRole?: ResultContractPredictionRole,
  requiredRole?: ResultContractPredictionRole,
): readonly ResultContractLatestPrediction[] {
  const normalized = predictions.map((prediction) => {
    if (prediction.scenario !== undefined) assertNonBlank("latest prediction scenario", prediction.scenario);
    assertNonBlank("latest prediction symbol", prediction.symbol);
    assertNonBlank("latest prediction featureDate", prediction.featureDate);
    assertProbability(
      `latest prediction probabilityUp for ${prediction.symbol}:${prediction.featureDate}`,
      prediction.probabilityUp,
    );
    if (prediction.operativeThreshold !== undefined) {
      assertProbability(
        `latest prediction operativeThreshold for ${prediction.symbol}:${prediction.featureDate}`,
        prediction.operativeThreshold,
      );
    }
    const predictionRole = prediction.predictionRole
      ?? defaultRole
      ?? (prediction.targetDate === undefined ? "current_unresolved" : "resolved_historical");
    const resolutionStatus = prediction.resolutionStatus
      ?? (predictionRole === "current_unresolved" ? "unresolved" : "resolved");
    if (requiredRole !== undefined && predictionRole !== requiredRole) {
      fail(`${collectionPath} predictions must use role ${requiredRole}`);
    }
    if (
      (predictionRole === "current_unresolved" && resolutionStatus !== "unresolved")
      || (predictionRole === "resolved_historical" && resolutionStatus !== "resolved")
    ) {
      fail(`${collectionPath} prediction role and resolution status are inconsistent`);
    }
    if (resolutionStatus === "unresolved" && prediction.actualDirection !== undefined) {
      fail(`${collectionPath} unresolved predictions must not contain actualDirection`);
    }
    if (resolutionStatus === "unresolved" && prediction.realizedReturn !== undefined) {
      fail(`${collectionPath} unresolved predictions must not contain realizedReturn`);
    }
    if (prediction.actualDirection !== undefined
      && prediction.actualDirection !== "up"
      && prediction.actualDirection !== "down") {
      fail(`${collectionPath} actualDirection must be up or down`);
    }
    if (prediction.realizedReturn !== undefined) {
      assertFinite(`${collectionPath} realizedReturn`, prediction.realizedReturn);
    }
    return {
      ...(prediction.scenario === undefined ? {} : { scenario: prediction.scenario }),
      symbol: prediction.symbol,
      featureDate: prediction.featureDate,
      probabilityUp: prediction.probabilityUp,
      predictedDirection: prediction.predictedDirection,
      predictionRole,
      resolutionStatus,
      operativeThreshold: fieldFromOptional(
        prediction.operativeThreshold,
        `${collectionPath}[*].operativeThreshold`,
        "The prediction source does not expose the exact operative threshold used for its position.",
        unavailableFields,
      ),
      ...(prediction.position === undefined ? {} : { position: prediction.position }),
      targetDate: fieldFromOptional(
        prediction.targetDate,
        `${collectionPath}[*].targetDate`,
        "The prediction source does not expose a target date.",
        unavailableFields,
      ),
      close: fieldFromOptional(
        prediction.close,
        `${collectionPath}[*].close`,
        "The prediction source has no close value for this prediction.",
        unavailableFields,
      ),
      predictionHorizon: fieldFromOptional(
        prediction.predictionHorizon === undefined
          ? undefined
          : normalizePredictionHorizon(
            prediction.predictionHorizon,
            `${collectionPath}[*].predictionHorizon`,
          ),
        `${collectionPath}[*].predictionHorizon`,
        "The prediction source does not expose its operative prediction horizon.",
        unavailableFields,
      ),
      actualDirection: fieldFromOptional(
        prediction.actualDirection,
        `${collectionPath}[*].actualDirection`,
        resolutionStatus === "unresolved"
          ? "The actual direction is unavailable because this prediction is unresolved."
          : "The prediction source does not expose the realized direction.",
        unavailableFields,
      ),
      realizedReturn: fieldFromOptional(
        prediction.realizedReturn,
        `${collectionPath}[*].realizedReturn`,
        resolutionStatus === "unresolved"
          ? "The realized return is unavailable because this prediction is unresolved."
          : "The prediction source does not expose the realized return.",
        unavailableFields,
      ),
    };
  });

  return normalized
    .map((prediction) => ({
      ...(prediction.scenario === undefined ? {} : { scenario: prediction.scenario }),
      symbol: prediction.symbol,
      featureDate: prediction.featureDate,
      probabilityUp: prediction.probabilityUp,
      predictedDirection: prediction.predictedDirection,
      predictionRole: prediction.predictionRole,
      resolutionStatus: prediction.resolutionStatus,
      operativeThreshold: prediction.operativeThreshold,
      ...(prediction.position === undefined ? {} : { position: prediction.position }),
      targetDate: prediction.targetDate,
      close: prediction.close,
      predictionHorizon: prediction.predictionHorizon,
      actualDirection: prediction.actualDirection,
      realizedReturn: prediction.realizedReturn,
    }))
    .sort((left, right) => comparePredictions(
      {
        ...(left.scenario === undefined ? {} : { scenario: left.scenario }),
        symbol: left.symbol,
        featureDate: left.featureDate,
        probabilityUp: left.probabilityUp,
        predictedDirection: left.predictedDirection,
        ...(left.operativeThreshold.availability === "available"
          ? { operativeThreshold: left.operativeThreshold.value }
          : {}),
        ...(left.position === undefined ? {} : { position: left.position }),
        ...(left.targetDate.availability === "available"
          ? { targetDate: left.targetDate.value }
          : {}),
      },
      {
        ...(right.scenario === undefined ? {} : { scenario: right.scenario }),
        symbol: right.symbol,
        featureDate: right.featureDate,
        probabilityUp: right.probabilityUp,
        predictedDirection: right.predictedDirection,
        ...(right.operativeThreshold.availability === "available"
          ? { operativeThreshold: right.operativeThreshold.value }
          : {}),
        ...(right.position === undefined ? {} : { position: right.position }),
        ...(right.targetDate.availability === "available"
          ? { targetDate: right.targetDate.value }
          : {}),
      },
    ));
}

function normalizePredictionUnavailable(
  scenarios: readonly ResultContractPredictionUnavailable[],
  unavailableFields: ResultContractUnavailableField[],
): readonly ResultContractPredictionUnavailable[] {
  const normalized = scenarios.map((entry) => {
    assertNonBlank("current prediction unavailable scenario", entry.scenario);
    assertNonBlank("current prediction unavailable reason", entry.reason);
    unavailableFields.push({
      path: `currentUnresolvedPredictions[${entry.scenario}]`,
      reason: entry.reason,
    });
    return { scenario: entry.scenario, reason: entry.reason };
  });
  const unique = new Map<string, ResultContractPredictionUnavailable>();
  for (const entry of normalized) unique.set(entry.scenario, entry);
  return [...unique.values()].sort((left, right) => left.scenario.localeCompare(right.scenario));
}

function normalizeSimulation(
  simulation: ResultContractSimulationInput,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractSimulationSummary {
  assertNonBlank("simulation schemaVersion", simulation.schemaVersion);
  if (simulation.scenario !== undefined) assertNonBlank("simulation scenario", simulation.scenario);
  assertNonBlank("simulation symbol", simulation.symbol);
  assertFinite("simulation validationThreshold", simulation.validationThreshold);
  assertFinite("simulation roundTripCostBps", simulation.roundTripCostBps);
  assertFinite("simulation initialCapital", simulation.initialCapital);
  assertFinite("simulation excessReturn", simulation.excessReturn);

  return {
    sourceSchemaVersion: simulation.schemaVersion,
    ...(simulation.scenario === undefined ? {} : { scenario: simulation.scenario }),
    symbol: simulation.symbol,
    evaluatedThreshold: simulation.validationThreshold,
    roundTripCostBps: simulation.roundTripCostBps,
    initialCapital: simulation.initialCapital,
    strategy: normalizeSimulationPath("simulation.strategy", simulation.strategy),
    benchmark: normalizeSimulationPath("simulation.benchmark", simulation.benchmark),
    excessReturn: simulation.excessReturn,
    sourceResultSha256: fieldFromOptional(
      simulation.normalizedResultSha256,
      "simulation.sourceResultSha256",
      "The simulation source did not provide its normalized result hash.",
      unavailableFields,
    ),
  };
}

function assertNullableProbability(name: string, value: number | null): void {
  if (value !== null) assertProbability(name, value);
}

function assertNullableFinite(name: string, value: number | null): void {
  if (value !== null) assertFinite(name, value);
}

function normalizeFinalTestReliability(
  profile: ResultContractFinalTestReliability,
): ResultContractFinalTestReliability {
  if (profile.groupDimension !== "symbol") {
    fail("finalTestReliability.groupDimension must be symbol");
  }
  if (profile.baselineMetricName !== "FINAL_TEST_MAJORITY_CLASS_ACCURACY") {
    fail("finalTestReliability.baselineMetricName must be FINAL_TEST_MAJORITY_CLASS_ACCURACY");
  }
  if (!Number.isInteger(profile.finalTestRowCount) || profile.finalTestRowCount < 0) {
    fail("finalTestReliability.finalTestRowCount must be a non-negative integer");
  }

  const seenSymbols = new Set<string>();
  let groupedRowCount = 0;
  const groups = profile.groups.map((group, index) => {
    assertNonBlank(`finalTestReliability.groups[${index}].symbol`, group.symbol);
    if (seenSymbols.has(group.symbol)) {
      fail(`finalTestReliability.groups contains duplicate symbol ${group.symbol}`);
    }
    seenSymbols.add(group.symbol);
    if (group.groupDimension !== "symbol") {
      fail(`finalTestReliability.groups[${index}].groupDimension must be symbol`);
    }
    if (!Number.isInteger(group.finalTestRowCount) || group.finalTestRowCount < 0) {
      fail(`finalTestReliability.groups[${index}].finalTestRowCount must be a non-negative integer`);
    }
    if (
      !Number.isInteger(group.correctPredictionCount)
      || group.correctPredictionCount < 0
      || group.correctPredictionCount > group.finalTestRowCount
    ) {
      fail(`finalTestReliability.groups[${index}].correctPredictionCount is invalid`);
    }
    assertNullableProbability(`finalTestReliability.groups[${index}].accuracy`, group.accuracy);
    assertNullableProbability(
      `finalTestReliability.groups[${index}].baselineAccuracy`,
      group.baselineAccuracy,
    );
    assertNullableFinite(`finalTestReliability.groups[${index}].accuracyDelta`, group.accuracyDelta);
    if (group.accuracyDelta !== null && (group.accuracyDelta < -1 || group.accuracyDelta > 1)) {
      fail(`finalTestReliability.groups[${index}].accuracyDelta must be within [-1, 1]`);
    }
    assertNullableProbability(`finalTestReliability.groups[${index}].actualUpRate`, group.actualUpRate);
    assertNullableProbability(
      `finalTestReliability.groups[${index}].predictedUpRate`,
      group.predictedUpRate,
    );
    assertNullableProbability(
      `finalTestReliability.groups[${index}].meanProbabilityUp`,
      group.meanProbabilityUp,
    );
    assertNullableFinite(
      `finalTestReliability.groups[${index}].calibrationGap`,
      group.calibrationGap,
    );
    if (group.calibrationGap !== null && (group.calibrationGap < -1 || group.calibrationGap > 1)) {
      fail(`finalTestReliability.groups[${index}].calibrationGap must be within [-1, 1]`);
    }
    assertNullableProbability(
      `finalTestReliability.groups[${index}].balancedAccuracy`,
      group.balancedAccuracy,
    );
    assertNullableProbability(`finalTestReliability.groups[${index}].brierScore`, group.brierScore);
    groupedRowCount += group.finalTestRowCount;
    return {
      groupDimension: "symbol" as const,
      symbol: group.symbol,
      finalTestRowCount: group.finalTestRowCount,
      correctPredictionCount: group.correctPredictionCount,
      accuracy: group.accuracy,
      baselineAccuracy: group.baselineAccuracy,
      accuracyDelta: group.accuracyDelta,
      actualUpRate: group.actualUpRate,
      predictedUpRate: group.predictedUpRate,
      meanProbabilityUp: group.meanProbabilityUp,
      calibrationGap: group.calibrationGap,
      balancedAccuracy: group.balancedAccuracy,
      brierScore: group.brierScore,
      warnings: normalizeMessages(group.warnings),
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  if (groupedRowCount !== profile.finalTestRowCount) {
    fail(
      `finalTestReliability group counts ${groupedRowCount} differ from final-test row count ${profile.finalTestRowCount}`,
    );
  }
  return {
    groupDimension: "symbol",
    baselineMetricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY",
    finalTestRowCount: profile.finalTestRowCount,
    groups,
    warnings: normalizeMessages(profile.warnings),
  };
}

function normalizeFinalTestEconomicEdge(
  edge: ResultContractFinalTestEconomicEdge,
): ResultContractFinalTestEconomicEdge {
  if (edge.schemaVersion !== "MMS_FINAL_TEST_PER_SYMBOL_ECONOMIC_EDGE_V1") {
    fail("finalTestEconomicEdge.schemaVersion is unsupported");
  }
  if (edge.researchMode !== "diagnostic-only") {
    fail("finalTestEconomicEdge.researchMode must be diagnostic-only");
  }
  if (edge.evaluationPartition !== "FINAL_TEST") {
    fail("finalTestEconomicEdge.evaluationPartition must be FINAL_TEST");
  }
  if (!Number.isInteger(edge.finalTestRowCount) || edge.finalTestRowCount < 0) {
    fail("finalTestEconomicEdge.finalTestRowCount must be a non-negative integer");
  }
  assertNonBlank("finalTestEconomicEdge.finalTestRowsSha256", edge.finalTestRowsSha256);
  assertNonBlank("finalTestEconomicEdge.finalTestScoredRowsSha256", edge.finalTestScoredRowsSha256);
  assertNonBlank("finalTestEconomicEdge.normalizedResultSha256", edge.normalizedResultSha256);
  assertProbability("finalTestEconomicEdge.operativeThreshold", edge.operativeThreshold);
  if (edge.thresholdSelectionSource !== "VALIDATION") {
    fail("finalTestEconomicEdge.thresholdSelectionSource must be VALIDATION");
  }
  assertFinite("finalTestEconomicEdge.transactionCostBps", edge.transactionCostBps);
  if (edge.transactionCostBps < 0) {
    fail("finalTestEconomicEdge.transactionCostBps must be non-negative");
  }
  assertFinite("finalTestEconomicEdge.initialCapital", edge.initialCapital);
  if (edge.initialCapital <= 0) fail("finalTestEconomicEdge.initialCapital must be positive");
  if (edge.guardrails.providesInvestmentAdvice !== false
    || edge.guardrails.supportsOrderExecution !== false
    || edge.guardrails.supportsAutomaticPromotion !== false
    || edge.guardrails.supportsPortfolioOptimization !== false
    || edge.guardrails.supportsMultiSymbolAllocation !== false
    || edge.guardrails.supportsSymbolSelection !== false) {
    fail("finalTestEconomicEdge guardrails must remain fail-closed");
  }

  const seenSymbols = new Set<string>();
  let groupedRowCount = 0;
  const groups = edge.groups.map((group, index) => {
    assertNonBlank(`finalTestEconomicEdge.groups[${index}].symbol`, group.symbol);
    if (seenSymbols.has(group.symbol)) {
      fail(`finalTestEconomicEdge.groups contains duplicate symbol ${group.symbol}`);
    }
    seenSymbols.add(group.symbol);
    if (!Number.isInteger(group.finalTestRows) || group.finalTestRows <= 0) {
      fail(`finalTestEconomicEdge.groups[${index}].finalTestRows must be a positive integer`);
    }
    assertNonBlank(
      `finalTestEconomicEdge.groups[${index}].evaluationStartDate`,
      group.evaluationStartDate,
    );
    assertNonBlank(
      `finalTestEconomicEdge.groups[${index}].evaluationEndDate`,
      group.evaluationEndDate,
    );
    if (group.evaluationStartDate > group.evaluationEndDate) {
      fail(`finalTestEconomicEdge.groups[${index}] evaluation window is reversed`);
    }
    assertProbability(
      `finalTestEconomicEdge.groups[${index}].operativeThreshold`,
      group.operativeThreshold,
    );
    if (group.thresholdSelectionSource !== "VALIDATION") {
      fail(`finalTestEconomicEdge.groups[${index}].thresholdSelectionSource must be VALIDATION`);
    }
    assertFinite(
      `finalTestEconomicEdge.groups[${index}].transactionCostBps`,
      group.transactionCostBps,
    );
    if (group.transactionCostBps < 0) {
      fail(`finalTestEconomicEdge.groups[${index}].transactionCostBps must be non-negative`);
    }
    if (group.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH") {
      fail(`finalTestEconomicEdge.groups[${index}].strategyPolicy is unsupported`);
    }
    if (group.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK") {
      fail(`finalTestEconomicEdge.groups[${index}].benchmarkPolicy is unsupported`);
    }
    const returnFields = [
      "strategyGrossReturn",
      "strategyNetReturn",
      "benchmarkGrossReturn",
      "benchmarkNetReturn",
      "excessReturn",
      "strategyMaximumDrawdown",
      "benchmarkMaximumDrawdown",
    ] as const;
    for (const field of returnFields) {
      assertFinite(
        `finalTestEconomicEdge.groups[${index}].${field}`,
        group[field],
      );
    }
    const countFields = [
      "tradeCount",
      "longWindowCount",
      "cashWindowCount",
      "replayWindowCount",
      "skippedOverlapCount",
    ] as const;
    for (const field of countFields) {
      if (!Number.isInteger(group[field]) || group[field] < 0) {
        fail(`finalTestEconomicEdge.groups[${index}].${field} must be a non-negative integer`);
      }
    }
    if (group.replayWindowCount + group.skippedOverlapCount !== group.finalTestRows) {
      fail(`finalTestEconomicEdge.groups[${index}] replay cardinality does not match final-test rows`);
    }
    groupedRowCount += group.finalTestRows;
    return {
      ...group,
      warnings: normalizeMessages(group.warnings),
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  if (groupedRowCount !== edge.finalTestRowCount) {
    fail(
      `finalTestEconomicEdge group counts ${groupedRowCount} differ from final-test row count ${edge.finalTestRowCount}`,
    );
  }
  return {
    schemaVersion: edge.schemaVersion,
    researchMode: edge.researchMode,
    evaluationPartition: edge.evaluationPartition,
    finalTestRowCount: edge.finalTestRowCount,
    finalTestRowsSha256: edge.finalTestRowsSha256,
    finalTestScoredRowsSha256: edge.finalTestScoredRowsSha256,
    operativeThreshold: edge.operativeThreshold,
    thresholdSelectionSource: edge.thresholdSelectionSource,
    transactionCostBps: edge.transactionCostBps,
    initialCapital: edge.initialCapital,
    groups,
    warnings: normalizeMessages(edge.warnings),
    guardrails: {
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    },
    normalizedResultSha256: edge.normalizedResultSha256,
  };
}

function normalizePerSymbolLogisticChallenger(
  challenger: ResultContractPerSymbolLogisticChallenger,
): ResultContractPerSymbolLogisticChallenger {
  if (challenger.schemaVersion !== "MMS_PER_SYMBOL_LOGISTIC_CHALLENGER_V1") {
    fail("perSymbolLogisticChallenger.schemaVersion is unsupported");
  }
  if (challenger.researchMode !== "diagnostic-only") {
    fail("perSymbolLogisticChallenger.researchMode must be diagnostic-only");
  }
  if (challenger.comparisonBaseline !== "POOLED_INCUMBENT"
    && challenger.comparisonBaseline !== "PER_SYMBOL_CONTROL") {
    fail("perSymbolLogisticChallenger.comparisonBaseline is unsupported");
  }
  if (challenger.incumbentModelAlgorithm !== "binary_logistic_regression"
    || challenger.challengerModelAlgorithm !== "binary_logistic_regression") {
    fail("perSymbolLogisticChallenger model algorithms must be binary_logistic_regression");
  }
  assertNonBlank("perSymbolLogisticChallenger.candidateDataQualityBasis", challenger.candidateDataQualityBasis);
  if (challenger.featureNames.length === 0) {
    fail("perSymbolLogisticChallenger.featureNames must not be empty");
  }
  if (challenger.controlFeatureNames.length === 0) {
    fail("perSymbolLogisticChallenger.controlFeatureNames must not be empty");
  }
  const candidateFeatureNames = new Set(challenger.featureNames);
  if (challenger.controlFeatureNames.some((name) => !candidateFeatureNames.has(name))) {
    fail("perSymbolLogisticChallenger control feature names must be present in the candidate feature names");
  }
  if (challenger.featureFamily !== undefined) {
    const family = challenger.featureFamily;
    if (family.newFeatureFields.length === 0) {
      fail("perSymbolLogisticChallenger.featureFamily.newFeatureFields must not be empty");
    }
    const incumbentFields = new Set(family.currentIncumbentFeatureFields);
    const newFields = new Set(family.newFeatureFields);
    if (newFields.size !== family.newFeatureFields.length) {
      fail("perSymbolLogisticChallenger.featureFamily contains duplicate new fields");
    }
    if (family.newFeatureFields.some((name) => incumbentFields.has(name))) {
      fail("perSymbolLogisticChallenger.featureFamily duplicates an incumbent field");
    }
    if (family.newFeatureFields.some((name) => !candidateFeatureNames.has(name))) {
      fail("perSymbolLogisticChallenger.featureFamily field is absent from the candidate feature names");
    }
    for (const [field, value] of [
      ["featureFamilyName", family.featureFamilyName],
      ["legacySourcePath", family.legacySourcePath],
      ["legacySourceSymbolOrFormula", family.legacySourceSymbolOrFormula],
      ["whyNotDuplicative", family.whyNotDuplicative],
      ["availableAtRule", family.availableAtRule],
      ["missingValueRule", family.missingValueRule],
    ] as const) assertNonBlank(`perSymbolLogisticChallenger.featureFamily.${field}`, value);
    if (!Number.isInteger(family.lookbackRowsRequired) || family.lookbackRowsRequired <= 0) {
      fail("perSymbolLogisticChallenger.featureFamily.lookbackRowsRequired is invalid");
    }
  }
  assertFinite("perSymbolLogisticChallenger.roundTripCostBps", challenger.roundTripCostBps);
  if (challenger.roundTripCostBps < 0) {
    fail("perSymbolLogisticChallenger.roundTripCostBps must be non-negative");
  }
  assertFinite("perSymbolLogisticChallenger.initialCapital", challenger.initialCapital);
  if (challenger.initialCapital <= 0) {
    fail("perSymbolLogisticChallenger.initialCapital must be positive");
  }
  if (challenger.promotionDecision !== "do_not_promote") {
    fail("perSymbolLogisticChallenger promotion decision must remain do_not_promote");
  }
  if (challenger.guardrails.providesInvestmentAdvice !== false
    || challenger.guardrails.supportsOrderExecution !== false
    || challenger.guardrails.supportsAutomaticPromotion !== false
    || challenger.guardrails.supportsPortfolioOptimization !== false
    || challenger.guardrails.supportsMultiSymbolAllocation !== false
    || challenger.guardrails.supportsSymbolSelection !== false) {
    fail("perSymbolLogisticChallenger guardrails must remain fail-closed");
  }

  const normalizeNullableReturn = (name: string, value: number | null): number | null => {
    if (value !== null) assertFinite(name, value);
    return value;
  };
  const normalizeEconomicGroup = (
    group: ResultContractFinalTestEconomicEdgeGroup | null,
    path: string,
  ): ResultContractFinalTestEconomicEdgeGroup | null => {
    if (group === null) return null;
    assertNonBlank(`${path}.symbol`, group.symbol);
    if (!Number.isInteger(group.finalTestRows) || group.finalTestRows <= 0) {
      fail(`${path}.finalTestRows must be a positive integer`);
    }
    assertNonBlank(`${path}.evaluationStartDate`, group.evaluationStartDate);
    assertNonBlank(`${path}.evaluationEndDate`, group.evaluationEndDate);
    if (group.evaluationStartDate > group.evaluationEndDate) {
      fail(`${path} evaluation window is reversed`);
    }
    assertProbability(`${path}.operativeThreshold`, group.operativeThreshold);
    if (group.thresholdSelectionSource !== "VALIDATION") {
      fail(`${path}.thresholdSelectionSource must be VALIDATION`);
    }
    assertFinite(`${path}.transactionCostBps`, group.transactionCostBps);
    if (group.transactionCostBps < 0) fail(`${path}.transactionCostBps must be non-negative`);
    if (group.strategyPolicy !== "VALIDATION_THRESHOLD_LONG_CASH") {
      fail(`${path}.strategyPolicy is unsupported`);
    }
    if (group.benchmarkPolicy !== "ALWAYS_LONG_BENCHMARK") {
      fail(`${path}.benchmarkPolicy is unsupported`);
    }
    for (const field of [
      "strategyGrossReturn",
      "strategyNetReturn",
      "benchmarkGrossReturn",
      "benchmarkNetReturn",
      "excessReturn",
      "strategyMaximumDrawdown",
      "benchmarkMaximumDrawdown",
    ] as const) {
      assertFinite(`${path}.${field}`, group[field]);
    }
    for (const field of [
      "tradeCount",
      "longWindowCount",
      "cashWindowCount",
      "replayWindowCount",
      "skippedOverlapCount",
    ] as const) {
      if (!Number.isInteger(group[field]) || group[field] < 0) {
        fail(`${path}.${field} must be a non-negative integer`);
      }
    }
    if (group.replayWindowCount + group.skippedOverlapCount !== group.finalTestRows) {
      fail(`${path} replay cardinality does not match final-test rows`);
    }
    return {
      ...group,
      warnings: normalizeMessages(group.warnings),
    };
  };

  const seenSymbols = new Set<string>();
  const groups = challenger.groups.map((group, index) => {
    const path = `perSymbolLogisticChallenger.groups[${index}]`;
    assertNonBlank(`${path}.symbol`, group.symbol);
    if (seenSymbols.has(group.symbol)) fail(`perSymbolLogisticChallenger groups contain duplicate symbol ${group.symbol}`);
    seenSymbols.add(group.symbol);
    if (group.challenger.symbol !== group.symbol) fail(`${path}.challenger.symbol must match group.symbol`);
    const candidate = group.challenger;
    for (const [field, value] of [
      ["trainingRows", candidate.trainingRows],
      ["validationRows", candidate.validationRows],
      ["finalTestRows", candidate.finalTestRows],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) fail(`${path}.challenger.${field} must be a positive integer`);
    }
    for (const [field, value] of [
      ["trainValidationPurgeRows", candidate.trainValidationPurgeRows],
      ["validationFinalPurgeRows", candidate.validationFinalPurgeRows],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) fail(`${path}.challenger.${field} must be a non-negative integer`);
    }
    for (const field of [
      "trainEndDate",
      "validationStartDate",
      "validationEndDate",
      "finalTestStartDate",
      "trainingRowsSha256",
      "validationRowsSha256",
      "finalTestRowsSha256",
    ] as const) assertNonBlank(`${path}.challenger.${field}`, candidate[field]);
    if (candidate.trainEndDate >= candidate.validationStartDate
      || candidate.validationEndDate >= candidate.finalTestStartDate) {
      fail(`${path}.challenger chronological boundaries are invalid`);
    }

    const fit = candidate.fit;
    if (fit.fitPartition !== "TRAINING") fail(`${path}.challenger.fit.fitPartition must be TRAINING`);
    assertNonBlank(`${path}.challenger.fit.trainingRowsSha256`, fit.trainingRowsSha256);
    assertNonBlank(`${path}.challenger.fit.scalerStateSha256`, fit.scalerStateSha256);
    assertNonBlank(`${path}.challenger.fit.modelStateSha256`, fit.modelStateSha256);
    if (fit.trainingRowsSha256 !== candidate.trainingRowsSha256) {
      fail(`${path}.challenger fit rows must match challenger training rows`);
    }
    if (fit.scalerFitRowCount !== candidate.trainingRows || fit.modelFitRowCount !== candidate.trainingRows) {
      fail(`${path}.challenger fit row counts must match challenger training rows`);
    }
    if (!Number.isInteger(fit.iterations) || fit.iterations <= 0) fail(`${path}.challenger.fit.iterations is invalid`);
    assertFinite(`${path}.challenger.fit.learningRate`, fit.learningRate);
    if (fit.learningRate <= 0) fail(`${path}.challenger.fit.learningRate must be positive`);
    assertFinite(`${path}.challenger.fit.l2`, fit.l2);
    if (fit.l2 < 0) fail(`${path}.challenger.fit.l2 must be non-negative`);
    assertFinite(`${path}.challenger.fit.initialRegularizedLoss`, fit.initialRegularizedLoss);
    assertFinite(`${path}.challenger.fit.finalRegularizedLoss`, fit.finalRegularizedLoss);

    const threshold = candidate.thresholdSelection;
    if (threshold.selectionPartition !== "VALIDATION") {
      fail(`${path}.challenger.thresholdSelection must use VALIDATION`);
    }
    if (threshold.validationRowsSha256 !== candidate.validationRowsSha256) {
      fail(`${path}.challenger threshold rows must match challenger validation rows`);
    }
    assertNonBlank(`${path}.challenger.thresholdSelection.validationRowsSha256`, threshold.validationRowsSha256);
    if (threshold.fixedThresholdGrid.length === 0) fail(`${path}.challenger threshold grid is empty`);
    threshold.fixedThresholdGrid.forEach((value, thresholdIndex) => {
      assertProbability(`${path}.challenger.thresholdSelection.fixedThresholdGrid[${thresholdIndex}]`, value);
    });
    assertProbability(`${path}.challenger.thresholdSelection.selectedThreshold`, threshold.selectedThreshold);
    if (!threshold.fixedThresholdGrid.includes(threshold.selectedThreshold)) {
      fail(`${path}.challenger selected threshold is not in its fixed grid`);
    }

    const metrics = candidate.finalTestMetrics;
    if (metrics.sampleCount !== candidate.finalTestRows) {
      fail(`${path}.challenger final-test metric count does not match final-test rows`);
    }
    for (const [field, value] of [
      ["accuracy", metrics.accuracy],
      ["balancedAccuracy", metrics.balancedAccuracy],
      ["majorityBaseline", metrics.majorityBaseline],
      ["brierScore", metrics.brierScore],
      ["logLoss", metrics.logLoss],
    ] as const) assertFinite(`${path}.challenger.finalTestMetrics.${field}`, value);
    assertProbability(`${path}.challenger.majorityBaselineAccuracy`, candidate.majorityBaselineAccuracy);
    assertFinite(`${path}.challenger.accuracyDelta`, candidate.accuracyDelta);
    assertFinite(`${path}.challenger.actualUpRate`, candidate.actualUpRate);
    assertFinite(`${path}.challenger.predictedUpRate`, candidate.predictedUpRate);
    assertFinite(`${path}.challenger.meanProbabilityUp`, candidate.meanProbabilityUp);
    assertNonBlank(`${path}.challenger.finalTestRowsSha256`, candidate.finalTestRowsSha256);

    const incumbent = group.incumbent;
    if (!Number.isInteger(incumbent.finalTestRows) || incumbent.finalTestRows < 0) {
      fail(`${path}.incumbent.finalTestRows is invalid`);
    }
    assertNullableProbability(`${path}.incumbent.accuracy`, incumbent.accuracy);
    assertNullableProbability(`${path}.incumbent.majorityBaselineAccuracy`, incumbent.majorityBaselineAccuracy);
    for (const field of [
      "excessReturn",
      "strategyNetReturn",
      "benchmarkNetReturn",
      "strategyMaximumDrawdown",
      "benchmarkMaximumDrawdown",
    ] as const) normalizeNullableReturn(`${path}.incumbent.${field}`, incumbent[field]);
    if (incumbent.tradeCount !== null
      && (!Number.isInteger(incumbent.tradeCount) || incumbent.tradeCount < 0)) {
      fail(`${path}.incumbent.tradeCount is invalid`);
    }

    const comparison = group.incumbentVsChallenger;
    assertNullableProbability(`${path}.incumbentVsChallenger.incumbentAccuracy`, comparison.incumbentAccuracy);
    assertProbability(`${path}.incumbentVsChallenger.challengerAccuracy`, comparison.challengerAccuracy);
    normalizeNullableReturn(
      `${path}.incumbentVsChallenger.accuracyDeltaChallengerMinusIncumbent`,
      comparison.accuracyDeltaChallengerMinusIncumbent,
    );
    assertProbability(`${path}.incumbentVsChallenger.majorityBaselineAccuracy`, comparison.majorityBaselineAccuracy);
    normalizeNullableReturn(`${path}.incumbentVsChallenger.incumbentExcessReturn`, comparison.incumbentExcessReturn);
    assertFinite(`${path}.incumbentVsChallenger.challengerExcessReturn`, comparison.challengerExcessReturn);
    normalizeNullableReturn(
      `${path}.incumbentVsChallenger.excessDeltaChallengerMinusIncumbent`,
      comparison.excessDeltaChallengerMinusIncumbent,
    );

    const challengerEconomic = normalizeEconomicGroup(group.challengerEconomic, `${path}.challengerEconomic`);
    const incumbentEconomic = normalizeEconomicGroup(group.incumbentEconomic, `${path}.incumbentEconomic`);
    if (challengerEconomic === null || challengerEconomic.symbol !== group.symbol) {
      fail(`${path}.challengerEconomic must match group.symbol`);
    }
    if (incumbentEconomic !== null && incumbentEconomic.symbol !== group.symbol) {
      fail(`${path}.incumbentEconomic must match group.symbol`);
    }
    return {
      symbol: group.symbol,
      challenger: {
        ...candidate,
        fit: { ...fit },
        thresholdSelection: {
          selectionPartition: threshold.selectionPartition,
          validationRowsSha256: threshold.validationRowsSha256,
          fixedThresholdGrid: [...threshold.fixedThresholdGrid],
          selectedThreshold: threshold.selectedThreshold,
          tieBreakRule: normalizeMessages(threshold.tieBreakRule),
        },
        finalTestMetrics: { ...metrics },
        warnings: normalizeMessages(candidate.warnings),
      },
      incumbent: { ...incumbent },
      challengerEconomic,
      incumbentEconomic,
      incumbentVsChallenger: { ...comparison },
      warnings: normalizeMessages(group.warnings),
    };
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  if (groups.length !== challenger.symbols.length
    || groups.some((group, index) => group.symbol !== challenger.symbols.slice().sort().at(index))) {
    fail("perSymbolLogisticChallenger symbols do not match its groups");
  }
  const normalized = {
    schemaVersion: challenger.schemaVersion,
    researchMode: challenger.researchMode,
    comparisonBaseline: challenger.comparisonBaseline,
    candidateDataQualityBasis: challenger.candidateDataQualityBasis,
    incumbentModelAlgorithm: challenger.incumbentModelAlgorithm,
    challengerModelAlgorithm: challenger.challengerModelAlgorithm,
    featureNames: [...challenger.featureNames],
    controlFeatureNames: [...challenger.controlFeatureNames],
    ...(challenger.featureFamily === undefined
      ? {}
      : {
        featureFamily: {
          ...challenger.featureFamily,
          newFeatureFields: [...challenger.featureFamily.newFeatureFields],
          currentIncumbentFeatureFields: [...challenger.featureFamily.currentIncumbentFeatureFields],
        },
      }),
    symbols: groups.map(({ symbol }) => symbol),
    roundTripCostBps: challenger.roundTripCostBps,
    initialCapital: challenger.initialCapital,
    groups,
    doesAnyChallengerBeatDirectionalBaseline: challenger.doesAnyChallengerBeatDirectionalBaseline,
    doesAnyChallengerBeatBuyAndHoldAfterCost: challenger.doesAnyChallengerBeatBuyAndHoldAfterCost,
    doesAnyChallengerImproveBothDirectionalAndEconomicEvidence:
      challenger.doesAnyChallengerImproveBothDirectionalAndEconomicEvidence,
    challengerConclusion: challenger.challengerConclusion,
    promotionDecision: "do_not_promote" as const,
    warnings: normalizeMessages(challenger.warnings),
    guardrails: {
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    } as const,
    normalizedResultSha256: challenger.normalizedResultSha256,
  };
  return normalized;
}

function normalizeFinalTestEconomicReconciliation(
  reconciliation: ResultContractFinalTestEconomicReconciliation,
): ResultContractFinalTestEconomicReconciliation {
  if (reconciliation.schemaVersion !== "MMS_0050_RAW_ADJUSTED_ECONOMIC_EDGE_RECONCILIATION_V1") {
    fail("finalTestEconomicReconciliation.schemaVersion is unsupported");
  }
  if (reconciliation.researchMode !== "diagnostic-only") {
    fail("finalTestEconomicReconciliation.researchMode must be diagnostic-only");
  }
  if (reconciliation.symbol !== "0050") {
    fail("finalTestEconomicReconciliation.symbol must be 0050");
  }
  if (![
    "DATA_QUALITY_ARTIFACT",
    "EDGE_SURVIVES_ADJUSTMENT",
    "UNRESOLVED_COMPARABILITY",
  ].includes(reconciliation.classification)) {
    fail("finalTestEconomicReconciliation.classification is unsupported");
  }
  if (reconciliation.promotionDecision !== "do_not_promote") {
    fail("finalTestEconomicReconciliation promotion must remain do_not_promote");
  }
  const normalizeScenario = (
    scenario: ResultContractFinalTestEconomicReconciliationScenario,
    expectedScenario: "0050_RAW" | "0050_SOURCE_QUALIFIED_ADJUSTED",
    expectedClassification: "RAW_UNADJUSTED_PRICE_PATH" | "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
  ): ResultContractFinalTestEconomicReconciliationScenario => {
    if (scenario.scenario !== expectedScenario) {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.scenario is inconsistent`);
    }
    if (scenario.symbol !== "0050") {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.symbol must be 0050`);
    }
    if (scenario.sourceDataQualityClassification !== expectedClassification) {
      fail(`finalTestEconomicReconciliation.${expectedScenario} source classification is inconsistent`);
    }
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.sourceEvidenceReference`, scenario.sourceEvidenceReference);
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.evaluationStartDate`, scenario.evaluationStartDate);
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.evaluationEndDate`, scenario.evaluationEndDate);
    if (scenario.evaluationStartDate > scenario.evaluationEndDate) {
      fail(`finalTestEconomicReconciliation.${expectedScenario} evaluation window is reversed`);
    }
    if (!Number.isInteger(scenario.finalTestRowCount) || scenario.finalTestRowCount <= 0) {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.finalTestRowCount must be positive`);
    }
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.finalTestRowsSha256`, scenario.finalTestRowsSha256);
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.finalTestScoredRowsSha256`, scenario.finalTestScoredRowsSha256);
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.predictionSource`, scenario.predictionSource);
    assertNonBlank(`finalTestEconomicReconciliation.${expectedScenario}.positionSource`, scenario.positionSource);
    assertProbability(`finalTestEconomicReconciliation.${expectedScenario}.operativeThreshold`, scenario.operativeThreshold);
    if (scenario.operativeThresholdSource !== "VALIDATION") {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.operativeThresholdSource must be VALIDATION`);
    }
    assertFinite(`finalTestEconomicReconciliation.${expectedScenario}.transactionCostBps`, scenario.transactionCostBps);
    if (scenario.transactionCostBps < 0) {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.transactionCostBps must be non-negative`);
    }
    for (const field of [
      "strategyGrossReturn",
      "strategyNetReturn",
      "benchmarkGrossReturn",
      "benchmarkNetReturn",
      "excessReturn",
      "strategyMaximumDrawdown",
      "benchmarkMaximumDrawdown",
    ] as const) {
      assertFinite(`finalTestEconomicReconciliation.${expectedScenario}.${field}`, scenario[field]);
    }
    if (!Number.isInteger(scenario.tradeCount) || scenario.tradeCount < 0) {
      fail(`finalTestEconomicReconciliation.${expectedScenario}.tradeCount must be non-negative`);
    }
    return {
      ...scenario,
      dataQualityWarnings: normalizeMessages(scenario.dataQualityWarnings),
      corporateActionWarnings: normalizeMessages(scenario.corporateActionWarnings),
      replayWarnings: normalizeMessages(scenario.replayWarnings),
    };
  };

  const normalizeDelta = (name: string, value: number | null): number | null => {
    if (value !== null) assertFinite(name, value);
    return value;
  };
  if (![
    "IDENTICAL",
    "UNRESOLVED",
  ].includes(reconciliation.commonWindowCheck.status)) {
    fail("finalTestEconomicReconciliation.commonWindowCheck.status is unsupported");
  }
  assertNonBlank(
    "finalTestEconomicReconciliation.commonWindowCheck.rawWindowKeysSha256",
    reconciliation.commonWindowCheck.rawWindowKeysSha256,
  );
  assertNonBlank(
    "finalTestEconomicReconciliation.commonWindowCheck.adjustedWindowKeysSha256",
    reconciliation.commonWindowCheck.adjustedWindowKeysSha256,
  );
  if (reconciliation.commonWindowCheck.reason !== undefined) {
    assertNonBlank("finalTestEconomicReconciliation.commonWindowCheck.reason", reconciliation.commonWindowCheck.reason);
  }
  assertNonBlank("finalTestEconomicReconciliation.normalizedResultSha256", reconciliation.normalizedResultSha256);

  return {
    schemaVersion: reconciliation.schemaVersion,
    researchMode: reconciliation.researchMode,
    symbol: reconciliation.symbol,
    classification: reconciliation.classification,
    raw: normalizeScenario(
      reconciliation.raw,
      "0050_RAW",
      "RAW_UNADJUSTED_PRICE_PATH",
    ),
    adjusted: normalizeScenario(
      reconciliation.adjusted,
      "0050_SOURCE_QUALIFIED_ADJUSTED",
      "SOURCE_QUALIFIED_ADJUSTED_PRICE_PATH",
    ),
    rawVsAdjusted: {
      benchmarkReturnDelta: normalizeDelta(
        "finalTestEconomicReconciliation.rawVsAdjusted.benchmarkReturnDelta",
        reconciliation.rawVsAdjusted.benchmarkReturnDelta,
      ),
      strategyReturnDelta: normalizeDelta(
        "finalTestEconomicReconciliation.rawVsAdjusted.strategyReturnDelta",
        reconciliation.rawVsAdjusted.strategyReturnDelta,
      ),
      excessReturnDelta: normalizeDelta(
        "finalTestEconomicReconciliation.rawVsAdjusted.excessReturnDelta",
        reconciliation.rawVsAdjusted.excessReturnDelta,
      ),
    },
    commonWindowCheck: {
      status: reconciliation.commonWindowCheck.status,
      rawWindowKeysSha256: reconciliation.commonWindowCheck.rawWindowKeysSha256,
      adjustedWindowKeysSha256: reconciliation.commonWindowCheck.adjustedWindowKeysSha256,
      ...(reconciliation.commonWindowCheck.reason === undefined
        ? {}
        : { reason: reconciliation.commonWindowCheck.reason }),
    },
    warnings: normalizeMessages(reconciliation.warnings),
    promotionDecision: "do_not_promote",
    guardrails: {
      providesInvestmentAdvice: false,
      supportsOrderExecution: false,
      supportsAutomaticPromotion: false,
      supportsPortfolioOptimization: false,
      supportsMultiSymbolAllocation: false,
      supportsSymbolSelection: false,
    },
    normalizedResultSha256: reconciliation.normalizedResultSha256,
  };
}

function normalizeSimulationPath(
  name: string,
  path: ResultContractSimulationPathSummary,
): ResultContractSimulationPathSummary {
  assertNonBlank(`${name}.policy`, path.policy);
  assertFinite(`${name}.totalReturn`, path.totalReturn);
  assertFinite(`${name}.maximumDrawdown`, path.maximumDrawdown);
  assertFinite(`${name}.totalTransactionCost`, path.totalTransactionCost);
  return {
    policy: path.policy,
    totalReturn: path.totalReturn,
    maximumDrawdown: path.maximumDrawdown,
    totalTransactionCost: path.totalTransactionCost,
  };
}

function normalizeMessages(messages: readonly string[]): readonly string[] {
  return [...new Set(messages
    .map((message) => message.trim())
    .filter((message) => message.length > 0))].sort();
}

function normalizeUnavailableFields(
  fields: readonly ResultContractUnavailableField[],
): readonly ResultContractUnavailableField[] {
  const unique = new Map<string, ResultContractUnavailableField>();
  for (const field of fields) {
    const key = `${field.path}\u0000${field.reason}`;
    unique.set(key, { path: field.path, reason: field.reason });
  }
  return [...unique.values()].sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
  });
}

function normalizeProvenanceReferences(
  references: readonly ResultContractProvenanceReference[],
): readonly ResultContractProvenanceReference[] {
  const normalized = references.map((reference) => {
    assertNonBlank("provenance reference", reference.reference);
    if (reference.sha256 !== undefined) assertNonBlank("provenance sha256", reference.sha256);
    return reference.sha256 === undefined
      ? { kind: reference.kind, reference: reference.reference }
      : { kind: reference.kind, reference: reference.reference, sha256: reference.sha256 };
  });
  const unique = new Map<string, ResultContractProvenanceReference>();
  for (const reference of normalized) {
    const key = `${reference.kind}\u0000${reference.reference}\u0000${reference.sha256 ?? ""}`;
    unique.set(key, reference);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.kind}\u0000${left.reference}\u0000${left.sha256 ?? ""}`;
    const rightKey = `${right.kind}\u0000${right.reference}\u0000${right.sha256 ?? ""}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function buildPromotion(
  evidence: ExperimentRunEvidence | undefined,
  promotionDecision: PromotionDecision | undefined,
  unavailableFields: ResultContractUnavailableField[],
): ResultContractPromotion {
  if (promotionDecision === undefined) {
    unavailableFields.push({
      path: "promotion.upstreamStatus",
      reason: "No upstream promotion decision was supplied.",
    });
    return {
      verdict: "do_not_promote",
      upstreamStatus: null,
      automaticPromotion: false,
      manualApprovalRequired: true,
      reasons: ["No upstream promotion decision was supplied; defaulted to do_not_promote."],
    };
  }

  const reasons = normalizeMessages(promotionDecision.reasons);
  if (evidence !== undefined && promotionDecision.status === "RESEARCH_CANDIDATE") {
    return {
      verdict: "research_only",
      upstreamStatus: promotionDecision.status,
      automaticPromotion: false,
      manualApprovalRequired: true,
      reasons: normalizeMessages([
        "Upstream RESEARCH_CANDIDATE is retained as research_only; no promotion is authorized.",
        ...reasons,
      ]),
    };
  }

  return {
    verdict: "do_not_promote",
    upstreamStatus: promotionDecision.status,
    automaticPromotion: false,
    manualApprovalRequired: true,
    reasons: normalizeMessages([
      evidence === undefined
        ? "Research evidence is unavailable; promotion is fail-closed."
        : "Upstream evidence is blocked; promotion is fail-closed.",
      ...reasons,
    ]),
  };
}

export function readLatestPredictionsArtifact(
  artifact: LegacyLatestPredictionArtifact,
): readonly ResultContractLatestPredictionInput[] {
  assertNonBlank("latest-predictions artifact schemaVersion", artifact.schemaVersion);
  assertNonBlank("latest-predictions artifact runId", artifact.runId);
  assertNonBlank("latest-predictions artifact sourceSha256", artifact.sourceSha256);
  assertNonBlank("latest-predictions artifact dataEndDate", artifact.dataEndDate);

  const latest = artifact.openPredictions
    .filter((prediction) => prediction.isLatest)
    .map((prediction) => {
      const { isLatest, ...normalized } = prediction;
      if (!isLatest) fail("latest-predictions reader received a non-latest record after filtering");
      return normalized;
    })
    .sort(comparePredictions);
  return deepFreezeClone(latest);
}

export function buildPredictionRetrainingResultV1(
  input: BuildPredictionRetrainingResultV1Input,
): PredictionRetrainingResultV1 {
  assertNonBlank("runId", input.runId);
  assertNonBlank("generatedAt", input.generatedAt);
  if (input.dataAsOf !== undefined) assertNonBlank("dataAsOf", input.dataAsOf);
  if (input.researchVersion !== undefined) assertNonBlank("researchVersion", input.researchVersion);
  if (input.modelVersion !== undefined) assertNonBlank("modelVersion", input.modelVersion);
  if (input.modelAlgorithm !== undefined) assertNonBlank("modelAlgorithm", input.modelAlgorithm);

  const unavailableFields: ResultContractUnavailableField[] = [];
  const evidence = input.evidence;
  const dataAsOf = fieldFromOptional(
    input.dataAsOf,
    "dataAsOf",
    "The upstream research evidence does not expose a data-as-of value.",
    unavailableFields,
  );

  const dataset: ResultContractField<ResultContractDatasetIdentity> = evidence === undefined
    ? unavailableFor("dataset", "No ExperimentRunEvidence was supplied.", unavailableFields)
    : available({
      datasetId: evidence.datasetVersion.datasetId,
      version: evidence.datasetVersion.version,
      source: evidence.datasetVersion.source,
      datasetSha256: evidence.datasetSha256,
      featureRowsSha256: evidence.featureRowsSha256,
    });

  const researchVersion = input.researchVersion ?? evidence?.schemaVersion;
  const modelVersion = input.modelVersion ?? evidence?.fit.modelStateSha256;
  const model: ResultContractModelProvenance = {
    researchVersion: fieldFromOptional(
      researchVersion,
      "model.researchVersion",
      "No research version was supplied or exposed by the evidence.",
      unavailableFields,
    ),
    modelVersion: fieldFromOptional(
      modelVersion,
      "model.modelVersion",
      "No model version or model state identity was supplied.",
      unavailableFields,
    ),
    algorithm: fieldFromOptional(
      input.modelAlgorithm,
      "model.algorithm",
      "The current evidence does not carry a normalized model algorithm name.",
      unavailableFields,
    ),
    fitPartition: evidence === undefined
      ? unavailableFor("model.fitPartition", "No ExperimentRunEvidence was supplied.", unavailableFields)
      : available(evidence.fit.fitPartition),
    trainingRowsSha256: evidence === undefined
      ? unavailableFor("model.trainingRowsSha256", "No ExperimentRunEvidence was supplied.", unavailableFields)
      : available(evidence.fit.trainingRowsSha256),
  };

  const retraining: ResultContractField<ResultContractRetrainingProvenance> = evidence === undefined
    ? unavailableFor("retraining", "No ExperimentRunEvidence was supplied.", unavailableFields)
    : available({
      runId: input.runId,
      executed: true,
      fitPartition: evidence.fit.fitPartition,
      trainingRowCount: evidence.split.trainingRowCount,
      trainingRowsSha256: evidence.fit.trainingRowsSha256,
      modelStateSha256: available(evidence.fit.modelStateSha256),
    });

  const partitions = buildPartitionBoundaries(evidence, unavailableFields);

  let thresholdSelection: ResultContractField<ResultContractThresholdSelection>;
  let finalTestMetrics: ResultContractField<EvaluationMetrics>;
  let baselineMetrics: ResultContractField<ResultContractBaselineMetrics>;
  if (evidence === undefined) {
    const reason = "No ExperimentRunEvidence was supplied.";
    thresholdSelection = unavailableFor("thresholdSelection", reason, unavailableFields);
    finalTestMetrics = unavailableFor("finalTestMetrics", reason, unavailableFields);
    baselineMetrics = unavailableFor("baselineMetrics", reason, unavailableFields);
  } else {
    if (evidence.fit.fitPartition !== "TRAINING") {
      fail("model fit evidence must use the TRAINING partition");
    }
    if (evidence.thresholdSelection.selectionPartition !== "VALIDATION") {
      fail("threshold selection must use the VALIDATION partition");
    }
    if (evidence.finalTest.evaluationPartition !== "FINAL_TEST") {
      fail("final-test evidence must use the FINAL_TEST partition");
    }
    if (evidence.thresholdSelection.selectedThreshold !== evidence.finalTest.frozenThreshold) {
      fail("final-test must use the threshold selected on validation");
    }
    if (evidence.thresholdSelection.validationRowsSha256 === evidence.finalTest.finalTestRowsSha256) {
      fail("final-test rows must not be reused as threshold-selection rows");
    }
    thresholdSelection = available({
      selectedThreshold: evidence.thresholdSelection.selectedThreshold,
      selectionSource: "VALIDATION",
      selectionRowsSha256: evidence.thresholdSelection.validationRowsSha256,
      candidateThresholds: [...evidence.thresholdSelection.fixedThresholdGrid].sort((left, right) => left - right),
      tieBreakRule: [...evidence.thresholdSelection.tieBreakRule],
    });
    finalTestMetrics = available(evidence.finalTest.metrics);
    baselineMetrics = available({
      metricName: "FINAL_TEST_MAJORITY_CLASS_ACCURACY",
      majorityClassAccuracy: evidence.finalTest.metrics.majorityBaseline,
    });
  }

  const finalTestReliability: ResultContractField<ResultContractFinalTestReliability> = input.finalTestReliability === undefined
    ? unavailableFor(
      "finalTestReliability",
      "No per-symbol final-test reliability evidence was supplied.",
      unavailableFields,
    )
    : available(normalizeFinalTestReliability(input.finalTestReliability));

  const finalTestEconomicEdge: ResultContractField<ResultContractFinalTestEconomicEdge> = input.finalTestEconomicEdge === undefined
    ? unavailableFor(
      "finalTestEconomicEdge",
      "No per-symbol final-test economic-edge evidence was supplied.",
      unavailableFields,
    )
    : available(normalizeFinalTestEconomicEdge(input.finalTestEconomicEdge));

  const perSymbolLogisticChallenger: ResultContractField<ResultContractPerSymbolLogisticChallenger> =
    input.perSymbolLogisticChallenger === undefined
      ? unavailableFor(
        "perSymbolLogisticChallenger",
        "No per-symbol logistic challenger evidence was supplied.",
        unavailableFields,
      )
      : available(normalizePerSymbolLogisticChallenger(input.perSymbolLogisticChallenger));

  let latestPredictions: ResultContractField<readonly ResultContractLatestPrediction[]>;
  if (input.latestPredictions === undefined || input.latestPredictions.length === 0) {
    latestPredictions = unavailableFor(
      "latestPredictions",
      "No latest per-symbol prediction evidence was supplied.",
      unavailableFields,
    );
  } else {
    latestPredictions = available(normalizePredictions(
      input.latestPredictions,
      "latestPredictions",
      unavailableFields,
    ));
  }

  const currentPredictionUnavailable = normalizePredictionUnavailable(
    input.currentPredictionUnavailable ?? [],
    unavailableFields,
  );
  let currentUnresolvedPredictions: ResultContractField<readonly ResultContractLatestPrediction[]>;
  if (
    input.currentUnresolvedPredictions === undefined
    || input.currentUnresolvedPredictions.length === 0
  ) {
    currentUnresolvedPredictions = unavailableFor(
      "currentUnresolvedPredictions",
      "No current unresolved prediction evidence was supplied.",
      unavailableFields,
    );
  } else {
    currentUnresolvedPredictions = available(normalizePredictions(
      input.currentUnresolvedPredictions,
      "currentUnresolvedPredictions",
      unavailableFields,
      "current_unresolved",
      "current_unresolved",
    ));
  }

  let simulation: ResultContractField<ResultContractSimulationSummary>;
  if (input.simulation === undefined) {
    simulation = unavailableFor(
      "simulation",
      "No transaction-cost or simulation evidence was supplied.",
      unavailableFields,
    );
  } else {
    simulation = available(normalizeSimulation(input.simulation, unavailableFields));
  }

  const promotion = buildPromotion(evidence, input.promotionDecision, unavailableFields);
  const warnings = normalizeMessages([
    ...(input.warnings ?? []),
    ...(evidence?.dataQualityFindings.map((finding) => `${finding.code}: ${finding.message}`) ?? []),
    ...(input.promotionDecision?.reasons ?? []),
  ]);

  const provenanceReferences: ResultContractProvenanceReference[] = [
    ...(input.provenanceReferences ?? []),
  ];
  if (evidence !== undefined) {
    provenanceReferences.push({
      kind: "research_evidence",
      reference: evidence.schemaVersion,
      sha256: evidence.normalizedEvidenceSha256,
    });
    provenanceReferences.push({
      kind: "dataset",
      reference: `${evidence.datasetVersion.datasetId}@${evidence.datasetVersion.version}`,
      sha256: evidence.datasetSha256,
    });
    provenanceReferences.push({
      kind: "retraining",
      reference: input.runId,
      sha256: evidence.fit.modelStateSha256,
    });
  }
  if (input.simulation !== undefined && input.simulation.normalizedResultSha256 !== undefined) {
    provenanceReferences.push({
      kind: "simulation",
      reference: input.simulation.schemaVersion,
      sha256: input.simulation.normalizedResultSha256,
    });
  }
  if (input.finalTestEconomicEdge !== undefined) {
    provenanceReferences.push({
      kind: "economic_edge",
      reference: input.finalTestEconomicEdge.schemaVersion,
      sha256: input.finalTestEconomicEdge.normalizedResultSha256,
    });
  }
  if (input.perSymbolLogisticChallenger !== undefined) {
    provenanceReferences.push({
      kind: "challenger",
      reference: input.perSymbolLogisticChallenger.schemaVersion,
      sha256: input.perSymbolLogisticChallenger.normalizedResultSha256,
    });
  }
  if (input.finalTestEconomicReconciliation !== undefined) {
    provenanceReferences.push({
      kind: "economic_edge",
      reference: input.finalTestEconomicReconciliation.schemaVersion,
      sha256: input.finalTestEconomicReconciliation.normalizedResultSha256,
    });
  }

  const finalTestEconomicReconciliation = input.finalTestEconomicReconciliation === undefined
    ? undefined
    : normalizeFinalTestEconomicReconciliation(input.finalTestEconomicReconciliation);

  const result: PredictionRetrainingResultV1 = {
    schemaVersion: PREDICTION_RETRAINING_RESULT_SCHEMA_VERSION,
    runId: input.runId,
    generatedAt: input.generatedAt,
    dataAsOf,
    dataset,
    model,
    retraining,
    partitions,
    thresholdSelection,
    finalTestMetrics,
    baselineMetrics,
    finalTestReliability,
    finalTestEconomicEdge,
    perSymbolLogisticChallenger,
    ...(finalTestEconomicReconciliation === undefined ? {} : { finalTestEconomicReconciliation }),
    latestPredictions,
    currentUnresolvedPredictions,
    currentPredictionUnavailable,
    simulation,
    promotion,
    warnings,
    unavailableFields: normalizeUnavailableFields(unavailableFields),
    provenanceReferences: normalizeProvenanceReferences(provenanceReferences),
    guardrails: PREDICTION_RETRAINING_RESULT_GUARDRAILS,
  };

  return deepFreezeClone(result);
}

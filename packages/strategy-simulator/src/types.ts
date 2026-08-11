export interface LongCashReplayInput {
  readonly symbol: string;
  readonly validationThreshold: number;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly rows: readonly LongCashReplayRow[];
}

export interface LongCashReplayRow {
  readonly entryDate: string;
  readonly exitDate: string;
  readonly probabilityUp: number;
  readonly realizedForwardReturn: number;
}

export type LongCashReplayPosition = "LONG" | "CASH";

export interface SelectedScheduleWindow {
  readonly entryDate: string;
  readonly exitDate: string;
}

export interface LongCashReplayWindow {
  readonly sourceRowIndex: number;
  readonly entryDate: string;
  readonly exitDate: string;
  readonly probabilityUp: number;
  readonly realizedForwardReturn: number;
  readonly strategyPosition: LongCashReplayPosition;
  readonly strategyGrossReturn: number;
  readonly strategyNetReturn: number;
  readonly benchmarkGrossReturn: number;
  readonly benchmarkNetReturn: number;
  readonly strategyCapital: number;
  readonly benchmarkCapital: number;
}

export type LongCashReplayPolicy =
  | "VALIDATION_THRESHOLD_LONG_CASH"
  | "ALWAYS_LONG_BENCHMARK";

export interface LongCashReplayPathSummary {
  readonly policy: LongCashReplayPolicy;
  readonly initialCapital: number;
  readonly finalCapital: number;
  readonly totalReturn: number;
  readonly maximumDrawdown: number;
  readonly longWindowCount: number;
  readonly cashWindowCount: number;
  readonly roundTripCount: number;
  readonly totalTransactionCost: number;
  readonly winningLongTradeCount: number;
  readonly losingLongTradeCount: number;
  readonly averageActiveLongNetReturn: number;
}

export interface LongCashReplayGuardrails {
  readonly providesInvestmentAdvice: false;
  readonly supportsOrderExecution: false;
  readonly supportsAutomaticPromotion: false;
  readonly supportsPortfolioOptimization: false;
  readonly supportsMultiSymbolAllocation: false;
}

export interface LongCashReplayResult {
  readonly schemaVersion: "MMS_LONG_CASH_REPLAY_V1";
  readonly researchMode: "diagnostic-only";
  readonly symbol: string;
  readonly validationThreshold: number;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly inputRowCount: number;
  readonly replayWindowCount: number;
  readonly skippedOverlapCount: number;
  readonly inputSha256: string;
  readonly selectedSchedule: readonly SelectedScheduleWindow[];
  readonly selectedScheduleSha256: string;
  readonly replayWindowsSha256: string;
  readonly windows: readonly LongCashReplayWindow[];
  readonly strategy: LongCashReplayPathSummary;
  readonly benchmark: LongCashReplayPathSummary;
  readonly excessReturn: number;
  readonly guardrails: LongCashReplayGuardrails;
  readonly normalizedResultSha256: string;
}

export interface LongCashThresholdCalibrationInput {
  readonly symbol: string;
  readonly candidateThresholds: readonly number[];
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly calibrationRows: readonly LongCashReplayRow[];
  readonly validationRows: readonly LongCashReplayRow[];
}

export interface LongCashThresholdCalibrationCandidateResult {
  readonly threshold: number;
  readonly eligible: boolean;
  readonly replay: LongCashReplayResult;
}

export interface LongCashThresholdCalibrationResult {
  readonly schemaVersion: "MMS_LONG_CASH_THRESHOLD_CALIBRATION_V1";
  readonly researchMode: "diagnostic-only";
  readonly symbol: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly candidateThresholds: readonly number[];
  readonly calibrationMaxExitDate: string;
  readonly validationMinEntryDate: string;
  readonly calibrationResults: readonly LongCashThresholdCalibrationCandidateResult[];
  readonly selectedThreshold: number;
  readonly selectedCalibrationResult: LongCashReplayResult;
  readonly validationResult: LongCashReplayResult;
}

export interface WalkForwardThresholdEvaluationFoldInput {
  readonly foldId: string;
  readonly candidateThresholds: readonly number[];
  readonly calibrationRows: readonly LongCashReplayRow[];
  readonly validationRows: readonly LongCashReplayRow[];
}

export interface WalkForwardThresholdEvaluationInput {
  readonly symbol: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly folds: readonly WalkForwardThresholdEvaluationFoldInput[];
}

export interface WalkForwardThresholdEvaluationFoldResult {
  readonly foldId: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly selectedThreshold: number;
  readonly calibrationResult: LongCashThresholdCalibrationResult;
}

export interface WalkForwardEquityCurvePoint {
  readonly foldId: string | null;
  readonly capital: number;
}

export interface WalkForwardThresholdFrequency {
  readonly threshold: number;
  readonly count: number;
}

export interface WalkForwardThresholdEvaluationResult {
  readonly schemaVersion: "MMS_WALK_FORWARD_THRESHOLD_EVALUATION_V1";
  readonly researchMode: "diagnostic-only";
  readonly symbol: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly foldCount: number;
  readonly orderedFoldIds: readonly string[];
  readonly foldResults: readonly WalkForwardThresholdEvaluationFoldResult[];
  readonly aggregateStrategyEquityCurve: readonly WalkForwardEquityCurvePoint[];
  readonly aggregateBenchmarkEquityCurve: readonly WalkForwardEquityCurvePoint[];
  readonly cumulativeAggregateStrategyReturn: number;
  readonly cumulativeAggregateBenchmarkReturn: number;
  readonly aggregateExcessReturn: number;
  readonly aggregateMaximumStrategyDrawdown: number;
  readonly thresholdFrequencies: readonly WalkForwardThresholdFrequency[];
  readonly normalizedFoldsSha256: string;
  readonly foldResultsSha256: string;
  readonly aggregateStrategyCurveSha256: string;
  readonly aggregateBenchmarkCurveSha256: string;
  readonly normalizedResultSha256: string;
}

export type ThresholdParameterSensitivityFragilityStatus =
  | "NO_EXCESS_RETURN_SIGN_FLIP"
  | "EXCESS_RETURN_SIGN_FLIP";

export type ThresholdParameterSensitivityAggregateStatus =
  | "NO_FOLD_SIGN_FLIP"
  | "ONE_OR_MORE_FOLD_SIGN_FLIPS";

export interface ThresholdParameterSensitivityGuardrails {
  readonly providesInvestmentAdvice: false;
  readonly supportsOrderExecution: false;
  readonly supportsAutomaticPromotion: false;
  readonly supportsPortfolioOptimization: false;
  readonly supportsMultiSymbolAllocation: false;
  readonly validationOutcomesAffectThresholdSelection: false;
  readonly candidateThresholdsAreDiagnosticsOnly: true;
}

export interface ThresholdParameterSensitivityCandidateResult {
  readonly threshold: number;
  readonly isSelectedThreshold: boolean;
  readonly validationStrategyReturn: number;
  readonly validationBenchmarkReturn: number;
  readonly validationExcessReturn: number;
  readonly validationMaximumDrawdown: number;
  readonly returnDeltaVersusSelectedThreshold: number;
  readonly excessReturnDeltaVersusSelectedThreshold: number;
  readonly degradationVersusSelectedThreshold: number;
  readonly excessReturnDegradationVersusSelectedThreshold: number;
}

export interface ThresholdParameterSensitivityFoldResult {
  readonly foldId: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly selectedThreshold: number;
  readonly selectedValidationStrategyReturn: number;
  readonly selectedValidationBenchmarkReturn: number;
  readonly selectedValidationExcessReturn: number;
  readonly candidateThresholdResults: readonly ThresholdParameterSensitivityCandidateResult[];
  readonly maximumValidationReturnDegradation: number;
  readonly maximumValidationExcessReturnDegradation: number;
  readonly anyCandidateChangesValidationExcessReturnSign: boolean;
  readonly fragilityStatus: ThresholdParameterSensitivityFragilityStatus;
}

export interface ThresholdParameterSensitivityResult {
  readonly schemaVersion: "MMS_THRESHOLD_PARAMETER_SENSITIVITY_V1";
  readonly researchMode: "diagnostic-only";
  readonly symbol: string;
  readonly roundTripCostBps: number;
  readonly initialCapital: number;
  readonly candidateThresholds: readonly number[];
  readonly foldCount: number;
  readonly orderedFoldIds: readonly string[];
  readonly foldResults: readonly ThresholdParameterSensitivityFoldResult[];
  readonly foldSignFlipCount: number;
  readonly aggregateFragilityStatus: ThresholdParameterSensitivityAggregateStatus;
  readonly guardrails: ThresholdParameterSensitivityGuardrails;
  readonly foldResultsSha256: string;
  readonly normalizedResultSha256: string;
}

export interface WalkForwardStabilityFoldDiagnostic {
  readonly foldId: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly selectedThreshold: number;
  readonly validationStrategyReturn: number;
  readonly validationBenchmarkReturn: number;
  readonly validationExcessReturn: number;
  readonly validationMaximumDrawdown: number;
  readonly validationActiveLongCount: number;
  readonly validationCashCount: number;
}

export interface WalkForwardStabilityDiagnostics {
  readonly schemaVersion: "MMS_WALK_FORWARD_STABILITY_DIAGNOSTICS_V1";
  readonly researchMode: "diagnostic-only";
  readonly foldCount: number;
  readonly foldDiagnostics: readonly WalkForwardStabilityFoldDiagnostic[];
  readonly positiveStrategyReturnFoldCount: number;
  readonly positiveExcessReturnFoldCount: number;
  readonly nonNegativeExcessReturnFoldCount: number;
  readonly meanValidationStrategyReturn: number;
  readonly medianValidationStrategyReturn: number;
  readonly meanValidationBenchmarkReturn: number;
  readonly medianValidationBenchmarkReturn: number;
  readonly meanValidationExcessReturn: number;
  readonly medianValidationExcessReturn: number;
  readonly bestFoldByExcessReturn: WalkForwardStabilityFoldDiagnostic;
  readonly worstFoldByExcessReturn: WalkForwardStabilityFoldDiagnostic;
  readonly maximumValidationDrawdownAcrossFolds: number;
  readonly selectedThresholdFrequencies: readonly WalkForwardThresholdFrequency[];
  readonly uniqueSelectedThresholdCount: number;
  readonly dominantSelectedThreshold: number;
  readonly dominantSelectedThresholdFrequency: number;
  readonly dominantSelectedThresholdRatio: number;
  readonly aggregateStrategyReturn: number;
  readonly aggregateBenchmarkReturn: number;
  readonly aggregateExcessReturn: number;
  readonly aggregateMaximumDrawdown: number;
  readonly foldDiagnosticsSha256: string;
  readonly selectedThresholdFrequenciesSha256: string;
  readonly normalizedResultSha256: string;
}

export interface WalkForwardStabilityGatePolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly minimumFoldCount: number;
  readonly minimumPositiveExcessReturnFoldRatio: number;
  readonly minimumMedianValidationExcessReturn: number;
  readonly minimumAggregateExcessReturn: number;
  readonly maximumAggregateDrawdown: number;
  readonly maximumDominantThresholdRatio: number;
}

export type WalkForwardStabilityGateCriterionId =
  | "MINIMUM_FOLD_COUNT"
  | "MINIMUM_POSITIVE_EXCESS_RETURN_FOLD_RATIO"
  | "MINIMUM_MEDIAN_VALIDATION_EXCESS_RETURN"
  | "MINIMUM_AGGREGATE_EXCESS_RETURN"
  | "MAXIMUM_AGGREGATE_DRAWDOWN"
  | "MAXIMUM_DOMINANT_THRESHOLD_RATIO";

export interface WalkForwardStabilityGateCriterionResult {
  readonly criterionId: WalkForwardStabilityGateCriterionId;
  readonly pass: boolean;
  readonly observedValue: number;
  readonly thresholdValue: number;
  readonly comparator: ">=" | "<=";
}

export interface EvaluateWalkForwardStabilityGateInput {
  readonly policy: WalkForwardStabilityGatePolicy;
  readonly diagnostics: WalkForwardStabilityDiagnostics;
}

export interface WalkForwardStabilityGateEvaluationResult {
  readonly schemaVersion: "MMS_WALK_FORWARD_STABILITY_GATE_EVALUATION_V1";
  readonly researchMode: "diagnostic-only";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policySha256: string;
  readonly diagnosticsSha256: string;
  readonly overallPass: boolean;
  readonly criteria: readonly WalkForwardStabilityGateCriterionResult[];
  readonly policy: WalkForwardStabilityGatePolicy;
  readonly normalizedResultSha256: string;
}

export class LongCashReplayError extends Error {
  constructor(message: string) {
    super(`strategy simulator failed closed: ${message}`);
    this.name = "LongCashReplayError";
  }
}

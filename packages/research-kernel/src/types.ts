export type BinaryTarget = 0 | 1;

export type FeatureVector = readonly [number, number, number, number, number];

export interface MarketDataRow {
  readonly symbol: string;
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly source: string;
}

export interface FeatureRow {
  readonly symbol: string;
  readonly featureDate: string;
  readonly targetDate: string;
  readonly featureSourceStartDate: string;
  readonly featureSourceEndDate: string;
  readonly features: FeatureVector;
  readonly target: BinaryTarget;
  readonly forwardReturn: number;
}

export interface DatasetVersion {
  readonly datasetId: string;
  readonly version: string;
  readonly source: string;
}

export type DataQualityFindingCode =
  | "INVALID_ORDERING"
  | "MALFORMED_DATE"
  | "INVALID_OHLCV"
  | "DUPLICATE_SYMBOL_DATE"
  | "UNADJUSTED_PRICE_DISCONTINUITY_RISK";

export interface DataQualityFinding {
  readonly code: DataQualityFindingCode;
  readonly severity: "BLOCKING";
  readonly message: string;
  readonly symbol?: string;
  readonly date?: string;
  readonly priorDate?: string;
  readonly value?: number;
}

export interface ConfusionMatrix {
  readonly truePositive: number;
  readonly trueNegative: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
}

export interface EvaluationMetrics {
  readonly sampleCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly predictedPositiveCount: number;
  readonly predictedNegativeCount: number;
  readonly accuracy: number;
  readonly balancedAccuracy: number;
  readonly majorityBaseline: number;
  readonly precision: number;
  readonly recall: number;
  readonly specificity: number;
  readonly brierScore: number;
  readonly logLoss: number;
  readonly confusionMatrix: ConfusionMatrix;
}

export type PartitionKind =
  | "TRAINING"
  | "TRAIN_VALIDATION_PURGE"
  | "VALIDATION"
  | "VALIDATION_FINAL_PURGE"
  | "FINAL_TEST";

export interface RowPartition<K extends PartitionKind> {
  readonly kind: K;
  readonly rows: readonly FeatureRow[];
  readonly rowIdentitySha256: string;
}

export interface ThreeWayChronologicalSplit {
  readonly uniqueFeatureDates: readonly string[];
  readonly trainEndDate: string;
  readonly validationStartDate: string;
  readonly validationEndDate: string;
  readonly finalTestStartDate: string;
  readonly training: RowPartition<"TRAINING">;
  readonly trainValidationPurge: RowPartition<"TRAIN_VALIDATION_PURGE">;
  readonly validation: RowPartition<"VALIDATION">;
  readonly validationFinalPurge: RowPartition<"VALIDATION_FINAL_PURGE">;
  readonly finalTest: RowPartition<"FINAL_TEST">;
}

export interface StandardScalerFit {
  readonly fitPartition: "TRAINING";
  readonly means: FeatureVector;
  readonly standardDeviations: FeatureVector;
  readonly fitRowCount: number;
  readonly fitRowIdentitySha256: string;
  readonly stateSha256: string;
}

export interface LogisticRegressionConfig {
  readonly iterations: number;
  readonly learningRate: number;
  readonly l2: number;
}

export interface LogisticRegressionFit {
  readonly fitPartition: "TRAINING";
  readonly weights: readonly [number, number, number, number, number, number];
  readonly fitRowCount: number;
  readonly fitRowIdentitySha256: string;
  readonly initialRegularizedLoss: number;
  readonly finalRegularizedLoss: number;
  readonly config: LogisticRegressionConfig;
  readonly stateSha256: string;
}

export interface ThresholdCandidateEvidence {
  readonly threshold: number;
  readonly metrics: EvaluationMetrics;
}

export interface ThresholdSelectionEvidence {
  readonly selectionPartition: "VALIDATION";
  readonly validationRowsSha256: string;
  readonly fixedThresholdGrid: readonly number[];
  readonly candidates: readonly ThresholdCandidateEvidence[];
  readonly selectedThreshold: number;
  readonly selectedValidationMetrics: EvaluationMetrics;
  readonly validationCandidateStateSha256: string;
  readonly tieBreakRule: readonly string[];
}

export interface FinalTestEvidence {
  readonly evaluationPartition: "FINAL_TEST";
  readonly finalTestRowsSha256: string;
  readonly finalTestScoredRowsSha256: string;
  readonly frozenThreshold: number;
  readonly evaluatorExecutionCount: 1;
  readonly metrics: EvaluationMetrics;
}

export interface ExperimentRunEvidence {
  readonly schemaVersion: "MMS_RESEARCH_EVIDENCE_V1";
  readonly researchMode: "diagnostic-only";
  readonly datasetVersion: DatasetVersion;
  readonly datasetSha256: string;
  readonly featureRowsSha256: string;
  readonly featureNames: readonly string[];
  readonly dataQualityFindings: readonly DataQualityFinding[];
  readonly split: {
    readonly trainEndDate: string;
    readonly validationStartDate: string;
    readonly validationEndDate: string;
    readonly finalTestStartDate: string;
    readonly trainingRowCount: number;
    readonly trainValidationPurgeRowCount: number;
    readonly validationRowCount: number;
    readonly validationFinalPurgeRowCount: number;
    readonly finalTestRowCount: number;
    readonly trainingRowsSha256: string;
  };
  readonly fit: {
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
  };
  readonly thresholdSelection: ThresholdSelectionEvidence;
  readonly finalTest: FinalTestEvidence;
  readonly normalizedEvidenceSha256: string;
}

export type PromotionStatus =
  | "BLOCKED_DATA_QUALITY"
  | "BLOCKED_INSUFFICIENT_EVIDENCE"
  | "BLOCKED_UNDERPERFORMS_BASELINE"
  | "RESEARCH_CANDIDATE";

export interface PromotionDecision {
  readonly status: PromotionStatus;
  readonly automaticPromotion: false;
  readonly manualApprovalRequired: true;
  readonly requiredBaseline: "FINAL_TEST_MAJORITY_CLASS_ACCURACY";
  readonly reasons: readonly string[];
}

export interface ResearchEvidenceKernelInput {
  readonly datasetVersion: DatasetVersion;
  readonly marketRows: readonly MarketDataRow[];
  readonly logisticRegression?: Partial<LogisticRegressionConfig>;
  readonly discontinuityThreshold?: number;
}

export interface ResearchEvidenceKernelResult {
  readonly evidence: ExperimentRunEvidence;
  readonly promotionDecision: PromotionDecision;
}

export class ResearchEvidenceKernelError extends Error {
  constructor(message: string) {
    super(`research evidence kernel failed closed: ${message}`);
    this.name = "ResearchEvidenceKernelError";
  }
}

export function fail(message: string): never {
  throw new ResearchEvidenceKernelError(message);
}

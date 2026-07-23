export const PROMOTION_STATUSES = [
  "BLOCKED_DATA_QUALITY",
  "BLOCKED_INSUFFICIENT_EVIDENCE",
  "BLOCKED_UNDERPERFORMS_BASELINE",
  "RESEARCH_CANDIDATE",
] as const;

export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export type BinaryTarget = 0 | 1;

export type FeatureVector = readonly [
  return5d: number,
  return20d: number,
  volatility10d: number,
  volumeRatio20d: number,
  intradayRangePct: number,
];

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

export interface ChronologicalSplitEvidence {
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
}

export interface FitEvidence {
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
  readonly split: ChronologicalSplitEvidence;
  readonly fit: FitEvidence;
  readonly thresholdSelection: ThresholdSelectionEvidence;
  readonly finalTest: FinalTestEvidence;
  readonly normalizedEvidenceSha256: string;
}

export interface PromotionDecision {
  readonly status: PromotionStatus;
  readonly automaticPromotion: false;
  readonly manualApprovalRequired: true;
  readonly requiredBaseline: "FINAL_TEST_MAJORITY_CLASS_ACCURACY";
  readonly reasons: readonly string[];
}

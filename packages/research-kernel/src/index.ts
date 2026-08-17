export const researchKernelBootstrapIdentity = {
  researchMode: "diagnostic-only",
  providesInvestmentAdvice: false,
  supportsTradingExecution: false,
} as const;

export * from "./chronologicalSplit.js";
export * from "./buildFinalTestReliabilityProfile.js";
export * from "./dataQuality.js";
export * from "./evaluation.js";
export * from "./evidence.js";
export * from "./finalTestEconomicEvidence.js";
export * from "./features.js";
export * from "./gaussianNaiveBayes.js";
export * from "./gaussianNaiveBayesChallenger.js";
export * from "./legacyTechnicalFeatureChallenger.js";
export * from "./logisticRegression.js";
export * from "./perSymbolLogisticChallenger.js";
export * from "./researchEvidenceKernel.js";
export * from "./returnHurdleTarget.js";
export * from "./scaler.js";
export * from "./twseAdjustedOhlcvQualification.js";
export * from "./twStrategyResearchRunner.js";
export * from "./twStrategyTemporalRobustness.js";
export * from "./twStrategyTransactionCostSensitivity.js";
export * from "./types.js";

export { PaperTradingEngine } from "./engine.js";
export {
  evaluateHistoricalWindow,
  reconcileHistoricalRun,
  runHistoricalActionCostDiagnosticFiles,
  sellTaxBounds,
} from "./historicalActionCostDiagnostic.js";
export type { HistoricalDividend, HistoricalDiagnosticWindow } from "./historicalActionCostDiagnostic.js";
export { commonEligibilityWindow, relativePnlAttribution, runHistoricalExposureAuditFiles } from "./historicalExposureAudit.js";
export {
  evaluateSplitRebasedForwardSample,
  evaluateSplitRebasedHistoricalBenchmark,
  rebasePriceBandForSplit,
  runSplitRebasedHistoricalBenchmarkFiles,
  SPLIT_REBASED_BENCHMARK_VERSION,
  SPLIT_REBASED_DIVIDENDS,
} from "./splitRebasedHistoricalBenchmark.js";
export type { SplitRebasedDividend } from "./splitRebasedHistoricalBenchmark.js";
export {
  calculateTenMonthSmaSignals,
  evaluateTrendVsHoldDiagnostic,
  runTrendVsHoldDiagnosticFiles,
  TREND_VS_HOLD_VERSION,
} from "./trendVsHoldDiagnostic.js";
export type { MonthEndTrendSignal, TenMonthTrendPlan, TrendEvaluationWindow } from "./trendVsHoldDiagnostic.js";
export {
  DurablePaperTradingSession,
  PaperJournalConflictError,
  PaperJournalCorruptError,
  PaperJournalError,
  PaperJournalReplayError,
} from "./durablePaperSession.js";
export { DurableGatewayPaperSession } from "./durableExecutionSession.js";
export type {
  DurableGatewayMarketResult,
  GatewayRecoveryState,
} from "./durableExecutionSession.js";
export {
  PriceBandStrategy,
  RollingMeanReversionV1Strategy,
  ROLLING_MEAN_REVERSION_V1,
  ROLLING_MEAN_REVERSION_V1_STRATEGY_VERSION,
  ROLLING_MEAN_REVERSION_V1_TARGET_QUANTITY,
  alwaysFillNextEvent,
} from "./strategy.js";
export type { RollingMeanReversionV1Config } from "./strategy.js";
export {
  ROLLING_ZSCORE_MEAN_REVERSION_V1,
  ROLLING_ZSCORE_MEAN_REVERSION_V1_STRATEGY_VERSION,
  RollingZScoreMeanReversionV1Strategy,
  rollingCloseZScore,
} from "./zscoreStrategy.js";
export type { RollingZScoreMeanReversionV1Config } from "./zscoreStrategy.js";
export type {
  AccountSnapshot,
  CancelRequest,
  Clock,
  DecisionRecord,
  ExecutionReport,
  ExternalOrderReconciliation,
  ExternalOrderStatus,
  FillRuleDecision,
  HaltRequest,
  MarketEvent,
  MarketObservation,
  OperationResult,
  OrderSide,
  OrderStatus,
  PaperOrder,
  PaperStrategy,
  PaperTradingEngineConfig,
  RiskLimits,
  SimulatedFillRule,
  SimulationEvent,
  SyntheticTradingTerms,
  StrategyInput,
} from "./types.js";

export { CostCoveredZScoreExitV1Strategy } from "./costCoveredZScoreExit.js";
export type { CostCoveredZScoreExitV1Config } from "./costCoveredZScoreExit.js";

export { CostCoveredZScoreExitV2Strategy } from "./costCoveredZScoreExitV2.js";
export type { CostCoveredZScoreExitV2Config } from "./costCoveredZScoreExitV2.js";
export { freezePaperCostModelV2, paperFillCostsV2, publicTwCostScenarioV2 } from "./paperCostModelV2.js";
export { createSharedCostPaperPairV2 } from "./sharedCostPaperPairV2.js";
export type { PaperCostModelV2 } from "./types.js";

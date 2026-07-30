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

export class LongCashReplayError extends Error {
  constructor(message: string) {
    super(`strategy simulator failed closed: ${message}`);
    this.name = "LongCashReplayError";
  }
}

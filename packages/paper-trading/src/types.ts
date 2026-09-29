export type OrderSide = "buy" | "sell";

export type OrderStatus =
  | "pending"
  | "partially-filled"
  | "filled"
  | "rejected"
  | "cancelled";

export interface MarketEvent {
  readonly eventId: string;
  readonly timestamp: number;
  readonly symbol: string;
  /** Synthetic price in the smallest configured currency unit per share. */
  readonly priceMinor: bigint;
}

export type MarketObservation = MarketEvent;

export interface StrategyInput {
  readonly current: MarketObservation;
  /** Earlier fresh observations only. No future-derived values are provided. */
  readonly history: readonly MarketObservation[];
  readonly positionQuantity: number;
}

export interface PaperStrategy {
  readonly strategyVersion: string;
  decide(input: StrategyInput): number;
}

export interface Clock {
  now(): number;
}

export interface RiskLimits {
  readonly maxPositionQuantity: number;
  readonly maxExposureMinor: bigint;
  readonly maxMarketAgeMs: number;
}

export interface SyntheticTradingTerms {
  readonly label: "SYNTHETIC_ONLY";
  readonly feeBps: number;
  readonly slippageBps: number;
}

export interface PaperOrder {
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly filledQuantity: number;
  readonly remainingQuantity: number;
  readonly referencePriceMinor: bigint;
  readonly createdAt: number;
  readonly createdEventId: string;
  readonly status: OrderStatus;
  readonly rejectionReason?: string;
}

export interface ExecutionReport {
  readonly fillId: string;
  readonly clientOrderId: string;
  readonly marketEventId: string;
  readonly timestamp: number;
  readonly quantity: number;
  readonly executionPriceMinor: bigint;
  readonly feeMinor: bigint;
}

export type FillRuleDecision =
  | { readonly kind: "no-fill" }
  | { readonly kind: "fill"; readonly fillId: string; readonly quantity: number }
  | { readonly kind: "reject"; readonly reasonCode: string };

export interface FillRuleInput {
  readonly order: PaperOrder;
  readonly market: MarketObservation;
}

export type SimulatedFillRule = (input: FillRuleInput) => FillRuleDecision;

export type OperationResult =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | { readonly status: "stale"; readonly reasonCode: string }
  | { readonly status: "rejected"; readonly reasonCode: string };

export type DecisionStatus = "no-trade" | "order-submitted" | "risk-rejected";

export interface DecisionRecord {
  readonly eventId: string;
  readonly timestamp: number;
  readonly sourceEventId: string;
  readonly strategyVersion: string;
  readonly currentPositionQuantity: number;
  readonly targetPositionQuantity: number | null;
  readonly status: DecisionStatus;
  readonly reasonCode: string;
}

export type SimulationEvent =
  | {
      readonly eventId: string;
      readonly timestamp: number;
      readonly kind: "market";
      readonly sourceEventId: string;
      readonly symbol: string;
      readonly priceMinor: bigint;
      readonly status: "fresh" | "stale";
      readonly reasonCode?: string;
    }
  | ({ readonly kind: "decision" } & DecisionRecord)
  | {
      readonly eventId: string;
      readonly timestamp: number;
      readonly kind: "order";
      readonly sourceEventId: string;
      readonly clientOrderId: string;
      readonly status: OrderStatus;
      readonly side: OrderSide;
      readonly quantity: number;
      readonly filledQuantity: number;
      readonly remainingQuantity: number;
      readonly reasonCode?: string;
    }
  | {
      readonly eventId: string;
      readonly timestamp: number;
      readonly kind: "fill";
      readonly fillId: string;
      readonly clientOrderId: string;
      readonly sourceMarketEventId: string;
      readonly side: OrderSide;
      readonly quantity: number;
      readonly executionPriceMinor: bigint;
      readonly feeMinor: bigint;
    }
  | {
      readonly eventId: string;
      readonly timestamp: number;
      readonly kind: "halt";
      readonly sourceEventId: string;
      readonly reason: string;
    }
  | {
      readonly eventId: string;
      readonly timestamp: number;
      readonly kind: "cancel";
      readonly sourceEventId: string;
      readonly clientOrderId: string;
      readonly status: "cancelled" | "rejected";
      readonly reasonCode: string;
    };

export interface AccountSnapshot {
  readonly symbol: string;
  readonly cashMinor: bigint;
  readonly reservedCashMinor: bigint;
  readonly availableCashMinor: bigint;
  readonly positionQuantity: number;
  readonly markPriceMinor: bigint | null;
  readonly positionCostBasisMinor: bigint;
  readonly realizedPnlMinor: bigint;
  readonly unrealizedPnlMinor: bigint;
  readonly feesPaidMinor: bigint;
  /** Cash plus marked holdings. The reservation is informational, not equity. */
  readonly equityMinor: bigint;
  readonly halted: boolean;
  readonly activeOrder: PaperOrder | null;
}

export interface PaperTradingEngineConfig {
  readonly symbol: string;
  readonly initialCashMinor: bigint;
  readonly risk: RiskLimits;
  readonly terms: SyntheticTradingTerms;
  readonly clock: Clock;
  readonly strategy: PaperStrategy;
  readonly fillRule: SimulatedFillRule;
}

export interface CancelRequest {
  readonly eventId: string;
  readonly timestamp: number;
  readonly clientOrderId: string;
}

export interface HaltRequest {
  readonly eventId: string;
  readonly timestamp: number;
  readonly reason: string;
}

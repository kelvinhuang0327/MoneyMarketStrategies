export type OrderSide = "buy" | "sell";

export type OrderIntent = Readonly<{
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  createdAt: string;
  strategyVersion?: string;
  decisionRef?: string;
}> &
  (
    | {
        orderType: "market";
        limitPriceMinor?: never;
      }
    | {
        orderType: "limit";
        limitPriceMinor: number;
      }
  );

export type OrderAcknowledgement =
  | Readonly<{
      clientOrderId: string;
      brokerOrderId: string;
      status: "accepted";
    }>
  | Readonly<{
      clientOrderId: string;
      brokerOrderId?: string;
      status: "rejected";
      rejectionReason: string;
    }>;

export type ReconciliationRequired = Readonly<{
  clientOrderId: string;
  status: "reconciliationRequired";
  reason: string;
}>;

export type SubmitOrderResult = OrderAcknowledgement | ReconciliationRequired;

export type OrderStatus =
  | "pending"
  | "partiallyFilled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "reconciliationRequired";

export type Fill = Readonly<{
  fillId: string;
  brokerOrderId: string;
  quantity: number;
  priceMinor: number;
  feeMinor: number;
  timestamp: string;
}>;

export type OrderStatusSnapshot = Readonly<{
  clientOrderId: string;
  brokerOrderId: string;
  status: OrderStatus;
  fills: readonly Fill[];
}>;

export type ReconciliationResult =
  | Readonly<{
      outcome: "orderFound";
      clientOrderId: string;
      order: OrderStatusSnapshot;
    }>
  | Readonly<{
      outcome: "notFound";
      clientOrderId: string;
    }>
  | Readonly<{
      outcome: "unknown";
      clientOrderId: string;
      reason: string;
    }>;

/** Kept as a descriptive alias for callers that already use this name. */
export type OrderReconciliationResult = ReconciliationResult;

export type CancelResult =
  | Readonly<{
      outcome: "cancelled";
      clientOrderId: string;
      brokerOrderId: string;
    }>
  | Readonly<{
      outcome: "pending";
      clientOrderId: string;
      brokerOrderId: string;
    }>
  | Readonly<{
      outcome: "notCancelled";
      clientOrderId: string;
      brokerOrderId?: string;
      orderStatus?: OrderStatus;
      reason: string;
    }>
  | Readonly<{
      outcome: "reconciliationRequired";
      clientOrderId: string;
      reason: string;
    }>;

export class ClientOrderIdConflictError extends Error {
  constructor(clientOrderId: string) {
    super(`clientOrderId "${clientOrderId}" was already used with a different intent`);
    this.name = "ClientOrderIdConflictError";
  }
}

export class FillIdentityConflictError extends Error {
  constructor(fillId: string) {
    super(`fillId "${fillId}" was reused with different fill evidence`);
    this.name = "FillIdentityConflictError";
  }
}

export interface ExecutionGateway {
  /**
   * Submit one logical order. clientOrderId is its idempotency authority: an
   * identical retry refers to the same logical order, while a conflicting
   * intent must throw ClientOrderIdConflictError. An unclear outcome must be
   * returned as reconciliationRequired and must not trigger an automatic
   * retry or a new logical intent.
   */
  submit(intent: OrderIntent): Promise<SubmitOrderResult>;

  /** Request cancellation; only outcome "cancelled" confirms cancellation. */
  cancel(clientOrderId: string): Promise<CancelResult>;

  /** Query status and reconcile an order, including a previously unclear submit. */
  reconcile(clientOrderId: string): Promise<ReconciliationResult>;
}

/** Validate fields whose invalid values would make order identity unsafe. */
export function assertValidOrderIntent(intent: OrderIntent): void {
  if (intent.clientOrderId.trim().length === 0) {
    throw new TypeError("clientOrderId must not be empty");
  }
  if (intent.symbol.trim().length === 0) {
    throw new TypeError("symbol must not be empty");
  }
  if (intent.side !== "buy" && intent.side !== "sell") {
    throw new TypeError("side must be buy or sell");
  }
  if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) {
    throw new TypeError("quantity must be a finite number greater than zero");
  }
  if (Number.isNaN(Date.parse(intent.createdAt))) {
    throw new TypeError("createdAt must be a parseable timestamp");
  }
  if (intent.orderType === "market" && "limitPriceMinor" in intent) {
    throw new TypeError("market orders must not include limitPriceMinor");
  }
  if (
    intent.orderType === "limit" &&
    (!Number.isSafeInteger(intent.limitPriceMinor) || intent.limitPriceMinor <= 0)
  ) {
    throw new TypeError("limitPriceMinor must be a positive safe integer");
  }
}

/** Compare every field in the provider-neutral intent contract. */
export function sameOrderIntent(left: OrderIntent, right: OrderIntent): boolean {
  return (
    left.clientOrderId === right.clientOrderId &&
    left.symbol === right.symbol &&
    left.side === right.side &&
    left.quantity === right.quantity &&
    left.orderType === right.orderType &&
    left.limitPriceMinor === right.limitPriceMinor &&
    left.createdAt === right.createdAt &&
    left.strategyVersion === right.strategyVersion &&
    left.decisionRef === right.decisionRef
  );
}

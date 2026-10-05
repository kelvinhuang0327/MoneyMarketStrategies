import type {
  CancelResult,
  ExecutionGateway,
  OrderReconciliationResult,
} from "./index.js";

type AppliedResult =
  | Readonly<{ status: "accepted" | "duplicate" }>
  | Readonly<{ status: "stale" | "rejected"; reasonCode: string }>;

type ExternalOrderStatus = "pending" | "partiallyFilled" | "filled" | "cancelled" | "rejected";

type CancelRequest = Readonly<{
  eventId: string;
  timestamp: number;
  clientOrderId: string;
}>;

type ExternalOrderReconciliation = Readonly<{
  eventId: string;
  timestamp: number;
  clientOrderId: string;
}> & (
  | Readonly<{ outcome: "unknown" | "notFound" }>
  | Readonly<{
      outcome: "orderFound";
      externalOrderId: string;
      orderStatus: ExternalOrderStatus;
    }>
);

type ExternalExecutionReport = Readonly<{
  fillId: string;
  clientOrderId: string;
  externalOrderId: string;
  timestamp: number;
  quantity: number;
  executionPriceMinor: bigint;
  feeMinor: bigint;
}>;

/** Minimal durable-session surface needed by the cancellation/fill contract. */
export interface DurableGatewayOrderSession {
  requestExternalCancel(request: CancelRequest): Promise<AppliedResult>;
  acceptExecutionReport(report: ExternalExecutionReport): Promise<AppliedResult>;
  recordExternalReconciliation(reconciliation: ExternalOrderReconciliation): Promise<AppliedResult>;
}

export class GatewayEvidenceApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayEvidenceApplyError";
  }
}

export interface GatewayReconciliationReceipt {
  readonly gatewayResult: OrderReconciliationResult;
  readonly appliedOutcome: "unknown" | "notFound" | "orderFound";
  readonly fillResults: readonly AppliedResult[];
  readonly lifecycleResult: AppliedResult;
}

/**
 * Persist every observed gateway fill before recording the reconciled order
 * state. Unknown leaves the paper order and its reserve unresolved; notFound
 * is recorded as absence unless this cancel call already returned an external
 * order ID, in which case a contradictory notFound is downgraded to unknown.
 */
export async function reconcileGatewayOrder(input: {
  readonly gateway: ExecutionGateway;
  readonly session: DurableGatewayOrderSession;
  readonly clientOrderId: string;
  readonly reconciliationEventId: string;
  readonly reconciliationTimestamp: number;
  readonly expectedExternalOrderId?: string;
}): Promise<GatewayReconciliationReceipt> {
  const result = await input.gateway.reconcile(input.clientOrderId);
  if (result.clientOrderId !== input.clientOrderId) {
    throw new GatewayEvidenceApplyError("gateway reconciliation returned a different clientOrderId");
  }

  if (result.outcome === "unknown" || result.outcome === "notFound") {
    const appliedOutcome = result.outcome === "notFound" && input.expectedExternalOrderId !== undefined
      ? "unknown"
      : result.outcome;
    const lifecycleResult = await input.session.recordExternalReconciliation({
      eventId: input.reconciliationEventId,
      timestamp: input.reconciliationTimestamp,
      clientOrderId: input.clientOrderId,
      outcome: appliedOutcome,
    });
    assertApplied(lifecycleResult, `gateway reconciliation ${appliedOutcome}`);
    return { gatewayResult: result, appliedOutcome, fillResults: [], lifecycleResult };
  }

  if (result.order.clientOrderId !== input.clientOrderId || result.order.brokerOrderId.trim() === "") {
    throw new GatewayEvidenceApplyError("gateway order evidence has an invalid order identity");
  }
  if (input.expectedExternalOrderId !== undefined && result.order.brokerOrderId !== input.expectedExternalOrderId) {
    throw new GatewayEvidenceApplyError("gateway reconciliation returned a different external order identity");
  }

  const fillResults: AppliedResult[] = [];
  for (const fill of result.order.fills) {
    if (fill.brokerOrderId !== result.order.brokerOrderId) {
      throw new GatewayEvidenceApplyError(`fill ${fill.fillId} does not match the reconciled external order`);
    }
    const timestamp = Date.parse(fill.timestamp);
    if (!Number.isSafeInteger(timestamp)
      || !Number.isSafeInteger(fill.quantity) || fill.quantity <= 0
      || !Number.isSafeInteger(fill.priceMinor) || fill.priceMinor <= 0
      || !Number.isSafeInteger(fill.feeMinor) || fill.feeMinor < 0) {
      throw new GatewayEvidenceApplyError(`fill ${fill.fillId} contains invalid external evidence`);
    }
    const applied = await input.session.acceptExecutionReport({
      fillId: fill.fillId,
      clientOrderId: input.clientOrderId,
      externalOrderId: fill.brokerOrderId,
      timestamp,
      quantity: fill.quantity,
      executionPriceMinor: BigInt(fill.priceMinor),
      feeMinor: BigInt(fill.feeMinor),
    });
    assertApplied(applied, `fill ${fill.fillId}`);
    fillResults.push(applied);
  }

  const lifecycleResult = await input.session.recordExternalReconciliation({
    eventId: input.reconciliationEventId,
    timestamp: input.reconciliationTimestamp,
    clientOrderId: input.clientOrderId,
    outcome: "orderFound",
    externalOrderId: result.order.brokerOrderId,
    orderStatus: result.order.status,
  });
  assertApplied(lifecycleResult, "gateway order status");
  return { gatewayResult: result, appliedOutcome: "orderFound", fillResults, lifecycleResult };
}

/** Persist cancel intent before the gateway call, then reconcile regardless of the cancel response. */
export async function cancelAndReconcileGatewayOrder(input: {
  readonly gateway: ExecutionGateway;
  readonly session: DurableGatewayOrderSession;
  readonly cancelRequest: CancelRequest;
  readonly reconciliationEventId: string;
  readonly reconciliationTimestamp: number;
}): Promise<{
  readonly cancelResult: CancelResult;
  readonly reconciliation: GatewayReconciliationReceipt;
}> {
  const requestResult = await input.session.requestExternalCancel(input.cancelRequest);
  assertApplied(requestResult, "cancel request");

  const cancelResult = await input.gateway.cancel(input.cancelRequest.clientOrderId);
  if (cancelResult.clientOrderId !== input.cancelRequest.clientOrderId) {
    throw new GatewayEvidenceApplyError("gateway cancel returned a different clientOrderId");
  }

  const expectedExternalOrderId = cancelResult.outcome === "cancelled"
    || cancelResult.outcome === "pending"
    || cancelResult.outcome === "notCancelled"
    ? cancelResult.brokerOrderId
    : undefined;
  const reconciliation = await reconcileGatewayOrder({
    gateway: input.gateway,
    session: input.session,
    clientOrderId: input.cancelRequest.clientOrderId,
    reconciliationEventId: input.reconciliationEventId,
    reconciliationTimestamp: input.reconciliationTimestamp,
    ...(expectedExternalOrderId === undefined ? {} : { expectedExternalOrderId }),
  });
  return { cancelResult, reconciliation };
}

function assertApplied(result: AppliedResult, label: string): void {
  if (result.status === "stale" || result.status === "rejected") {
    throw new GatewayEvidenceApplyError(`${label} was not durably applied: ${result.reasonCode}`);
  }
}

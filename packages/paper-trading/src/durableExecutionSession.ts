import type {
  ExecutionGateway,
  Fill,
  OrderIntent,
  OrderStatusSnapshot,
} from "@mms/execution-gateway";
import { DurablePaperTradingSession, PaperJournalError } from "./durablePaperSession.js";
import type {
  AccountSnapshot,
  ExecutionReport,
  MarketEvent,
  OperationResult,
  PaperOrder,
  PaperTradingEngineConfig,
  SimulationEvent,
} from "./types.js";

export type GatewayRecoveryState =
  | { readonly status: "ready" }
  | {
      readonly status: "waitingForMarketEvent";
      readonly clientOrderId: string;
      readonly timestamp: number;
    }
  | {
      readonly status: "reconciliationRequired";
      readonly clientOrderId: string;
      readonly reason: string;
    };

type UnreadyGatewayRecovery = Exclude<GatewayRecoveryState, { readonly status: "ready" }>;

export type DurableGatewayMarketResult =
  | { readonly status: "notProcessed"; readonly recovery: UnreadyGatewayRecovery }
  | {
      readonly status: "processed";
      readonly operation: OperationResult;
      readonly recovery: GatewayRecoveryState;
    };

function noLocalFill(): { readonly kind: "no-fill" } {
  return { kind: "no-fill" };
}

function isOpenOrder(order: PaperOrder): boolean {
  return order.status === "pending" || order.status === "partially-filled";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderIntent(order: PaperOrder): OrderIntent {
  return Object.freeze({
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    orderType: "market",
    createdAt: new Date(order.createdAt).toISOString(),
    decisionRef: order.createdEventId,
  });
}

function sameFillEvidence(left: Fill, right: Fill): boolean {
  return left.fillId === right.fillId
    && left.brokerOrderId === right.brokerOrderId
    && left.quantity === right.quantity
    && left.priceMinor === right.priceMinor
    && left.feeMinor === right.feeMinor
    && left.timestamp === right.timestamp;
}

function isMarketEvent(event: SimulationEvent): event is Extract<SimulationEvent, { readonly kind: "market" }> {
  return event.kind === "market";
}

/**
 * Coordinates durable paper orders with an execution gateway. The paper journal
 * commits the order event and clientOrderId before this class can submit it.
 */
export class DurableGatewayPaperSession {
  private operationPending = false;

  private constructor(
    private readonly paper: DurablePaperTradingSession,
    private readonly gateway: ExecutionGateway,
  ) {}

  /**
   * Opens the existing durable paper journal in gateway-driven mode. The no-fill
   * rule prevents the local simulator from inventing fills; gateway evidence is
   * applied through DurablePaperTradingSession.acceptExecutionReport instead.
   */
  static async open(
    config: PaperTradingEngineConfig,
    journalPath: string,
    gateway: ExecutionGateway,
  ): Promise<DurableGatewayPaperSession> {
    const paper = await DurablePaperTradingSession.open(
      { ...config, fillRule: noLocalFill },
      journalPath,
    );
    const session = new DurableGatewayPaperSession(paper, gateway);
    await session.reconcile();
    return session;
  }

  getSnapshot(): AccountSnapshot {
    return this.paper.getSnapshot();
  }

  getOrders(): readonly PaperOrder[] {
    return this.paper.getOrders();
  }

  getFills(): readonly ExecutionReport[] {
    return this.paper.getFills();
  }

  getEvents(): readonly SimulationEvent[] {
    return this.paper.getEvents();
  }

  getJournalSequence(): number {
    return this.paper.getJournalSequence();
  }

  /** Reconcile every durable open order before accepting more market input. */
  async reconcile(): Promise<GatewayRecoveryState> {
    return this.exclusive(() => this.reconcileInternal());
  }

  /**
   * A new market event is held while an order outcome is unknown. A future fill
   * may advance only through its matching durable market event, so the ledger
   * never guesses a market price or applies a fill against a later mark.
   */
  async processMarketEvent(event: MarketEvent): Promise<DurableGatewayMarketResult> {
    return this.exclusive(async () => {
      const before = await this.reconcileInternal();
      if (before.status === "reconciliationRequired") {
        return { status: "notProcessed", recovery: before };
      }
      if (before.status === "waitingForMarketEvent" && event.timestamp > before.timestamp) {
        return { status: "notProcessed", recovery: before };
      }

      // This await must succeed before reconcileInternal can submit any order.
      const operation = await this.paper.processMarketEvent(event);
      const recovery = await this.reconcileInternal();
      return { status: "processed", operation, recovery };
    });
  }

  close(): void {
    if (this.operationPending) throw new PaperJournalError("cannot close while gateway recovery is in progress");
    this.paper.close();
  }

  private async reconcileInternal(): Promise<GatewayRecoveryState> {
    const orders = this.paper.getOrders().filter(isOpenOrder);
    for (const order of orders) {
      let result;
      try {
        result = await this.gateway.reconcile(order.clientOrderId);
      } catch (error) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: `gateway reconciliation failed: ${errorMessage(error)}`,
        };
      }

      if (result.clientOrderId !== order.clientOrderId) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: "gateway reconciliation returned a different clientOrderId",
        };
      }
      if (result.outcome === "unknown") {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: result.reason,
        };
      }
      if (result.outcome === "notFound") {
        if (order.filledQuantity !== 0) {
          return {
            status: "reconciliationRequired",
            clientOrderId: order.clientOrderId,
            reason: "gateway reports absence for an order with durable fills",
          };
        }
        const submission = await this.submitAbsentOrder(order);
        if (submission.status !== "ready") return submission;
        continue;
      }

      if (result.order.clientOrderId !== order.clientOrderId) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: "gateway order snapshot returned a different clientOrderId",
        };
      }
      const applied = await this.applyOrderSnapshot(order, result.order);
      if (applied.status !== "ready") return applied;
    }
    return { status: "ready" };
  }

  private async submitAbsentOrder(order: PaperOrder): Promise<GatewayRecoveryState> {
    let result;
    try {
      // The intent is reconstructed from the journaled PaperOrder, retaining its
      // original clientOrderId and fields on every safe retry.
      result = await this.gateway.submit(orderIntent(order));
    } catch (error) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: `gateway submission outcome is unknown: ${errorMessage(error)}`,
      };
    }
    if (result.clientOrderId !== order.clientOrderId) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway submit returned a different clientOrderId",
      };
    }
    if (result.status === "reconciliationRequired") {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: result.reason,
      };
    }
    if (result.status === "accepted") {
      if (!isNonEmptyString(result.brokerOrderId)) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: "gateway acknowledgement omitted brokerOrderId",
        };
      }
      return { status: "ready" };
    }

    const cancelled = await this.cancelLocalTerminalOrder(order.clientOrderId, "submit-rejected");
    return cancelled ? { status: "ready" } : {
      status: "reconciliationRequired",
      clientOrderId: order.clientOrderId,
      reason: "gateway rejected the order but the local terminal state was not committed",
    };
  }

  private async applyOrderSnapshot(
    order: PaperOrder,
    snapshot: OrderStatusSnapshot,
  ): Promise<GatewayRecoveryState> {
    if (!isNonEmptyString(snapshot.brokerOrderId)) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway order snapshot omitted brokerOrderId",
      };
    }
    if (snapshot.status === "reconciliationRequired") {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway order remains under reconciliation",
      };
    }

    const uniqueFills = new Map<string, Fill>();
    for (const fill of snapshot.fills) {
      if (!isNonEmptyString(fill.fillId) || fill.brokerOrderId !== snapshot.brokerOrderId
        || !Number.isSafeInteger(fill.quantity) || fill.quantity <= 0
        || !Number.isSafeInteger(fill.priceMinor) || fill.priceMinor <= 0
        || !Number.isSafeInteger(fill.feeMinor) || fill.feeMinor < 0
        || !Number.isSafeInteger(Date.parse(fill.timestamp))) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: "gateway returned invalid fill evidence",
        };
      }
      const previous = uniqueFills.get(fill.fillId);
      if (previous !== undefined && !sameFillEvidence(previous, fill)) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: `gateway reused fillId ${fill.fillId} with conflicting evidence`,
        };
      }
      uniqueFills.set(fill.fillId, fill);
    }

    const orderedFills = [...uniqueFills.values()].sort((left, right) => {
      return Date.parse(left.timestamp) - Date.parse(right.timestamp);
    });
    const totalFillQuantity = orderedFills.reduce((total, fill) => total + fill.quantity, 0);
    if (!Number.isSafeInteger(totalFillQuantity) || totalFillQuantity > order.quantity) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway fills exceed the durable order quantity",
      };
    }
    if (order.filledQuantity > totalFillQuantity) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway snapshot omits a previously journaled fill",
      };
    }
    if (snapshot.status === "pending" && totalFillQuantity !== 0
      || snapshot.status === "partiallyFilled" && (totalFillQuantity === 0 || totalFillQuantity >= order.quantity)
      || snapshot.status === "filled" && totalFillQuantity !== order.quantity) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway order status conflicts with its fill evidence",
      };
    }

    for (const fill of orderedFills) {
      const timestamp = Date.parse(fill.timestamp);
      const durableFill = this.paper.getFills().find((candidate) => candidate.fillId === fill.fillId);
      if (durableFill !== undefined) {
        if (durableFill.clientOrderId !== order.clientOrderId
          || durableFill.timestamp !== timestamp
          || durableFill.quantity !== fill.quantity
          || durableFill.executionPriceMinor !== BigInt(fill.priceMinor)
          || durableFill.feeMinor !== BigInt(fill.feeMinor)) {
          return {
            status: "reconciliationRequired",
            clientOrderId: order.clientOrderId,
            reason: `gateway fillId ${fill.fillId} conflicts with the durable ledger`,
          };
        }
        continue;
      }

      const marketResult = this.marketForFill(order, fill, timestamp);
      if (marketResult.status !== "ready") return marketResult;
      const currentOrder = this.paper.getOrders().find((candidate) => candidate.clientOrderId === order.clientOrderId);
      if (currentOrder === undefined || !isOpenOrder(currentOrder)
        || fill.quantity > currentOrder.remainingQuantity || timestamp <= currentOrder.createdAt) {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: `gateway fill ${fill.fillId} does not match an active durable order`,
        };
      }
      const outcome = await this.paper.acceptExecutionReport({
        fillId: fill.fillId,
        clientOrderId: order.clientOrderId,
        marketEventId: marketResult.marketEventId,
        timestamp,
        quantity: fill.quantity,
        executionPriceMinor: BigInt(fill.priceMinor),
        feeMinor: BigInt(fill.feeMinor),
      });
      if (outcome.status === "rejected") {
        return {
          status: "reconciliationRequired",
          clientOrderId: order.clientOrderId,
          reason: `durable ledger rejected gateway fill ${fill.fillId}: ${outcome.reasonCode}`,
        };
      }
    }

    const currentOrder = this.paper.getOrders().find((candidate) => candidate.clientOrderId === order.clientOrderId);
    if (currentOrder === undefined) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "durable order disappeared during reconciliation",
      };
    }
    if (snapshot.status === "cancelled" || snapshot.status === "rejected") {
      if (isOpenOrder(currentOrder)) {
        const cancelled = await this.cancelLocalTerminalOrder(order.clientOrderId, snapshot.status);
        if (!cancelled) {
          return {
            status: "reconciliationRequired",
            clientOrderId: order.clientOrderId,
            reason: "gateway terminal status was observed but not committed to the local journal",
          };
        }
      }
    } else if (snapshot.status === "filled" && currentOrder.status !== "filled") {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "gateway reports a filled order without a complete durable fill ledger",
      };
    }
    return { status: "ready" };
  }

  private marketForFill(
    order: PaperOrder,
    fill: Fill,
    timestamp: number,
  ): { readonly status: "ready"; readonly marketEventId: string }
    | Extract<GatewayRecoveryState, { readonly status: "waitingForMarketEvent" | "reconciliationRequired" }> {
    const events = this.paper.getEvents();
    const atTimestamp = events.find((event) => isMarketEvent(event) && event.timestamp === timestamp);
    if (atTimestamp?.kind === "market" && atTimestamp.status === "stale") {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: `gateway fill ${fill.fillId} refers to a stale market event`,
      };
    }
    const currentMarket = [...events].reverse().find((event) => isMarketEvent(event) && event.status === "fresh");
    if (currentMarket === undefined) {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: "durable journal has no fresh market event for gateway fill evidence",
      };
    }
    if (timestamp > currentMarket.timestamp) {
      return { status: "waitingForMarketEvent", clientOrderId: order.clientOrderId, timestamp };
    }
    if (timestamp < currentMarket.timestamp || atTimestamp?.kind !== "market" || atTimestamp.status !== "fresh") {
      return {
        status: "reconciliationRequired",
        clientOrderId: order.clientOrderId,
        reason: `gateway fill ${fill.fillId} has no matching current market event`,
      };
    }
    return { status: "ready", marketEventId: atTimestamp.sourceEventId };
  }

  private async cancelLocalTerminalOrder(clientOrderId: string, reason: string): Promise<boolean> {
    const order = this.paper.getOrders().find((candidate) => candidate.clientOrderId === clientOrderId);
    if (order === undefined || !isOpenOrder(order)) return true;
    const latestMarketEvent = [...this.paper.getEvents()].reverse().find(isMarketEvent);
    if (latestMarketEvent === undefined) return false;
    const result = await this.paper.cancelOrder({
      eventId: `execution-gateway/${reason}/${encodeURIComponent(clientOrderId)}`,
      timestamp: latestMarketEvent.timestamp,
      clientOrderId,
    });
    return result.status === "accepted" || result.status === "duplicate";
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationPending) throw new PaperJournalError("a gateway session operation is already in progress");
    this.operationPending = true;
    try {
      return await operation();
    } finally {
      this.operationPending = false;
    }
  }
}

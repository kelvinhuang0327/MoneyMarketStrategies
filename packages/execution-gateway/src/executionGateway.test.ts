import { describe, expect, it } from "vitest";

import {
  assertValidOrderIntent,
  ClientOrderIdConflictError,
  FillIdentityConflictError,
  sameOrderIntent,
  type CancelResult,
  type ExecutionGateway,
  type Fill,
  type OrderIntent,
  type OrderStatus,
  type OrderStatusSnapshot,
  type SubmitOrderResult,
} from "./index.js";

type PlannedSubmitOutcome =
  | "accept"
  | "reject"
  | "timeoutAfterAccept"
  | "timeoutWithoutOrder"
  | "unknownOnReconcile";

type FakeOrder = {
  intent: OrderIntent;
  brokerOrderId: string;
  cancelled: boolean;
  fills: Map<string, Fill>;
};

type FakeSubmission = {
  intent: OrderIntent;
  result: SubmitOrderResult;
  reconciledNotFound: boolean;
  reconciliationRemainsUnknown: boolean;
};

/** Test-only in-memory evidence source. It has no transport or external state. */
class InMemoryFakeGateway implements ExecutionGateway {
  private readonly submissions = new Map<string, FakeSubmission>();
  private readonly orders = new Map<string, FakeOrder>();
  private readonly fillsById = new Map<string, Fill>();
  private readonly plannedOutcomes = new Map<string, PlannedSubmitOutcome[]>();
  private requestCount = 0;
  private orderSequence = 0;

  planNextSubmit(clientOrderId: string, outcome: PlannedSubmitOutcome): void {
    const outcomes = this.plannedOutcomes.get(clientOrderId) ?? [];
    outcomes.push(outcome);
    this.plannedOutcomes.set(clientOrderId, outcomes);
  }

  get submitRequestCount(): number {
    return this.requestCount;
  }

  get brokerOrderCount(): number {
    return this.orders.size;
  }

  get logicalIntentCount(): number {
    return this.submissions.size;
  }

  async submit(intent: OrderIntent): Promise<SubmitOrderResult> {
    assertValidOrderIntent(intent);
    const previous = this.submissions.get(intent.clientOrderId);
    if (previous !== undefined) {
      if (!sameOrderIntent(previous.intent, intent)) {
        throw new ClientOrderIdConflictError(intent.clientOrderId);
      }
      if (
        previous.result.status === "reconciliationRequired" &&
        previous.reconciledNotFound
      ) {
        previous.reconciledNotFound = false;
        const planned = this.takeNextOutcome(intent.clientOrderId);
        previous.reconciliationRemainsUnknown = planned === "unknownOnReconcile";
        previous.result = this.dispatch(intent, planned);
      }
      return previous.result;
    }

    const planned = this.takeNextOutcome(intent.clientOrderId);
    const submission: FakeSubmission = {
      intent: { ...intent },
      result: {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired",
        reason: "submission has not been attempted",
      },
      reconciledNotFound: false,
      reconciliationRemainsUnknown: planned === "unknownOnReconcile",
    };
    this.submissions.set(intent.clientOrderId, submission);
    submission.result = this.dispatch(intent, planned);
    return submission.result;
  }

  async cancel(clientOrderId: string): Promise<CancelResult> {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) {
      return {
        outcome: "reconciliationRequired",
        clientOrderId,
        reason: "order status is not available in the fake evidence store",
      };
    }

    const snapshot = this.snapshot(order);
    if (snapshot.status === "pending" || snapshot.status === "partiallyFilled") {
      order.cancelled = true;
      return {
        outcome: "cancelled",
        clientOrderId,
        brokerOrderId: order.brokerOrderId,
      };
    }
    return {
      outcome: "notCancelled",
      clientOrderId,
      brokerOrderId: order.brokerOrderId,
      orderStatus: snapshot.status,
      reason: `order is already ${snapshot.status}`,
    };
  }

  async reconcile(clientOrderId: string) {
    const submission = this.submissions.get(clientOrderId);
    if (
      submission?.result.status === "reconciliationRequired" &&
      submission.reconciliationRemainsUnknown
    ) {
      return {
        outcome: "unknown" as const,
        clientOrderId,
        reason: "fake evidence remains inconclusive",
      };
    }

    const order = this.orders.get(clientOrderId);
    if (order !== undefined) {
      return {
        outcome: "orderFound" as const,
        clientOrderId,
        order: this.snapshot(order),
      };
    }
    if (submission?.result.status === "reconciliationRequired") {
      submission.reconciledNotFound = true;
    }
    return { outcome: "notFound" as const, clientOrderId };
  }

  addFill(clientOrderId: string, fill: Fill): void {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) {
      throw new Error(`cannot add fill without fake order evidence for ${clientOrderId}`);
    }
    if (fill.brokerOrderId !== order.brokerOrderId) {
      throw new Error("fill brokerOrderId does not match the fake order evidence");
    }
    if (
      fill.fillId.trim().length === 0 ||
      !Number.isFinite(fill.quantity) ||
      fill.quantity <= 0 ||
      !Number.isSafeInteger(fill.priceMinor) ||
      fill.priceMinor <= 0 ||
      !Number.isSafeInteger(fill.feeMinor) ||
      fill.feeMinor < 0 ||
      Number.isNaN(Date.parse(fill.timestamp))
    ) {
      throw new TypeError("fill evidence contains an invalid amount or timestamp");
    }

    const previous = this.fillsById.get(fill.fillId);
    if (previous !== undefined) {
      if (!sameFill(previous, fill)) {
        throw new FillIdentityConflictError(fill.fillId);
      }
      return;
    }
    const evidence = { ...fill };
    order.fills.set(fill.fillId, evidence);
    this.fillsById.set(fill.fillId, evidence);
  }

  private takeNextOutcome(clientOrderId: string): PlannedSubmitOutcome {
    const outcomes = this.plannedOutcomes.get(clientOrderId) ?? [];
    const planned = outcomes.shift() ?? "accept";
    this.plannedOutcomes.set(clientOrderId, outcomes);
    return planned;
  }

  private dispatch(
    intent: OrderIntent,
    planned: PlannedSubmitOutcome,
  ): SubmitOrderResult {
    this.requestCount += 1;
    if (planned === "reject") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "rejected",
        rejectionReason: "fake gateway rejection",
      };
    }
    if (planned === "timeoutWithoutOrder" || planned === "unknownOnReconcile") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired",
        reason: "request timed out before an outcome was known",
      };
    }

    this.orderSequence += 1;
    const order: FakeOrder = {
      intent: { ...intent },
      brokerOrderId: `fake-order-${this.orderSequence}`,
      cancelled: false,
      fills: new Map(),
    };
    this.orders.set(intent.clientOrderId, order);
    if (planned === "timeoutAfterAccept") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired",
        reason: "request timed out after fake order evidence was created",
      };
    }
    return {
      clientOrderId: intent.clientOrderId,
      brokerOrderId: order.brokerOrderId,
      status: "accepted",
    };
  }

  private snapshot(order: FakeOrder): OrderStatusSnapshot {
    const filledQuantity = [...order.fills.values()].reduce(
      (total, fill) => total + fill.quantity,
      0,
    );
    const status: OrderStatus = order.cancelled
      ? "cancelled"
      : filledQuantity >= order.intent.quantity
        ? "filled"
        : filledQuantity > 0
          ? "partiallyFilled"
          : "pending";
    return {
      clientOrderId: order.intent.clientOrderId,
      brokerOrderId: order.brokerOrderId,
      status,
      fills: [...order.fills.values()].map((fill) => ({ ...fill })),
    };
  }
}

function sameFill(left: Fill, right: Fill): boolean {
  return (
    left.fillId === right.fillId &&
    left.brokerOrderId === right.brokerOrderId &&
    left.quantity === right.quantity &&
    left.priceMinor === right.priceMinor &&
    left.feeMinor === right.feeMinor &&
    left.timestamp === right.timestamp
  );
}

function marketIntent(clientOrderId = "client-1"): OrderIntent {
  return {
    clientOrderId,
    symbol: "TEST",
    side: "buy",
    quantity: 3,
    orderType: "market",
    createdAt: "2026-10-01T01:00:00.000Z",
    strategyVersion: "strategy-v1",
    decisionRef: "decision-1",
  };
}

function fill(
  brokerOrderId: string,
  fillId: string,
  quantity: number,
  priceMinor = 1_000,
): Fill {
  return {
    fillId,
    brokerOrderId,
    quantity,
    priceMinor,
    feeMinor: 2,
    timestamp: "2026-10-01T01:01:00.000Z",
  };
}

describe("execution gateway contract", () => {
  it("accepts an order with a broker acknowledgement", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent();

    await expect(gateway.submit(intent)).resolves.toEqual({
      clientOrderId: intent.clientOrderId,
      brokerOrderId: "fake-order-1",
      status: "accepted",
    });
  });

  it("represents rejection with a reason", async () => {
    const gateway = new InMemoryFakeGateway();
    gateway.planNextSubmit("client-rejected", "reject");

    await expect(gateway.submit(marketIntent("client-rejected"))).resolves.toEqual({
      clientOrderId: "client-rejected",
      status: "rejected",
      rejectionReason: "fake gateway rejection",
    });
  });

  it("reports pending, partial, and full status only as fill evidence arrives", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-fill-progress");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") {
      throw new Error("expected accepted acknowledgement");
    }

    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "pending", fills: [] },
    });

    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-1", 1));
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "partiallyFilled", fills: [{ fillId: "fill-1", quantity: 1 }] },
    });

    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-2", 2));
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: {
        status: "filled",
        fills: [
          { fillId: "fill-1", quantity: 1 },
          { fillId: "fill-2", quantity: 2 },
        ],
      },
    });
  });

  it("confirms cancellation and retains earlier fill evidence", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-cancel");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") {
      throw new Error("expected accepted acknowledgement");
    }
    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-1", 1));

    await expect(gateway.cancel(intent.clientOrderId)).resolves.toEqual({
      outcome: "cancelled",
      clientOrderId: intent.clientOrderId,
      brokerOrderId: acknowledgement.brokerOrderId,
    });
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "cancelled", fills: [{ fillId: "fill-1" }] },
    });
  });

  it("makes an identical submit retry idempotent", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-idempotent");

    const first = await gateway.submit(intent);
    const retry = await gateway.submit({ ...intent });

    expect(retry).toEqual(first);
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(1);
    expect(gateway.logicalIntentCount).toBe(1);
  });

  it("rejects a conflicting intent that reuses clientOrderId", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-conflict");
    await gateway.submit(intent);

    await expect(
      gateway.submit({ ...intent, quantity: intent.quantity + 1 }),
    ).rejects.toThrow(ClientOrderIdConflictError);
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(1);
  });

  it("returns an unclear timeout on identical retry without submitting again", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-timeout-retry");
    gateway.planNextSubmit(intent.clientOrderId, "timeoutAfterAccept");

    const timedOut = await gateway.submit(intent);
    expect(timedOut).toMatchObject({ status: "reconciliationRequired" });

    await expect(gateway.submit({ ...intent })).resolves.toEqual(timedOut);
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(1);
    expect(gateway.logicalIntentCount).toBe(1);
  });

  it("reconciles a timed-out submit to the existing broker order", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-timeout-found");
    gateway.planNextSubmit(intent.clientOrderId, "timeoutAfterAccept");

    await gateway.submit(intent);
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "pending", brokerOrderId: "fake-order-1", fills: [] },
    });
    expect(gateway.submitRequestCount).toBe(1);
  });

  it("confirms absence without automatically retrying or rejecting the intent", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-timeout-absent");
    gateway.planNextSubmit(intent.clientOrderId, "timeoutWithoutOrder");

    const timedOut = await gateway.submit(intent);
    expect(timedOut.status).toBe("reconciliationRequired");
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toEqual({
      outcome: "notFound",
      clientOrderId: intent.clientOrderId,
    });
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(0);
    expect(gateway.logicalIntentCount).toBe(1);

    const explicitRetry = await gateway.submit(intent);
    expect(explicitRetry.status).toBe("accepted");
    expect(gateway.submitRequestCount).toBe(2);
    expect(gateway.brokerOrderCount).toBe(1);
    expect(gateway.logicalIntentCount).toBe(1);
  });

  it("keeps reconciliation unknown when evidence remains inconclusive", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-still-unknown");
    gateway.planNextSubmit(intent.clientOrderId, "unknownOnReconcile");

    const timedOut = await gateway.submit(intent);
    expect(timedOut.status).toBe("reconciliationRequired");
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "unknown",
      clientOrderId: intent.clientOrderId,
    });
    await expect(gateway.submit(intent)).resolves.toEqual(timedOut);
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(0);
  });

  it("does not count duplicate fillId evidence twice", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-duplicate-fill");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") {
      throw new Error("expected accepted acknowledgement");
    }
    const evidence = fill(acknowledgement.brokerOrderId, "fill-duplicate", 1);
    gateway.addFill(intent.clientOrderId, evidence);
    gateway.addFill(intent.clientOrderId, evidence);

    const result = await gateway.reconcile(intent.clientOrderId);
    expect(result).toMatchObject({
      outcome: "orderFound",
      order: { status: "partiallyFilled", fills: [{ fillId: "fill-duplicate", quantity: 1 }] },
    });
    if (result.outcome !== "orderFound") throw new Error("expected order evidence");
    expect(result.order.fills).toHaveLength(1);
  });

  it("fails when one fillId is reused for conflicting evidence", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-fill-conflict");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") {
      throw new Error("expected accepted acknowledgement");
    }
    gateway.addFill(
      intent.clientOrderId,
      fill(acknowledgement.brokerOrderId, "fill-same-id", 1),
    );

    expect(() =>
      gateway.addFill(
        intent.clientOrderId,
        fill(acknowledgement.brokerOrderId, "fill-same-id", 2),
      ),
    ).toThrow(FillIdentityConflictError);
  });

  it("validates a limit price in minor currency units", () => {
    expect(() =>
      assertValidOrderIntent({
        clientOrderId: "client-limit-invalid",
        symbol: "TEST",
        side: "buy",
        quantity: 1,
        orderType: "limit",
        limitPriceMinor: 1.5,
        createdAt: "2026-10-01T01:00:00.000Z",
      }),
    ).toThrow("limitPriceMinor must be a positive safe integer");
  });

  it("compares the complete order intent including decision references", () => {
    const intent = marketIntent("client-intent-comparison");
    expect(sameOrderIntent(intent, { ...intent })).toBe(true);
    expect(sameOrderIntent(intent, { ...intent, decisionRef: "decision-2" })).toBe(false);
  });
});

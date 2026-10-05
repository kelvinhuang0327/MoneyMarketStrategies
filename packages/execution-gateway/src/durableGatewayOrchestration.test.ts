import { describe, expect, it } from "vitest";

import {
  assertValidOrderIntent,
  ClientOrderIdConflictError,
  FillIdentityConflictError,
  cancelAndReconcileGatewayOrder,
  reconcileGatewayOrder,
  type CancelResult,
  type DurableGatewayOrderSession,
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

type PlannedReconciliationOutcome = "unknown" | "notFound";

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
  unknownOnReconcile: boolean;
};

/** Test-only in-memory evidence source. It has no transport or external state. */
class InMemoryFakeGateway implements ExecutionGateway {
  private readonly submissions = new Map<string, FakeSubmission>();
  private readonly orders = new Map<string, FakeOrder>();
  private readonly plannedOutcomes = new Map<string, PlannedSubmitOutcome[]>();
  private readonly plannedReconciliations = new Map<string, PlannedReconciliationOutcome[]>();
  private requestCount = 0;
  private orderSequence = 0;

  planNextSubmit(clientOrderId: string, outcome: PlannedSubmitOutcome): void {
    const outcomes = this.plannedOutcomes.get(clientOrderId) ?? [];
    outcomes.push(outcome);
    this.plannedOutcomes.set(clientOrderId, outcomes);
  }

  planNextReconciliation(clientOrderId: string, outcome: PlannedReconciliationOutcome): void {
    const outcomes = this.plannedReconciliations.get(clientOrderId) ?? [];
    outcomes.push(outcome);
    this.plannedReconciliations.set(clientOrderId, outcomes);
  }

  get submitRequestCount(): number {
    return this.requestCount;
  }

  get brokerOrderCount(): number {
    return this.orders.size;
  }

  async submit(intent: OrderIntent): Promise<SubmitOrderResult> {
    assertValidOrderIntent(intent);
    const previous = this.submissions.get(intent.clientOrderId);
    if (previous !== undefined) {
      if (!sameIntent(previous.intent, intent)) {
        throw new ClientOrderIdConflictError(intent.clientOrderId);
      }
      if (
        previous.result.status === "reconciliationRequired" &&
        previous.reconciledNotFound
      ) {
        previous.reconciledNotFound = false;
        previous.result = this.dispatch(intent);
      }
      return previous.result;
    }

    const submission: FakeSubmission = {
      intent: { ...intent },
      result: {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired",
        reason: "submission has not been attempted",
      },
      reconciledNotFound: false,
      unknownOnReconcile: false,
    };
    this.submissions.set(intent.clientOrderId, submission);
    submission.result = this.dispatch(intent);
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
    const planned = this.plannedReconciliations.get(clientOrderId)?.shift();
    if (planned === "unknown" || submission?.unknownOnReconcile) {
      return {
        outcome: "unknown" as const,
        clientOrderId,
        reason: "fake evidence remains inconclusive",
      };
    }
    if (planned === "notFound") {
      if (submission?.result.status === "reconciliationRequired") submission.reconciledNotFound = true;
      return { outcome: "notFound" as const, clientOrderId };
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

    const previous = order.fills.get(fill.fillId);
    if (previous !== undefined) {
      if (!sameFill(previous, fill)) {
        throw new FillIdentityConflictError(fill.fillId);
      }
      return;
    }
    order.fills.set(fill.fillId, { ...fill });
  }

  private dispatch(intent: OrderIntent): SubmitOrderResult {
    this.requestCount += 1;
    const outcomes = this.plannedOutcomes.get(intent.clientOrderId) ?? [];
    const planned = outcomes.shift() ?? "accept";
    this.plannedOutcomes.set(intent.clientOrderId, outcomes);

    if (planned === "reject") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "rejected",
        rejectionReason: "fake gateway rejection",
      };
    }
    if (planned === "timeoutWithoutOrder" || planned === "unknownOnReconcile") {
      if (planned === "unknownOnReconcile") {
        const submission = this.submissions.get(intent.clientOrderId);
        if (submission !== undefined) submission.unknownOnReconcile = true;
      }
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

function sameIntent(left: OrderIntent, right: OrderIntent): boolean {
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

  it("keeps an unresolved found-order status unknown rather than releasing exposure", async () => {
    const gateway: ExecutionGateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-unresolved-found");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
    gateway.reconcile = async (clientOrderId) => ({
      outcome: "orderFound" as const,
      clientOrderId,
      order: {
        clientOrderId,
        brokerOrderId: acknowledgement.brokerOrderId,
        status: "reconciliationRequired" as const,
        fills: [],
      },
    });
    const outcomes: string[] = [];
    const session: DurableGatewayOrderSession = {
      requestExternalCancel: async () => ({ status: "accepted" }),
      acceptExecutionReport: async () => { throw new Error("there is no fill evidence"); },
      recordExternalReconciliation: async (value) => {
        outcomes.push(value.outcome);
        return { status: "accepted" };
      },
    };
    const receipt = await reconcileGatewayOrder({
      gateway, session, clientOrderId: intent.clientOrderId,
      reconciliationEventId: "unresolved-order-query", reconciliationTimestamp: 1234,
    });
    expect(receipt.appliedOutcome).toBe("unknown");
    expect(receipt.fillResults).toEqual([]);
    expect(outcomes).toEqual(["unknown"]);
  });

  it("accepts and reports a full fill only with explicit fill evidence", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent();
    const acknowledgement = await gateway.submit(intent);

    expect(acknowledgement).toMatchObject({ status: "accepted", clientOrderId: intent.clientOrderId });
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-1", 3));

    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "filled", fills: [{ fillId: "fill-1", quantity: 3, priceMinor: 1_000 }] },
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

  it("reports partial fills from explicit fill evidence", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-partial");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-1", 1));

    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "partiallyFilled", fills: [{ fillId: "fill-1", quantity: 1 }] },
    });
  });

  it("confirms cancellation and retains earlier fill evidence", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-cancel");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
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

  it("journals cancellation intent before the gateway and keeps cancel acknowledgement separate from reconciliation", async () => {
    const backingGateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-cancel-unknown");
    await backingGateway.submit(intent);
    backingGateway.planNextReconciliation(intent.clientOrderId, "unknown");
    const calls: string[] = [];
    const gateway: ExecutionGateway = {
      submit: (orderIntent) => backingGateway.submit(orderIntent),
      cancel: async (clientOrderId) => {
        calls.push("gateway:cancel");
        return backingGateway.cancel(clientOrderId);
      },
      reconcile: async (clientOrderId) => {
        calls.push("gateway:reconcile");
        return backingGateway.reconcile(clientOrderId);
      },
    };
    const session: DurableGatewayOrderSession = {
      requestExternalCancel: async () => {
        calls.push("session:cancel-request");
        return { status: "accepted" };
      },
      acceptExecutionReport: async () => {
        calls.push("session:fill");
        return { status: "accepted" };
      },
      recordExternalReconciliation: async ({ outcome }) => {
        calls.push(`session:${outcome}`);
        return { status: "accepted" };
      },
    };

    const result = await cancelAndReconcileGatewayOrder({
      gateway,
      session,
      cancelRequest: {
        eventId: "cancel-request-1",
        timestamp: 1_791_834_000_000,
        clientOrderId: intent.clientOrderId,
      },
      reconciliationEventId: "reconcile-1",
      reconciliationTimestamp: 1_791_834_000_001,
    });

    expect(result.cancelResult.outcome).toBe("cancelled");
    expect(result.reconciliation.gatewayResult.outcome).toBe("unknown");
    expect(calls).toEqual([
      "session:cancel-request",
      "gateway:cancel",
      "gateway:reconcile",
      "session:unknown",
    ]);
  });

  it("applies every externally evidenced fill before recording a terminal order state", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-late-fill");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "late-fill-1", 1));
    await gateway.cancel(intent.clientOrderId);
    const calls: string[] = [];
    const session: DurableGatewayOrderSession = {
      requestExternalCancel: async () => ({ status: "accepted" }),
      acceptExecutionReport: async (report) => {
        calls.push(`fill:${report.fillId}`);
        return { status: "accepted" };
      },
      recordExternalReconciliation: async (reconciliation) => {
        calls.push(`state:${reconciliation.outcome}`);
        return { status: "accepted" };
      },
    };

    const result = await reconcileGatewayOrder({
      gateway,
      session,
      clientOrderId: intent.clientOrderId,
      reconciliationEventId: "reconcile-late-fill",
      reconciliationTimestamp: 1_791_834_000_002,
    });

    expect(result.gatewayResult).toMatchObject({
      outcome: "orderFound",
      order: { status: "cancelled", fills: [{ fillId: "late-fill-1" }] },
    });
    expect(calls).toEqual(["fill:late-fill-1", "state:orderFound"]);
    expect(result.fillResults).toMatchObject([{ status: "accepted" }]);
    expect(result.lifecycleResult.status).toBe("accepted");
  });

  it("makes an identical submit retry idempotent", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-idempotent");

    const first = await gateway.submit(intent);
    const retry = await gateway.submit({ ...intent });

    expect(retry).toEqual(first);
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(1);
  });

  it("rejects a conflicting intent that reuses clientOrderId", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-conflict");
    await gateway.submit(intent);

    await expect(gateway.submit({ ...intent, quantity: intent.quantity + 1 })).rejects.toThrow(
      ClientOrderIdConflictError,
    );
    expect(gateway.submitRequestCount).toBe(1);
    expect(gateway.brokerOrderCount).toBe(1);
  });

  it("reconciles a timed-out submit to existing order evidence without retrying", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-timeout-found");
    gateway.planNextSubmit(intent.clientOrderId, "timeoutAfterAccept");

    const timedOut = await gateway.submit(intent);
    expect(timedOut).toMatchObject({ status: "reconciliationRequired", clientOrderId: intent.clientOrderId });
    expect(timedOut.status).not.toBe("rejected");

    const repeated = await gateway.submit(intent);
    expect(repeated).toEqual(timedOut);
    expect(gateway.submitRequestCount).toBe(1);

    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "orderFound",
      order: { status: "pending", brokerOrderId: "fake-order-1", fills: [] },
    });
    expect(gateway.submitRequestCount).toBe(1);
  });

  it("reconciles a timed-out submit to not found without automatic rejection or retry", async () => {
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

    const explicitRetry = await gateway.submit(intent);
    expect(explicitRetry.status).toBe("accepted");
    expect(gateway.submitRequestCount).toBe(2);
    expect(gateway.brokerOrderCount).toBe(1);
  });

  it("keeps reconciliation unknown when evidence is still inconclusive", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-still-unknown");
    gateway.planNextSubmit(intent.clientOrderId, "unknownOnReconcile");

    expect((await gateway.submit(intent)).status).toBe("reconciliationRequired");
    await expect(gateway.reconcile(intent.clientOrderId)).resolves.toMatchObject({
      outcome: "unknown",
      clientOrderId: intent.clientOrderId,
    });
    expect(gateway.submitRequestCount).toBe(1);
  });

  it("does not count duplicate fill evidence as a second logical fill", async () => {
    const gateway = new InMemoryFakeGateway();
    const intent = marketIntent("client-duplicate-fill");
    const acknowledgement = await gateway.submit(intent);
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
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
    if (acknowledgement.status !== "accepted") throw new Error("expected accepted acknowledgement");
    gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-same-id", 1));

    expect(() =>
      gateway.addFill(intent.clientOrderId, fill(acknowledgement.brokerOrderId, "fill-same-id", 2)),
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
});

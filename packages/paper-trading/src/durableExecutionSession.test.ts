import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CancelResult, ExecutionGateway, Fill, OrderIntent } from "@mms/execution-gateway";
import { DurableGatewayPaperSession } from "./durableExecutionSession.js";
import { feeMinorForFill } from "./money.js";
import type {
  Clock,
  MarketEvent,
  PaperTradingEngineConfig,
  SimulatedFillRule,
} from "./types.js";

type SubmitPlan = "accept" | "timeoutAfterAccept" | "timeoutWithoutAccept" | "reject";

interface FakeOrder {
  readonly intent: OrderIntent;
  readonly brokerOrderId: string;
  readonly fills: Map<string, Fill>;
  cancelled: boolean;
}

interface FakeGatewayStore {
  readonly intents: Map<string, OrderIntent>;
  readonly orders: Map<string, FakeOrder>;
  readonly submitAttempts: OrderIntent[];
  readonly submitPlans: SubmitPlan[];
  readonly unknownClientOrderIds: Set<string>;
  readonly reconcileCalls: string[];
  beforeSubmit: ((intent: OrderIntent) => Promise<void> | void) | undefined;
  beforeReconcile: ((clientOrderId: string, callNumber: number) => Promise<void>) | undefined;
}

function fakeGatewayStore(): FakeGatewayStore {
  return {
    intents: new Map(),
    orders: new Map(),
    submitAttempts: [],
    submitPlans: [],
    unknownClientOrderIds: new Set(),
    reconcileCalls: [],
    beforeSubmit: undefined,
    beforeReconcile: undefined,
  };
}

function sameIntent(left: OrderIntent, right: OrderIntent): boolean {
  return left.clientOrderId === right.clientOrderId
    && left.symbol === right.symbol
    && left.side === right.side
    && left.quantity === right.quantity
    && left.orderType === right.orderType
    && left.limitPriceMinor === right.limitPriceMinor
    && left.createdAt === right.createdAt
    && left.strategyVersion === right.strategyVersion
    && left.decisionRef === right.decisionRef;
}

/** External evidence lives in this store, outside each restarted session object. */
class RestartableFakeGateway implements ExecutionGateway {
  constructor(private readonly store: FakeGatewayStore) {}

  async submit(intent: OrderIntent) {
    const prior = this.store.intents.get(intent.clientOrderId);
    if (prior !== undefined && !sameIntent(prior, intent)) {
      throw new Error(`conflicting fake intent for ${intent.clientOrderId}`);
    }
    await this.store.beforeSubmit?.(intent);
    this.store.intents.set(intent.clientOrderId, Object.freeze({ ...intent }));
    this.store.submitAttempts.push(Object.freeze({ ...intent }));

    const plan = this.store.submitPlans.shift() ?? "accept";
    if (plan === "reject") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "rejected" as const,
        rejectionReason: "fake gateway rejection",
      };
    }
    if (plan === "timeoutWithoutAccept") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired" as const,
        reason: "fake response was lost before acceptance",
      };
    }

    let order = this.store.orders.get(intent.clientOrderId);
    if (order === undefined) {
      order = {
        intent: Object.freeze({ ...intent }),
        brokerOrderId: `fake-broker:${intent.clientOrderId}`,
        fills: new Map(),
        cancelled: false,
      };
      this.store.orders.set(intent.clientOrderId, order);
    }
    if (plan === "timeoutAfterAccept") {
      return {
        clientOrderId: intent.clientOrderId,
        status: "reconciliationRequired" as const,
        reason: "fake order was accepted but the response was lost",
      };
    }
    return {
      clientOrderId: intent.clientOrderId,
      brokerOrderId: order.brokerOrderId,
      status: "accepted" as const,
    };
  }

  async cancel(clientOrderId: string): Promise<CancelResult> {
    return {
      outcome: "reconciliationRequired",
      clientOrderId,
      reason: "the integration test does not issue remote cancellations",
    };
  }

  async reconcile(clientOrderId: string) {
    this.store.reconcileCalls.push(clientOrderId);
    await this.store.beforeReconcile?.(clientOrderId, this.store.reconcileCalls.length);
    if (this.store.unknownClientOrderIds.has(clientOrderId)) {
      return { outcome: "unknown" as const, clientOrderId, reason: "fake evidence remains unknown" };
    }
    const order = this.store.orders.get(clientOrderId);
    if (order === undefined) return { outcome: "notFound" as const, clientOrderId };

    const filledQuantity = [...order.fills.values()].reduce((sum, fill) => sum + fill.quantity, 0);
    const status = order.cancelled
      ? "cancelled" as const
      : filledQuantity >= order.intent.quantity
        ? "filled" as const
        : filledQuantity > 0
          ? "partiallyFilled" as const
          : "pending" as const;
    return {
      outcome: "orderFound" as const,
      clientOrderId,
      order: {
        clientOrderId,
        brokerOrderId: order.brokerOrderId,
        status,
        fills: [...order.fills.values()].map((fill) => ({ ...fill })),
      },
    };
  }

  addFill(clientOrderId: string, fill: Fill): void {
    const order = this.store.orders.get(clientOrderId);
    if (order === undefined) throw new Error(`missing fake order ${clientOrderId}`);
    if (fill.brokerOrderId !== order.brokerOrderId) throw new Error("fill brokerOrderId does not match fake order");
    const prior = order.fills.get(fill.fillId);
    if (prior !== undefined && !sameFill(prior, fill)) throw new Error(`conflicting fake fill ${fill.fillId}`);
    order.fills.set(fill.fillId, Object.freeze({ ...fill }));
  }
}

function sameFill(left: Fill, right: Fill): boolean {
  return left.fillId === right.fillId
    && left.brokerOrderId === right.brokerOrderId
    && left.quantity === right.quantity
    && left.priceMinor === right.priceMinor
    && left.feeMinor === right.feeMinor
    && left.timestamp === right.timestamp;
}

interface Harness {
  readonly config: PaperTradingEngineConfig;
  setNow(timestamp: number): void;
}

function harness(): Harness {
  let currentTimestamp = 0;
  const clock: Clock = { now: () => currentTimestamp };
  const fillRule: SimulatedFillRule = () => ({ kind: "no-fill" });
  return {
    config: {
      symbol: "TST",
      initialCashMinor: 100_000n,
      risk: { maxPositionQuantity: 10, maxExposureMinor: 100_000_000n, maxMarketAgeMs: 100_000 },
      terms: { label: "SYNTHETIC_ONLY", feeBps: 100, slippageBps: 0 },
      clock,
      strategy: {
        strategyVersion: "durable-gateway-test-v1",
        strategyParameters: { entryAtOrBelowMinor: 90, targetQuantity: 2 },
        decide: ({ current }) => current.priceMinor <= 90n ? 2 : 0,
      },
      fillRule,
    },
    setNow(timestamp) { currentTimestamp = timestamp; },
  };
}

function quote(eventId: string, timestamp: number, priceMinor: bigint): MarketEvent {
  return { eventId, timestamp, symbol: "TST", priceMinor };
}

function state(session: DurableGatewayPaperSession): unknown {
  return {
    account: session.getSnapshot(),
    orders: session.getOrders(),
    fills: session.getFills(),
    events: session.getEvents(),
  };
}

function fill(brokerOrderId: string, fillId: string, timestamp: number): Fill {
  return {
    fillId,
    brokerOrderId,
    quantity: 1,
    priceMinor: 80,
    feeMinor: Number(feeMinorForFill(80n, 1, 100)),
    timestamp: new Date(timestamp).toISOString(),
  };
}

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mms-gateway-session-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function processQuote(
  session: DurableGatewayPaperSession,
  testHarness: Harness,
  event: MarketEvent,
) {
  testHarness.setNow(event.timestamp);
  return session.processMarketEvent(event);
}

describe("durable paper session with an execution gateway", () => {
  it("reconciles an accepted order after a lost response and restart without resubmitting", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const store = fakeGatewayStore();
      store.submitPlans.push("timeoutAfterAccept");
      const testHarness = harness();
      const first = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      let journalSequenceAtSubmit = 0;
      store.beforeSubmit = () => { journalSequenceAtSubmit = first.getJournalSequence(); };

      const submitted = await processQuote(first, testHarness, quote("entry", 101, 80n));
      expect(submitted).toMatchObject({
        status: "processed",
        operation: { status: "accepted" },
        recovery: { status: "reconciliationRequired" },
      });
      const clientOrderId = first.getOrders()[0]!.clientOrderId;
      expect(journalSequenceAtSubmit).toBeGreaterThan(0);
      expect(store.orders.size).toBe(1);
      expect(store.submitAttempts).toHaveLength(1);
      expect(first.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 162n });
      first.close();

      const resumed = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(resumed.getOrders()[0]!.clientOrderId).toBe(clientOrderId);
      expect(resumed.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 162n });
      expect(resumed.getFills()).toHaveLength(0);
      expect(store.orders.size).toBe(1);
      expect(store.intents.size).toBe(1);
      expect(store.submitAttempts).toHaveLength(1);
      expect(store.reconcileCalls.at(-1)).toBe(clientOrderId);
      resumed.close();
    });
  });

  it("retries an absent intent only with its original logical identity", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const store = fakeGatewayStore();
      store.submitPlans.push("timeoutWithoutAccept", "accept");
      const testHarness = harness();
      const first = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      const result = await processQuote(first, testHarness, quote("entry", 201, 80n));
      expect(result).toMatchObject({ recovery: { status: "reconciliationRequired" } });
      expect(store.orders.size).toBe(0);
      expect(store.submitAttempts).toHaveLength(1);
      const firstIntent = store.submitAttempts[0]!;
      first.close();

      const resumed = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(store.submitAttempts).toHaveLength(2);
      expect(store.submitAttempts[1]!.clientOrderId).toBe(firstIntent.clientOrderId);
      expect(sameIntent(store.submitAttempts[1]!, firstIntent)).toBe(true);
      expect(store.intents.size).toBe(1);
      expect(store.orders.size).toBe(1);
      expect(resumed.getOrders()[0]!.clientOrderId).toBe(firstIntent.clientOrderId);
      resumed.close();
    });
  });

  it("keeps unknown outcomes and risk unresolved without processing another event or inventing fills", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const store = fakeGatewayStore();
      store.submitPlans.push("timeoutAfterAccept");
      const testHarness = harness();
      const first = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      await processQuote(first, testHarness, quote("entry", 301, 80n));
      const clientOrderId = first.getOrders()[0]!.clientOrderId;
      store.unknownClientOrderIds.add(clientOrderId);
      const before = state(first);
      const sequence = first.getJournalSequence();
      first.close();

      const resumed = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(await resumed.reconcile()).toMatchObject({ status: "reconciliationRequired", clientOrderId });
      const blocked = await processQuote(resumed, testHarness, quote("must-wait", 302, 70n));
      expect(blocked).toMatchObject({ status: "notProcessed", recovery: { status: "reconciliationRequired", clientOrderId } });
      expect(resumed.getJournalSequence()).toBe(sequence);
      expect(state(resumed)).toEqual(before);
      expect(resumed.getFills()).toHaveLength(0);
      expect(store.orders.size).toBe(1);
      expect(store.submitAttempts).toHaveLength(1);
      resumed.close();
    });
  });

  it("deduplicates partial fills across restart and matches uninterrupted ledger state", async () => {
    await withTemporaryRoot(async (root) => {
      const store = fakeGatewayStore();
      const testHarness = harness();
      const path = join(root, "restarted-journal");
      let session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      await processQuote(session, testHarness, quote("flat", 400, 100n));
      await processQuote(session, testHarness, quote("entry", 401, 80n));
      const clientOrderId = session.getOrders()[0]!.clientOrderId;
      const brokerOrderId = store.orders.get(clientOrderId)!.brokerOrderId;

      const firstFill = fill(brokerOrderId, "fill-one", 402);
      new RestartableFakeGateway(store).addFill(clientOrderId, firstFill);
      session.close();

      // The provider fill survives while the process/session is absent.
      session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(await session.reconcile()).toMatchObject({ status: "waitingForMarketEvent", timestamp: 402 });
      expect(session.getFills()).toHaveLength(0);
      await processQuote(session, testHarness, quote("fill-one-market", 402, 80n));
      expect(session.getSnapshot()).toMatchObject({ positionQuantity: 1, reservedCashMinor: 81n, feesPaidMinor: 1n });
      expect(session.getFills()).toHaveLength(1);
      const partialSequence = session.getJournalSequence();
      const partialState = state(session);

      // Repeated provider evidence and another restart must not book fill-one twice.
      new RestartableFakeGateway(store).addFill(clientOrderId, firstFill);
      expect(await session.reconcile()).toEqual({ status: "ready" });
      expect(session.getJournalSequence()).toBe(partialSequence);
      session.close();
      session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(state(session)).toEqual(partialState);
      expect(session.getJournalSequence()).toBe(partialSequence);

      const secondFill = fill(brokerOrderId, "fill-two", 403);
      new RestartableFakeGateway(store).addFill(clientOrderId, secondFill);
      await processQuote(session, testHarness, quote("fill-two-market", 403, 80n));
      expect(session.getSnapshot()).toMatchObject({ positionQuantity: 2, reservedCashMinor: 0n, feesPaidMinor: 2n });
      expect(session.getOrders()[0]!.status).toBe("filled");
      expect(session.getFills().map(({ fillId }) => fillId)).toEqual(["fill-one", "fill-two"]);
      const restartedState = state(session);
      session.close();

      const uninterruptedPath = join(root, "uninterrupted-journal");
      const uninterruptedStore = fakeGatewayStore();
      const uninterruptedHarness = harness();
      const uninterrupted = await DurableGatewayPaperSession.open(
        uninterruptedHarness.config,
        uninterruptedPath,
        new RestartableFakeGateway(uninterruptedStore),
      );
      await processQuote(uninterrupted, uninterruptedHarness, quote("flat", 400, 100n));
      await processQuote(uninterrupted, uninterruptedHarness, quote("entry", 401, 80n));
      const uninterruptedOrderId = uninterrupted.getOrders()[0]!.clientOrderId;
      const uninterruptedBrokerId = uninterruptedStore.orders.get(uninterruptedOrderId)!.brokerOrderId;
      const uninterruptedGateway = new RestartableFakeGateway(uninterruptedStore);
      uninterruptedGateway.addFill(uninterruptedOrderId, fill(uninterruptedBrokerId, "fill-one", 402));
      await processQuote(uninterrupted, uninterruptedHarness, quote("fill-one-market", 402, 80n));
      await uninterrupted.reconcile();
      uninterruptedGateway.addFill(uninterruptedOrderId, fill(uninterruptedBrokerId, "fill-two", 403));
      await processQuote(uninterrupted, uninterruptedHarness, quote("fill-two-market", 403, 80n));
      expect(state(uninterrupted)).toEqual(restartedState);
      uninterrupted.close();
    });
  });

  it("does not submit or book a fill when the required journal commit fails", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const store = fakeGatewayStore();
      const testHarness = harness();
      const session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      const eventsDirectory = join(path, "events");
      await rm(eventsDirectory, { recursive: true, force: true });
      await writeFile(eventsDirectory, "blocked", "utf8");

      await expect(processQuote(session, testHarness, quote("cannot-commit", 501, 80n))).rejects.toThrow();
      expect(store.submitAttempts).toHaveLength(0);
      expect(store.orders.size).toBe(0);
      expect(() => session.getSnapshot()).toThrow();
      session.close();
    });
  });

  it("recovers provider fills after a fill-journal write failure without double booking", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const eventsDirectory = join(path, "events");
      const savedEventsDirectory = join(root, "saved-events");
      const store = fakeGatewayStore();
      const testHarness = harness();
      let session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      await processQuote(session, testHarness, quote("flat", 600, 100n));
      await processQuote(session, testHarness, quote("entry", 601, 80n));
      const clientOrderId = session.getOrders()[0]!.clientOrderId;
      const brokerOrderId = store.orders.get(clientOrderId)!.brokerOrderId;
      const providerFill = fill(brokerOrderId, "provider-fill", 602);
      new RestartableFakeGateway(store).addFill(clientOrderId, providerFill);

      let restoredDirectory = false;
      store.beforeReconcile = async (_id, callNumber) => {
        if (callNumber !== 3 || restoredDirectory) return;
        await rename(eventsDirectory, savedEventsDirectory);
        await writeFile(eventsDirectory, "blocked", "utf8");
      };
      await expect(processQuote(session, testHarness, quote("fill-market", 602, 80n))).rejects.toThrow();
      await rm(eventsDirectory, { force: true });
      await rename(savedEventsDirectory, eventsDirectory);
      restoredDirectory = true;
      store.beforeReconcile = undefined;
      expect(() => session.getSnapshot()).toThrow();
      session.close();

      session = await DurableGatewayPaperSession.open(testHarness.config, path, new RestartableFakeGateway(store));
      expect(session.getSnapshot()).toMatchObject({ positionQuantity: 1, reservedCashMinor: 81n, feesPaidMinor: 1n });
      expect(session.getFills().map(({ fillId }) => fillId)).toEqual(["provider-fill"]);
      const sequence = session.getJournalSequence();
      await session.reconcile();
      expect(session.getFills()).toHaveLength(1);
      expect(session.getJournalSequence()).toBe(sequence);
      expect(store.submitAttempts).toHaveLength(1);
      session.close();
    });
  });
});

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurablePaperTradingSession,
  PaperJournalConflictError,
  PaperJournalCorruptError,
} from "./durablePaperSession.js";
import { feeMinorForFill } from "./money.js";
import type {
  Clock,
  PaperStrategy,
  PaperTradingEngineConfig,
  SimulatedFillRule,
} from "./types.js";

interface Harness {
  readonly config: PaperTradingEngineConfig;
  setNow(timestamp: number): void;
}

function harness(options: {
  readonly fillRule?: SimulatedFillRule;
  readonly initialCashMinor?: bigint;
  readonly maxExposureMinor?: bigint;
  readonly strategy?: PaperStrategy;
  readonly feeBps?: number;
} = {}): Harness {
  let currentTimestamp = 0;
  const clock: Clock = { now: () => currentTimestamp };
  const strategy = options.strategy ?? {
    strategyVersion: "durable-test-v1",
    strategyParameters: { entryAtOrBelowMinor: "90", targetQuantity: 2 },
    decide: ({ current }) => current.priceMinor <= 90n ? 2 : 0,
  };
  const config: PaperTradingEngineConfig = {
    symbol: "TST",
    initialCashMinor: options.initialCashMinor ?? 100_000n,
    risk: {
      maxPositionQuantity: 10,
      maxExposureMinor: options.maxExposureMinor ?? 100_000_000n,
      maxMarketAgeMs: 100_000,
    },
    terms: { label: "SYNTHETIC_ONLY", feeBps: options.feeBps ?? 25, slippageBps: 0 },
    clock,
    strategy,
    fillRule: options.fillRule ?? (() => ({ kind: "no-fill" })),
  };
  return { config, setNow: (timestamp) => { currentTimestamp = timestamp; } };
}

function quote(eventId: string, timestamp: number, priceMinor: bigint): {
  readonly eventId: string;
  readonly timestamp: number;
  readonly symbol: string;
  readonly priceMinor: bigint;
} {
  return { eventId, timestamp, symbol: "TST", priceMinor };
}

function state(session: DurablePaperTradingSession): unknown {
  return {
    account: session.getSnapshot(),
    orders: session.getOrders(),
    fills: session.getFills(),
    events: session.getEvents(),
  };
}

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mms-paper-journal-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitMarket(
  session: DurablePaperTradingSession,
  clock: Harness,
  event: ReturnType<typeof quote>,
): Promise<void> {
  clock.setNow(event.timestamp);
  await session.processMarketEvent(event);
}

describe("durable paper trading journal", () => {
  it("replays an uninterrupted account, orders, fills, fees, and realized P&L exactly", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const fillRule: SimulatedFillRule = ({ order, market }) => ({
        kind: "fill",
        fillId: `fill:${market.eventId}`,
        quantity: order.remainingQuantity,
      });
      const originalConfig = harness({ fillRule, feeBps: 37 });
      const original = await DurablePaperTradingSession.open(originalConfig.config, path);
      await commitMarket(original, originalConfig, quote("flat", 0, 100n));
      await commitMarket(original, originalConfig, quote("entry", 1, 80n));
      await commitMarket(original, originalConfig, quote("entry-fill", 2, 80n));
      await commitMarket(original, originalConfig, quote("exit", 3, 100n));
      await commitMarket(original, originalConfig, quote("exit-fill", 4, 100n));
      const expected = state(original);
      expect(original.getSnapshot()).toMatchObject({
        cashMinor: 100_038n,
        reservedCashMinor: 0n,
        positionQuantity: 0,
        feesPaidMinor: 2n,
        realizedPnlMinor: 38n,
        halted: false,
      });
      expect(original.getFills()).toHaveLength(2);
      original.close();

      const resumedConfig = harness({ fillRule, feeBps: 37 });
      resumedConfig.setNow(999);
      const resumed = await DurablePaperTradingSession.open(resumedConfig.config, path);
      expect(state(resumed)).toEqual(expected);
      expect(resumed.getSnapshot().feesPaidMinor).toBeGreaterThan(0n);
      expect(resumed.getSnapshot().realizedPnlMinor).toBeDefined();
      resumed.close();
    });
  });

  it("restores a pending order and its reserved cash", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const firstConfig = harness();
      const first = await DurablePaperTradingSession.open(firstConfig.config, path);
      await commitMarket(first, firstConfig, quote("pending-buy", 10, 80n));
      const expected = state(first);
      expect(first.getSnapshot()).toMatchObject({ positionQuantity: 0, reservedCashMinor: 162n });
      expect(first.getOrders()).toMatchObject([{ status: "pending", remainingQuantity: 2 }]);
      first.close();

      const resumed = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(resumed)).toEqual(expected);
      resumed.close();
    });
  });

  it("restores a partial fill with exact remaining reserve and fill history", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const fillOne: SimulatedFillRule = ({ order, market }) => ({
        kind: "fill",
        fillId: `partial:${market.eventId}`,
        quantity: Math.min(1, order.remainingQuantity),
      });
      const firstConfig = harness({ fillRule: fillOne, feeBps: 100 });
      const first = await DurablePaperTradingSession.open(firstConfig.config, path);
      await commitMarket(first, firstConfig, quote("partial-order", 20, 80n));
      await commitMarket(first, firstConfig, quote("partial-fill", 21, 80n));
      const expected = state(first);
      expect(first.getSnapshot()).toMatchObject({ positionQuantity: 1, reservedCashMinor: 81n, feesPaidMinor: 1n });
      expect(first.getOrders()).toMatchObject([{ status: "partially-filled", filledQuantity: 1, remainingQuantity: 1 }]);
      expect(first.getFills()).toHaveLength(1);
      first.close();

      const resumed = await DurablePaperTradingSession.open(harness({ fillRule: fillOne, feeBps: 100 }).config, path);
      expect(state(resumed)).toEqual(expected);
      resumed.close();
    });
  });

  it("restores HALT and the cancellation of a pending buy remainder", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const firstConfig = harness();
      const first = await DurablePaperTradingSession.open(firstConfig.config, path);
      await commitMarket(first, firstConfig, quote("halt-pending", 30, 80n));
      firstConfig.setNow(30);
      expect(await first.halt({ eventId: "halt-now", timestamp: 30, reason: "operator halt" })).toEqual({ status: "accepted" });
      const expected = state(first);
      expect(first.getSnapshot()).toMatchObject({ halted: true, reservedCashMinor: 0n, activeOrder: null });
      expect(first.getOrders()).toMatchObject([{ status: "cancelled", rejectionReason: "HALTED_CANCELLED_BUY_REMAINDER" }]);
      first.close();

      const resumed = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(resumed)).toEqual(expected);
      resumed.close();
    });
  });

  it("restores explicit cancellation and risk-rejected orders", async () => {
    await withTemporaryRoot(async (root) => {
      const cancelPath = join(root, "cancel-journal");
      const cancelConfig = harness();
      const cancelled = await DurablePaperTradingSession.open(cancelConfig.config, cancelPath);
      await commitMarket(cancelled, cancelConfig, quote("cancel-pending", 40, 80n));
      const clientOrderId = cancelled.getOrders()[0]!.clientOrderId;
      cancelConfig.setNow(40);
      await cancelled.cancelOrder({ eventId: "cancel-order", timestamp: 40, clientOrderId });
      const cancelledState = state(cancelled);
      cancelled.close();
      const cancelledReplay = await DurablePaperTradingSession.open(harness().config, cancelPath);
      expect(state(cancelledReplay)).toEqual(cancelledState);
      cancelledReplay.close();

      const rejectPath = join(root, "reject-journal");
      const rejectConfig = harness({ initialCashMinor: 1n });
      const rejected = await DurablePaperTradingSession.open(rejectConfig.config, rejectPath);
      await commitMarket(rejected, rejectConfig, quote("risk-rejected-order", 50, 80n));
      const rejectedState = state(rejected);
      expect(rejected.getOrders()).toMatchObject([{ status: "rejected", rejectionReason: "INSUFFICIENT_FUNDS" }]);
      rejected.close();
      const rejectedReplay = await DurablePaperTradingSession.open(harness({ initialCashMinor: 1n }).config, rejectPath);
      expect(state(rejectedReplay)).toEqual(rejectedState);
      rejectedReplay.close();
    });
  });

  it("preserves minor-unit amounts above Number.MAX_SAFE_INTEGER exactly", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const price = 9_007_199_254_740_993n;
      const initialCash = 90_071_992_547_409_931n;
      const strategy: PaperStrategy = {
        strategyVersion: "minor-unit-exact-v1",
        strategyParameters: { targetQuantity: 1 },
        decide: () => 1,
      };
      const fillRule: SimulatedFillRule = ({ order, market }) => ({
        kind: "fill",
        fillId: `large:${market.eventId}`,
        quantity: Math.min(1, order.remainingQuantity),
      });
      const firstConfig = harness({
        fillRule,
        initialCashMinor: initialCash,
        maxExposureMinor: initialCash,
        strategy,
        feeBps: 37,
      });
      const first = await DurablePaperTradingSession.open(firstConfig.config, path);
      await commitMarket(first, firstConfig, quote("large-order", 60, price));
      await commitMarket(first, firstConfig, quote("large-fill", 61, price));
      const expected = state(first);
      const expectedFee = feeMinorForFill(price, 1, 37);
      expect(first.getSnapshot().cashMinor).toBe(initialCash - price - expectedFee);
      first.close();

      const resumed = await DurablePaperTradingSession.open(harness({
        fillRule,
        initialCashMinor: initialCash,
        maxExposureMinor: initialCash,
        strategy,
        feeBps: 37,
      }).config, path);
      expect(state(resumed)).toEqual(expected);
      expect(resumed.getSnapshot().cashMinor).toBe(initialCash - price - expectedFee);
      resumed.close();
    });
  });

  it("deduplicates identical IDs across calls and repeated replays", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const firstConfig = harness();
      const first = await DurablePaperTradingSession.open(firstConfig.config, path);
      const event = quote("once", 70, 80n);
      await commitMarket(first, firstConfig, event);
      const expected = state(first);
      const sequence = first.getJournalSequence();
      firstConfig.setNow(70);
      expect(await first.processMarketEvent(event)).toEqual({ status: "duplicate" });
      expect(first.getJournalSequence()).toBe(sequence);
      first.close();

      const resumed = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(resumed)).toEqual(expected);
      expect(await resumed.processMarketEvent(event)).toEqual({ status: "duplicate" });
      expect(resumed.getJournalSequence()).toBe(sequence);
      const secondState = state(resumed);
      resumed.close();

      const replayedAgain = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(replayedAgain)).toEqual(secondState);
      replayedAgain.close();
    });
  });

  it("rejects conflicting event and fill IDs without exposing another state change", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const firstConfig = harness();
      const session = await DurablePaperTradingSession.open(firstConfig.config, path);
      const event = quote("identity", 80, 80n);
      await commitMarket(session, firstConfig, event);
      const expected = state(session);
      const sequence = session.getJournalSequence();
      await expect(session.processMarketEvent(quote("identity", 80, 81n))).rejects.toBeInstanceOf(PaperJournalConflictError);
      expect(state(session)).toEqual(expected);
      expect(session.getJournalSequence()).toBe(sequence);

      const report = {
        fillId: "rejected-fill-id",
        clientOrderId: "missing-order",
        marketEventId: "missing-market",
        timestamp: 80,
        quantity: 1,
        executionPriceMinor: 80n,
        feeMinor: 0n,
      };
      firstConfig.setNow(80);
      expect(await session.acceptExecutionReport(report)).toMatchObject({ status: "rejected", reasonCode: "ORDER_NOT_ACTIVE" });
      await expect(session.acceptExecutionReport({ ...report, feeMinor: 1n })).rejects.toBeInstanceOf(PaperJournalConflictError);
      const expectedAfterRejectedFill = state(session);
      session.close();

      const resumed = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(resumed)).toEqual(expectedAfterRejectedFill);
      expect(await resumed.acceptExecutionReport(report)).toMatchObject({ status: "rejected", reasonCode: "ORDER_NOT_ACTIVE" });
      resumed.close();
    });
  });

  it("treats an exact duplicate journal record as idempotent during replay", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "journal");
      const config = harness();
      const session = await DurablePaperTradingSession.open(config.config, path);
      await commitMarket(session, config, quote("journal-duplicate", 90, 80n));
      const expected = state(session);
      session.close();

      const eventsDirectory = join(path, "events");
      const [firstFile] = await readdir(eventsDirectory);
      const first = await readFile(join(eventsDirectory, firstFile!), "utf8");
      const duplicate = JSON.parse(first) as Record<string, unknown>;
      duplicate["sequence"] = 2;
      await writeFile(join(eventsDirectory, "000000000002.json"), JSON.stringify(duplicate), "utf8");

      const replay = await DurablePaperTradingSession.open(harness().config, path);
      expect(state(replay)).toEqual(expected);
      expect(replay.getJournalSequence()).toBe(2);
      replay.close();
    });
  });

  it("fails closed on conflicting duplicate records, corrupt/truncated data, and unknown schema versions", async () => {
    await withTemporaryRoot(async (root) => {
      const path = join(root, "conflict-journal");
      const config = harness();
      const session = await DurablePaperTradingSession.open(config.config, path);
      await commitMarket(session, config, quote("duplicate-conflict", 100, 80n));
      session.close();
      const eventsDirectory = join(path, "events");
      const [firstFile] = await readdir(eventsDirectory);
      const firstPath = join(eventsDirectory, firstFile!);
      const copied = JSON.parse(await readFile(firstPath, "utf8")) as Record<string, unknown>;
      copied["sequence"] = 2;
      const payload = copied["payload"] as Record<string, unknown>;
      payload["priceMinor"] = "81";
      await writeFile(join(eventsDirectory, "000000000002.json"), JSON.stringify(copied), "utf8");
      await expect(DurablePaperTradingSession.open(harness().config, path)).rejects.toBeInstanceOf(PaperJournalConflictError);
    });

    await withTemporaryRoot(async (root) => {
      const path = join(root, "truncated-journal");
      const config = harness();
      const session = await DurablePaperTradingSession.open(config.config, path);
      await commitMarket(session, config, quote("truncated", 110, 80n));
      session.close();
      const eventsDirectory = join(path, "events");
      const [firstFile] = await readdir(eventsDirectory);
      await writeFile(join(eventsDirectory, firstFile!), "{\"schemaVersion\":1", "utf8");
      await expect(DurablePaperTradingSession.open(harness().config, path)).rejects.toBeInstanceOf(PaperJournalCorruptError);
    });

    await withTemporaryRoot(async (root) => {
      const path = join(root, "unknown-schema-journal");
      const config = harness();
      const session = await DurablePaperTradingSession.open(config.config, path);
      await commitMarket(session, config, quote("unknown-schema", 120, 80n));
      session.close();
      const eventsDirectory = join(path, "events");
      const [firstFile] = await readdir(eventsDirectory);
      const entry = JSON.parse(await readFile(join(eventsDirectory, firstFile!), "utf8")) as Record<string, unknown>;
      entry["schemaVersion"] = 2;
      await writeFile(join(eventsDirectory, firstFile!), JSON.stringify(entry), "utf8");
      await expect(DurablePaperTradingSession.open(harness().config, path)).rejects.toBeInstanceOf(PaperJournalCorruptError);
    });
  });
});

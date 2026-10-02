import { describe, expect, it } from "vitest";
import { PaperTradingEngine, RollingMeanReversionV1Strategy, alwaysFillNextEvent } from "./index.js";
import type { Clock, MarketEvent, PaperStrategy, StrategyInput } from "./types.js";

class TestClock implements Clock {
  private timestamp = 0;

  now(): number {
    return this.timestamp;
  }

  set(timestamp: number): void {
    this.timestamp = timestamp;
  }
}

function input(
  currentPriceMinor: bigint,
  historyPricesMinor: readonly bigint[],
  positionQuantity = 0,
  positionEntryExecutionNotionalMinor = 0n,
  timestamp = historyPricesMinor.length + 1,
): StrategyInput {
  const history = historyPricesMinor.map((priceMinor, index) => Object.freeze({
    eventId: `history-${index}`,
    timestamp: index + 1,
    symbol: "SYNTH",
    priceMinor,
  }));
  return Object.freeze({
    current: Object.freeze({
      eventId: `current-${timestamp}`,
      timestamp,
      symbol: "SYNTH",
      priceMinor: currentPriceMinor,
    }),
    history: Object.freeze(history),
    positionQuantity,
    positionEntryExecutionNotionalMinor,
  });
}

function strategy(overrides: Partial<ConstructorParameters<typeof RollingMeanReversionV1Strategy>[0]> = {}) {
  return new RollingMeanReversionV1Strategy({
    lookback: 2,
    entryDiscountBps: 200,
    takeProfitBps: 200,
    maxHoldBars: 10,
    ...overrides,
  });
}

function engineWith(strategyOverride: PaperStrategy, slippageBps = 0) {
  const clock = new TestClock();
  const engine = new PaperTradingEngine({
    symbol: "SYNTH",
    initialCashMinor: 1_000_000n,
    risk: { maxPositionQuantity: 4, maxExposureMinor: 1_000_000n, maxMarketAgeMs: 1_000_000 },
    terms: { label: "SYNTHETIC_ONLY", feeBps: 0, slippageBps },
    clock,
    strategy: strategyOverride,
    fillRule: (value) => alwaysFillNextEvent(value),
  });
  return { clock, engine };
}

function send(
  harness: ReturnType<typeof engineWith>,
  index: number,
  priceMinor: bigint,
): void {
  const event: MarketEvent = {
    eventId: `event-${index}`,
    timestamp: index + 1,
    symbol: "SYNTH",
    priceMinor,
  };
  harness.clock.set(event.timestamp);
  const result = harness.engine.processMarketEvent(event);
  expect(result.status).toBe("accepted");
}

describe("ROLLING_MEAN_REVERSION_V1 strategy", () => {
  it("uses the current close in the trailing SMA and enters only below its discounted average", () => {
    const exactBoundary = strategy({ lookback: 3 });
    expect(exactBoundary.decide(input(9_700n, [10_000n, 10_000n]))).toBe(3);

    const currentCloseIsPartOfSma = strategy({ lookback: 3 });
    expect(currentCloseIsPartOfSma.decide(input(9_800n, [10_000n, 10_000n]))).toBe(0);
  });

  it("cannot change an earlier decision when later closes change", () => {
    const decisionsFor = (laterPrices: readonly bigint[]) => {
      const harness = engineWith(strategy());
      send(harness, 0, 10_000n);
      send(harness, 1, 9_000n);
      laterPrices.forEach((price, index) => send(harness, index + 2, price));
      return harness.engine.getDecisions().slice(0, 2);
    };

    expect(decisionsFor([9_500n, 8_000n])).toEqual(decisionsFor([50_000n, 1n]));
  });

  it("leaves an entry decision pending until the next market event", () => {
    const harness = engineWith(strategy());
    send(harness, 0, 10_000n);
    send(harness, 1, 9_000n);

    expect(harness.engine.getDecisions().at(-1)).toMatchObject({
      currentPositionQuantity: 0,
      targetPositionQuantity: 3,
      status: "order-submitted",
    });
    expect(harness.engine.getFills()).toHaveLength(0);

    send(harness, 2, 9_000n);
    expect(harness.engine.getFills()).toHaveLength(1);
    expect(harness.engine.getFills()[0]?.timestamp).toBeGreaterThan(harness.engine.getOrders()[0]!.createdAt);
  });

  it("exits after the configured held-bar count and does not leave the position open indefinitely", () => {
    const harness = engineWith(strategy({ maxHoldBars: 2 }));
    send(harness, 0, 10_000n);
    send(harness, 1, 9_000n);
    send(harness, 2, 9_000n);
    expect(harness.engine.getSnapshot().positionQuantity).toBe(3);

    send(harness, 3, 9_000n);
    expect(harness.engine.getOrders().at(-1)).toMatchObject({ side: "sell", createdAt: 4, quantity: 3 });
    expect(harness.engine.getSnapshot().positionQuantity).toBe(3);

    send(harness, 4, 9_000n);
    expect(harness.engine.getSnapshot().positionQuantity).toBe(0);
    expect(harness.engine.getFills().map(({ timestamp }) => timestamp)).toEqual([3, 5]);
  });

  it("uses the actual open execution notional, including execution slippage", () => {
    let observedEntryNotional = 0n;
    const captureStrategy: PaperStrategy = {
      strategyVersion: "entry-notional-capture-test-v1",
      decide: (value) => {
        if (value.positionQuantity > 0) observedEntryNotional = value.positionEntryExecutionNotionalMinor;
        return value.positionQuantity === 0 ? 3 : value.positionQuantity;
      },
    };
    const harness = engineWith(captureStrategy, 100);
    send(harness, 0, 10_000n);
    send(harness, 1, 9_000n);

    expect(observedEntryNotional).toBe(27_270n);
  });
});

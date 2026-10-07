import { describe, expect, it } from "vitest";
import { CostCoveredZScoreExitV1Strategy } from "./costCoveredZScoreExit.js";
import { RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import { PaperTradingEngine } from "./engine.js";
import type { StrategyInput } from "./types.js";

const config = { lookback: 2, entryZ: 0.75, exitZ: 0, maxHoldBars: 20, feeBps: 30, slippageBps: 100 };
function input(price: bigint, basis?: bigint, quantity = 3, timestamp = 2): StrategyInput {
  return {
    current: { eventId: `current-${timestamp}`, timestamp, symbol: "0056", priceMinor: price },
    history: [{ eventId: "prior", timestamp: 1, symbol: "0056", priceMinor: price - 1n }],
    positionQuantity: quantity, positionEntryExecutionNotionalMinor: 30_000n,
    ...(basis === undefined ? {} : { positionCostBasisMinor: basis }),
  };
}

describe("cost-covered discretionary exit", () => {
  it("gates at exact rounded net proceeds including the entry fee, accepting equality", () => {
    const candidate = new CostCoveredZScoreExitV1Strategy(config);
    expect(candidate.decide(input(10_000n, 29_611n))).toBe(3);
    expect(candidate.decide(input(10_000n, 29_610n))).toBe(0); // 3*9900-ceil(29700*30/10000)
    expect(candidate.getDiagnostics()).toMatchObject({ belowCost: 1, costCovered: 1 });
  });
  it("keeps unknown/invalid cost positions until the unchanged 20th held bar", () => {
    const candidate = new CostCoveredZScoreExitV1Strategy(config);
    for (let i = 1; i < 20; i += 1) expect(candidate.decide(input(10_000n, undefined, 3, i + 1))).toBe(3);
    expect(candidate.decide(input(10_000n))).toBe(0);
    expect(candidate.getDiagnostics()).toMatchObject({ unknownCost: 19, forcedExits: 1 });
    expect(new CostCoveredZScoreExitV1Strategy(config).decide(input(10_000n, 0n))).toBe(3);
  });
  it("forces an exit at max hold even without a z-score exit and despite a loss", () => {
    const candidate = new CostCoveredZScoreExitV1Strategy(config);
    const falling = { ...input(8_000n, 100_000n), history: [input(10_000n).current] };
    for (let i = 1; i < 20; i += 1) expect(candidate.decide(falling)).toBe(3);
    expect(candidate.decide(falling)).toBe(0);
  });
  it("preserves baseline entries and resets held bars after a flat position", () => {
    const candidate = new CostCoveredZScoreExitV1Strategy(config), baseline = new RollingZScoreMeanReversionV1Strategy(config);
    for (const price of [8_000n, 9_000n, 10_000n, 12_000n]) {
      const value = { ...input(price, undefined, 0), history: [input(10_000n).current] };
      expect(candidate.decide(value)).toBe(baseline.decide(value));
    }
    for (let i = 0; i < 19; i += 1) candidate.decide(input(10_000n));
    candidate.decide(input(10_000n, undefined, 0));
    expect(candidate.decide(input(10_000n))).toBe(3);
  });
  it("preserves the active-from warmup boundary", () => {
    const candidate = new CostCoveredZScoreExitV1Strategy({ ...config, activeFromTimestamp: 10 });
    expect(candidate.decide({ ...input(8_000n, undefined, 0), history: [input(10_000n).current] })).toBe(0);
  });
  it("freezes caller configuration and rejects invalid cost assumptions", () => {
    const mutable = { ...config };
    const candidate = new CostCoveredZScoreExitV1Strategy(mutable);
    mutable.slippageBps = 0;
    expect(candidate.decide(input(10_000n, 29_611n))).toBe(3);
    expect(() => new CostCoveredZScoreExitV1Strategy({ ...config, slippageBps: 10_000 })).toThrow();
    expect(() => new CostCoveredZScoreExitV1Strategy({ ...config, feeBps: -1 })).toThrow();
  });
  it("supplies actual per-fill fee-rounded remaining lot cost and ignores duplicate events", () => {
    let time = 0;
    const inputs: StrategyInput[] = [];
    const engine = new PaperTradingEngine({
      symbol: "0056", initialCashMinor: 100_000n,
      clock: { now: () => time }, risk: { maxPositionQuantity: 4, maxExposureMinor: 10_000n, maxMarketAgeMs: 5000 },
      terms: { label: "SYNTHETIC_ONLY", feeBps: 1, slippageBps: 0 },
      strategy: { strategyVersion: "capture-cost", decide: (value) => { inputs.push(value); return 3; } },
      fillRule: ({ order, market }) => ({ kind: "fill", quantity: 1, fillId: `${order.clientOrderId}-${market.eventId}` }),
    });
    for (time = 1; time <= 4; time += 1) {
      const event = { eventId: `e-${time}`, timestamp: time, symbol: "0056", priceMinor: 100n };
      expect(engine.processMarketEvent(event).status).toBe("accepted");
      expect(engine.processMarketEvent(event).status).toBe("duplicate");
    }
    expect(inputs).toHaveLength(4);
    expect(inputs.at(-1)).toMatchObject({ positionQuantity: 3, positionEntryExecutionNotionalMinor: 300n, positionCostBasisMinor: 303n });
    expect(Object.isFrozen(inputs.at(-1))).toBe(true);
    const actual = inputs.at(-1)!;
    const candidate = new CostCoveredZScoreExitV1Strategy({ ...config, feeBps: 1, slippageBps: 0 });
    expect(candidate.decide({ ...actual, current: { ...actual.current, priceMinor: 101n } })).toBe(3); // net302 < actual303
    expect(candidate.decide({ ...actual, current: { ...actual.current, priceMinor: 101n }, positionCostBasisMinor: 301n })).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paperFillCostsV2, freezePaperCostModelV2, publicTwCostScenarioV2 } from "./paperCostModelV2.js";
import { reservedBuyCashMinor } from "./money.js";
import { CostCoveredZScoreExitV2Strategy } from "./costCoveredZScoreExitV2.js";
import { PaperTradingEngine } from "./engine.js";
import { DurablePaperTradingSession } from "./durablePaperSession.js";
import { createSharedCostPaperPairV2 } from "./sharedCostPaperPairV2.js";
import { alwaysFillNextEvent } from "./strategy.js";
import type { PaperTradingEngineConfig, StrategyInput } from "./types.js";

const stock = publicTwCostScenarioV2("stock"), etf = publicTwCostScenarioV2("equity-etf");
const strategyConfig = { lookback: 2, entryZ: 0.75, exitZ: 0, maxHoldBars: 20 };
const terms = { label: "SYNTHETIC_ONLY", feeBps: 0, slippageBps: 0, costModel: stock } as const;
function value(price: bigint, basis = 32_000n): StrategyInput {
  return { current: { eventId: "quote", timestamp: 2, symbol: "2330", priceMinor: price },
    history: [{ eventId: "prior", timestamp: 1, symbol: "2330", priceMinor: price - 1n }],
    positionQuantity: 3, positionEntryExecutionNotionalMinor: 30_000n,
    positionCostBasisMinor: basis, paperTradingTerms: terms };
}
function config(now: () => number, target: (input: StrategyInput) => number = () => 3): PaperTradingEngineConfig {
  return { symbol: "2330", initialCashMinor: 100_000n, terms,
    risk: { maxPositionQuantity: 4, maxExposureMinor: 100_000n, maxMarketAgeMs: 5000 },
    strategy: { strategyVersion: "synthetic-cost-v2", decide: target }, clock: { now }, fillRule: alwaysFillNextEvent };
}

describe("shared paper costs v2", () => {
  it("charges minimum commission, no buy tax, and separate stock/ETF sell taxes", () => {
    expect(paperFillCostsV2("buy", 4000n, 3, stock)).toEqual({ notionalMinor: 12_000n, commissionMinor: 2000n, sellTaxMinor: 0n, totalFeeMinor: 2000n });
    expect(paperFillCostsV2("sell", 100_000n, 3, stock).totalFeeMinor).toBe(2900n);
    expect(paperFillCostsV2("sell", 100_000n, 3, etf).totalFeeMinor).toBe(2300n);
    expect(paperFillCostsV2("buy", 100_000n, 3, stock).totalFeeMinor).toBe(2000n);
    expect(paperFillCostsV2("buy", 1_000_000n, 3, stock).commissionMinor).toBe(4300n);
    expect(paperFillCostsV2("sell", 100n, 0, stock).totalFeeMinor).toBe(0n);
  });
  it.each(["ceil", "floor", "nearest-half-up"] as const)("makes %s quantum boundary rounding explicit", (roundingMode) => {
    const model = freezePaperCostModelV2({ ...stock, commissionRateMillionths: 500_000,
      minimumCommissionMinor: 0n, roundingMode, roundingIncrementMinor: 100n });
    const expected = roundingMode === "ceil" ? [100n, 100n, 100n, 100n, 200n]
      : roundingMode === "floor" ? [0n, 0n, 0n, 100n, 100n] : [0n, 100n, 100n, 100n, 100n];
    expect([99n, 100n, 101n, 200n, 201n].map(p => paperFillCostsV2("buy", p, 1, model).commissionMinor)).toEqual(expected);
  });
  it("defines a separate minimum for every partial execution report", () => {
    const full = paperFillCostsV2("buy", 100n, 3, stock).totalFeeMinor;
    const partial = 3n * paperFillCostsV2("buy", 100n, 1, stock).totalFeeMinor;
    expect(full).toBe(2000n); expect(partial).toBe(6000n);
  });
  it("bounds all partial partitions when actual commission rounds to nearest", () => {
    const model = freezePaperCostModelV2({ ...stock, minimumCommissionMinor: 0n,
      commissionRateMillionths: 340_000, roundingMode: "nearest-half-up" });
    const threePartialCosts = 3n * paperFillCostsV2("buy", 100n, 2, model).totalFeeMinor;
    expect(threePartialCosts).toBe(300n);
    expect(paperFillCostsV2("buy", 100n, 6, model).totalFeeMinor).toBe(200n);
    expect(reservedBuyCashMinor(6, 100n, 0, 0, model)).toBeGreaterThanOrEqual(600n + threePartialCosts);
  });
  it("blocks fee-above-gross-profit exits and permits exact coverage equality", () => {
    const candidate = new CostCoveredZScoreExitV2Strategy(strategyConfig);
    expect(candidate.decide(value(11_000n))).toBe(3); // gross gain3000; round-trip costs4100
    expect(candidate.decide(value(11_400n))).toBe(0); // 34200-2000-200 == actual32000
    expect(candidate.getDiagnostics()).toMatchObject({ belowCost: 1, costCovered: 1 });
  });
  it("fails closed with missing terms/basis while preserving max-hold loss exits", () => {
    const candidate = new CostCoveredZScoreExitV2Strategy({ ...strategyConfig, maxHoldBars: 2 });
    const missing = { ...value(9000n), paperTradingTerms: undefined };
    expect(candidate.decide(missing)).toBe(3);
    expect(candidate.decide(missing)).toBe(0);
    expect(new CostCoveredZScoreExitV2Strategy(strategyConfig).decide({ ...value(11000n), positionCostBasisMinor: undefined })).toBe(3);
  });
  it("freezes caller costs, rejects ambiguous rates and invalid increments", () => {
    const mutable = { ...stock };
    const engine = new PaperTradingEngine({ ...config(() => 1), terms: { ...terms, costModel: mutable } });
    mutable.minimumCommissionMinor = 0n;
    expect(engine.terms.costModel?.minimumCommissionMinor).toBe(2000n);
    expect(Object.isFrozen(engine.terms.costModel)).toBe(true);
    expect(() => new PaperTradingEngine({ ...config(() => 1), terms: { ...terms, feeBps: 30 } })).toThrow(/ambiguous/);
    expect(() => freezePaperCostModelV2({ ...stock, commissionRateMillionths: 1425.5 })).toThrow();
    expect(() => freezePaperCostModelV2({ ...stock, roundingIncrementMinor: 0n })).toThrow();
    expect(() => freezePaperCostModelV2({ ...stock, minimumCommissionMinor: 2010n })).toThrow();
  });
  it("uses per-partial costs in cash reservations, actual lots and duplicate accounting", () => {
    let time = 1;
    const engine = new PaperTradingEngine({ ...config(() => time),
      fillRule: ({ order, market }) => ({ kind: "fill", quantity: 1, fillId: `${order.clientOrderId}-${market.eventId}` }) });
    for (; time <= 4; time += 1) {
      const event = { eventId: `m${time}`, timestamp: time, symbol: "2330", priceMinor: 100n };
      expect(engine.processMarketEvent(event).status).toBe("accepted");
      expect(engine.processMarketEvent(event).status).toBe("duplicate");
      if (time === 1) expect(engine.getSnapshot().reservedCashMinor).toBe(6300n);
    }
    expect(engine.getSnapshot()).toMatchObject({ cashMinor: 93_700n, positionQuantity: 3, positionCostBasisMinor: 6300n, feesPaidMinor: 6000n });
  });
  it("charges separate sell tax and minimums on every partial exit", () => {
    let time = 1;
    const engine = new PaperTradingEngine({ ...config(() => time, (input) => input.current.timestamp >= 5 ? 0 : 3),
      fillRule: ({ order, market }) => ({ kind: "fill", quantity: 1, fillId: `${order.clientOrderId}-${market.eventId}` }) });
    for (; time <= 8; time += 1) engine.processMarketEvent({ eventId: `partial${time}`, timestamp: time, symbol: "2330", priceMinor: 10_000n });
    expect(engine.getFills().map(f => f.feeMinor)).toEqual([2000n, 2000n, 2000n, 2100n, 2100n, 2100n]);
    expect(engine.getSnapshot()).toMatchObject({ positionQuantity: 0, feesPaidMinor: 12_300n, realizedPnlMinor: -12_300n });
  });
  it("prevents mixing frozen v1 with new costs or v2 with missing costs", () => {
    expect(() => new PaperTradingEngine({ ...config(() => 1), strategy: { strategyVersion: "cost-covered-zscore-exit-v1", decide: () => 0 } })).toThrow(/frozen/);
    expect(() => new PaperTradingEngine({ ...config(() => 1), terms: { label: "SYNTHETIC_ONLY", feeBps: 30, slippageBps: 100 },
      strategy: new CostCoveredZScoreExitV2Strategy(strategyConfig) })).toThrow(/requires costModel/);
  });
  it("preserves cancel-pending reserves and accounts a synthetic late fill only once", () => {
    let time = 1;
    const engine = new PaperTradingEngine({ ...config(() => time), fillRule: () => ({ kind: "no-fill" }) });
    engine.processMarketEvent({ eventId: "late1", timestamp: time, symbol: "2330", priceMinor: 10_000n });
    const clientOrderId = engine.getOrders()[0]!.clientOrderId;
    expect(engine.requestExternalCancel({ eventId: "cancel", timestamp: time, clientOrderId }).status).toBe("accepted");
    time = 2;
    engine.processMarketEvent({ eventId: "late2", timestamp: time, symbol: "2330", priceMinor: 10_000n });
    expect(engine.getSnapshot().reservedCashMinor).toBe(36_000n);
    const report = { fillId: "synthetic-late-fill", clientOrderId, externalOrderId: "FAKE-OFFLINE-ORDER",
      timestamp: time, quantity: 1, executionPriceMinor: 10_000n,
      feeMinor: paperFillCostsV2("buy", 10_000n, 1, stock).totalFeeMinor };
    expect(engine.acceptExecutionReport(report).status).toBe("accepted");
    expect(engine.acceptExecutionReport(report).status).toBe("duplicate");
    expect(engine.getSnapshot()).toMatchObject({ positionQuantity: 1, positionCostBasisMinor: 12_000n,
      feesPaidMinor: 2000n, reservedCashMinor: 24_000n, activeOrder: { cancelPending: true, remainingQuantity: 2 } });
  });
  it("includes minimum fees in affordability without changing risk thresholds", () => {
    const engine = new PaperTradingEngine({ ...config(() => 1), initialCashMinor: 6299n });
    engine.processMarketEvent({ eventId: "m", timestamp: 1, symbol: "2330", priceMinor: 100n });
    expect(engine.getDecisions().at(-1)?.reasonCode).toBe("INSUFFICIENT_FUNDS");
    expect(engine.riskLimits).toEqual(config(() => 1).risk);
  });
  it("binds both arms to the same model and still records a next-event loss after covered quote", () => {
    let time = 0;
    const pair = createSharedCostPaperPairV2({ ...config(() => time), strategyConfig, costModel: stock, slippageBps: 0 });
    for (const price of [10_100n, 9000n, 9100n, 10_500n, 9400n]) {
      time += 1;
      for (const engine of [pair.baseline, pair.candidate]) engine.processMarketEvent({ eventId: `m${time}`, timestamp: time, symbol: "2330", priceMinor: price });
    }
    expect(pair.baseline.terms).toEqual(pair.candidate.terms);
    expect(pair.candidate.getSnapshot().realizedPnlMinor).toBe(-3200n); // entry29300; actual exit26100
    expect(pair.candidate.getSnapshot().feesPaidMinor).toBe(4100n);
    expect(pair.candidate.getFills()[0]?.feeMinor).toBe(pair.baseline.getFills()[0]?.feeMinor);
  });
  it("rejects unsupported durable cost format before creating any journal directory", async () => {
    const temp = await mkdtemp(join(tmpdir(), "mms-shared-cost-test-")), journal = join(temp, "synthetic-journal");
    await expect(DurablePaperTradingSession.open(config(() => 1), journal)).rejects.toThrow(/unsupported/);
    await expect(access(journal)).rejects.toThrow();
  });
});

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parsePaperSession, runPaperSession, runSessionFile } from "./sessionRunner.js";
import type { SimulatedFillRule } from "./types.js";
import { CROSS_SYMBOL_RESEARCH_RISK_V1 } from "./crossSymbolResearchRisk.js";

const BASE_TIME = 1_700_000_000_000;

function quote(eventId: string, offset: number, priceMinor: string) {
  return {
    eventId,
    timestamp: BASE_TIME + offset,
    symbol: "SYNTH",
    priceMinor,
  };
}

function session(events: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    dataKind: "SYNTHETIC",
    sourceLabel: "runner-test-fixture",
    asset: { symbol: "SYNTH", currencyCode: "TWD", minorUnit: "0.01" },
    simulation: {
      initialCashMinor: "100000",
      risk: { maxPositionQuantity: 4, maxExposureMinor: "50000", maxMarketAgeMs: 5000 },
      terms: { label: "SYNTHETIC_ONLY", feeBps: 0, slippageBps: 0 },
      strategy: { entryAtOrBelowMinor: "90", exitAtOrAboveMinor: "120", targetQuantity: 1 },
    },
    events,
    ...overrides,
  };
}

function run(input: unknown, fillRule?: SimulatedFillRule) {
  return runPaperSession(parsePaperSession(input), "a".repeat(64), fillRule);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("paper session runner", () => {
  it("keeps default risk settings and applies the fixed research override only when supplied", () => {
    const input = session([quote("risk-0", 1, "90"), quote("risk-1", 2, "120")]);
    const parsed = parsePaperSession(input);
    const defaultResult = asRecord(runPaperSession(parsed, "a".repeat(64)));
    const normalizedResult = asRecord(runPaperSession(
      parsed,
      "a".repeat(64),
      undefined,
      undefined,
      CROSS_SYMBOL_RESEARCH_RISK_V1,
    ));
    const defaultSettings = asRecord(defaultResult.simulationSettings);
    const normalizedSettings = asRecord(normalizedResult.simulationSettings);
    expect(defaultSettings.initialCashMinor).toBe(100_000n);
    expect(asRecord(defaultSettings.risk)).toMatchObject({
      maxPositionQuantity: 4,
      maxExposureMinor: 50_000n,
      maxMarketAgeMs: 5_000,
    });
    expect(defaultSettings.riskProfileId).toBeUndefined();
    expect(normalizedSettings.initialCashMinor).toBe(10_000_000n);
    expect(asRecord(normalizedSettings.risk)).toMatchObject({
      maxPositionQuantity: 4,
      maxExposureMinor: 2_000_000n,
      maxMarketAgeMs: 5_000,
    });
    expect(normalizedSettings.riskProfileId).toBe("CROSS_SYMBOL_RESEARCH_RISK_V1");
  });

  it("keeps cash and position checks active under the research profile", () => {
    const lowCashProfile = Object.freeze({
      ...CROSS_SYMBOL_RESEARCH_RISK_V1,
      initialCapitalMinor: 1n,
    });
    const lowCashResult = asRecord(runPaperSession(
      parsePaperSession(session([quote("low-cash-0", 1, "90")])),
      "a".repeat(64),
      undefined,
      undefined,
      lowCashProfile,
    ));
    const lowCashDecision = (lowCashResult.journal as readonly Record<string, unknown>[])
      .find((event) => event.kind === "decision");
    expect(lowCashDecision).toMatchObject({ status: "risk-rejected", reasonCode: "INSUFFICIENT_FUNDS" });

    const tooManyShares = session([quote("position-limit-0", 1, "90")]);
    asRecord(asRecord(tooManyShares).simulation).strategy = {
      entryAtOrBelowMinor: "90",
      exitAtOrAboveMinor: "120",
      targetQuantity: 5,
    };
    const positionResult = asRecord(runPaperSession(
      parsePaperSession(tooManyShares),
      "a".repeat(64),
      undefined,
      undefined,
      CROSS_SYMBOL_RESEARCH_RISK_V1,
    ));
    const positionDecision = (positionResult.journal as readonly Record<string, unknown>[])
      .find((event) => event.kind === "decision");
    expect(positionDecision).toMatchObject({ status: "risk-rejected", reasonCode: "MAX_POSITION_EXCEEDED" });
  });

  it("is deterministic and keeps earlier decisions unchanged when future prices change", () => {
    const events = [quote("q1", 1, "90"), quote("q2", 2, "100"), quote("q3", 3, "120"), quote("q4", 4, "110")];
    const first = run(session(events));
    const repeated = run(session(events));
    const changedFuture = run(session([...events.slice(0, 3), quote("q4", 4, "500") ]));
    expect(first).toEqual(repeated);

    const decisionsBeforeChangedFuture = asRecord(changedFuture).journal as readonly Record<string, unknown>[];
    const firstDecisions = (asRecord(first).journal as readonly Record<string, unknown>[])
      .filter((event) => event.kind === "decision" && event.sourceEventId !== "q4");
    const changedPrefixDecisions = decisionsBeforeChangedFuture
      .filter((event) => event.kind === "decision" && event.sourceEventId !== "q4");
    expect(changedPrefixDecisions).toEqual(firstDecisions);
  });

  it("deduplicates an identical replay and fails on conflicts or out-of-order new events", () => {
    const events = [quote("q1", 1, "90"), quote("q2", 2, "100")];
    const duplicateResult = run(session([...events, events[0]]));
    expect(asRecord(duplicateResult).eventProcessingResults).toMatchObject([
      { eventId: "q1", status: "accepted" },
      { eventId: "q2", status: "accepted" },
      { eventId: "q1", status: "duplicate" },
    ]);

    expect(() => run(session([...events, quote("q1", 1, "91")]))).toThrow("EVENT_ID_CONFLICT");
    expect(() => run(session([...events, quote("q0", 0, "89")]))).toThrow("NON_MONOTONIC_MARKET_EVENT");
  });

  it("rejects malformed fields, invalid prices, and strategy-answer data", () => {
    expect(() => run(session([quote("q1", 1, "0")]))).toThrow("must be greater than zero");
    expect(() => run(session([{ ...quote("q1", 1, "90"), realizedForwardReturn: 0.1 }]))).toThrow("unsupported: realizedForwardReturn");
    expect(() => run(session([{ ...quote("q1", 1, 90) }]))).toThrow("integer string");
    expect(() => run(session([quote("q1", 1, "90")], { strategyAnswers: [] }))).toThrow("unsupported: strategyAnswers");
  });

  it("computes hand-checkable cost-after-fee wins, losses, breakevens, averages, and account totals", () => {
    const events = [
      quote("w1", 1, "90"), quote("w2", 2, "100"), quote("w3", 3, "120"), quote("w4", 4, "110"),
      quote("l1", 5, "90"), quote("l2", 6, "100"), quote("l3", 7, "120"), quote("l4", 8, "95"),
      quote("b1", 9, "90"), quote("b2", 10, "100"), quote("b3", 11, "120"), quote("b4", 12, "103"),
    ];
    const input = session(events);
    asRecord(input).simulation = {
      ...(asRecord(input).simulation as Record<string, unknown>),
      terms: { label: "SYNTHETIC_ONLY", feeBps: 100, slippageBps: 0 },
    };
    const result = asRecord(run(input));
    const stats = asRecord(result.tradingStatistics);
    const account = asRecord(result.accountSummary);
    expect(stats).toMatchObject({ completeTradeCount: 3, wins: 1, losses: 1, breakevens: 1, netWinRate: 1 / 3 });
    expect(stats.averageWinPnlMinor).toEqual({ numeratorMinor: "7", denominator: 1 });
    expect(stats.averageLossPnlMinor).toEqual({ numeratorMinor: "-7", denominator: 1 });
    expect(stats.averageCompleteTradeNetPnlMinor).toEqual({ numeratorMinor: "0", denominator: 3 });
    expect(account).toMatchObject({
      cashMinor: 100_000n,
      positionQuantity: 0,
      realizedPnlMinor: 0n,
      unrealizedPnlMinor: 0n,
      feesPaidMinor: 8n,
      equityMinor: 100_000n,
    });
    expect(result.accountReconciliation).toMatchObject({
      fillFeesMatch: true,
      positionsMatch: true,
      realizedPnlMatches: true,
      equityMatches: true,
    });
  });

  it("counts partial entry and exit fills as one complete trade", () => {
    const input = session([
      quote("p1", 1, "90"), quote("p2", 2, "90"), quote("p3", 3, "90"),
      quote("p4", 4, "120"), quote("p5", 5, "120"), quote("p6", 6, "120"),
    ]);
    asRecord(asRecord(input).simulation).strategy = {
      entryAtOrBelowMinor: "90", exitAtOrAboveMinor: "120", targetQuantity: 2,
    };
    const oneUnitPerEvent: SimulatedFillRule = ({ order, market }) => ({
      kind: "fill",
      fillId: `${order.clientOrderId}:partial:${market.eventId}`,
      quantity: 1,
    });
    const result = asRecord(run(input, oneUnitPerEvent));
    const stats = asRecord(result.tradingStatistics);
    expect(stats).toMatchObject({ completeTradeCount: 1, wins: 1, losses: 0, breakevens: 0 });
    expect((stats.completedTrades as readonly unknown[])).toHaveLength(1);
    expect((asRecord(result.accountSummary)).positionQuantity).toBe(0);
    const fills = (result.journal as readonly Record<string, unknown>[]).filter((event) => event.kind === "fill");
    expect(fills).toHaveLength(4);
  });

  it("keeps partial exits and open positions out of the completed-trade denominator", () => {
    const input = session([quote("u1", 1, "90"), quote("u2", 2, "100"), quote("u3", 3, "120"), quote("u4", 4, "110")]);
    asRecord(asRecord(input).simulation).strategy = {
      entryAtOrBelowMinor: "90", exitAtOrAboveMinor: "120", targetQuantity: 2,
    };
    asRecord(asRecord(input).simulation).terms = { label: "SYNTHETIC_ONLY", feeBps: 100, slippageBps: 0 };
    const onePartialSell: SimulatedFillRule = ({ order, market }) => ({
      kind: "fill",
      fillId: `${order.clientOrderId}:partial:${market.eventId}`,
      quantity: order.side === "buy" ? order.remainingQuantity : 1,
    });
    const result = asRecord(run(input, onePartialSell));
    const stats = asRecord(result.tradingStatistics);
    const account = asRecord(result.accountSummary);
    expect(stats).toMatchObject({ completeTradeCount: 0, wins: 0, losses: 0, breakevens: 0, netWinRate: null });
    expect(stats.averageCompleteTradeNetPnlMinor).toBeNull();
    expect(stats.incompleteTrade).toMatchObject({ positionQuantity: 1, realizedPnlMinor: 7n });
    expect(account).toMatchObject({
      cashMinor: 99_906n,
      positionQuantity: 1,
      positionCostBasisMinor: 101n,
      realizedPnlMinor: 7n,
      unrealizedPnlMinor: 9n,
      feesPaidMinor: 4n,
      equityMinor: 100_016n,
    });
    expect(result.accountReconciliation).toMatchObject({
      positionsMatch: true,
      realizedPnlMatches: true,
      fillFeesMatch: true,
      equityMatches: true,
    });
  });

  it("returns null averages and win rate when no completed trade exists and surfaces missing files", async () => {
    const empty = asRecord(run(session([quote("only", 1, "90")])));
    const stats = asRecord(empty.tradingStatistics);
    expect(stats).toMatchObject({ completeTradeCount: 0, netWinRate: null });
    expect(stats.averageWinPnlMinor).toBeNull();
    expect(stats.averageLossPnlMinor).toBeNull();
    expect(stats.averageCompleteTradeNetPnlMinor).toBeNull();
    await expect(runSessionFile("packages/paper-trading/fixtures/does-not-exist.json")).rejects.toThrow();
  });

  it("emits parseable CLI JSON, fails without an input file, and preserves the demo summary", () => {
    const runner = spawnSync("npm", [
      "run", "--silent", "paper:run", "--", "--input", "packages/paper-trading/fixtures/session.synthetic.json",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(runner.status).toBe(0);
    expect(runner.stderr).toBe("");
    const output = JSON.parse(runner.stdout) as Record<string, unknown>;
    expect(output.classification).toBe("SIMULATION_ONLY");
    expect(asRecord(output.tradingStatistics)).toMatchObject({ completeTradeCount: 2, wins: 1, losses: 1, netWinRate: 0.5 });

    const missing = spawnSync("npm", [
      "run", "--silent", "paper:run", "--", "--input", "packages/paper-trading/fixtures/does-not-exist.json",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("ENOENT");

    const demo = spawnSync("npm", ["run", "--silent", "paper:demo"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(demo.status).toBe(0);
    expect(demo.stderr).toBe("");
    expect(demo.stdout).toContain("market_events=4");
    expect(demo.stdout).toContain("cash_minor=100092");
    expect(demo.stdout).toContain("fees_minor=187");
  }, 60_000);
});

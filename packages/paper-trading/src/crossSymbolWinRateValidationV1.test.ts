import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoCrossSymbolCliOverrides,
  buildCrossSymbolValidationResult,
  createFrozenMeanReversionStrategy,
  CROSS_SYMBOL_VALIDATION_DATA_PATH,
  CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID,
  CROSS_SYMBOL_VALIDATION_INPUT_SHA256,
  CROSS_SYMBOL_VALIDATION_SYMBOLS,
  evaluateCrossSymbolValidationCsv,
  loadFrozenCrossSymbolChallenger,
  readCrossSymbolValidationMarketCsv,
  serializeCrossSymbolValidationResult,
  type CrossSymbolOutcomeDiagnostic,
} from "./crossSymbolWinRateValidationV1.js";
import { wilsonLowerBound95 } from "./winRateOptimizerV2.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../..");
const AUTHORITY_PATH = resolve(PROJECT_ROOT, "packages/paper-trading/win-rate-strategy-family-v1.json");
const DATA_PATH = resolve(PROJECT_ROOT, CROSS_SYMBOL_VALIDATION_DATA_PATH);
const EXPECTED_SYMBOLS = ["0056", "2317", "2330", "2454"] as const;

async function frozenAuthority(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(AUTHORITY_PATH, "utf8")) as Record<string, unknown>;
}

function diagnostic(
  symbol: string,
  WIN: number,
  LOSS: number,
  BREAKEVEN: number,
  diagnosticNetPnl = "0.00",
  diagnosticFees = "0.00",
): CrossSymbolOutcomeDiagnostic {
  return { symbol, WIN, LOSS, BREAKEVEN, diagnosticNetPnl, diagnosticFees };
}

function outcomesForPooledMetric(): readonly CrossSymbolOutcomeDiagnostic[] {
  return [
    diagnostic("0056", 2, 1, 0, "10.00", "1.00"),
    diagnostic("2317", 1, 1, 1, "-5.00", "2.00"),
    diagnostic("2330", 0, 0, 0),
    diagnostic("2454", 3, 2, 1, "2.00", "3.00"),
  ];
}

function syntheticCsv(): string {
  const closes = [...Array.from({ length: 20 }, () => 100), 90, 90, 100, 100];
  const rows = EXPECTED_SYMBOLS.flatMap((symbol) => closes.map((close, index) => {
    const date = new Date(Date.UTC(2020, 0, 2 + index)).toISOString().slice(0, 10);
    const price = close.toFixed(2);
    return [symbol, date, price, price, price, price, "1000", "synthetic/test"].join(",");
  }));
  return ["symbol,date,open,high,low,close,volume,source", ...rows].join("\n");
}

describe("cross-symbol blind win-rate validation v1", () => {
  it("loads the frozen challenger and its parameters from the checked-in authority artifact", async () => {
    const artifact = await frozenAuthority();
    const challenger = loadFrozenCrossSymbolChallenger(artifact);
    const rawParameters = artifact["FROZEN_PARAMETERS"] as Record<string, unknown>;

    expect(challenger.id).toBe(CROSS_SYMBOL_VALIDATION_FROZEN_CHALLENGER_ID);
    expect(challenger.id).toBe(artifact["FROZEN_CHALLENGER_ID"]);
    expect(challenger.parameters).toEqual(rawParameters);
    expect(Object.isFrozen(challenger)).toBe(true);
    expect(Object.isFrozen(challenger.parameters)).toBe(true);
  });

  it("uses exactly the four predeclared validation symbols and excludes 0050", () => {
    expect(CROSS_SYMBOL_VALIDATION_SYMBOLS).toEqual(EXPECTED_SYMBOLS);
    expect(CROSS_SYMBOL_VALIDATION_SYMBOLS).toHaveLength(4);
    expect(CROSS_SYMBOL_VALIDATION_SYMBOLS).not.toContain("0050");
    expect(() => assertNoCrossSymbolCliOverrides(["0050"])).toThrow(/no CLI arguments/);
  });

  it("rejects parameter changes that conflict with the frozen candidate identity", async () => {
    const artifact = await frozenAuthority();
    const parameters = artifact["FROZEN_PARAMETERS"] as Record<string, unknown>;
    const tampered = { ...artifact, FROZEN_PARAMETERS: { ...parameters, lookback: 40 } };

    expect(() => loadFrozenCrossSymbolChallenger(tampered)).toThrow(/parameters do not match/);
  });

  it("creates the same strategy policy for every validation symbol", async () => {
    const challenger = loadFrozenCrossSymbolChallenger(await frozenAuthority());
    const strategyPolicies = CROSS_SYMBOL_VALIDATION_SYMBOLS.map(() => (
      createFrozenMeanReversionStrategy(challenger).strategyParameters
    ));

    expect(strategyPolicies.every((policy) => JSON.stringify(policy) === JSON.stringify(strategyPolicies[0]))).toBe(true);
    expect(strategyPolicies[0]).toMatchObject(challenger.parameters);
  });

  it("pools W/L/BE before calculating the aggregate Wilson score", async () => {
    const challenger = loadFrozenCrossSymbolChallenger(await frozenAuthority());
    const result = buildCrossSymbolValidationResult(challenger, "a".repeat(64), outcomesForPooledMetric());
    const symbolWilsonScores = result.perSymbol
      .map(({ WilsonLowerBound95 }) => WilsonLowerBound95)
      .filter((value): value is number => value !== null);
    const symbolWilsonMean = symbolWilsonScores.reduce((sum, value) => sum + value, 0) / symbolWilsonScores.length;

    expect(result.aggregate).toMatchObject({
      completedTradeCount: 12,
      WIN: 6,
      LOSS: 4,
      BREAKEVEN: 2,
      rawNetWinRate: 0.5,
      WilsonLowerBound95: wilsonLowerBound95(6, 12),
    });
    expect(result.aggregate.WilsonLowerBound95).not.toBe(symbolWilsonMean);
  });

  it("keeps a zero-trade symbol represented in results and coverage", async () => {
    const challenger = loadFrozenCrossSymbolChallenger(await frozenAuthority());
    const result = buildCrossSymbolValidationResult(challenger, "b".repeat(64), outcomesForPooledMetric());
    const zeroTradeSymbol = result.perSymbol.find(({ symbol }) => symbol === "2330");

    expect(zeroTradeSymbol).toMatchObject({
      completedTradeCount: 0,
      WIN: 0,
      LOSS: 0,
      BREAKEVEN: 0,
      rawNetWinRate: null,
      WilsonLowerBound95: null,
    });
    expect(result.coverage.symbolsWithTrades).toEqual(["0056", "2317", "2454"]);
    expect(result.coverage.symbolsWithoutTrades).toEqual(["2330"]);
  });

  it("does not let diagnostic P&L or fees affect evidence classification or win-rate metrics", async () => {
    const challenger = loadFrozenCrossSymbolChallenger(await frozenAuthority());
    const first = buildCrossSymbolValidationResult(challenger, "c".repeat(64), outcomesForPooledMetric());
    const changedDiagnostics = outcomesForPooledMetric().map((row) => ({
      ...row,
      diagnosticNetPnl: row.symbol === "0056" ? "-999999.99" : "888888.88",
      diagnosticFees: "123456.78",
    }));
    const second = buildCrossSymbolValidationResult(challenger, "c".repeat(64), changedDiagnostics);

    expect(first.validationStatus).toBe("EVIDENCE_OBSERVED");
    expect(second.validationStatus).toBe(first.validationStatus);
    expect(second.aggregate).toEqual(first.aggregate);
  });

  it("produces byte-identical machine results for identical strategy, CSV, and hash inputs", async () => {
    const artifact = await frozenAuthority();
    const contents = syntheticCsv();
    const inputSha256 = createHash("sha256").update(contents).digest("hex");
    const first = evaluateCrossSymbolValidationCsv(artifact, contents, inputSha256);
    const second = evaluateCrossSymbolValidationCsv(artifact, contents, inputSha256);

    expect(first.validationSymbols).toEqual(EXPECTED_SYMBOLS);
    expect(first.perSymbol).toHaveLength(4);
    expect(first.perSymbol.map(({ completedTradeCount }) => completedTradeCount)).toEqual([1, 1, 1, 1]);
    expect(serializeCrossSymbolValidationResult(first)).toBe(serializeCrossSymbolValidationResult(second));
  });

  it("reads the existing P194 dataset without changing its pinned SHA-256", async () => {
    const before = createHash("sha256").update(await readFile(DATA_PATH)).digest("hex");
    const loaded = await readCrossSymbolValidationMarketCsv();
    const after = createHash("sha256").update(await readFile(DATA_PATH)).digest("hex");

    expect(before).toBe(CROSS_SYMBOL_VALIDATION_INPUT_SHA256);
    expect(loaded.inputSha256).toBe(CROSS_SYMBOL_VALIDATION_INPUT_SHA256);
    expect(after).toBe(before);
  });

  it("rejects incomplete or reordered symbol outcome sets", async () => {
    const challenger = loadFrozenCrossSymbolChallenger(await frozenAuthority());
    expect(() => buildCrossSymbolValidationResult(challenger, "d".repeat(64), outcomesForPooledMetric().slice(1)))
      .toThrow(/every predeclared symbol/);
    expect(() => buildCrossSymbolValidationResult(challenger, "d".repeat(64), [
      diagnostic("2317", 1, 0, 0),
      ...outcomesForPooledMetric().slice(1),
    ])).toThrow(/policy order/);
  });
});

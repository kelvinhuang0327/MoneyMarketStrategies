import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH } from "./crossSymbolWinRateValidationV1.js";
import { wilsonLowerBound95 } from "./winRateOptimizerV2.js";
import { buildZScoreCandidateGrid, ZSCORE_HISTORICAL_CUTOFF } from "./zscoreWinRateSelector.js";
import {
  decideFreshWinRateImprovement,
  evaluateZScoreCrossSymbolForward,
  isFreshEvidenceSufficient,
  serializeZScoreForwardResult,
  validateFreshCrossSymbolCsv,
  ZSCORE_FORWARD_CSV_SOURCE,
  ZSCORE_FORWARD_EVALUATOR_VERSION,
  ZSCORE_FORWARD_SOURCE,
  ZSCORE_FORWARD_SYMBOLS,
} from "./zscoreCrossSymbolForwardEvaluator.js";

const PROJECT_ROOT = resolve(process.cwd());
const CSV_HEADER = "symbol,date,open,high,low,close,volume,source";
const FREEZE_COMMIT = "1".repeat(40);

function csvForCycles(cyclesBySymbol: Readonly<Record<string, number>>): { readonly bytes: Uint8Array; readonly rowsBySymbol: Readonly<Record<string, number>> } {
  const lines = [CSV_HEADER];
  const rowsBySymbol: Record<string, number> = {};
  for (const symbol of ZSCORE_FORWARD_SYMBOLS) {
    const closes = [...Array(45).fill(100) as number[]];
    const cycleCount = cyclesBySymbol[symbol] ?? 0;
    for (let cycle = 0; cycle < cycleCount; cycle += 1) closes.push(90, 100, 110, 110, 100);
    rowsBySymbol[symbol] = closes.length;
    closes.forEach((price, index) => {
      const date = new Date(Date.UTC(2026, 7, 12 + index)).toISOString().slice(0, 10);
      const decimal = price.toFixed(2);
      lines.push([symbol, date, decimal, decimal, decimal, decimal, "1000", ZSCORE_FORWARD_CSV_SOURCE].join(","));
    });
  }
  return Object.freeze({ bytes: new TextEncoder().encode(`${lines.join("\n")}\n`), rowsBySymbol: Object.freeze(rowsBySymbol) });
}

function flatRows(): { readonly bytes: Uint8Array; readonly rowsBySymbol: Readonly<Record<string, number>> } {
  const lines = [CSV_HEADER];
  const rowsBySymbol: Record<string, number> = Object.fromEntries(ZSCORE_FORWARD_SYMBOLS.map((symbol) => [symbol, 0]));
  for (const symbol of ZSCORE_FORWARD_SYMBOLS.slice(0, 3)) {
    for (let index = 0; index < 8; index += 1) {
      const date = new Date(Date.UTC(2026, 7, 12 + index)).toISOString().slice(0, 10);
      lines.push([symbol, date, "100.00", "100.00", "100.00", "100.00", "1000", ZSCORE_FORWARD_CSV_SOURCE].join(","));
      rowsBySymbol[symbol] = 8;
    }
  }
  return Object.freeze({ bytes: new TextEncoder().encode(`${lines.join("\n")}\n`), rowsBySymbol: Object.freeze(rowsBySymbol) });
}

function provenance(bytes: Uint8Array, rowsBySymbol: Readonly<Record<string, number>>) {
  const allRows = new TextDecoder().decode(bytes).trim().split("\n").slice(1);
  const dates = allRows.map((line) => line.split(",")[1]!).sort();
  return Object.freeze({
    schemaVersion: 1,
    artifactId: "cross-symbol-forward-v1",
    symbols: ZSCORE_FORWARD_SYMBOLS,
    source: ZSCORE_FORWARD_SOURCE,
    providerVersion: ZSCORE_FORWARD_EVALUATOR_VERSION,
    fetchedAtUtc: "2026-09-30T05:45:03.047Z",
    historicalCutoff: ZSCORE_HISTORICAL_CUTOFF,
    actualDateRange: Object.freeze({ start: dates[0] ?? null, end: dates.at(-1) ?? null }),
    perSymbolRowCounts: rowsBySymbol,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    purpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION",
    sourceUrls: Object.freeze(ZSCORE_FORWARD_SYMBOLS.map((symbol) => `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260801&stockNo=${symbol}`)),
  });
}

function frozenSelectionArtifact() {
  const selected = buildZScoreCandidateGrid().find(({ parameters }) => (
    parameters.lookback === 40 && parameters.entryZ === 1.25 && parameters.exitZ === 0 && parameters.maxHoldBars === 10
  ));
  if (!selected) throw new Error("test frozen candidate is missing from the fixed grid");
  return Object.freeze({
    schemaVersion: 1,
    strategyFamily: "ROLLING_ZSCORE_MEAN_REVERSION_V1",
    objective: "WIN_RATE_WILSON_LOWER_BOUND_95",
    historicalInputSha256: "ba4ee5760e1f12e2c0eb67eaee66adf773374d8f4e37f629416098316bc091d7",
    historicalDataEnd: ZSCORE_HISTORICAL_CUTOFF,
    selectionStatus: "SELECTED_FUTURE_CANDIDATE",
    candidateDiagnostics: Array.from({ length: 24 }, (_, index) => ({ candidateId: `fixture-${index}` })),
    selectedFutureCandidate: Object.freeze({
      id: selected.candidateId,
      strategyFamily: "ROLLING_ZSCORE_MEAN_REVERSION_V1",
      parameters: selected.parameters,
    }),
  });
}

async function legacyArtifact(): Promise<unknown> {
  const bytes = await readFile(resolve(PROJECT_ROOT, CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function evaluateFixture(bytes: Uint8Array, rowsBySymbol: Readonly<Record<string, number>>) {
  return evaluateZScoreCrossSymbolForward({
    freshDataBytes: bytes,
    freshProvenance: provenance(bytes, rowsBySymbol),
    legacyReferenceArtifact: {
      schemaVersion: 1,
      strategyFamily: "ROLLING_MEAN_REVERSION_V1",
      selectionStatus: "SELECTED_FUTURE_CHALLENGER",
      FROZEN_CHALLENGER_ID: "lookback-20-entry-0.04-take-0.04-hold-10",
      FROZEN_PARAMETERS: { lookback: 20, entryDiscount: 0.04, takeProfit: 0.04, maxHoldBars: 10 },
      selectedFutureChallenger: {
        id: "lookback-20-entry-0.04-take-0.04-hold-10",
        strategyFamily: "ROLLING_MEAN_REVERSION_V1",
        parameters: { lookback: 20, entryDiscount: 0.04, takeProfit: 0.04, maxHoldBars: 10 },
      },
    },
    frozenSelectionArtifact: frozenSelectionArtifact(),
    frozenSelectionCommit: FREEZE_COMMIT,
  });
}

describe("blind z-score cross-symbol forward evaluation", () => {
  it("feeds the exact same fixed fresh rows to both strategies and keeps all four symbols", () => {
    const fixture = csvForCycles({ "0056": 1, "2317": 2, "2330": 3, "2454": 4 });
    const result = evaluateFixture(fixture.bytes, fixture.rowsBySymbol);
    expect(result["freshSymbols"]).toEqual(ZSCORE_FORWARD_SYMBOLS);
    expect(result["freshRowsBySymbol"]).toEqual(fixture.rowsBySymbol);
    expect((result["legacyReference"] as Record<string, unknown>)["perSymbol"])
      .toHaveLength(ZSCORE_FORWARD_SYMBOLS.length);
    expect((result["newFrozenChallenger"] as Record<string, unknown>)["perSymbol"])
      .toHaveLength(ZSCORE_FORWARD_SYMBOLS.length);
    expect(result["freshDataSha256"]).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
  });

  it("rejects historical-cutoff rows, duplicate dates, unsupported symbols, and malformed OHLCV", () => {
    const header = `${CSV_HEADER}\n`;
    expect(() => validateFreshCrossSymbolCsv(`${header}0056,${ZSCORE_HISTORICAL_CUTOFF},100.00,100.00,100.00,100.00,1,${ZSCORE_FORWARD_CSV_SOURCE}\n`))
      .toThrow(/strictly after/);
    const row = `0056,2026-08-12,100.00,100.00,100.00,100.00,1,${ZSCORE_FORWARD_CSV_SOURCE}`;
    expect(() => validateFreshCrossSymbolCsv(`${header}${row}\n${row}\n`)).toThrow(/duplicate symbol\/date/);
    expect(() => validateFreshCrossSymbolCsv(`${header}9999,2026-08-12,100.00,100.00,100.00,100.00,1,${ZSCORE_FORWARD_CSV_SOURCE}\n`))
      .toThrow(/unsupported symbol/);
    expect(() => validateFreshCrossSymbolCsv(`${header}0056,2026-08-12,101.00,100.00,99.00,100.00,1,${ZSCORE_FORWARD_CSV_SOURCE}\n`))
      .toThrow(/inconsistent OHLC/);
  });

  it("pools individual completed outcomes before calculating aggregate Wilson", () => {
    const fixture = csvForCycles({ "0056": 6, "2317": 4, "2330": 3, "2454": 2 });
    const result = evaluateFixture(fixture.bytes, fixture.rowsBySymbol);
    const legacy = result["legacyReference"] as Record<string, unknown>;
    const perSymbol = legacy["perSymbol"] as readonly Record<string, unknown>[];
    const aggregate = legacy["aggregate"] as Record<string, unknown>;
    const trades = perSymbol.reduce((sum, row) => sum + Number(row["completedTradeCount"]), 0);
    const wins = perSymbol.reduce((sum, row) => sum + Number(row["WIN"]), 0);
    const symbolWilsonMean = perSymbol.reduce((sum, row) => sum + Number(row["WilsonLowerBound95"]), 0) / perSymbol.length;
    expect(aggregate["aggregateCompletedTrades"]).toBe(trades);
    expect(aggregate["aggregateW"]).toBe(wins);
    expect(aggregate["aggregateWilsonLowerBound95"]).toBe(wilsonLowerBound95(wins, trades));
    expect(aggregate["aggregateWilsonLowerBound95"]).not.toBe(symbolWilsonMean);
  });

  it("marks insufficient evidence and represents symbols with zero rows", () => {
    const fixture = flatRows();
    const result = evaluateFixture(fixture.bytes, fixture.rowsBySymbol);
    expect(result["freshRowsBySymbol"]).toEqual(fixture.rowsBySymbol);
    expect(result["comparisonStatus"]).toBe("INSUFFICIENT_FRESH_TRADES");
    expect(result["tradingWinRateImprovement"]).toBe("NOT EVALUABLE");
    const challenger = result["newFrozenChallenger"] as Record<string, unknown>;
    expect((challenger["perSymbol"] as readonly Record<string, unknown>[]).map(({ symbol, completedTradeCount }) => [symbol, completedTradeCount]))
      .toEqual([["0056", 0], ["2317", 0], ["2330", 0], ["2454", 0]]);
  });

  it("requires the fixed three-symbol and 12-trade sufficiency gate", () => {
    expect(isFreshEvidenceSufficient({
      perSymbol: [{ completedTradeCount: 4 }, { completedTradeCount: 4 }, { completedTradeCount: 4 }, { completedTradeCount: 0 }],
      aggregate: { completedTradeCount: 12 },
    })).toBe(true);
    expect(isFreshEvidenceSufficient({
      perSymbol: [{ completedTradeCount: 6 }, { completedTradeCount: 6 }, { completedTradeCount: 0 }, { completedTradeCount: 0 }],
      aggregate: { completedTradeCount: 12 },
    })).toBe(false);
    expect(isFreshEvidenceSufficient({
      perSymbol: [{ completedTradeCount: 3 }, { completedTradeCount: 3 }, { completedTradeCount: 3 }, { completedTradeCount: 2 }],
      aggregate: { completedTradeCount: 11 },
    })).toBe(false);
  });

  it("reports YES only for a strict Wilson improvement; equal scores stay NO despite P&L", () => {
    expect(decideFreshWinRateImprovement({ WilsonLowerBound95: 0.3 }, { WilsonLowerBound95: 0.300001 }, true)).toBe("YES");
    expect(decideFreshWinRateImprovement({ WilsonLowerBound95: 0.3 }, { WilsonLowerBound95: 0.3 }, true)).toBe("NO");
    expect(decideFreshWinRateImprovement({ WilsonLowerBound95: 0.3 }, { WilsonLowerBound95: 0.2 }, true)).toBe("NO");
    expect(decideFreshWinRateImprovement({ WilsonLowerBound95: 0.3 }, { WilsonLowerBound95: 0.9 }, false)).toBe("NOT EVALUABLE");
  });

  it("produces deterministic results for identical frozen and fresh inputs", () => {
    const fixture = csvForCycles({ "0056": 3, "2317": 2, "2330": 1, "2454": 0 });
    const first = evaluateFixture(fixture.bytes, fixture.rowsBySymbol);
    const second = evaluateFixture(fixture.bytes, fixture.rowsBySymbol);
    expect(serializeZScoreForwardResult(first)).toBe(serializeZScoreForwardResult(second));
  });

  it("uses the checked-in legacy identity artifact as its reference authority", async () => {
    const artifact = await legacyArtifact() as Record<string, unknown>;
    expect(artifact["FROZEN_CHALLENGER_ID"]).toBe("lookback-20-entry-0.04-take-0.04-hold-10");
  });
});

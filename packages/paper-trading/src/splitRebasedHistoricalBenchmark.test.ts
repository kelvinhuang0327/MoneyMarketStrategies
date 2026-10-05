import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import {
  evaluateSplitRebasedForwardSample,
  evaluateSplitRebasedHistoricalBenchmark,
  rebasePriceBandForSplit,
  type SplitRebasedDividend,
} from "./splitRebasedHistoricalBenchmark.js";

const TWSE_PROFILE = "twse-daily-ohlcv-close-v1";
const SAMPLE_DIVIDENDS: readonly SplitRebasedDividend[] = Object.freeze([
  Object.freeze({
    exDate: "2025-07-21",
    payDate: "2025-08-08",
    amountPerShareMinor: "36",
    source: "https://www.yuantafunds.com/myfund/information/1066?tab=3",
  }),
]);

function raw0050Csv(): string {
  return [
    "symbol,date,open,high,low,close,volume",
    "0050,2025-06-10,184.90,188.90,184.90,188.65,1000",
    "0050,2025-06-18,47.50,47.72,47.14,47.57,4000",
    "0050,2025-06-19,47.50,47.55,47.02,47.10,4000",
    "0050,2025-07-18,51.00,51.50,50.80,51.45,4000",
    "0050,2025-07-21,50.90,51.10,50.50,50.90,4000",
    "0050,2025-07-22,50.90,51.10,50.80,51.00,4000",
    "0050,2025-08-08,51.00,51.10,50.90,51.00,4000",
  ].join("\n");
}

function artifacts(inputSha256: string, rowCount: number) {
  const champion = {
    entryAtOrBelowMinor: "10000",
    exitAtOrAboveMinor: "11000",
    targetQuantity: 3,
  };
  const challenger = {
    entryAtOrBelowMinor: "11000",
    exitAtOrAboveMinor: "12000",
    targetQuantity: 3,
  };
  return {
    selection: {
      schemaVersion: 2,
      symbol: "0050",
      inputSha256,
      FROZEN_SELECTION_INPUT_SHA256: inputSha256,
      FROZEN_STRATEGY_VERSION: "price-band-fixed-v1",
      FROZEN_SELECTION_POLICY_VERSION: "wilson-lower-bound-95-development-v1",
      FROZEN_CHALLENGER_ID: "entry-11000-exit-12000",
      FROZEN_PARAMETERS: challenger,
      observedThroughDate: "2026-08-11",
      developmentBoundary: { startRow: 1, endRow: 1279, rowCount: 1279 },
      championDevelopment: {
        parameters: champion,
        completedTradeCount: 1,
        wins: 1,
        losses: 0,
        breakevens: 0,
      },
      selectedFutureChallenger: {
        id: "entry-11000-exit-12000",
        parameters: challenger,
        completedTradeCount: 2,
        wins: 2,
        losses: 0,
        breakevens: 0,
      },
    },
    provenance: {
      artifactId: "p194-twstock-ohlcv-v1",
      producer: "scripts/p194_twstock_export_ohlcv.py",
      provider: "twstock Stock.fetch(year, month); TWSE/TPEX",
      providerVersion: "1.5.1",
      fetchedAtUtc: "2026-08-12T03:29:21Z",
      csvSha256: inputSha256,
      rowCount,
      perSymbolRowCounts: { "0050": rowCount },
      actualDateRange: { start: "2025-06-10", end: "2025-08-08" },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("split-rebased historical benchmark", () => {
  it("rebases both price bands mechanically into the post-split share unit", () => {
    expect(rebasePriceBandForSplit({
      entryAtOrBelowMinor: 10_000n,
      exitAtOrAboveMinor: 11_000n,
      targetQuantity: 3,
    })).toEqual({
      entryAtOrBelowMinor: 2_500n,
      exitAtOrAboveMinor: 2_750n,
      targetQuantity: 3,
    });
    expect(rebasePriceBandForSplit({
      entryAtOrBelowMinor: 11_000n,
      exitAtOrAboveMinor: 12_000n,
      targetQuantity: 3,
    })).toEqual({
      entryAtOrBelowMinor: 2_750n,
      exitAtOrAboveMinor: 3_000n,
      targetQuantity: 3,
    });
    expect(() => rebasePriceBandForSplit({
      entryAtOrBelowMinor: 10_001n,
      exitAtOrAboveMinor: 11_000n,
      targetQuantity: 3,
    })).toThrow("cannot be represented exactly");
  });

  it("keeps raw post-split prices, accrues dividends once to prior-close holders, and leaves zero-trade win rate undefined", () => {
    const csv = raw0050Csv();
    const sourceSha256 = createHash("sha256").update(csv).digest("hex");
    const parsed = parseHistoricalCsv(csv, "0050", "synthetic split boundary", TWSE_PROFILE);
    const { selection, provenance } = artifacts(sourceSha256, parsed.rowCount);
    const result = evaluateSplitRebasedHistoricalBenchmark(
      parsed,
      sourceSha256,
      selection,
      provenance,
      SAMPLE_DIVIDENDS,
    );

    expect(result).toMatchObject({
      classification: "HISTORICAL_DIAGNOSTIC_ONLY",
      trueForwardStatus: "AWAITING_UNSEEN_DATA",
      sample: { start: "2025-06-18", end: "2025-08-08", rowCount: 6 },
    });
    const results = record(result["results"]);
    const champion = record(results["champion"]);
    const challenger = record(results["challenger"]);
    const benchmark = record(results["costMatchedBenchmark"]);
    expect(champion).toMatchObject({
      parameters: { entryAtOrBelowMinor: "2500", exitAtOrAboveMinor: "2750" },
      completedTradeCount: 0,
      rawNetWinRate: null,
      outcome: "NO_SIGNAL",
      openPositionQuantity: 0,
    });
    expect(challenger).toMatchObject({
      parameters: { entryAtOrBelowMinor: "2750", exitAtOrAboveMinor: "3000" },
      completedTradeCount: 0,
      rawNetWinRate: null,
      outcome: "NO_SIGNAL",
      openPositionQuantity: 0,
    });
    expect(champion["netReturnFraction"]).toBe("0.00000000");
    expect(champion["costMatchedBenchmark"]).toMatchObject({
      policy: "ALWAYS_LONG",
      completedTradeCount: 0,
      openPositionQuantity: 3,
      distributionIncomeMinor: "108",
    });
    expect(benchmark).toMatchObject({
      completedTradeCount: 0,
      openPositionQuantity: 3,
      distributionIncomeMinor: "108",
    });

    const benchmarkCurve = benchmark["dailyEquity"] as readonly Record<string, unknown>[];
    const exDate = benchmarkCurve.find((point) => point["date"] === "2025-07-21");
    const payDate = benchmarkCurve.find((point) => point["date"] === "2025-08-08");
    expect(exDate).toMatchObject({ dividendCashMinor: "0", dividendReceivableMinor: "108" });
    expect(payDate).toMatchObject({ dividendCashMinor: "108", dividendReceivableMinor: "0" });
    expect(benchmarkCurve).toHaveLength(6);
  });

  it("replays already archived fresh rows on the rebased thresholds without changing frozen artifacts", () => {
    const csv = [
      "symbol,date,open,high,low,close,volume",
      "0050,2026-08-12,105.00,105.25,104.45,105.20,1000",
      "0050,2026-08-13,106.55,107.00,106.15,106.70,1000",
      "0050,2026-08-14,107.10,107.50,106.05,106.40,1000",
    ].join("\n");
    const freshDataSha256 = createHash("sha256").update(csv).digest("hex");
    const historicalSourceSha256 = "a".repeat(64);
    const parsed = parseHistoricalCsv(csv, "0050", "synthetic fresh forward input", TWSE_PROFILE);
    const { selection } = artifacts(historicalSourceSha256, 1);
    const result = evaluateSplitRebasedForwardSample(
      parsed,
      freshDataSha256,
      historicalSourceSha256,
      selection,
      {
        schemaVersion: 1,
        artifactId: "0050-forward-v2",
        symbol: "0050",
        source: "reused local fixture",
        sha256: freshDataSha256,
        rowCount: parsed.rowCount,
        historicalCutoff: "2026-08-11",
        dateRange: { start: parsed.startDate, end: parsed.endDate },
      },
      {
        historicalCutoff: "2026-08-11",
        freshDataSha256,
        freshRowCount: parsed.rowCount,
        freshDateRange: { start: parsed.startDate, end: parsed.endDate },
      },
      [],
    );

    expect(result).toMatchObject({
      classification: "TRUE_FORWARD_SAMPLE_DIAGNOSTIC",
      status: "INSUFFICIENT_FRESH_TRADES",
      historicalCutoff: "2026-08-11",
      sample: { start: "2026-08-12", end: "2026-08-14", rowCount: 3 },
    });
    expect(record(result["champion"])).toMatchObject({
      parameters: { entryAtOrBelowMinor: "2500", exitAtOrAboveMinor: "2750" },
      completedTradeCount: 0,
      rawNetWinRate: null,
      outcome: "NO_SIGNAL",
      openPositionQuantity: 0,
      netReturnFraction: "0.00000000",
    });
    expect(record(result["challenger"])).toMatchObject({
      parameters: { entryAtOrBelowMinor: "2750", exitAtOrAboveMinor: "3000" },
      completedTradeCount: 0,
      rawNetWinRate: null,
      outcome: "NO_SIGNAL",
      openPositionQuantity: 0,
    });
    expect(record(result["costMatchedBenchmark"])).toMatchObject({
      completedTradeCount: 0,
      openPositionQuantity: 3,
      distributionIncomeMinor: "0",
    });
  });
});

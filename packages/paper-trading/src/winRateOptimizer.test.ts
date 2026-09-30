import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import {
  buildCandidateGrid,
  buildDevelopmentLayout,
  determinePromotionStatus,
  isDevelopmentEligible,
  optimizeParsedHistoricalData,
  type TradeCounts,
  type WinRateParameters,
} from "./winRateOptimizer.js";

const TWSE_PROFILE = "twse-daily-ohlcv-close-v1";
const CHAMPION: WinRateParameters = Object.freeze({
  entryAtOrBelowMinor: 10_000n,
  exitAtOrAboveMinor: 11_000n,
  targetQuantity: 3,
});

function counts(wins: number, losses: number, breakevens: number): TradeCounts {
  const completedTradeCount = wins + losses + breakevens;
  return {
    completedTradeCount,
    wins,
    losses,
    breakevens,
    netWinRate: completedTradeCount === 0 ? null : wins / completedTradeCount,
  };
}

function twseCsv(prices: readonly number[]): string {
  const rows = prices.map((price, index) => {
    const date = new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10);
    return `0050,${date},ignored,ignored,ignored,${price},ignored`;
  });
  return ["symbol,date,open,high,low,close,volume", ...rows].join("\n");
}

function repeatedMarketCsv(rowCount = 80): string {
  const pattern = [120, 80, 85, 130, 125, 90, 80, 130];
  return twseCsv(Array.from({ length: rowCount }, (_, index) => pattern[index % pattern.length]!));
}

function parseAndOptimize(contents: string): Record<string, unknown> {
  const parsed = parseHistoricalCsv(contents, "0050", "optimizer test input", TWSE_PROFILE);
  const inputSha256 = createHash("sha256").update(contents).digest("hex");
  return optimizeParsedHistoricalData(parsed, inputSha256);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("bounded win-rate optimizer", () => {
  it("freezes the first 80 percent for development and keeps rolling validation before the holdout", () => {
    const layout = buildDevelopmentLayout(1_599);
    expect(layout.developmentBoundary).toEqual({ startRow: 1, endRow: 1_279, rowCount: 1_279 });
    expect(layout.holdoutBoundary).toEqual({ startRow: 1_280, endRow: 1_599, rowCount: 320 });
    expect(layout.developmentFolds).toEqual([
      {
        id: "fold-1",
        trainingRows: { startRow: 1, endRow: 426, rowCount: 426 },
        validationRows: { startRow: 427, endRow: 853, rowCount: 427 },
      },
      {
        id: "fold-2",
        trainingRows: { startRow: 1, endRow: 853, rowCount: 853 },
        validationRows: { startRow: 854, endRow: 1_279, rowCount: 426 },
      },
    ]);
    for (const fold of layout.developmentFolds) {
      expect(fold.validationRows.startRow).toBeGreaterThan(fold.trainingRows.endRow);
      expect(fold.validationRows.endRow).toBeLessThanOrEqual(layout.developmentBoundary.endRow);
    }
  });

  it("does not let changed final-holdout rows affect the grid, development scores, or frozen choice", () => {
    const prices = Array.from({ length: 80 }, (_, index) => [120, 80, 85, 130, 125, 90, 80, 130][index % 8]!);
    const holdoutStart = Math.floor(prices.length * 0.8);
    const changedPrices = prices.map((price, index) => index < holdoutStart ? price : 20 + (index % 3));
    const original = parseAndOptimize(twseCsv(prices));
    const changed = parseAndOptimize(twseCsv(changedPrices));

    expect(changed["candidateGrid"]).toEqual(original["candidateGrid"]);
    expect(changed["selectedChallenger"]).toEqual(original["selectedChallenger"]);
    expect(asRecord(changed["champion"])).toMatchObject({
      developmentCompletedTrades: asRecord(original["champion"])["developmentCompletedTrades"],
      developmentWins: asRecord(original["champion"])["developmentWins"],
      developmentLosses: asRecord(original["champion"])["developmentLosses"],
      developmentBreakevens: asRecord(original["champion"])["developmentBreakevens"],
      developmentNetWinRate: asRecord(original["champion"])["developmentNetWinRate"],
    });
  });

  it("keeps the fixed candidate grid bounded, deterministic, and inclusive of the champion", () => {
    const first = buildCandidateGrid(CHAMPION);
    const second = buildCandidateGrid(CHAMPION);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(25);
    expect(first.some(({ parameters }) => (
      parameters.entryAtOrBelowMinor === CHAMPION.entryAtOrBelowMinor
      && parameters.exitAtOrAboveMinor === CHAMPION.exitAtOrAboveMinor
    ))).toBe(true);
    expect(first.every(({ parameters }) => parameters.targetQuantity === CHAMPION.targetQuantity)).toBe(true);
  });

  it("makes zero-trade and lower-activity candidates ineligible", () => {
    expect(isDevelopmentEligible(counts(0, 0, 0), 0)).toBe(false);
    expect(isDevelopmentEligible(counts(2, 0, 0), 3)).toBe(false);
    expect(isDevelopmentEligible(counts(1, 1, 1), 3)).toBe(true);
  });

  it("requires strictly higher holdout win rate and enough completed trades", () => {
    expect(determinePromotionStatus(counts(1, 1, 0), counts(2, 0, 0))).toBe("PROMOTE");
    expect(determinePromotionStatus(counts(1, 1, 0), counts(1, 1, 0))).toBe("NO_PROMOTION");
    expect(determinePromotionStatus(counts(2, 0, 0), counts(2, 0, 0))).toBe("CEILING_NO_PROMOTION");
    expect(determinePromotionStatus(counts(1, 2, 0), counts(1, 0, 0))).toBe("NO_PROMOTION");
    expect(determinePromotionStatus(counts(0, 0, 0), counts(1, 0, 0)))
      .toBe("INSUFFICIENT_CHAMPION_HOLDOUT_TRADES");
    expect(determinePromotionStatus(counts(1, 0, 0), counts(0, 0, 0)))
      .toBe("INSUFFICIENT_CHALLENGER_HOLDOUT_TRADES");
  });

  it("is reproducible and reconciles champion and challenger W/L/BE counts", () => {
    const csv = repeatedMarketCsv();
    const first = parseAndOptimize(csv);
    const repeated = parseAndOptimize(csv);
    expect(first).toEqual(repeated);

    const champion = asRecord(first["champion"]);
    expect(Number(champion["developmentWins"]) + Number(champion["developmentLosses"])
      + Number(champion["developmentBreakevens"])).toBe(champion["developmentCompletedTrades"]);
    expect(Number(champion["holdoutWins"]) + Number(champion["holdoutLosses"])
      + Number(champion["holdoutBreakevens"])).toBe(champion["holdoutCompletedTrades"]);
    const challenger = first["selectedChallenger"];
    if (challenger !== null) expect(asRecord(challenger)["frozenBeforeHoldout"]).toBe(true);
    const challengerHoldout = first["challengerHoldout"];
    if (challengerHoldout !== null) {
      const stats = asRecord(challengerHoldout);
      expect(Number(stats["wins"]) + Number(stats["losses"]) + Number(stats["breakevens"]))
        .toBe(stats["completedTradeCount"]);
    }
  });
});

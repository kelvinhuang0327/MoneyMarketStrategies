import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";
import {
  CROSS_SYMBOL_RESEARCH_RISK_V1,
  type CrossSymbolResearchRiskProfile,
} from "./crossSymbolResearchRisk.js";
import { rollingCloseZScore, RollingZScoreMeanReversionV1Strategy } from "./zscoreStrategy.js";
import {
  buildZScoreCandidateGrid,
  buildZScoreRollingOriginFolds,
  evaluateZScoreFold,
  isZScoreCandidateEligible,
  rankZScoreCandidates,
  selectRiskNormalizedZScoreWinRateCandidate,
  selectZScoreWinRateCandidate,
  serializeZScoreSelectionArtifact,
  ZSCORE_HISTORICAL_INPUT_PATH,
  ZSCORE_HISTORICAL_INPUT_SHA256,
  ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
  ZSCORE_SELECTION_ARTIFACT_PATH,
  ZSCORE_WIN_RATE_SYMBOLS,
  type ZScoreCandidateDiagnostics,
  type ZScoreParameters,
} from "./zscoreWinRateSelector.js";

const PROJECT_ROOT = resolve(process.cwd());

function diagnostic(
  candidateId: string,
  parameters: ZScoreParameters,
  wilson: number,
  rawNetWinRate: number,
  netPnl: string,
): ZScoreCandidateDiagnostics {
  return Object.freeze({
    candidateId,
    parameters,
    perSymbol: Object.freeze([]),
    aggregate: Object.freeze({
      completedTradeCount: 20,
      WIN: 10,
      LOSS: 10,
      BREAKEVEN: 0,
      rawNetWinRate,
      WilsonLowerBound95: wilson,
      netPnl,
      fees: "0.00",
    }),
    eligible: true,
    parameterDistanceFromGridCenter: 0,
  });
}

function parsedFlatSymbol(symbol: string) {
  const lines = ["date,symbol,close"];
  for (let index = 0; index < 8; index += 1) {
    const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
    lines.push(`${date},${symbol},100.00`);
  }
  return parseHistoricalCsv(`${lines.join("\n")}\n`, symbol, "synthetic selector fixture", "twse-daily-ohlcv-close-v1");
}

describe("z-score historical win-rate selection", () => {
  it("builds exactly the fixed 24-candidate grid", () => {
    const grid = buildZScoreCandidateGrid();
    expect(grid).toHaveLength(24);
    expect(new Set(grid.map(({ candidateId }) => candidateId)).size).toBe(24);
    expect(new Set(grid.map(({ parameters }) => parameters.lookback))).toEqual(new Set([20, 40]));
    expect(new Set(grid.map(({ parameters }) => parameters.entryZ))).toEqual(new Set([0.75, 1, 1.25]));
    expect(new Set(grid.map(({ parameters }) => parameters.exitZ))).toEqual(new Set([-0.25, 0]));
    expect(new Set(grid.map(({ parameters }) => parameters.maxHoldBars))).toEqual(new Set([10, 20]));
    expect(grid.every(({ parameters }) => Object.keys(parameters).sort().join(",") === "entryZ,exitZ,lookback,maxHoldBars")).toBe(true);
    expect(grid.every(({ parameters }) => !Object.hasOwn(parameters, "maxExposureMinor"))).toBe(true);
  });

  it("defines one fixed TWD research profile and keeps its artifact separate", () => {
    expect(CROSS_SYMBOL_RESEARCH_RISK_V1).toEqual({
      id: "CROSS_SYMBOL_RESEARCH_RISK_V1",
      initialCapitalMinor: 10_000_000n,
      maxExposureMinor: 2_000_000n,
      maxExposureFractionOfInitialCapital: 0.20,
      currency: "TWD",
      minorUnitsPerMajor: 100,
    });
    expect(ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH).toBe("packages/paper-trading/zscore-win-rate-strategy-risk-normalized-v1.json");
    expect(ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH).not.toBe(ZSCORE_SELECTION_ARTIFACT_PATH);
  });

  it("starts each validation fold strictly after its training prefix", () => {
    const folds = buildZScoreRollingOriginFolds(12);
    expect(folds).toHaveLength(3);
    expect(folds.map(({ trainingEndIndex, validationStartIndex, validationEndIndex }) => [
      trainingEndIndex, validationStartIndex, validationEndIndex,
    ])).toEqual([[3, 3, 6], [6, 6, 9], [9, 9, 12]]);
    expect(folds.every(({ trainingEndIndex, validationStartIndex }) => trainingEndIndex > 0 && validationStartIndex === trainingEndIndex)).toBe(true);
  });

  it("keeps the fixed four-of-five and pooled-trade eligibility gate", () => {
    expect(isZScoreCandidateEligible([10, 10, 10, 9, 0], 39, 0.2)).toBe(true);
    expect(isZScoreCandidateEligible([10, 10, 10, 1, 0], 31, 0.2)).toBe(false);
    expect(isZScoreCandidateEligible([4, 4, 4, 4, 0], 16, 0.2)).toBe(false);
    expect(isZScoreCandidateEligible([10, 10, 10, 9, 0], 39, null)).toBe(false);
  });

  it("ranks pooled Wilson lower bound before raw win rate", () => {
    const lowerWilson = diagnostic("raw-winner", { lookback: 20, entryZ: 1, exitZ: 0, maxHoldBars: 10 }, 0.31, 0.9, "99999.00");
    const higherWilson = diagnostic("wilson-winner", { lookback: 40, entryZ: 0.75, exitZ: -0.25, maxHoldBars: 20 }, 0.42, 0.5, "-99999.00");
    expect(rankZScoreCandidates([lowerWilson, higherWilson]).map(({ candidateId }) => candidateId))
      .toEqual(["wilson-winner", "raw-winner"]);
  });

  it("uses raw rate, grid-center distance, and lexical id only as ordered tie breaks", () => {
    const highRaw = diagnostic("raw", { lookback: 20, entryZ: 0.75, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.8, "-500.00");
    const lowRaw = diagnostic("low-raw", { lookback: 20, entryZ: 1, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.7, "900.00");
    expect(rankZScoreCandidates([lowRaw, highRaw])[0]?.candidateId).toBe("raw");

    const center = diagnostic("center", { lookback: 20, entryZ: 1, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.8, "-500.00");
    const farther = diagnostic("farther", { lookback: 20, entryZ: 0.75, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.8, "900.00");
    expect(rankZScoreCandidates([farther, center])[0]?.candidateId).toBe("center");

    const lexicalZ = diagnostic("z-candidate", center.parameters, 0.4, 0.8, "100000.00");
    const lexicalA = diagnostic("a-candidate", center.parameters, 0.4, 0.8, "-100000.00");
    expect(rankZScoreCandidates([lexicalZ, lexicalA]).map(({ candidateId }) => candidateId))
      .toEqual(["a-candidate", "z-candidate"]);
  });

  it("does not let P&L or fees affect ranking", () => {
    const negativePnlCloser = diagnostic("closer", { lookback: 20, entryZ: 1, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.8, "-999999.00");
    const positivePnlFarther = diagnostic("farther", { lookback: 20, entryZ: 0.75, exitZ: -0.25, maxHoldBars: 10 }, 0.4, 0.8, "999999.00");
    expect(rankZScoreCandidates([positivePnlFarther, negativePnlCloser])[0]?.candidateId).toBe("closer");
  });

  it("selects deterministically from the same historical fixture", () => {
    const parsedBySymbol = new Map(ZSCORE_WIN_RATE_SYMBOLS.map((symbol) => [symbol, parsedFlatSymbol(symbol)]));
    const first = selectZScoreWinRateCandidate(parsedBySymbol, "a".repeat(64));
    const second = selectZScoreWinRateCandidate(parsedBySymbol, "a".repeat(64));
    expect(serializeZScoreSelectionArtifact(first)).toBe(serializeZScoreSelectionArtifact(second));
    expect(first["selectionStatus"]).toBe("NO_ELIGIBLE_CANDIDATE");
    expect(first["candidateDiagnostics"]).toHaveLength(24);

    const normalizedFirst = selectRiskNormalizedZScoreWinRateCandidate(parsedBySymbol, "a".repeat(64));
    const normalizedSecond = selectRiskNormalizedZScoreWinRateCandidate(parsedBySymbol, "a".repeat(64));
    expect(serializeZScoreSelectionArtifact(normalizedFirst)).toBe(serializeZScoreSelectionArtifact(normalizedSecond));
    expect(normalizedFirst["riskProfile"]).toMatchObject({
      id: "CROSS_SYMBOL_RESEARCH_RISK_V1",
      initialCapitalMinor: 10_000_000,
      maxExposureMinor: 2_000_000,
      currency: "TWD",
      minorUnitsPerMajor: 100,
    });
  });

  it("preserves 2330 and 2454 entry signals while removing the exposure-only rejection", async () => {
    const bytes = await readFile(resolve(PROJECT_ROOT, ZSCORE_HISTORICAL_INPUT_PATH));
    const inputSha256 = createHash("sha256").update(bytes).digest("hex");
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const oldExposureProbe: CrossSymbolResearchRiskProfile = Object.freeze({
      ...CROSS_SYMBOL_RESEARCH_RISK_V1,
      maxExposureMinor: 50_000n,
    });

    for (const symbol of ["2330", "2454"] as const) {
      const parsed = parseHistoricalCsv(contents, symbol, ZSCORE_HISTORICAL_INPUT_PATH, "twse-daily-ohlcv-close-v1");
      let selected: { readonly index: number; readonly parameters: ZScoreParameters } | undefined;
      for (const { parameters } of buildZScoreCandidateGrid()) {
        const index = parsed.session.events.findIndex((event, eventIndex) => {
          if (event.priceMinor <= oldExposureProbe.maxExposureMinor) return false;
          const zScore = rollingCloseZScore(parsed.session.events.slice(0, eventIndex), event.priceMinor, parameters.lookback);
          return zScore !== null && zScore <= -parameters.entryZ;
        });
        if (index >= 1) {
          selected = { index, parameters };
          break;
        }
      }
      expect(selected, `${symbol} should have a historical high-price entry signal`).toBeDefined();
      const { index, parameters } = selected!;
      const event = parsed.session.events[index]!;
      const oneEventFold = Object.freeze({
        id: "risk-profile-probe",
        trainingEndIndex: index,
        validationStartIndex: index,
        validationEndIndex: index + 1,
      });
      const oldCapOutcome = evaluateZScoreFold(parsed, oneEventFold, parameters, inputSha256, oldExposureProbe);
      const normalizedOutcome = evaluateZScoreFold(
        parsed,
        oneEventFold,
        parameters,
        inputSha256,
        CROSS_SYMBOL_RESEARCH_RISK_V1,
      );
      expect(normalizedOutcome.entrySignalTrace).toEqual(oldCapOutcome.entrySignalTrace);
      expect(normalizedOutcome.entrySignalTrace).toEqual([{ timestamp: event.timestamp, zScore: expect.any(Number) }]);
      expect(normalizedOutcome.entryIntentCount).toBe(1);
      expect(oldCapOutcome.entryIntentCount).toBe(1);
      expect(oldCapOutcome.rejectedEntryOrderCountByReason["MAX_EXPOSURE_EXCEEDED"]).toBe(1);
      expect(normalizedOutcome.rejectedEntryOrderCountByReason["MAX_EXPOSURE_EXCEEDED"] ?? 0).toBe(0);
      expect(normalizedOutcome.acceptedEntryOrderCount).toBe(1);

      const nextEvent = parsed.session.events[index + 1];
      expect(nextEvent).toBeDefined();
      const strategy = new RollingZScoreMeanReversionV1Strategy({
        ...parameters,
        activeFromTimestamp: event.timestamp,
      });
      const sessionThroughNextEvent = Object.freeze({
        ...parsed.session,
        events: Object.freeze(parsed.session.events.slice(0, index + 2)),
      });
      const normalizedRun = runPaperSession(
        sessionThroughNextEvent,
        inputSha256,
        undefined,
        strategy,
        CROSS_SYMBOL_RESEARCH_RISK_V1,
      );
      const journal = normalizedRun["journal"] as readonly Record<string, unknown>[];
      const entryDecision = journal.find((row) => row.kind === "decision" && row.sourceEventId === event.eventId);
      const fill = journal.find((row) => row.kind === "fill");
      const account = normalizedRun["accountSummary"] as Record<string, unknown>;
      expect(entryDecision).toMatchObject({
        timestamp: event.timestamp,
        targetPositionQuantity: strategy.strategyParameters.targetQuantity,
        status: "order-submitted",
        reasonCode: "ORDER_ACCEPTED",
      });
      expect(fill).toMatchObject({ timestamp: nextEvent!.timestamp, sourceMarketEventId: nextEvent!.eventId });
      expect(account["cashMinor"]).toBeGreaterThanOrEqual(0n);
    }
  });

  it("leaves the pinned historical input bytes unchanged", async () => {
    const bytes = await readFile(resolve(PROJECT_ROOT, ZSCORE_HISTORICAL_INPUT_PATH));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ZSCORE_HISTORICAL_INPUT_SHA256);
  });
});

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  runWalkForwardThresholdEvaluation,
  summarizeWalkForwardStability,
} from "@mms/strategy-simulator";

import { findPriceDiscontinuities } from "./dataQuality.js";
import {
  AdjustedOhlcvQualificationError,
  buildTwseQualificationSnapshotFromFixture,
  classifyPointInTimeStatus,
  parseCommittedQualificationObservationsFromText,
  qualifyTwseSnapshot,
  TWSE_QUALIFICATION_FIXTURE_PAYLOADS,
} from "./twseAdjustedOhlcvQualification.js";
import {
  ADJUSTMENT_COVERAGE,
  applyBoundedAdjustment,
  buildScenarioFoldInputs,
  CANDIDATE_THRESHOLDS,
  CURRENT_DATE_PREDICTION_CLAIM,
  INITIAL_CAPITAL,
  parseTwStrategyResearchCsvText,
  PROMOTION_REASON,
  ROUND_TRIP_COST_BPS,
  TwStrategyResearchRunnerError,
  validateTwStrategyResearchRows,
  VOLUME_ADJUSTMENT_STATUS,
} from "./twStrategyResearchRunner.js";
import type { MarketDataRow } from "./types.js";

const DATA_END_DATE = "2026-07-01";

function addDaysIso(startIso: string, offset: number): string {
  const date = new Date(`${startIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic alternating-momentum walk: short blocks of consistent
 * up/down drift give `return_5d`/`return_20d` a learnable relationship with
 * the 5-row-forward target, so the fitted model's probabilityUp actually
 * spans a range that crosses the candidate thresholds in every fold
 * (a smooth single-direction or single-cycle walk tends to produce
 * degenerate all-cash calibration windows).
 */
function syntheticMarketRows(symbol: string, dayCount: number, startIso = "2024-01-01"): MarketDataRow[] {
  const blockLength = 8;
  let close = 100;
  return Array.from({ length: dayCount }, (_, index) => {
    const trendUp = Math.floor(index / blockLength) % 2 === 0;
    const dailyReturn = trendUp ? 0.014 : -0.014;
    const wiggle = 0.002 * Math.sin(index * 1.3);
    const previousClose = close;
    close = Number((close * (1 + dailyReturn + wiggle)).toFixed(6));
    const open = Number((previousClose * (1 + wiggle * 0.3)).toFixed(6));
    const high = Number((Math.max(open, close) * 1.004).toFixed(6));
    const low = Number((Math.min(open, close) * 0.996).toFixed(6));
    const volume = 1_000_000 + Math.round(50_000 * Math.abs(Math.sin(index * 0.53))) + 1;
    return {
      symbol,
      date: addDaysIso(startIso, index),
      open,
      high,
      low,
      close,
      volume,
      source: "synthetic-test-fixture",
    };
  });
}

function toCsvText(rows: readonly MarketDataRow[]): string {
  const header = "symbol,date,open,high,low,close,volume,source,fetched_at_utc";
  const lines = rows.map((row) =>
    [row.symbol, row.date, row.open, row.high, row.low, row.close, row.volume, row.source, "2026-07-01T00:00:00.000Z"]
      .join(","));
  return [header, ...lines].join("\n") + "\n";
}

describe("parseTwStrategyResearchCsvText + validateTwStrategyResearchRows (schema validation)", () => {
  const rows = [
    ...syntheticMarketRows("2330", 30),
    ...syntheticMarketRows("0050", 30),
  ];
  const csvText = toCsvText(rows);

  it("fails closed on a malformed header (missing required column)", () => {
    const headerless = csvText.split("\n").slice(1).join("\n");
    expect(() => parseTwStrategyResearchCsvText(headerless)).toThrow(/MALFORMED_CSV_HEADER/);
  });

  it("fails closed on a missing required symbol", () => {
    const parsed = parseTwStrategyResearchCsvText(csvText);
    expect(() =>
      validateTwStrategyResearchRows(parsed, {
        dataEndDate: DATA_END_DATE,
        requiredSymbols: ["2330", "0050", "2454"],
      })).toThrow(/MISSING_REQUIRED_SYMBOL/);
  });

  it("fails closed on a row dated after dataEndDate rather than silently truncating it", () => {
    const parsed = parseTwStrategyResearchCsvText(csvText);
    const withFutureRow = [...parsed, { ...parsed[0]!, date: "2099-01-01" }];
    expect(() =>
      validateTwStrategyResearchRows(withFutureRow, {
        dataEndDate: DATA_END_DATE,
        requiredSymbols: ["2330", "0050"],
      })).toThrow(/FUTURE_ROW/);
  });

  it("fails closed on a duplicate (symbol,date) row", () => {
    const parsed = parseTwStrategyResearchCsvText(csvText);
    const withDuplicate = [...parsed, parsed[0]!];
    expect(() =>
      validateTwStrategyResearchRows(withDuplicate, {
        dataEndDate: DATA_END_DATE,
        requiredSymbols: ["2330", "0050"],
      })).toThrow(TwStrategyResearchRunnerError);
  });

  it("fails closed on an invalid OHLCV domain (high below low)", () => {
    const invalidRows = [...rows];
    invalidRows[0] = { ...invalidRows[0]!, high: 1, low: 100 };
    expect(() => parseTwStrategyResearchCsvText(toCsvText(invalidRows))).toThrow(/INVALID_OHLCV/);
  });

  it("rejects a non-canonical dataEndDate", () => {
    const parsed = parseTwStrategyResearchCsvText(csvText);
    expect(() =>
      validateTwStrategyResearchRows(parsed, {
        dataEndDate: "2026/07/01",
        requiredSymbols: ["2330", "0050"],
      })).toThrow(/INVALID_DATA_END_DATE/);
  });

  it("accepts a well-formed pinned CSV and reports its date range and symbols", () => {
    const parsed = parseTwStrategyResearchCsvText(csvText);
    const validated = validateTwStrategyResearchRows(parsed, {
      dataEndDate: DATA_END_DATE,
      requiredSymbols: ["2330", "0050"],
    });
    expect(validated.symbolsPresent).toEqual(["0050", "2330"]);
    expect(validated.rows).toHaveLength(60);
    expect(validated.dateRange.min <= validated.dateRange.max).toBe(true);
  });
});

describe("buildScenarioFoldInputs determinism", () => {
  it("produces byte-identical serialized output across repeated calls on the same input", () => {
    const marketRows = syntheticMarketRows("2330", 160);
    const first = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
    const second = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces a historical latest signal, never claiming a current-date prediction", () => {
    const marketRows = syntheticMarketRows("2330", 160);
    const prep = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
    expect(prep.latestSignal.signalAsOfFeatureDate <= marketRows.at(-1)!.date).toBe(true);
    expect(prep.latestSignal.signalAsOfTargetDate <= marketRows.at(-1)!.date).toBe(true);
    expect(CURRENT_DATE_PREDICTION_CLAIM).toBe(false);
    expect(PROMOTION_REASON).toBe("STABILITY_GATE_EVIDENCE_ONLY_MANUAL_RESEARCH_REVIEW_REQUIRED");
  });
});

describe("three required scenarios (research-kernel + strategy-simulator composition)", () => {
  function runScenario(symbol: string, marketRows: readonly MarketDataRow[]) {
    const prep = buildScenarioFoldInputs(marketRows, { candidateThresholds: CANDIDATE_THRESHOLDS });
    const walkForward = runWalkForwardThresholdEvaluation({
      symbol,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
      folds: prep.foldInputs,
    });
    const stability = summarizeWalkForwardStability(walkForward);
    const operativeThreshold = walkForward.foldResults.at(-1)!.selectedThreshold;
    const position = prep.latestSignal.probabilityUp >= operativeThreshold ? "LONG" : "CASH";
    return { prep, walkForward, stability, position };
  }

  it("runs 2330_RAW_CONTROL end to end with no data-quality findings", () => {
    const marketRows = syntheticMarketRows("2330", 160);
    const result = runScenario("2330", marketRows);
    expect(result.prep.dataQualityFindings).toHaveLength(0);
    expect(result.walkForward.foldCount).toBe(3);
    expect(["LONG", "CASH"]).toContain(result.position);
  });

  it("runs 0050_RAW end to end", () => {
    const marketRows = syntheticMarketRows("0050", 160);
    const result = runScenario("0050", marketRows);
    expect(result.walkForward.foldCount).toBe(3);
    expect(Number.isFinite(result.walkForward.aggregateExcessReturn)).toBe(true);
  });

  it("runs 0050_SOURCE_QUALIFIED_ADJUSTED with a bounded event-only adjustment applied", () => {
    const rawRows = syntheticMarketRows("0050", 160);
    const splitIndex = 100;
    const effectiveDate = rawRows[splitIndex]!.date;
    const adjustmentFactor = 0.25;
    // Simulate a real split: pre-event raw prices are ~4x the post-event
    // scale (matching applyBoundedAdjustment's own contract, which shrinks
    // rows strictly before effectiveDate by adjustmentFactor).
    const inflatePreSplit = 1 / adjustmentFactor;
    const discontinuous = rawRows.map((row, index) =>
      index < splitIndex
        ? {
          ...row,
          open: row.open * inflatePreSplit,
          high: row.high * inflatePreSplit,
          low: row.low * inflatePreSplit,
          close: row.close * inflatePreSplit,
        }
        : row);

    const rawFindings = findPriceDiscontinuities(discontinuous, 0.5);
    expect(rawFindings.length).toBeGreaterThan(0);

    const adjusted = applyBoundedAdjustment(discontinuous, effectiveDate, adjustmentFactor);
    const adjustedFindings = findPriceDiscontinuities(adjusted, 0.5);
    expect(adjustedFindings.length).toBe(0);

    // volume is never touched by the bounded adjustment (VOLUME_ADJUSTMENT_STATUS=NOT_APPLIED)
    adjusted.forEach((row, index) => expect(row.volume).toBe(discontinuous[index]!.volume));
    // rows on/after effectiveDate are untouched (adjustment applies strictly before it)
    adjusted.filter((row) => row.date >= effectiveDate).forEach((row) => {
      const original = discontinuous.find((candidate) => candidate.date === row.date)!;
      expect(row.close).toBe(original.close);
    });
    expect(ADJUSTMENT_COVERAGE).toBe("BOUNDED_EVENT_ONLY");
    expect(VOLUME_ADJUSTMENT_STATUS).toBe("NOT_APPLIED");

    const result = runScenario("0050", adjusted);
    expect(result.walkForward.foldCount).toBe(3);
  });
});

describe("TWSE 0050/2330 adjustment qualification", () => {
  const FIXED_AS_OF = "2025-06-18T10:00:00.000Z";
  const committedCsvText =
    "symbol,date,close\n"
    + "0050,2025-06-10,188.65\n"
    + "0050,2025-06-18,47.57\n"
    + "2330,2025-06-10,1045\n"
    + "2330,2025-06-18,1055\n";

  function sha256OfText(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  function goldenSnapshot() {
    return buildTwseQualificationSnapshotFromFixture(
      {
        splitReference: sha256OfText(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference),
        stockDay0050: sha256OfText(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050),
        stockDay2330: sha256OfText(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330),
      },
      FIXED_AS_OF,
    );
  }

  it("reconciles the 0050 split and preserves a negative (no-event) 2330 control", () => {
    const committedObservations = parseCommittedQualificationObservationsFromText(committedCsvText);
    const result = qualifyTwseSnapshot(goldenSnapshot(), committedObservations, FIXED_AS_OF);
    expect(result.qualificationStatus).toBe("PASS");
    expect(result["0050Reconciliation"].status).toBe("RECONCILED");
    expect(result["2330Control"].status).toBe("PASS");
    expect(result["2330Control"].corporateActionReported).toBe(false);
    expect(result["2330Control"].fabricatedEvent).toBe(false);
  });

  it("fails closed if a corporate action is ever reported for the 2330 control symbol", () => {
    const committedObservations = parseCommittedQualificationObservationsFromText(committedCsvText);
    const snapshot = goldenSnapshot();
    const tampered = {
      ...snapshot,
      records: snapshot.records.map((record) =>
        record.symbol === "2330"
          ? { ...record, corporateActionType: "ETF_SPLIT" as const, adjustmentFactor: 0.25 }
          : record),
    };
    expect(() => qualifyTwseSnapshot(tampered, committedObservations, FIXED_AS_OF))
      .toThrow(AdjustedOhlcvQualificationError);
  });

  it("fails closed if the committed CSV omits a required symbol/date observation", () => {
    const incompleteCsvText = "symbol,date,close\n0050,2025-06-10,188.65\n";
    expect(() => parseCommittedQualificationObservationsFromText(incompleteCsvText))
      .toThrow(/COMMITTED_OBSERVATION_MISSING/);
  });

  it("rejects a source publication timestamp reported in the future relative to the as-of date", () => {
    expect(() =>
      classifyPointInTimeStatus(
        [{
          sourcePublicationAvailabilityTimestamp: "2030-01-01T00:00:00.000Z",
          timestampEvidence: "HISTORICAL_PUBLICATION",
          evidenceIdentifier: "future-publication-guard",
        }],
        "2025-01-01T00:00:00.000Z",
      )).toThrow(/FUTURE_PUBLICATION_FOR_AS_OF/);
  });
});

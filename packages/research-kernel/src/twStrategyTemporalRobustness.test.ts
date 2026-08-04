import { describe, expect, it } from "vitest";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";
import {
  filterRowsForCutoff,
  isCanonicalIsoDate,
  resolveDataEndDate,
  runTwStrategyTemporalRobustnessStudy,
  summarizeTemporalScenarioResults,
  TwStrategyTemporalRobustnessError,
  validateCutoffDates,
  type ScenarioCutoffSummaryInput,
} from "./twStrategyTemporalRobustness.js";

function makeMockRow(symbol: string, date: string): RawTwStrategyResearchRow {
  return {
    symbol,
    date,
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1000,
    source: "MOCK",
    fetched_at_utc: "2026-07-01T00:00:00Z",
  };
}

describe("twStrategyTemporalRobustness", () => {
  describe("date and cutoff validation", () => {
    it("validates canonical ISO date strings", () => {
      expect(isCanonicalIsoDate("2025-09-30")).toBe(true);
      expect(isCanonicalIsoDate("2025-09-31")).toBe(false);
      expect(isCanonicalIsoDate("2025-9-30")).toBe(false);
      expect(isCanonicalIsoDate("invalid-date")).toBe(false);
    });

    it("accepts strictly ascending valid cutoffs", () => {
      const input = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-07-01"];
      const validated = validateCutoffDates(input);
      expect(validated).toEqual(input);
    });

    it("rejects invalid date formats", () => {
      expect(() => validateCutoffDates(["2025-09-30", "2025-13-01"])).toThrow(
        TwStrategyTemporalRobustnessError,
      );
      expect(() => validateCutoffDates(["invalid"])).toThrow(
        TwStrategyTemporalRobustnessError,
      );
    });

    it("rejects duplicate cutoffs", () => {
      expect(() => validateCutoffDates(["2025-09-30", "2025-09-30"])).toThrow(
        TwStrategyTemporalRobustnessError,
      );
    });

    it("rejects unordered cutoffs", () => {
      expect(() => validateCutoffDates(["2025-12-31", "2025-09-30"])).toThrow(
        TwStrategyTemporalRobustnessError,
      );
    });
  });

  describe("source row filtering and resolution", () => {
    const rows = [
      makeMockRow("2330", "2025-09-29"),
      makeMockRow("2330", "2025-09-30"),
      makeMockRow("2330", "2025-10-01"),
    ];

    it("filters rows strictly on or before cutoff date", () => {
      const filtered = filterRowsForCutoff(rows, "2025-09-30");
      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.date <= "2025-09-30")).toBe(true);
    });

    it("resolves latest trading row date on or before cutoff", () => {
      const resolved = resolveDataEndDate(rows, "2025-09-30");
      expect(resolved).toBe("2025-09-30");
    });

    it("resolves earlier trading row date if cutoff is non-trading day", () => {
      const resolved = resolveDataEndDate(rows, "2025-09-29");
      expect(resolved).toBe("2025-09-29");
    });

    it("throws if no rows remain on or before cutoff", () => {
      expect(() => resolveDataEndDate(rows, "2025-01-01")).toThrow(
        TwStrategyTemporalRobustnessError,
      );
    });
  });

  describe("summarizeTemporalScenarioResults", () => {
    it("classifies ALWAYS_PASS when all cutoffs pass", () => {
      const runs: ScenarioCutoffSummaryInput[] = [
        { cutoffDate: "2025-09-30", overallPass: true, aggregateExcessReturn: 0.1, aggregateMaximumDrawdown: 0.05, dominantThresholdRatio: 0.8, operativePosition: "LONG", latestSignalAsOf: "2025-09-29" },
        { cutoffDate: "2025-12-31", overallPass: true, aggregateExcessReturn: 0.12, aggregateMaximumDrawdown: 0.04, dominantThresholdRatio: 0.8, operativePosition: "LONG", latestSignalAsOf: "2025-12-30" },
      ];
      const summary = summarizeTemporalScenarioResults("0050_RAW", runs);
      expect(summary.temporalAcceptanceClassification).toBe("ALWAYS_PASS");
      expect(summary.passCount).toBe(2);
      expect(summary.failCount).toBe(0);
    });

    it("classifies ALWAYS_FAIL when all cutoffs fail", () => {
      const runs: ScenarioCutoffSummaryInput[] = [
        { cutoffDate: "2025-09-30", overallPass: false, aggregateExcessReturn: -0.1, aggregateMaximumDrawdown: 0.25, dominantThresholdRatio: 0.4, operativePosition: "CASH", latestSignalAsOf: "2025-09-29" },
        { cutoffDate: "2025-12-31", overallPass: false, aggregateExcessReturn: -0.05, aggregateMaximumDrawdown: 0.20, dominantThresholdRatio: 0.5, operativePosition: "CASH", latestSignalAsOf: "2025-12-30" },
      ];
      const summary = summarizeTemporalScenarioResults("0050_RAW", runs);
      expect(summary.temporalAcceptanceClassification).toBe("ALWAYS_FAIL");
      expect(summary.passCount).toBe(0);
      expect(summary.failCount).toBe(2);
    });

    it("classifies MIXED when cutoffs have both pass and fail", () => {
      const runs: ScenarioCutoffSummaryInput[] = [
        { cutoffDate: "2025-09-30", overallPass: true, aggregateExcessReturn: 0.1, aggregateMaximumDrawdown: 0.05, dominantThresholdRatio: 0.8, operativePosition: "LONG", latestSignalAsOf: "2025-09-29" },
        { cutoffDate: "2025-12-31", overallPass: false, aggregateExcessReturn: -0.05, aggregateMaximumDrawdown: 0.20, dominantThresholdRatio: 0.5, operativePosition: "CASH", latestSignalAsOf: "2025-12-30" },
      ];
      const summary = summarizeTemporalScenarioResults("0050_RAW", runs);
      expect(summary.temporalAcceptanceClassification).toBe("MIXED");
      expect(summary.passCount).toBe(1);
      expect(summary.failCount).toBe(1);
    });
  });

  describe("runTwStrategyTemporalRobustnessStudy", () => {
    const mockRows = Array.from({ length: 50 }, (_, i) => {
      const d = new Date("2025-01-01");
      d.setDate(d.getDate() + i * 7);
      const iso = d.toISOString().slice(0, 10);
      return makeMockRow("2330", iso);
    });

    it("executes study deterministically without mutating input", () => {
      const inputCopy = JSON.parse(JSON.stringify(mockRows));
      const cutoffs = ["2025-06-30", "2025-09-30"];

      const executeCutoffScenarios = ({ requestedCutoffDate }: { requestedCutoffDate: string }) => {
        const mockSummaryInput = (pass: boolean): ScenarioCutoffSummaryInput => ({
          cutoffDate: requestedCutoffDate,
          overallPass: pass,
          aggregateExcessReturn: 0.05,
          aggregateMaximumDrawdown: 0.1,
          dominantThresholdRatio: 0.7,
          operativePosition: "LONG",
          latestSignalAsOf: requestedCutoffDate,
        });

        return {
          scenarios: {
            "2330_RAW_CONTROL": { id: "2330_RAW_CONTROL" },
            "0050_RAW": { id: "0050_RAW" },
            "0050_SOURCE_QUALIFIED_ADJUSTED": { id: "0050_SOURCE_QUALIFIED_ADJUSTED" },
          },
          scenarioSummaryInputs: {
            "2330_RAW_CONTROL": mockSummaryInput(true),
            "0050_RAW": mockSummaryInput(false),
            "0050_SOURCE_QUALIFIED_ADJUSTED": mockSummaryInput(true),
          },
        };
      };

      const result1 = runTwStrategyTemporalRobustnessStudy({
        rawRows: mockRows,
        cutoffDates: cutoffs,
        source: { path: "dummy.csv", sha256: "abc" },
        policy: { policyId: "TEST_POLICY" },
        reviewDate: "2026-07-31",
        executeCutoffScenarios,
      });

      const result2 = runTwStrategyTemporalRobustnessStudy({
        rawRows: mockRows,
        cutoffDates: cutoffs,
        source: { path: "dummy.csv", sha256: "abc" },
        policy: { policyId: "TEST_POLICY" },
        reviewDate: "2026-07-31",
        executeCutoffScenarios,
      });

      expect(mockRows).toEqual(inputCopy);
      expect(result1.studySha256).toBe(result2.studySha256);
      expect(result1.schemaVersion).toBe("MMS_TW_STRATEGY_TEMPORAL_ROBUSTNESS_STUDY_V1");
      expect(result1.scenarioOrder).toEqual([
        "2330_RAW_CONTROL",
        "0050_RAW",
        "0050_SOURCE_QUALIFIED_ADJUSTED",
      ]);
      expect(result1.temporalSummaries["2330_RAW_CONTROL"]!.temporalAcceptanceClassification).toBe("ALWAYS_PASS");
      expect(result1.temporalSummaries["0050_RAW"]!.temporalAcceptanceClassification).toBe("ALWAYS_FAIL");

      // Verify no ranking or recommendation fields exist on result object
      const resRecord = result1 as Record<string, unknown>;
      expect(resRecord["bestScenario"]).toBeUndefined();
      expect(resRecord["rank"]).toBeUndefined();
      expect(resRecord["recommendation"]).toBeUndefined();
      expect(resRecord["score"]).toBeUndefined();
    });
  });
});

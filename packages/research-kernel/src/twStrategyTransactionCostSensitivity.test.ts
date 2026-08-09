import { describe, expect, it } from "vitest";
import {
  runTwStrategyTransactionCostSensitivityStudy,
  summarizeTransactionCostSensitivityScenarioResults,
  TwStrategyTransactionCostSensitivityError,
  validateRoundTripCostBpsGrid,
} from "./twStrategyTransactionCostSensitivity.js";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";
import {
  runTwStrategyTemporalRobustnessStudy,
  type ScenarioCutoffSummaryInput,
} from "./twStrategyTemporalRobustness.js";
import { TW_STABILITY_RESEARCH_POLICY_V1 } from "@mms/strategy-simulator";

type CostSensitivityExecutionArgs = {
  readonly requestedCutoffDate: string;
  readonly resolvedDataEndDate: string;
  readonly cutoffRawRows: readonly RawTwStrategyResearchRow[];
  readonly roundTripCostBps: number;
};

const PROHIBITED_PUBLIC_FIELD_NAMES = new Set([
  "bestCost",
  "recommendedCost",
  "bestStrategy",
  "ranking",
  "score",
  "automaticPromotion",
]);

function collectObjectKeys(value: unknown, keys = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (value === null || typeof value !== "object" || seen.has(value)) return keys;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys, seen);
    return keys;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(child, keys, seen);
  }
  return keys;
}

function makeMockRawRow(): RawTwStrategyResearchRow {
  return {
    date: "2025-01-02",
    symbol: "2330",
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    source: "MOCK",
    fetched_at_utc: "2026-07-01T00:00:00Z",
  };
}

describe("twStrategyTransactionCostSensitivity", () => {
  describe("validateRoundTripCostBpsGrid", () => {
    it("accepts valid ordered cost grid", () => {
      const grid = [0, 10, 20, 30, 50];
      const validated = validateRoundTripCostBpsGrid(grid);
      expect(validated).toEqual([0, 10, 20, 30, 50]);
      expect(Object.isFrozen(validated)).toBe(true);
    });

    it("rejects empty cost list", () => {
      expect(() => validateRoundTripCostBpsGrid([])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("EMPTY_COST_GRID");
      }
    });

    it("rejects duplicate costs", () => {
      expect(() => validateRoundTripCostBpsGrid([0, 10, 10, 20])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([0, 10, 10, 20]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("DUPLICATE_COSTS");
      }
    });

    it("rejects unordered costs", () => {
      expect(() => validateRoundTripCostBpsGrid([0, 20, 10, 30])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([0, 20, 10, 30]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("UNORDERED_COSTS");
      }
    });

    it("rejects negative cost", () => {
      expect(() => validateRoundTripCostBpsGrid([-10, 0, 10])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([-10, 0, 10]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("INVALID_ROUND_TRIP_COST_BPS");
      }
    });

    it("rejects non-integer cost", () => {
      expect(() => validateRoundTripCostBpsGrid([0, 10.5, 20])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([0, 10.5, 20]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("INVALID_ROUND_TRIP_COST_BPS");
      }
    });

    it("rejects over-limit cost", () => {
      expect(() => validateRoundTripCostBpsGrid([0, 10, 10001])).toThrow(TwStrategyTransactionCostSensitivityError);
      try {
        validateRoundTripCostBpsGrid([0, 10, 10001]);
      } catch (err) {
        expect((err as TwStrategyTransactionCostSensitivityError).code).toBe("OVER_LIMIT_COST");
      }
    });
  });

  describe("summarizeTransactionCostSensitivityScenarioResults", () => {
    const mockOrderedCosts = [0, 10, 20];
    const mockOrderedCutoffs = ["2025-09-30", "2025-12-31"];

    function createMockStudyResult(gateMap: Readonly<Record<string, "PASS" | "FAIL">>) {
      return runTwStrategyTemporalRobustnessStudy({
        rawRows: [makeMockRawRow()],
        cutoffDates: mockOrderedCutoffs,
        source: { path: "dummy.csv", sha256: "abc" },
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        reviewDate: "2026-07-31",
        executeCutoffScenarios: ({ requestedCutoffDate }) => {
          const gateStatus = gateMap[requestedCutoffDate];
          if (gateStatus === undefined) throw new Error(`missing mock gate status for ${requestedCutoffDate}`);

          const createSummaryInput = (overallPass: boolean): ScenarioCutoffSummaryInput => ({
            cutoffDate: requestedCutoffDate,
            overallPass,
            aggregateExcessReturn: 0.05,
            aggregateMaximumDrawdown: 0.1,
            dominantThresholdRatio: 0.5,
            operativePosition: "LONG",
            latestSignalAsOf: "2025-09-30",
          });

          return {
            scenarios: {
              "2330_RAW_CONTROL": { overallPass: gateStatus === "PASS" },
              "0050_RAW": { overallPass: true },
              "0050_SOURCE_QUALIFIED_ADJUSTED": { overallPass: true },
            },
            scenarioSummaryInputs: {
              "2330_RAW_CONTROL": createSummaryInput(gateStatus === "PASS"),
              "0050_RAW": createSummaryInput(true),
              "0050_SOURCE_QUALIFIED_ADJUSTED": createSummaryInput(true),
            },
          };
        },
      });
    }

    it("classifies PASS_AT_ALL_COSTS_AND_CUTOFFS when all cells pass", () => {
      const mockStudies = {
        "0": createMockStudyResult({ "2025-09-30": "PASS", "2025-12-31": "PASS" }),
        "10": createMockStudyResult({ "2025-09-30": "PASS", "2025-12-31": "PASS" }),
        "20": createMockStudyResult({ "2025-09-30": "PASS", "2025-12-31": "PASS" }),
      };
      const summary = summarizeTransactionCostSensitivityScenarioResults(
        "2330_RAW_CONTROL",
        mockOrderedCosts,
        mockOrderedCutoffs,
        mockStudies,
      );
      expect(summary.costSensitivityClassification).toBe("PASS_AT_ALL_COSTS_AND_CUTOFFS");
      expect(summary.passCountAcrossAllCells).toBe(6);
      expect(summary.failCountAcrossAllCells).toBe(0);
    });

    it("classifies FAIL_AT_ALL_COSTS_AND_CUTOFFS when all cells fail", () => {
      const mockStudies = {
        "0": createMockStudyResult({ "2025-09-30": "FAIL", "2025-12-31": "FAIL" }),
        "10": createMockStudyResult({ "2025-09-30": "FAIL", "2025-12-31": "FAIL" }),
        "20": createMockStudyResult({ "2025-09-30": "FAIL", "2025-12-31": "FAIL" }),
      };
      const summary = summarizeTransactionCostSensitivityScenarioResults(
        "2330_RAW_CONTROL",
        mockOrderedCosts,
        mockOrderedCutoffs,
        mockStudies,
      );
      expect(summary.costSensitivityClassification).toBe("FAIL_AT_ALL_COSTS_AND_CUTOFFS");
      expect(summary.passCountAcrossAllCells).toBe(0);
      expect(summary.failCountAcrossAllCells).toBe(6);
    });

    it("classifies MIXED_ACROSS_COSTS_OR_CUTOFFS when pass/fail results vary", () => {
      const mockStudies = {
        "0": createMockStudyResult({ "2025-09-30": "PASS", "2025-12-31": "PASS" }),
        "10": createMockStudyResult({ "2025-09-30": "PASS", "2025-12-31": "FAIL" }),
        "20": createMockStudyResult({ "2025-09-30": "FAIL", "2025-12-31": "FAIL" }),
      };
      const summary = summarizeTransactionCostSensitivityScenarioResults(
        "2330_RAW_CONTROL",
        mockOrderedCosts,
        mockOrderedCutoffs,
        mockStudies,
      );
      expect(summary.costSensitivityClassification).toBe("MIXED_ACROSS_COSTS_OR_CUTOFFS");
      expect(summary.passCountAcrossAllCells).toBe(3);
      expect(summary.failCountAcrossAllCells).toBe(3);
    });
  });

  describe("runTwStrategyTransactionCostSensitivityStudy structure and contracts", () => {
    it("does not contain ranking, recommendation, or optimization fields", () => {
      const input = {
        rawRows: [makeMockRawRow()],
        cutoffDates: ["2025-09-30"],
        roundTripCostBpsValues: [0, 10],
        source: { path: "dummy.csv", sha256: "abc" },
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        reviewDate: "2026-07-31",
        executeCutoffScenariosAtCost: (args: CostSensitivityExecutionArgs) => ({
          scenarios: {
            "2330_RAW_CONTROL": { overallPass: true },
            "0050_RAW": { overallPass: false },
            "0050_SOURCE_QUALIFIED_ADJUSTED": { overallPass: true },
          },
          scenarioSummaryInputs: {
            "2330_RAW_CONTROL": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: true,
              aggregateExcessReturn: 0.1,
              aggregateMaximumDrawdown: 0.05,
              dominantThresholdRatio: 0.5,
              operativePosition: "LONG",
              latestSignalAsOf: "2025-09-30",
            },
            "0050_RAW": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: false,
              aggregateExcessReturn: -0.02,
              aggregateMaximumDrawdown: 0.15,
              dominantThresholdRatio: 0.5,
              operativePosition: "CASH",
              latestSignalAsOf: "2025-09-30",
            },
            "0050_SOURCE_QUALIFIED_ADJUSTED": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: true,
              aggregateExcessReturn: 0.08,
              aggregateMaximumDrawdown: 0.06,
              dominantThresholdRatio: 0.5,
              operativePosition: "LONG",
              latestSignalAsOf: "2025-09-30",
            },
          },
        }),
      };

      const result = runTwStrategyTransactionCostSensitivityStudy(input);
      const objectKeys = collectObjectKeys(result);

      expect(result.schemaVersion).toBe("MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1");
      expect(result.providesInvestmentAdvice).toBe(false);
      for (const prohibitedFieldName of PROHIBITED_PUBLIC_FIELD_NAMES) {
        expect(objectKeys.has(prohibitedFieldName)).toBe(false);
      }
      expect(result.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining("No promotion, ranking, cost optimization")]),
      );
    });

    it("does not mutate caller input", () => {
      const rawRowsInput = [makeMockRawRow()];
      const cutoffsInput = ["2025-09-30"];
      const costsInput = [0, 10, 20];

      const input = {
        rawRows: rawRowsInput,
        cutoffDates: cutoffsInput,
        roundTripCostBpsValues: costsInput,
        source: { path: "dummy.csv", sha256: "abc" },
        policy: TW_STABILITY_RESEARCH_POLICY_V1,
        reviewDate: "2026-07-31",
        executeCutoffScenariosAtCost: (args: CostSensitivityExecutionArgs) => ({
          scenarios: {
            "2330_RAW_CONTROL": {},
            "0050_RAW": {},
            "0050_SOURCE_QUALIFIED_ADJUSTED": {},
          },
          scenarioSummaryInputs: {
            "2330_RAW_CONTROL": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: true,
              aggregateExcessReturn: 0.1,
              aggregateMaximumDrawdown: 0.05,
              dominantThresholdRatio: 0.5,
              operativePosition: "LONG",
              latestSignalAsOf: "2025-09-30",
            },
            "0050_RAW": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: true,
              aggregateExcessReturn: 0.1,
              aggregateMaximumDrawdown: 0.05,
              dominantThresholdRatio: 0.5,
              operativePosition: "LONG",
              latestSignalAsOf: "2025-09-30",
            },
            "0050_SOURCE_QUALIFIED_ADJUSTED": {
              cutoffDate: args.requestedCutoffDate,
              overallPass: true,
              aggregateExcessReturn: 0.1,
              aggregateMaximumDrawdown: 0.05,
              dominantThresholdRatio: 0.5,
              operativePosition: "LONG",
              latestSignalAsOf: "2025-09-30",
            },
          },
        }),
      };

      runTwStrategyTransactionCostSensitivityStudy(input);

      expect(rawRowsInput.length).toBe(1);
      expect(cutoffsInput).toEqual(["2025-09-30"]);
      expect(costsInput).toEqual([0, 10, 20]);
    });
  });
});

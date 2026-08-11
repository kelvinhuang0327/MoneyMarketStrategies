import { describe, expect, it } from "vitest";
import {
  runTwStrategyTransactionCostSensitivityStudy,
  validateCostGridBps,
  TwStrategyTransactionCostSensitivityError,
  type ScenarioCutoffSummaryInput,
} from "./twStrategyTransactionCostSensitivity.js";
import type { RawTwStrategyResearchRow } from "./twStrategyResearchRunner.js";

function makeSyntheticRow(date: string, symbol: string, open: number, close: number): RawTwStrategyResearchRow {
  return {
    date,
    symbol,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1000,
  };
}

function makeSyntheticRows(dates: string[]): RawTwStrategyResearchRow[] {
  const rows: RawTwStrategyResearchRow[] = [];
  for (const d of dates) {
    rows.push(makeSyntheticRow(d, "2330", 100, 101));
    rows.push(makeSyntheticRow(d, "0050", 50, 51));
  }
  return rows;
}

const DUMMY_POLICY = Object.freeze({
  minimumFoldCount: 3,
  minimumPositiveExcessReturnFoldRatio: 0.66,
  minimumMedianValidationExcessReturn: 0,
  minimumAggregateExcessReturn: 0,
  maximumAggregateDrawdown: 0.35,
  maximumDominantThresholdRatio: 0.67,
});

describe("validateCostGridBps", () => {
  it("rejects empty cost grid", () => {
    expect(() => validateCostGridBps([])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("INVALID_COST_GRID");
    }
  });

  it("rejects non-integer costs", () => {
    expect(() => validateCostGridBps([10.5])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([10.5]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("INVALID_COST_GRID");
    }
  });

  it("rejects negative costs", () => {
    expect(() => validateCostGridBps([-10])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([-10]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("INVALID_COST_GRID");
    }
  });

  it("rejects duplicate costs", () => {
    expect(() => validateCostGridBps([10, 10])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([10, 10]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("DUPLICATE_COSTS");
    }
  });

  it("rejects unordered costs", () => {
    expect(() => validateCostGridBps([20, 10])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([20, 10]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("UNORDERED_COST_GRID");
    }
  });

  it("rejects costs over limit of 10000 bps", () => {
    expect(() => validateCostGridBps([10001])).toThrowError(TwStrategyTransactionCostSensitivityError);
    try {
      validateCostGridBps([10001]);
    } catch (e) {
      expect((e as TwStrategyTransactionCostSensitivityError).code).toBe("COST_OUT_OF_RANGE");
    }
  });

  it("accepts valid strictly ascending cost grid and freezes it without mutating input", () => {
    const input = [0, 10, 20, 30, 50];
    const inputCopy = [...input];
    const validated = validateCostGridBps(input);
    expect(validated).toEqual([0, 10, 20, 30, 50]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(input).toEqual(inputCopy);
  });
});

describe("runTwStrategyTransactionCostSensitivityStudy", () => {
  const dates = ["2025-01-01", "2025-06-01", "2025-09-30", "2025-12-31", "2026-03-31", "2026-07-01"];
  const rawRows = makeSyntheticRows(dates);
  const cutoffDates = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-07-01"];
  const roundTripCostBpsList = [0, 10, 20, 30, 50];

  const dummyExecutor = (passOverride?: boolean) => {
    return (args: {
      requestedCutoffDate: string;
      resolvedDataEndDate: string;
      cutoffRawRows: readonly RawTwStrategyResearchRow[];
      roundTripCostBps: number;
    }) => {
      const scenarios: Record<string, { pass: boolean; cost: number }> = {
        "2330_RAW_CONTROL": { pass: passOverride ?? true, cost: args.roundTripCostBps },
        "0050_RAW": { pass: passOverride ?? true, cost: args.roundTripCostBps },
        "0050_SOURCE_QUALIFIED_ADJUSTED": { pass: passOverride ?? true, cost: args.roundTripCostBps },
      };

      const scenarioSummaryInputs: Record<string, ScenarioCutoffSummaryInput> = {
        "2330_RAW_CONTROL": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: passOverride ?? true,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_RAW": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: passOverride ?? true,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_SOURCE_QUALIFIED_ADJUSTED": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: passOverride ?? true,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
      };

      return { scenarios, scenarioSummaryInputs };
    };
  };

  it("produces deterministic result with correct classifications and fixed orders", () => {
    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: dummyExecutor(true),
    });

    expect(result.schemaVersion).toBe("MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1");
    expect(result.classification).toBe("MMS_TW_STRATEGY_TRANSACTION_COST_SENSITIVITY_STUDY_V1_IMPLEMENTED_AWAITING_AUTHORIZATION");
    expect(result.requestedCostGridBps).toEqual([0, 10, 20, 30, 50]);
    expect(result.requestedCutoffDates).toEqual(["2025-09-30", "2025-12-31", "2026-03-31", "2026-07-01"]);
    expect(result.scenarioOrder).toEqual(["2330_RAW_CONTROL", "0050_RAW", "0050_SOURCE_QUALIFIED_ADJUSTED"]);

    const summary = result.sensitivitySummaries["2330_RAW_CONTROL"]!;
    expect(summary.costSensitivityClassification).toBe("PASS_AT_ALL_COSTS_AND_CUTOFFS");
    expect(summary.passCountAcrossAllCells).toBe(20);
    expect(summary.failCountAcrossAllCells).toBe(0);
    expect(result.studySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("correctly classifies FAIL_AT_ALL_COSTS_AND_CUTOFFS", () => {
    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: dummyExecutor(false),
    });

    const summary = result.sensitivitySummaries["2330_RAW_CONTROL"]!;
    expect(summary.costSensitivityClassification).toBe("FAIL_AT_ALL_COSTS_AND_CUTOFFS");
    expect(summary.passCountAcrossAllCells).toBe(0);
    expect(summary.failCountAcrossAllCells).toBe(20);
  });

  it("correctly classifies MIXED_ACROSS_COSTS_OR_CUTOFFS", () => {
    const mixedExecutor = (args: {
      requestedCutoffDate: string;
      resolvedDataEndDate: string;
      cutoffRawRows: readonly RawTwStrategyResearchRow[];
      roundTripCostBps: number;
    }) => {
      const pass = args.roundTripCostBps <= 10;
      const scenarios: Record<string, { pass: boolean }> = {
        "2330_RAW_CONTROL": { pass },
        "0050_RAW": { pass },
        "0050_SOURCE_QUALIFIED_ADJUSTED": { pass },
      };

      const scenarioSummaryInputs: Record<string, ScenarioCutoffSummaryInput> = {
        "2330_RAW_CONTROL": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: pass,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_RAW": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: pass,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_SOURCE_QUALIFIED_ADJUSTED": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: pass,
          aggregateExcessReturn: 0.1,
          aggregateMaximumDrawdown: 0.05,
          dominantThresholdRatio: 0.5,
          operativePosition: "LONG",
          latestSignalAsOf: args.resolvedDataEndDate,
        },
      };

      return { scenarios, scenarioSummaryInputs };
    };

    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: mixedExecutor,
    });

    const summary = result.sensitivitySummaries["2330_RAW_CONTROL"]!;
    expect(summary.costSensitivityClassification).toBe("MIXED_ACROSS_COSTS_OR_CUTOFFS");
    expect(summary.passCountAcrossAllCells).toBe(8); // 2 costs (0, 10) * 4 cutoffs
    expect(summary.failCountAcrossAllCells).toBe(12); // 3 costs (20, 30, 50) * 4 cutoffs
  });

  it("does not expose ranking, recommendation, or optimization fields", () => {
    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: dummyExecutor(true),
    });

    const keys = Object.keys(result);
    expect(keys).not.toContain("bestCost");
    expect(keys).not.toContain("recommendedCost");
    expect(keys).not.toContain("bestStrategy");
    expect(keys).not.toContain("rank");
    expect(keys).not.toContain("score");
    expect(keys).not.toContain("optimizationResult");
    expect(keys).not.toContain("promotion");
  });

  it("treats non-boolean overallPass values ('FAIL' string or object) strictly as boolean FAIL", () => {
    const invalidTypeExecutor = (args: {
      requestedCutoffDate: string;
      resolvedDataEndDate: string;
      cutoffRawRows: readonly RawTwStrategyResearchRow[];
      roundTripCostBps: number;
    }) => {
      const scenarios = {
        "2330_RAW_CONTROL": { pass: false },
        "0050_RAW": { pass: false },
        "0050_SOURCE_QUALIFIED_ADJUSTED": { pass: false },
      };

      const scenarioSummaryInputs = {
        "2330_RAW_CONTROL": {
          cutoffDate: args.requestedCutoffDate,
          // Intentionally passing truthy non-boolean string "FAIL"
          overallPass: "FAIL" as unknown as boolean,
          aggregateExcessReturn: -0.1,
          aggregateMaximumDrawdown: 0.2,
          dominantThresholdRatio: 0.5,
          operativePosition: "CASH" as const,
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_RAW": {
          cutoffDate: args.requestedCutoffDate,
          // Intentionally passing truthy non-boolean object
          overallPass: { overallPass: false } as unknown as boolean,
          aggregateExcessReturn: -0.1,
          aggregateMaximumDrawdown: 0.2,
          dominantThresholdRatio: 0.5,
          operativePosition: "CASH" as const,
          latestSignalAsOf: args.resolvedDataEndDate,
        },
        "0050_SOURCE_QUALIFIED_ADJUSTED": {
          cutoffDate: args.requestedCutoffDate,
          overallPass: false,
          aggregateExcessReturn: -0.1,
          aggregateMaximumDrawdown: 0.2,
          dominantThresholdRatio: 0.5,
          operativePosition: "CASH" as const,
          latestSignalAsOf: args.resolvedDataEndDate,
        },
      };

      return { scenarios, scenarioSummaryInputs };
    };

    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: invalidTypeExecutor,
    });

    for (const scenarioId of ["2330_RAW_CONTROL", "0050_RAW", "0050_SOURCE_QUALIFIED_ADJUSTED"]) {
      const summary = result.sensitivitySummaries[scenarioId]!;
      expect(summary.costSensitivityClassification).toBe("FAIL_AT_ALL_COSTS_AND_CUTOFFS");
      expect(summary.passCountAcrossAllCells).toBe(0);
      expect(summary.failCountAcrossAllCells).toBe(20);
    }
  });

  it("verifies invariant passCountAcrossAllCells + failCountAcrossAllCells === costCount * cutoffCount", () => {
    const result = runTwStrategyTransactionCostSensitivityStudy({
      rawRows,
      cutoffDates,
      roundTripCostBpsList,
      source: { path: "dummy.csv", sha256: "abc123" },
      policy: DUMMY_POLICY,
      reviewDate: "2026-07-31",
      executeCutoffCostScenarios: dummyExecutor(true),
    });

    for (const scenarioId of result.scenarioOrder) {
      const summary = result.sensitivitySummaries[scenarioId]!;
      expect(summary.passCountAcrossAllCells + summary.failCountAcrossAllCells).toBe(summary.costCount * summary.cutoffCount);
      for (const cost of roundTripCostBpsList) {
        const costKey = String(cost);
        expect(summary.passCountByCost[costKey]! + summary.failCountByCost[costKey]!).toBe(summary.cutoffCount);
      }
    }
  });
});


import { describe, expect, it } from "vitest";

import {
  simulateLongCashReplay,
  validateLongCashReplay,
  type LongCashReplayIntegrityReport,
  type LongCashReplayResult,
} from "./index.js";

function dateAtOffset(dayOffset: number): string {
  return new Date(Date.UTC(2024, 0, 1 + dayOffset)).toISOString().slice(0, 10);
}

function makeReplay(options: {
  readonly returns: readonly number[];
  readonly probabilities?: readonly number[];
  readonly roundTripCostBps?: number;
}): LongCashReplayResult {
  const probabilities = options.probabilities ?? options.returns.map(() => 0.8);
  if (probabilities.length !== options.returns.length) {
    throw new Error("probabilities and returns must have equal lengths");
  }

  return simulateLongCashReplay({
    symbol: "TEST",
    validationThreshold: 0.5,
    roundTripCostBps: options.roundTripCostBps ?? 10,
    initialCapital: 100,
    rows: options.returns.map((realizedForwardReturn, index) => ({
      entryDate: dateAtOffset(index * 8),
      exitDate: dateAtOffset(index * 8 + 7),
      probabilityUp: probabilities[index]!,
      realizedForwardReturn,
    })),
  });
}

function codes(report: LongCashReplayIntegrityReport): readonly string[] {
  return report.warnings.map((warning) => warning.code);
}

describe("validateLongCashReplay", () => {
  it("returns a deterministic clean report for a sufficiently varied replay", () => {
    const replay = makeReplay({
      returns: Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.05)),
    });
    const replayBeforeValidation = JSON.stringify(replay);

    const first = validateLongCashReplay(replay);
    const second = validateLongCashReplay(replay);

    expect(first).toEqual(second);
    expect(first).toEqual({
      passed: true,
      trustScore: 100,
      warnings: [],
      summary: "No mapped replay-integrity warning detected.",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.warnings)).toBe(true);
    expect(JSON.stringify(replay)).toBe(replayBeforeValidation);
  });

  it("maps the supported high-risk legacy checks to structured warnings and penalties", () => {
    const report = validateLongCashReplay(makeReplay({
      returns: Array.from({ length: 22 }, () => 0.02),
      roundTripCostBps: 0,
    }));

    expect(codes(report)).toEqual([
      "SUSPICIOUS_WIN_RATE",
      "LOW_TRADE_COUNT",
      "SUSPICIOUS_LOW_DD",
      "NO_COST_DETECTED",
      "MODERATE_PERIOD",
    ]);
    expect(report.passed).toBe(false);
    expect(report.trustScore).toBe(20);
    expect(report.summary).toBe("5 replay-integrity cautions detected before interpreting this result.");
  });

  it("distinguishes insufficient samples, moderate periods, low exposure, and loss streaks", () => {
    const insufficient = validateLongCashReplay(makeReplay({
      returns: Array.from({ length: 9 }, (_, index) => (index % 2 === 0 ? 0.03 : -0.02)),
    }));
    expect(codes(insufficient)).toContain("INSUFFICIENT_TRADES");
    expect(codes(insufficient)).toContain("SHORT_PERIOD");

    const moderatePeriod = validateLongCashReplay(makeReplay({
      returns: Array.from({ length: 31 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.05)),
    }));
    expect(codes(moderatePeriod)).toEqual(["MODERATE_PERIOD"]);

    const lowExposure = validateLongCashReplay(makeReplay({
      returns: [0.1, 0.1, ...Array.from({ length: 20 }, () => 0)],
      probabilities: [0.8, 0.8, ...Array.from({ length: 20 }, () => 0.1)],
    }));
    expect(codes(lowExposure)).toContain("LOW_EXPOSURE");

    const lossStreak = validateLongCashReplay(makeReplay({
      returns: [-0.02, -0.02, -0.02, -0.02, -0.02, 0.04],
    }));
    expect(codes(lossStreak)).toContain("CONSECUTIVE_LOSSES");
  });

  it("does not treat omitted legacy metrics as V1 diagnostics", () => {
    const report = validateLongCashReplay(makeReplay({
      returns: Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.05)),
    }));

    expect(codes(report)).not.toContain("SUSPICIOUS_SHARPE");
    expect(codes(report)).not.toContain("UNREALISTIC_CAGR");
  });
});

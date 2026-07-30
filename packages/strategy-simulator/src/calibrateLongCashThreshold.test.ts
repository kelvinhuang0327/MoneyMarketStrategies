import { canonicalStringify } from "@mms/research-kernel";
import { describe, expect, it } from "vitest";

import {
  calibrateLongCashThreshold,
  LongCashReplayError,
  type LongCashReplayRow,
  type LongCashThresholdCalibrationInput,
} from "./index.js";

function acceptanceInput(): LongCashThresholdCalibrationInput {
  return {
    symbol: "TEST",
    candidateThresholds: [0.5, 0.7],
    roundTripCostBps: 0,
    initialCapital: 100,
    calibrationRows: [
      {
        entryDate: "2026-01-02",
        exitDate: "2026-01-09",
        probabilityUp: 0.9,
        realizedForwardReturn: 0.2,
      },
      {
        entryDate: "2026-01-10",
        exitDate: "2026-01-17",
        probabilityUp: 0.6,
        realizedForwardReturn: -0.1,
      },
      {
        entryDate: "2026-01-18",
        exitDate: "2026-01-25",
        probabilityUp: 0.4,
        realizedForwardReturn: 0.05,
      },
    ],
    validationRows: [
      {
        entryDate: "2026-01-26",
        exitDate: "2026-02-02",
        probabilityUp: 0.8,
        realizedForwardReturn: 0.1,
      },
    ],
  };
}

function rows(
  probabilities: readonly number[],
  returns: readonly number[],
): readonly LongCashReplayRow[] {
  return probabilities.map((probabilityUp, index) => ({
    entryDate: `2026-01-${String(index * 2 + 1).padStart(2, "0")}`,
    exitDate: `2026-01-${String(index * 2 + 2).padStart(2, "0")}`,
    probabilityUp,
    realizedForwardReturn: returns[index]!,
  }));
}

function calibrationInput(
  calibrationRows: readonly LongCashReplayRow[],
  candidateThresholds: readonly number[] = [0.5, 0.7],
): LongCashThresholdCalibrationInput {
  return {
    symbol: "TEST",
    candidateThresholds,
    roundTripCostBps: 0,
    initialCapital: 100,
    calibrationRows,
    validationRows: [{
      entryDate: "2026-02-01",
      exitDate: "2026-02-02",
      probabilityUp: 1,
      realizedForwardReturn: 0,
    }],
  };
}

describe("calibrateLongCashThreshold", () => {
  it("matches the acceptance fixture and validates only the selected calibration threshold", () => {
    const result = calibrateLongCashThreshold(acceptanceInput());

    expect(result.calibrationResults.map(({ threshold, replay }) => ({
      threshold,
      capitals: replay.windows.map((window) => window.strategyCapital),
    }))).toEqual([
      { threshold: 0.5, capitals: [120, 108, 108] },
      { threshold: 0.7, capitals: [120, 120, 120] },
    ]);
    expect(result.selectedThreshold).toBe(0.7);
    expect(result.selectedCalibrationResult.strategy.finalCapital).toBe(120);
    expect(result.validationResult.validationThreshold).toBe(0.7);
    expect(result.calibrationMaxExitDate).toBe("2026-01-25");
    expect(result.validationMinEntryDate).toBe("2026-01-26");
  });

  it("sorts a copied threshold list and makes caller ordering irrelevant", () => {
    const ascendingInput = acceptanceInput();
    const descendingInput = {
      ...acceptanceInput(),
      candidateThresholds: [0.7, 0.5],
    };
    const before = [...descendingInput.candidateThresholds];
    const ascending = calibrateLongCashThreshold(ascendingInput);
    const descending = calibrateLongCashThreshold(descendingInput);

    expect(descendingInput.candidateThresholds).toEqual(before);
    expect(descending.candidateThresholds).toEqual([0.5, 0.7]);
    expect(canonicalStringify(descending)).toBe(canonicalStringify(ascending));
  });

  it("never lets validation probabilities or returns affect threshold selection", () => {
    const baseline = acceptanceInput();
    const adverseValidation = {
      ...acceptanceInput(),
      validationRows: [{
        entryDate: "2026-01-26",
        exitDate: "2026-02-02",
        probabilityUp: 0.1,
        realizedForwardReturn: -0.9,
      }],
    };

    expect(calibrateLongCashThreshold(baseline).selectedThreshold).toBe(0.7);
    expect(calibrateLongCashThreshold(adverseValidation).selectedThreshold).toBe(0.7);
  });

  it("fails closed for touching or overlapping temporal splits using all rows", () => {
    const input = acceptanceInput();

    expect(() => calibrateLongCashThreshold({
      ...input,
      validationRows: [{
        ...input.validationRows[0]!,
        entryDate: "2026-01-25",
      }],
    })).toThrow(/strictly after/);
    expect(() => calibrateLongCashThreshold({
      ...input,
      validationRows: [
        input.validationRows[0]!,
        {
          entryDate: "2026-01-24",
          exitDate: "2026-01-27",
          probabilityUp: 1,
          realizedForwardReturn: 0,
        },
      ],
    })).toThrow(/strictly after/);
  });

  it.each([
    [[], /at least one threshold/],
    [[Number.NaN], /must be finite/],
    [[Number.POSITIVE_INFINITY], /must be finite/],
    [[-0.01], /within \[0, 1\]/],
    [[1.01], /within \[0, 1\]/],
    [[0.5, 0.5], /duplicate threshold 0.5/],
    [[-0, 0], /duplicate threshold 0/],
  ] as const)("fails closed for invalid candidate thresholds", (candidateThresholds, expected) => {
    expect(() => calibrateLongCashThreshold({
      ...acceptanceInput(),
      candidateThresholds,
    })).toThrow(LongCashReplayError);
    expect(() => calibrateLongCashThreshold({
      ...acceptanceInput(),
      candidateThresholds,
    })).toThrow(expected);
  });

  it("rejects all-cash candidate sets but retains ineligible candidate evidence otherwise", () => {
    const calibrationRows = rows([0.6], [0.1]);

    expect(() => calibrateLongCashThreshold(
      calibrationInput(calibrationRows, [0.7, 0.8]),
    )).toThrow(/only all-cash/);

    const result = calibrateLongCashThreshold(
      calibrationInput(calibrationRows, [0.5, 0.7]),
    );
    expect(result.selectedThreshold).toBe(0.5);
    expect(result.calibrationResults.map((candidate) => candidate.eligible)).toEqual([
      true,
      false,
    ]);
  });

  it("prefers lower drawdown after equal excess return", () => {
    const result = calibrateLongCashThreshold(calibrationInput(
      rows([0.9, 0.6, 0.6], [0, -0.5, 1]),
    ));

    expect(result.calibrationResults.map(({ replay }) => replay.excessReturn)).toEqual([0, 0]);
    expect(result.calibrationResults.map(
      ({ replay }) => replay.strategy.maximumDrawdown,
    )).toEqual([0.5, 0]);
    expect(result.selectedThreshold).toBe(0.7);
  });

  it("prefers more active long windows after equal excess return and drawdown", () => {
    const result = calibrateLongCashThreshold(calibrationInput(
      rows([0.9, 0.6], [0, 0]),
    ));

    expect(result.calibrationResults.map(({ replay }) => replay.excessReturn)).toEqual([0, 0]);
    expect(result.calibrationResults.map(
      ({ replay }) => replay.strategy.maximumDrawdown,
    )).toEqual([0, 0]);
    expect(result.calibrationResults.map(
      ({ replay }) => replay.strategy.longWindowCount,
    )).toEqual([2, 1]);
    expect(result.selectedThreshold).toBe(0.5);
  });

  it("uses the lower numeric threshold as the final tie-break", () => {
    const result = calibrateLongCashThreshold(calibrationInput(
      rows([0.9], [0.1]),
    ));

    expect(result.calibrationResults[0]!.replay.normalizedResultSha256).not.toBe(
      result.calibrationResults[1]!.replay.normalizedResultSha256,
    );
    expect(result.calibrationResults.map(
      ({ replay }) => replay.strategy.longWindowCount,
    )).toEqual([1, 1]);
    expect(result.selectedThreshold).toBe(0.5);
  });

  it("deeply freezes output without mutating, freezing, or retaining caller-owned input", () => {
    const source = acceptanceInput();
    const calibrationRows = source.calibrationRows.map((row) => ({ ...row }));
    const validationRows = source.validationRows.map((row) => ({ ...row }));
    const caller = { ...source, calibrationRows, validationRows };
    const callerCalibrationRow = calibrationRows[0]!;
    const callerValidationRow = validationRows[0]!;
    const before = canonicalStringify(caller);
    const result = calibrateLongCashThreshold(caller);

    expect(canonicalStringify(caller)).toBe(before);
    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(caller.candidateThresholds)).toBe(false);
    expect(Object.isFrozen(caller.calibrationRows)).toBe(false);
    expect(Object.isFrozen(callerValidationRow)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidateThresholds)).toBe(true);
    expect(Object.isFrozen(result.calibrationResults)).toBe(true);
    expect(result.calibrationResults.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(result.calibrationResults.every(
      (candidate) => Object.isFrozen(candidate.replay),
    )).toBe(true);
    expect(Object.isFrozen(result.selectedCalibrationResult)).toBe(true);
    expect(Object.isFrozen(result.validationResult)).toBe(true);

    callerCalibrationRow.probabilityUp = 0;
    callerValidationRow.realizedForwardReturn = -0.5;
    expect(result.calibrationResults[0]!.replay.windows[0]!.probabilityUp).toBe(0.9);
    expect(result.validationResult.windows[0]!.realizedForwardReturn).toBe(0.1);
  });

  it("accepts deeply frozen input and rejects empty row partitions", () => {
    const source = acceptanceInput();
    const frozenInput = Object.freeze({
      ...source,
      candidateThresholds: Object.freeze([...source.candidateThresholds]),
      calibrationRows: Object.freeze(source.calibrationRows.map((row) => Object.freeze({ ...row }))),
      validationRows: Object.freeze(source.validationRows.map((row) => Object.freeze({ ...row }))),
    });

    expect(() => calibrateLongCashThreshold(frozenInput)).not.toThrow();
    expect(() => calibrateLongCashThreshold({
      ...source,
      calibrationRows: [],
    })).toThrow(/calibrationRows/);
    expect(() => calibrateLongCashThreshold({
      ...source,
      validationRows: [],
    })).toThrow(/validationRows/);
  });
});

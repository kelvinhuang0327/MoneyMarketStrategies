import { simulateLongCashReplay } from "./simulateLongCashReplay.js";
import {
  LongCashReplayError,
  type LongCashReplayRow,
  type LongCashThresholdCalibrationCandidateResult,
  type LongCashThresholdCalibrationInput,
  type LongCashThresholdCalibrationResult,
} from "./types.js";

const SCHEMA_VERSION = "MMS_LONG_CASH_THRESHOLD_CALIBRATION_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function normalizeCandidateThresholds(
  candidateThresholds: readonly number[],
): readonly number[] {
  if (candidateThresholds.length === 0) {
    fail("candidateThresholds must contain at least one threshold");
  }

  const seen = new Set<number>();
  const normalized = candidateThresholds.map((candidate, index) => {
    if (!Number.isFinite(candidate)) {
      fail(`candidateThresholds[${index}] must be finite`);
    }
    if (candidate < 0 || candidate > 1) {
      fail(`candidateThresholds[${index}] must be within [0, 1]`);
    }
    const threshold = Object.is(candidate, -0) ? 0 : candidate;
    if (seen.has(threshold)) {
      fail(`candidateThresholds contains duplicate threshold ${threshold}`);
    }
    seen.add(threshold);
    return threshold;
  });

  normalized.sort((left, right) => left - right);
  return Object.freeze(normalized);
}

function maximumExitDate(rows: readonly LongCashReplayRow[]): string {
  if (rows.length === 0) {
    fail("calibrationRows must contain at least one prediction");
  }
  return rows.reduce(
    (maximum, row) => row.exitDate > maximum ? row.exitDate : maximum,
    rows[0]!.exitDate,
  );
}

function minimumEntryDate(rows: readonly LongCashReplayRow[]): string {
  if (rows.length === 0) {
    fail("validationRows must contain at least one prediction");
  }
  return rows.reduce(
    (minimum, row) => row.entryDate < minimum ? row.entryDate : minimum,
    rows[0]!.entryDate,
  );
}

function isBetterCandidate(
  candidate: LongCashThresholdCalibrationCandidateResult,
  selected: LongCashThresholdCalibrationCandidateResult,
): boolean {
  if (candidate.replay.excessReturn !== selected.replay.excessReturn) {
    return candidate.replay.excessReturn > selected.replay.excessReturn;
  }
  if (
    candidate.replay.strategy.maximumDrawdown
    !== selected.replay.strategy.maximumDrawdown
  ) {
    return candidate.replay.strategy.maximumDrawdown
      < selected.replay.strategy.maximumDrawdown;
  }
  if (candidate.replay.strategy.longWindowCount !== selected.replay.strategy.longWindowCount) {
    return candidate.replay.strategy.longWindowCount
      > selected.replay.strategy.longWindowCount;
  }
  return candidate.threshold < selected.threshold;
}

export function calibrateLongCashThreshold(
  input: LongCashThresholdCalibrationInput,
): LongCashThresholdCalibrationResult {
  const candidateThresholds = normalizeCandidateThresholds(input.candidateThresholds);
  const calibrationMaxExitDate = maximumExitDate(input.calibrationRows);
  const validationMinEntryDate = minimumEntryDate(input.validationRows);
  if (calibrationMaxExitDate >= validationMinEntryDate) {
    fail("validationRows must start strictly after all calibrationRows exit");
  }

  const calibrationResults = Object.freeze(candidateThresholds.map((threshold) => {
    const replay = simulateLongCashReplay({
      symbol: input.symbol,
      validationThreshold: threshold,
      roundTripCostBps: input.roundTripCostBps,
      initialCapital: input.initialCapital,
      rows: input.calibrationRows,
    });
    return Object.freeze({
      threshold,
      eligible: replay.strategy.longWindowCount > 0,
      replay,
    });
  }));
  const eligibleResults = calibrationResults.filter((candidate) => candidate.eligible);
  if (eligibleResults.length === 0) {
    fail("candidateThresholds produced only all-cash calibration replays");
  }

  const selected = eligibleResults.reduce((best, candidate) => (
    isBetterCandidate(candidate, best) ? candidate : best
  ));
  const validationResult = simulateLongCashReplay({
    symbol: input.symbol,
    validationThreshold: selected.threshold,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    rows: input.validationRows,
  });

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: selected.replay.symbol,
    roundTripCostBps: selected.replay.roundTripCostBps,
    initialCapital: selected.replay.initialCapital,
    candidateThresholds,
    calibrationMaxExitDate,
    validationMinEntryDate,
    calibrationResults,
    selectedThreshold: selected.threshold,
    selectedCalibrationResult: selected.replay,
    validationResult,
  });
}

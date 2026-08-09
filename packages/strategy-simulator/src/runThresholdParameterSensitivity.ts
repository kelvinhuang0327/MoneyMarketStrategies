import { hashValue } from "@mms/research-kernel";

import { runWalkForwardThresholdEvaluation } from "./runWalkForwardThresholdEvaluation.js";
import { simulateLongCashReplay } from "./simulateLongCashReplay.js";
import {
  LongCashReplayError,
  type ThresholdParameterSensitivityCandidateResult,
  type ThresholdParameterSensitivityFoldResult,
  type ThresholdParameterSensitivityResult,
  type WalkForwardThresholdEvaluationFoldInput,
  type WalkForwardThresholdEvaluationInput,
} from "./types.js";

const SCHEMA_VERSION = "MMS_THRESHOLD_PARAMETER_SENSITIVITY_V1" as const;
const RESEARCH_MODE = "diagnostic-only" as const;
const DECIMAL_PLACES = 8;

function fail(message: string): never {
  throw new LongCashReplayError(message);
}

function round(value: number): number {
  const rounded = Number(value.toFixed(DECIMAL_PLACES));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function hasOppositeNonZeroSign(left: number, right: number): boolean {
  return (left > 0 && right < 0) || (left < 0 && right > 0);
}

function sourceFoldsById(
  folds: readonly WalkForwardThresholdEvaluationFoldInput[],
): ReadonlyMap<string, WalkForwardThresholdEvaluationFoldInput> {
  return new Map(folds.map((fold) => [fold.foldId.trim(), fold]));
}

function replayCandidateThreshold(
  input: WalkForwardThresholdEvaluationInput,
  fold: WalkForwardThresholdEvaluationFoldInput,
  selectedThreshold: number,
  selectedValidationResult: ReturnType<typeof simulateLongCashReplay>,
  threshold: number,
): ThresholdParameterSensitivityCandidateResult {
  const replay = simulateLongCashReplay({
    symbol: input.symbol,
    validationThreshold: threshold,
    roundTripCostBps: input.roundTripCostBps,
    initialCapital: input.initialCapital,
    rows: fold.validationRows,
  });
  const returnDelta = round(
    replay.strategy.totalReturn - selectedValidationResult.strategy.totalReturn,
  );
  const excessReturnDelta = round(
    replay.excessReturn - selectedValidationResult.excessReturn,
  );

  return Object.freeze({
    threshold,
    isSelectedThreshold: threshold === selectedThreshold,
    validationStrategyReturn: replay.strategy.totalReturn,
    validationBenchmarkReturn: replay.benchmark.totalReturn,
    validationExcessReturn: replay.excessReturn,
    returnDeltaVersusSelectedThreshold: returnDelta,
    excessReturnDeltaVersusSelectedThreshold: excessReturnDelta,
    degradationVersusSelectedThreshold: Math.max(0, -returnDelta),
    excessReturnDegradationVersusSelectedThreshold: Math.max(0, -excessReturnDelta),
  });
}

function buildFoldResult(
  input: WalkForwardThresholdEvaluationInput,
  sourceFold: WalkForwardThresholdEvaluationFoldInput,
  evaluatedFold: ReturnType<typeof runWalkForwardThresholdEvaluation>["foldResults"][number],
): ThresholdParameterSensitivityFoldResult {
  const selectedValidationResult = evaluatedFold.calibrationResult.validationResult;
  const candidateThresholdResults = Object.freeze(
    evaluatedFold.calibrationResult.candidateThresholds.map((threshold) => (
      replayCandidateThreshold(
        input,
        sourceFold,
        evaluatedFold.selectedThreshold,
        selectedValidationResult,
        threshold,
      )
    )),
  );
  const anyCandidateChangesValidationExcessReturnSign = candidateThresholdResults.some(
    ({ validationExcessReturn }) => hasOppositeNonZeroSign(
      selectedValidationResult.excessReturn,
      validationExcessReturn,
    ),
  );
  const fragilityStatus = anyCandidateChangesValidationExcessReturnSign
    ? "EXCESS_RETURN_SIGN_FLIP"
    : "NO_EXCESS_RETURN_SIGN_FLIP";

  return Object.freeze({
    foldId: evaluatedFold.foldId,
    validationStartDate: evaluatedFold.validationStartDate,
    validationEndDate: evaluatedFold.validationEndDate,
    selectedThreshold: evaluatedFold.selectedThreshold,
    selectedValidationStrategyReturn: selectedValidationResult.strategy.totalReturn,
    selectedValidationBenchmarkReturn: selectedValidationResult.benchmark.totalReturn,
    selectedValidationExcessReturn: selectedValidationResult.excessReturn,
    candidateThresholdResults,
    maximumValidationReturnDegradation: candidateThresholdResults.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.degradationVersusSelectedThreshold),
      0,
    ),
    maximumValidationExcessReturnDegradation: candidateThresholdResults.reduce(
      (maximum, candidate) => Math.max(
        maximum,
        candidate.excessReturnDegradationVersusSelectedThreshold,
      ),
      0,
    ),
    anyCandidateChangesValidationExcessReturnSign,
    fragilityStatus,
  });
}

export function runThresholdParameterSensitivity(
  input: WalkForwardThresholdEvaluationInput,
): ThresholdParameterSensitivityResult {
  const walkForward = runWalkForwardThresholdEvaluation(input);
  const sourceFolds = sourceFoldsById(input.folds);
  const foldResults = Object.freeze(walkForward.foldResults.map((evaluatedFold) => {
    const sourceFold = sourceFolds.get(evaluatedFold.foldId);
    if (sourceFold === undefined) {
      fail(`missing source fold for ${evaluatedFold.foldId}`);
    }
    return buildFoldResult(input, sourceFold, evaluatedFold);
  }));
  const candidateThresholds = Object.freeze([...new Set(
    foldResults.flatMap(({ candidateThresholdResults }) => (
      candidateThresholdResults.map(({ threshold }) => threshold)
    )),
  )].sort((left, right) => left - right));
  const foldSignFlipCount = foldResults.filter(
    ({ anyCandidateChangesValidationExcessReturnSign }) => (
      anyCandidateChangesValidationExcessReturnSign
    ),
  ).length;
  const guardrails = Object.freeze({
    providesInvestmentAdvice: false,
    supportsOrderExecution: false,
    supportsAutomaticPromotion: false,
    supportsPortfolioOptimization: false,
    supportsMultiSymbolAllocation: false,
    validationOutcomesAffectThresholdSelection: false,
    candidateThresholdsAreDiagnosticsOnly: true,
  } as const);
  const aggregateFragilityStatus = foldSignFlipCount === 0
    ? "NO_FOLD_SIGN_FLIP"
    : "ONE_OR_MORE_FOLD_SIGN_FLIPS";
  const orderedFoldIds = Object.freeze(foldResults.map(({ foldId }) => foldId));
  const normalized = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    researchMode: RESEARCH_MODE,
    symbol: walkForward.symbol,
    roundTripCostBps: walkForward.roundTripCostBps,
    initialCapital: walkForward.initialCapital,
    candidateThresholds,
    foldCount: foldResults.length,
    orderedFoldIds,
    foldResults,
    foldSignFlipCount,
    aggregateFragilityStatus,
    guardrails,
    foldResultsSha256: hashValue(foldResults),
  });
  return Object.freeze({
    ...normalized,
    normalizedResultSha256: hashValue(normalized),
  });
}

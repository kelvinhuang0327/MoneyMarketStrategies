import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import {
  buildCandidateGrid,
  buildDevelopmentLayout,
  evaluateDevelopmentParameters,
  PRICE_BAND_FIXED_STRATEGY_VERSION,
  TWSE_SOURCE_PROFILE_ARGUMENT,
  type TradeCounts,
  type WinRateParameters,
} from "./winRateOptimizer.js";

export const WIN_RATE_OBJECTIVE = "WIN_RATE_WILSON_LOWER_BOUND_95" as const;
export const WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION = "wilson-lower-bound-95-development-v1" as const;

export interface WinRateV2Metrics {
  readonly completedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly rawNetWinRate: number | null;
  readonly wilsonLowerBound95: number | null;
}

export interface WinRateV2Candidate {
  readonly id: string;
  readonly parameters: WinRateParameters;
  readonly stats: WinRateV2Metrics;
}

export function wilsonLowerBound95(wins: number, completedTrades: number): number | null {
  if (
    !Number.isSafeInteger(wins)
    || !Number.isSafeInteger(completedTrades)
    || wins < 0
    || completedTrades < 0
    || wins > completedTrades
  ) {
    throw new RangeError("wins and completedTrades must be non-negative safe integers with wins <= completedTrades");
  }
  if (completedTrades === 0) return null;

  const z = 1.96;
  const zSquared = z * z;
  const proportion = wins / completedTrades;
  const denominator = 1 + zSquared / completedTrades;
  const center = proportion + zSquared / (2 * completedTrades);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * completedTrades)) / completedTrades,
  );
  return (center - margin) / denominator;
}

function metricsFromCounts(stats: TradeCounts): WinRateV2Metrics {
  return Object.freeze({
    completedTradeCount: stats.completedTradeCount,
    wins: stats.wins,
    losses: stats.losses,
    breakevens: stats.breakevens,
    rawNetWinRate: stats.netWinRate,
    wilsonLowerBound95: wilsonLowerBound95(stats.wins, stats.completedTradeCount),
  });
}

function parameterDistance(parameters: WinRateParameters, champion: WinRateParameters): bigint {
  const entryDistance = parameters.entryAtOrBelowMinor - champion.entryAtOrBelowMinor;
  const exitDistance = parameters.exitAtOrAboveMinor - champion.exitAtOrAboveMinor;
  return (entryDistance < 0n ? -entryDistance : entryDistance)
    + (exitDistance < 0n ? -exitDistance : exitDistance);
}

function compareParameters(left: WinRateParameters, right: WinRateParameters): number {
  if (left.entryAtOrBelowMinor !== right.entryAtOrBelowMinor) {
    return left.entryAtOrBelowMinor < right.entryAtOrBelowMinor ? -1 : 1;
  }
  if (left.exitAtOrAboveMinor !== right.exitAtOrAboveMinor) {
    return left.exitAtOrAboveMinor < right.exitAtOrAboveMinor ? -1 : 1;
  }
  return 0;
}

export function rankDevelopmentCandidatesV2(
  candidates: readonly WinRateV2Candidate[],
  championParameters: WinRateParameters,
): readonly WinRateV2Candidate[] {
  return Object.freeze(candidates
    .filter(({ stats }) => stats.completedTradeCount > 0 && stats.wilsonLowerBound95 !== null)
    .slice()
    .sort((left, right) => {
      const leftWilson = left.stats.wilsonLowerBound95!;
      const rightWilson = right.stats.wilsonLowerBound95!;
      if (leftWilson !== rightWilson) return leftWilson > rightWilson ? -1 : 1;

      const leftRawRate = left.stats.rawNetWinRate!;
      const rightRawRate = right.stats.rawNetWinRate!;
      if (leftRawRate !== rightRawRate) return leftRawRate > rightRawRate ? -1 : 1;

      const leftDistance = parameterDistance(left.parameters, championParameters);
      const rightDistance = parameterDistance(right.parameters, championParameters);
      if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1;
      return compareParameters(left.parameters, right.parameters);
    }));
}

function sameParameters(left: WinRateParameters, right: WinRateParameters): boolean {
  return left.entryAtOrBelowMinor === right.entryAtOrBelowMinor
    && left.exitAtOrAboveMinor === right.exitAtOrAboveMinor
    && left.targetQuantity === right.targetQuantity;
}

function publicParameters(parameters: WinRateParameters) {
  return Object.freeze({
    entryAtOrBelowMinor: parameters.entryAtOrBelowMinor.toString(),
    exitAtOrAboveMinor: parameters.exitAtOrAboveMinor.toString(),
    targetQuantity: parameters.targetQuantity,
  });
}

function validUtcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null;
}

export function determineFuturePromotionStatusV2(
  champion: WinRateV2Metrics,
  challenger: WinRateV2Metrics,
  firstEvidenceDate: string,
  observedThroughDate: string,
): "PROMOTE" | "NO_PROMOTION" {
  const firstEvidenceTimestamp = validUtcDate(firstEvidenceDate);
  const observedThroughTimestamp = validUtcDate(observedThroughDate);
  if (
    firstEvidenceTimestamp === null
    || observedThroughTimestamp === null
    || firstEvidenceTimestamp <= observedThroughTimestamp
    || champion.wilsonLowerBound95 === null
    || challenger.wilsonLowerBound95 === null
  ) {
    return "NO_PROMOTION";
  }
  return challenger.wilsonLowerBound95 > champion.wilsonLowerBound95 ? "PROMOTE" : "NO_PROMOTION";
}

export function optimizeParsedHistoricalDataV2(
  parsed: ParsedHistoricalCsv,
  inputSha256: string,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("inputSha256 must be a lowercase SHA-256 digest");
  if (parsed.rowCount !== parsed.session.events.length) {
    throw new Error("parsed historical row count does not match its event count");
  }

  const layout = buildDevelopmentLayout(parsed.rowCount);
  const strategy = parsed.session.simulation.strategy;
  const championParameters: WinRateParameters = Object.freeze({
    entryAtOrBelowMinor: strategy.entryAtOrBelowMinor,
    exitAtOrAboveMinor: strategy.exitAtOrAboveMinor,
    targetQuantity: strategy.targetQuantity,
  });
  const grid = buildCandidateGrid(championParameters);
  const candidates: readonly WinRateV2Candidate[] = Object.freeze(grid.map(({ id, parameters }) => Object.freeze({
    id,
    parameters,
    stats: metricsFromCounts(evaluateDevelopmentParameters(parsed, inputSha256, parameters)),
  })));
  const champion = candidates.find(({ parameters }) => sameParameters(parameters, championParameters));
  if (!champion) throw new Error("the fixed candidate grid omitted the champion parameters");

  const ranked = rankDevelopmentCandidatesV2(candidates, championParameters);
  const selected = ranked.find(({ id }) => id !== champion.id);
  if (!selected) throw new Error("the fixed candidate grid has no non-champion candidate with completed development trades");

  const frozenParameters = publicParameters(selected.parameters);
  const championMetrics = champion.stats;
  return Object.freeze({
    schemaVersion: 2,
    objective: WIN_RATE_OBJECTIVE,
    inputSha256,
    symbol: parsed.symbol,
    selectionPolicyVersion: WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
    strategyVersion: PRICE_BAND_FIXED_STRATEGY_VERSION,
    observedThroughDate: parsed.endDate,
    developmentBoundary: layout.developmentBoundary,
    developmentFolds: layout.developmentFolds,
    championDevelopment: Object.freeze({
      parameters: publicParameters(championParameters),
      ...championMetrics,
    }),
    candidateCount: candidates.length,
    candidateGrid: Object.freeze(candidates.map((candidate) => Object.freeze({
      id: candidate.id,
      parameters: publicParameters(candidate.parameters),
      developmentEligible: candidate.stats.completedTradeCount > 0,
      ...candidate.stats,
    }))),
    rankedDevelopmentCandidateIds: Object.freeze(ranked.map(({ id }) => id)),
    selectedFutureChallenger: Object.freeze({
      id: selected.id,
      parameters: frozenParameters,
      ...selected.stats,
    }),
    FROZEN_CHALLENGER_ID: selected.id,
    FROZEN_PARAMETERS: frozenParameters,
    FROZEN_STRATEGY_VERSION: PRICE_BAND_FIXED_STRATEGY_VERSION,
    FROZEN_SELECTION_INPUT_SHA256: inputSha256,
    FROZEN_SELECTION_POLICY_VERSION: WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
    V1_HOLDOUT_STATUS: "HISTORICAL_DIAGNOSTIC_ONLY",
    FUTURE_PROMOTION_STATUS: "AWAITING_UNSEEN_DATA",
  });
}

export async function runWinRateOptimizerV2File(
  inputPath: string,
  symbol: string,
  sourceProfile?: typeof TWSE_SOURCE_PROFILE_ARGUMENT,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(inputPath);
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`input file is not valid UTF-8 CSV: ${detail}`);
  }
  const parsed = parseHistoricalCsv(contents, symbol, inputPath, sourceProfile);
  return optimizeParsedHistoricalDataV2(parsed, inputSha256);
}

function helpText(): string {
  return [
    "Usage: npm run --silent paper:optimize-win-rate-v2 -- --input-csv <prices.csv> --symbol <symbol>",
    "       npm run --silent paper:optimize-win-rate-v2 -- --input-csv <ohlcv.csv> --symbol <symbol> --source-profile twse-daily-ohlcv-close-v1",
    "",
    "The candidate grid and selection policy are fixed; no tuning flags are supported.",
  ].join("\n");
}

function parseCliArguments(args: readonly string[]): {
  readonly help: boolean;
  readonly inputPath?: string;
  readonly symbol?: string;
  readonly sourceProfile?: typeof TWSE_SOURCE_PROFILE_ARGUMENT;
} {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  let inputPath: string | undefined;
  let symbol: string | undefined;
  let sourceProfile: typeof TWSE_SOURCE_PROFILE_ARGUMENT | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (
      (option !== "--input-csv" && option !== "--symbol" && option !== "--source-profile")
      || value === undefined
      || value === ""
    ) {
      throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for usage");
    }
    if (option === "--input-csv") {
      if (inputPath !== undefined) throw new TypeError("--input-csv may be specified only once");
      inputPath = value;
    } else if (option === "--symbol") {
      if (symbol !== undefined) throw new TypeError("--symbol may be specified only once");
      symbol = value;
    } else {
      if (sourceProfile !== undefined) throw new TypeError("--source-profile may be specified only once");
      if (value !== TWSE_SOURCE_PROFILE_ARGUMENT) throw new TypeError(`unsupported --source-profile ${value}`);
      sourceProfile = value;
    }
    index += 1;
  }
  if (inputPath === undefined || symbol === undefined) {
    throw new TypeError("expected --input-csv <path> and --symbol <symbol>; use --help for usage");
  }
  return {
    help: false,
    inputPath,
    symbol,
    ...(sourceProfile === undefined ? {} : { sourceProfile }),
  };
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await runWinRateOptimizerV2File(options.inputPath!, options.symbol!, options.sourceProfile);
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown win-rate optimizer v2 error";
    stderr.write(`paper:optimize-win-rate-v2: ${message}\n`);
    process.exitCode = 1;
  });
}

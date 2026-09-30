import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHistoricalCsv, type ParsedHistoricalCsv } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";

const STRATEGY_VERSION = "price-band-fixed-v1";
const TWSE_SOURCE_PROFILE_ARGUMENT = "twse-daily-ohlcv-close-v1" as const;
const DEVELOPMENT_FRACTION = 0.8;
const CANDIDATE_OFFSETS_MINOR = [-1_000n, -500n, 0n, 500n, 1_000n] as const;

export interface WinRateParameters {
  readonly entryAtOrBelowMinor: bigint;
  readonly exitAtOrAboveMinor: bigint;
  readonly targetQuantity: number;
}

export interface TradeCounts {
  readonly completedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly netWinRate: number | null;
}

export interface DevelopmentFold {
  readonly id: string;
  readonly trainingRows: { readonly startRow: number; readonly endRow: number; readonly rowCount: number };
  readonly validationRows: { readonly startRow: number; readonly endRow: number; readonly rowCount: number };
}

interface FoldIndices {
  readonly id: string;
  readonly trainingEndIndex: number;
  readonly validationStartIndex: number;
  readonly validationEndIndex: number;
}

interface DevelopmentLayout {
  readonly developmentEndIndex: number;
  readonly developmentBoundary: { readonly startRow: number; readonly endRow: number; readonly rowCount: number };
  readonly holdoutBoundary: { readonly startRow: number; readonly endRow: number; readonly rowCount: number };
  readonly developmentFolds: readonly DevelopmentFold[];
  readonly foldIndices: readonly FoldIndices[];
}

interface CandidateEvaluation {
  readonly id: string;
  readonly parameters: WinRateParameters;
  readonly stats: TradeCounts;
  readonly developmentEligible: boolean;
}

export type PromotionStatus =
  | "PROMOTE"
  | "NO_PROMOTION"
  | "CEILING_NO_PROMOTION"
  | "INSUFFICIENT_CHAMPION_HOLDOUT_TRADES"
  | "INSUFFICIENT_CHALLENGER_HOLDOUT_TRADES";

function rowBoundary(startIndex: number, endIndex: number) {
  return Object.freeze({
    startRow: startIndex + 1,
    endRow: endIndex,
    rowCount: endIndex - startIndex,
  });
}

export function buildDevelopmentLayout(acceptedRowCount: number): {
  readonly developmentBoundary: DevelopmentLayout["developmentBoundary"];
  readonly holdoutBoundary: DevelopmentLayout["holdoutBoundary"];
  readonly developmentFolds: readonly DevelopmentFold[];
} {
  if (!Number.isSafeInteger(acceptedRowCount) || acceptedRowCount < 3) {
    throw new RangeError("at least three accepted rows are required for chronological evaluation");
  }

  const developmentEndIndex = Math.floor(acceptedRowCount * DEVELOPMENT_FRACTION);
  const initialTrainingEndIndex = Math.floor(developmentEndIndex / 3);
  const secondValidationStartIndex = initialTrainingEndIndex
    + Math.ceil((developmentEndIndex - initialTrainingEndIndex) / 2);
  if (
    initialTrainingEndIndex < 1
    || secondValidationStartIndex <= initialTrainingEndIndex
    || secondValidationStartIndex >= developmentEndIndex
  ) {
    throw new RangeError("accepted rows do not support two non-empty rolling development folds");
  }

  const foldIndices: readonly FoldIndices[] = Object.freeze([
    Object.freeze({
      id: "fold-1",
      trainingEndIndex: initialTrainingEndIndex,
      validationStartIndex: initialTrainingEndIndex,
      validationEndIndex: secondValidationStartIndex,
    }),
    Object.freeze({
      id: "fold-2",
      trainingEndIndex: secondValidationStartIndex,
      validationStartIndex: secondValidationStartIndex,
      validationEndIndex: developmentEndIndex,
    }),
  ]);
  const developmentFolds = Object.freeze(foldIndices.map((fold) => Object.freeze({
    id: fold.id,
    trainingRows: rowBoundary(0, fold.trainingEndIndex),
    validationRows: rowBoundary(fold.validationStartIndex, fold.validationEndIndex),
  })));

  return Object.freeze({
    developmentBoundary: rowBoundary(0, developmentEndIndex),
    holdoutBoundary: rowBoundary(developmentEndIndex, acceptedRowCount),
    developmentFolds,
  });
}

function fullDevelopmentLayout(acceptedRowCount: number): DevelopmentLayout {
  const publicLayout = buildDevelopmentLayout(acceptedRowCount);
  const developmentEndIndex = publicLayout.developmentBoundary.rowCount;
  const initialTrainingEndIndex = publicLayout.developmentFolds[0]!.trainingRows.rowCount;
  const secondValidationStartIndex = publicLayout.developmentFolds[1]!.trainingRows.rowCount;
  return Object.freeze({
    ...publicLayout,
    developmentEndIndex,
    foldIndices: Object.freeze([
      Object.freeze({
        id: "fold-1",
        trainingEndIndex: initialTrainingEndIndex,
        validationStartIndex: initialTrainingEndIndex,
        validationEndIndex: secondValidationStartIndex,
      }),
      Object.freeze({
        id: "fold-2",
        trainingEndIndex: secondValidationStartIndex,
        validationStartIndex: secondValidationStartIndex,
        validationEndIndex: developmentEndIndex,
      }),
    ]),
  });
}

function candidateId(parameters: WinRateParameters): string {
  return `entry-${parameters.entryAtOrBelowMinor.toString()}-exit-${parameters.exitAtOrAboveMinor.toString()}`;
}

export function buildCandidateGrid(champion: WinRateParameters): readonly {
  readonly id: string;
  readonly parameters: WinRateParameters;
}[] {
  if (champion.entryAtOrBelowMinor <= 0n || champion.exitAtOrAboveMinor <= champion.entryAtOrBelowMinor) {
    throw new RangeError("champion price bands must be positive and exit must exceed entry");
  }

  const entries = CANDIDATE_OFFSETS_MINOR
    .map((offset) => champion.entryAtOrBelowMinor + offset)
    .filter((value) => value > 0n);
  const exits = CANDIDATE_OFFSETS_MINOR
    .map((offset) => champion.exitAtOrAboveMinor + offset)
    .filter((value) => value > 0n);
  const candidates: { readonly id: string; readonly parameters: WinRateParameters }[] = [];
  for (const entryAtOrBelowMinor of entries) {
    for (const exitAtOrAboveMinor of exits) {
      if (exitAtOrAboveMinor <= entryAtOrBelowMinor) continue;
      const parameters = Object.freeze({
        entryAtOrBelowMinor,
        exitAtOrAboveMinor,
        targetQuantity: champion.targetQuantity,
      });
      candidates.push(Object.freeze({ id: candidateId(parameters), parameters }));
    }
  }
  if (candidates.length > 25 || !candidates.some(({ parameters }) => sameParameters(parameters, champion))) {
    throw new Error("deterministic candidate grid violated its fixed policy");
  }
  return Object.freeze(candidates);
}

function sameParameters(left: WinRateParameters, right: WinRateParameters): boolean {
  return left.entryAtOrBelowMinor === right.entryAtOrBelowMinor
    && left.exitAtOrAboveMinor === right.exitAtOrAboveMinor
    && left.targetQuantity === right.targetQuantity;
}

function tradeCounts(wins: number, losses: number, breakevens: number): TradeCounts {
  const completedTradeCount = wins + losses + breakevens;
  return Object.freeze({
    completedTradeCount,
    wins,
    losses,
    breakevens,
    netWinRate: completedTradeCount === 0 ? null : wins / completedTradeCount,
  });
}

function readTradeCounts(result: Record<string, unknown>): TradeCounts {
  const raw = result["tradingStatistics"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("paper session did not return trading statistics");
  }
  const statistics = raw as Record<string, unknown>;
  const completedTradeCount = statistics["completeTradeCount"];
  const wins = statistics["wins"];
  const losses = statistics["losses"];
  const breakevens = statistics["breakevens"];
  const netWinRate = statistics["netWinRate"];
  if (
    !Number.isSafeInteger(completedTradeCount)
    || !Number.isSafeInteger(wins)
    || !Number.isSafeInteger(losses)
    || !Number.isSafeInteger(breakevens)
    || (netWinRate !== null && (typeof netWinRate !== "number" || !Number.isFinite(netWinRate)))
  ) {
    throw new TypeError("paper session returned invalid completed-trade statistics");
  }
  const counts = tradeCounts(wins as number, losses as number, breakevens as number);
  if (counts.completedTradeCount !== completedTradeCount || counts.netWinRate !== netWinRate) {
    throw new Error("completed-trade counts do not reconcile with the paper session result");
  }
  return counts;
}

function aggregateTradeCounts(values: readonly TradeCounts[]): TradeCounts {
  return tradeCounts(
    values.reduce((sum, value) => sum + value.wins, 0),
    values.reduce((sum, value) => sum + value.losses, 0),
    values.reduce((sum, value) => sum + value.breakevens, 0),
  );
}

function evaluateSessionWindow(
  parsed: ParsedHistoricalCsv,
  inputSha256: string,
  parameters: WinRateParameters,
  startIndex: number,
  endIndex: number,
): TradeCounts {
  const session = parsed.session;
  const windowSession = {
    ...session,
    simulation: {
      ...session.simulation,
      strategy: {
        ...session.simulation.strategy,
        entryAtOrBelowMinor: parameters.entryAtOrBelowMinor,
        exitAtOrAboveMinor: parameters.exitAtOrAboveMinor,
        targetQuantity: parameters.targetQuantity,
      },
    },
    events: session.events.slice(startIndex, endIndex),
  };
  return readTradeCounts(runPaperSession(windowSession, inputSha256));
}

export function isDevelopmentEligible(candidate: TradeCounts, championCompletedTradeCount: number): boolean {
  return candidate.netWinRate !== null && candidate.completedTradeCount >= championCompletedTradeCount;
}

function compareRate(left: TradeCounts, right: TradeCounts): number {
  if (left.netWinRate === null || right.netWinRate === null) {
    if (left.netWinRate === right.netWinRate) return 0;
    return left.netWinRate === null ? -1 : 1;
  }
  const leftNumerator = BigInt(left.wins) * BigInt(right.completedTradeCount);
  const rightNumerator = BigInt(right.wins) * BigInt(left.completedTradeCount);
  return leftNumerator < rightNumerator ? -1 : leftNumerator > rightNumerator ? 1 : 0;
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

function selectChallenger(
  candidates: readonly CandidateEvaluation[],
  champion: CandidateEvaluation,
): CandidateEvaluation | null {
  const eligibleAlternatives = candidates
    .filter((candidate) => candidate.developmentEligible && candidate.id !== champion.id)
    .slice()
    .sort((left, right) => {
      const rateOrder = compareRate(right.stats, left.stats);
      if (rateOrder !== 0) return rateOrder;
      const leftDistance = parameterDistance(left.parameters, champion.parameters);
      const rightDistance = parameterDistance(right.parameters, champion.parameters);
      if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1;
      return compareParameters(left.parameters, right.parameters);
    });
  return eligibleAlternatives[0] ?? null;
}

export function determinePromotionStatus(champion: TradeCounts, challenger: TradeCounts | null): PromotionStatus {
  if (champion.completedTradeCount === 0 || champion.netWinRate === null) {
    return "INSUFFICIENT_CHAMPION_HOLDOUT_TRADES";
  }
  if (challenger === null) return "NO_PROMOTION";
  if (challenger.completedTradeCount === 0 || challenger.netWinRate === null) {
    return "INSUFFICIENT_CHALLENGER_HOLDOUT_TRADES";
  }
  if (challenger.completedTradeCount < champion.completedTradeCount) return "NO_PROMOTION";
  if (challenger.netWinRate > champion.netWinRate) return "PROMOTE";
  if (champion.netWinRate === 1) return "CEILING_NO_PROMOTION";
  return "NO_PROMOTION";
}

function publicParameters(parameters: WinRateParameters) {
  return Object.freeze({
    entryAtOrBelowMinor: parameters.entryAtOrBelowMinor.toString(),
    exitAtOrAboveMinor: parameters.exitAtOrAboveMinor.toString(),
    targetQuantity: parameters.targetQuantity,
  });
}

function publicTradeCounts(stats: TradeCounts) {
  return Object.freeze({
    completedTradeCount: stats.completedTradeCount,
    wins: stats.wins,
    losses: stats.losses,
    breakevens: stats.breakevens,
    netWinRate: stats.netWinRate,
  });
}

export function optimizeParsedHistoricalData(
  parsed: ParsedHistoricalCsv,
  inputSha256: string,
): Record<string, unknown> {
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError("inputSha256 must be a lowercase SHA-256 digest");
  if (parsed.rowCount !== parsed.session.events.length) throw new Error("parsed historical row count does not match its event count");

  const layout = fullDevelopmentLayout(parsed.rowCount);
  const strategy = parsed.session.simulation.strategy;
  const championParameters: WinRateParameters = Object.freeze({
    entryAtOrBelowMinor: strategy.entryAtOrBelowMinor,
    exitAtOrAboveMinor: strategy.exitAtOrAboveMinor,
    targetQuantity: strategy.targetQuantity,
  });
  const grid = buildCandidateGrid(championParameters);

  const candidates: CandidateEvaluation[] = grid.map(({ id, parameters }) => {
    const foldStats = layout.foldIndices.map((fold) => evaluateSessionWindow(
      parsed,
      inputSha256,
      parameters,
      fold.validationStartIndex,
      fold.validationEndIndex,
    ));
    return Object.freeze({
      id,
      parameters,
      stats: aggregateTradeCounts(foldStats),
      developmentEligible: false,
    });
  });
  const champion = candidates.find(({ parameters }) => sameParameters(parameters, championParameters));
  if (!champion) throw new Error("the fixed candidate grid omitted the champion parameters");
  const developmentCandidates = candidates.map((candidate) => Object.freeze({
    ...candidate,
    developmentEligible: isDevelopmentEligible(candidate.stats, champion.stats.completedTradeCount),
  }));
  const developmentChampion = developmentCandidates.find(({ id }) => id === champion.id)!;
  const selected = selectChallenger(developmentCandidates, developmentChampion);

  // Freeze the development-only choice before either final-holdout simulation.
  const selectedChallenger = selected === null
    ? null
    : Object.freeze({
        id: selected.id,
        parameters: publicParameters(selected.parameters),
        frozenBeforeHoldout: true as const,
        developmentCompletedTradeCount: selected.stats.completedTradeCount,
        developmentWins: selected.stats.wins,
        developmentLosses: selected.stats.losses,
        developmentBreakevens: selected.stats.breakevens,
        developmentNetWinRate: selected.stats.netWinRate,
      });

  const championHoldout = evaluateSessionWindow(
    parsed,
    inputSha256,
    championParameters,
    layout.developmentEndIndex,
    parsed.rowCount,
  );
  const challengerHoldout = selected === null
    ? null
    : evaluateSessionWindow(
        parsed,
        inputSha256,
        selected.parameters,
        layout.developmentEndIndex,
        parsed.rowCount,
      );

  return Object.freeze({
    schemaVersion: 1,
    inputSha256,
    symbol: parsed.symbol,
    developmentBoundary: layout.developmentBoundary,
    holdoutBoundary: layout.holdoutBoundary,
    developmentFolds: layout.developmentFolds,
    champion: Object.freeze({
      strategyVersion: STRATEGY_VERSION,
      parameters: publicParameters(championParameters),
      developmentCompletedTrades: developmentChampion.stats.completedTradeCount,
      developmentWins: developmentChampion.stats.wins,
      developmentLosses: developmentChampion.stats.losses,
      developmentBreakevens: developmentChampion.stats.breakevens,
      developmentNetWinRate: developmentChampion.stats.netWinRate,
      holdoutCompletedTrades: championHoldout.completedTradeCount,
      holdoutWins: championHoldout.wins,
      holdoutLosses: championHoldout.losses,
      holdoutBreakevens: championHoldout.breakevens,
      holdoutNetWinRate: championHoldout.netWinRate,
    }),
    candidateGrid: Object.freeze(developmentCandidates.map((candidate) => Object.freeze({
      id: candidate.id,
      parameters: publicParameters(candidate.parameters),
      developmentEligible: candidate.developmentEligible,
      developmentCompletedTrades: candidate.stats.completedTradeCount,
      developmentWins: candidate.stats.wins,
      developmentLosses: candidate.stats.losses,
      developmentBreakevens: candidate.stats.breakevens,
      developmentNetWinRate: candidate.stats.netWinRate,
    }))),
    selectedChallenger,
    challengerHoldout: challengerHoldout === null ? null : publicTradeCounts(challengerHoldout),
    promotion: determinePromotionStatus(championHoldout, challengerHoldout),
  });
}

export async function runWinRateOptimizerFile(
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
  return optimizeParsedHistoricalData(parsed, inputSha256);
}

function helpText(): string {
  return [
    "Usage: npm run --silent paper:optimize-win-rate -- --input-csv <prices.csv> --symbol <symbol>",
    "       npm run --silent paper:optimize-win-rate -- --input-csv <ohlcv.csv> --symbol <symbol> --source-profile twse-daily-ohlcv-close-v1",
    "",
    "The bounded candidate grid is fixed by the optimizer policy; no tuning flags are supported.",
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
  const result = await runWinRateOptimizerFile(options.inputPath!, options.symbol!, options.sourceProfile);
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown win-rate optimizer error";
    stderr.write(`paper:optimize-win-rate: ${message}\n`);
    process.exitCode = 1;
  });
}

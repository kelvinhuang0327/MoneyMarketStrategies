import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHistoricalCsv } from "./historicalBaseline.js";
import {
  determineFuturePromotionStatusV2,
  WIN_RATE_OBJECTIVE,
  WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
  wilsonLowerBound95,
  type WinRateV2Metrics,
} from "./winRateOptimizerV2.js";
import {
  evaluateParametersOnAllRows,
  PRICE_BAND_FIXED_STRATEGY_VERSION,
  TWSE_SOURCE_PROFILE_ARGUMENT,
  type TradeCounts,
  type WinRateParameters,
} from "./winRateOptimizer.js";

export const FORWARD_DATA_CSV_PATH = "data/market/forward/0050-forward-v1/0050_forward.csv" as const;
export const FORWARD_DATA_PROVENANCE_PATH = "data/market/forward/0050-forward-v1/provenance.json" as const;
export const WIN_RATE_V2_ARTIFACT_PATH = "packages/paper-trading/win-rate-optimizer-v2.json" as const;
export const FORWARD_EVALUATION_OUTPUT_PATH = "packages/paper-trading/forward-win-rate-evaluation-v1.json" as const;

type PromotionStatus = "PROMOTE" | "NO_PROMOTION" | "INSUFFICIENT_FRESH_TRADES" | "NO_FRESH_DATA";

interface PublicParameters {
  readonly entryAtOrBelowMinor: string;
  readonly exitAtOrAboveMinor: string;
  readonly targetQuantity: number;
}

interface FrozenForwardIdentities {
  readonly objective: typeof WIN_RATE_OBJECTIVE;
  readonly selectionPolicyVersion: typeof WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION;
  readonly historicalCutoff: string;
  readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
  readonly championParameters: WinRateParameters;
  readonly challengerId: string;
  readonly challengerParameters: WinRateParameters;
}

interface ForwardMetrics {
  readonly freshDataSha256: string;
  readonly completedTradeCount: number;
  readonly freshCompletedTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakevens: number;
  readonly rawNetWinRate: number | null;
  readonly wilsonLowerBound95: number | null;
}

interface ProvenanceDateRange {
  readonly start: string | null;
  readonly end: string | null;
}

interface FreshProvenance {
  readonly artifactId: "0050-forward-v1";
  readonly symbol: "0050";
  readonly source: string;
  readonly fetchedAtUtc: string;
  readonly dateRange: ProvenanceDateRange;
  readonly rowCount: number;
  readonly sha256: string;
  readonly historicalCutoff: string;
  readonly purpose: "FORWARD_EVALUATION_ONLY";
}

export interface ForwardWinRateEvaluation {
  readonly schemaVersion: 1;
  readonly objective: typeof WIN_RATE_OBJECTIVE;
  readonly selectionPolicyVersion: typeof WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION;
  readonly historicalCutoff: string;
  readonly freshDataSha256: string;
  readonly freshDateRange: { readonly start: string; readonly end: string } | null;
  readonly freshRowCount: number;
  readonly freshCompletedTradeCount: { readonly champion: number; readonly challenger: number };
  readonly champion: {
    readonly id: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly parameters: PublicParameters;
  } & ForwardMetrics;
  readonly challenger: {
    readonly id: string;
    readonly strategyVersion: typeof PRICE_BAND_FIXED_STRATEGY_VERSION;
    readonly parameters: PublicParameters;
  } & ForwardMetrics;
  readonly promotionStatus: PromotionStatus;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseParameters(value: unknown, label: string): WinRateParameters {
  const parameters = asRecord(value, label);
  const entry = parameters["entryAtOrBelowMinor"];
  const exit = parameters["exitAtOrAboveMinor"];
  const quantity = parameters["targetQuantity"];
  if (typeof entry !== "string" || !/^(?:0|[1-9]\d*)$/.test(entry)) {
    throw new TypeError(`${label}.entryAtOrBelowMinor must be a canonical non-negative integer string`);
  }
  if (typeof exit !== "string" || !/^(?:0|[1-9]\d*)$/.test(exit)) {
    throw new TypeError(`${label}.exitAtOrAboveMinor must be a canonical non-negative integer string`);
  }
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 0) {
    throw new TypeError(`${label}.targetQuantity must be a non-negative safe integer`);
  }
  return Object.freeze({
    entryAtOrBelowMinor: BigInt(entry),
    exitAtOrAboveMinor: BigInt(exit),
    targetQuantity: quantity as number,
  });
}

function sameParameters(left: WinRateParameters, right: WinRateParameters): boolean {
  return left.entryAtOrBelowMinor === right.entryAtOrBelowMinor
    && left.exitAtOrAboveMinor === right.exitAtOrAboveMinor
    && left.targetQuantity === right.targetQuantity;
}

function derivedCandidateId(parameters: WinRateParameters): string {
  return `entry-${parameters.entryAtOrBelowMinor.toString()}-exit-${parameters.exitAtOrAboveMinor.toString()}`;
}

function publicParameters(parameters: WinRateParameters): PublicParameters {
  return Object.freeze({
    entryAtOrBelowMinor: parameters.entryAtOrBelowMinor.toString(),
    exitAtOrAboveMinor: parameters.exitAtOrAboveMinor.toString(),
    targetQuantity: parameters.targetQuantity,
  });
}

export function loadFrozenForwardIdentities(value: unknown): FrozenForwardIdentities {
  const artifact = asRecord(value, "V2 optimizer artifact");
  const championDevelopment = asRecord(artifact["championDevelopment"], "V2 championDevelopment");
  const selectedFutureChallenger = asRecord(artifact["selectedFutureChallenger"], "V2 selectedFutureChallenger");
  const objective = artifact["objective"];
  const selectionPolicyVersion = artifact["FROZEN_SELECTION_POLICY_VERSION"];
  const strategyVersion = artifact["FROZEN_STRATEGY_VERSION"];
  const historicalCutoff = artifact["observedThroughDate"];
  const challengerId = artifact["FROZEN_CHALLENGER_ID"];
  if (artifact["schemaVersion"] !== 2 || objective !== WIN_RATE_OBJECTIVE) {
    throw new TypeError("V2 optimizer artifact has an unsupported schema or objective");
  }
  if (selectionPolicyVersion !== WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION) {
    throw new TypeError("V2 optimizer artifact has an unsupported frozen selection policy");
  }
  if (strategyVersion !== PRICE_BAND_FIXED_STRATEGY_VERSION) {
    throw new TypeError("V2 optimizer artifact has an unsupported frozen strategy version");
  }
  if (typeof historicalCutoff !== "string" || !validDate(historicalCutoff)) {
    throw new TypeError("V2 optimizer artifact has an invalid observed-through date");
  }
  if (typeof challengerId !== "string" || challengerId.length === 0) {
    throw new TypeError("V2 optimizer artifact is missing its frozen challenger identity");
  }

  const championParameters = parseParameters(championDevelopment["parameters"], "V2 championDevelopment.parameters");
  const challengerParameters = parseParameters(artifact["FROZEN_PARAMETERS"], "V2 FROZEN_PARAMETERS");
  const selectedChallengerParameters = parseParameters(
    selectedFutureChallenger["parameters"],
    "V2 selectedFutureChallenger.parameters",
  );
  if (
    selectedFutureChallenger["id"] !== challengerId
    || !sameParameters(challengerParameters, selectedChallengerParameters)
    || derivedCandidateId(challengerParameters) !== challengerId
  ) {
    throw new TypeError("V2 optimizer artifact has inconsistent frozen challenger identity fields");
  }

  return Object.freeze({
    objective: WIN_RATE_OBJECTIVE,
    selectionPolicyVersion: WIN_RATE_OPTIMIZER_V2_SELECTION_POLICY_VERSION,
    historicalCutoff,
    strategyVersion: PRICE_BAND_FIXED_STRATEGY_VERSION,
    championParameters,
    challengerId,
    challengerParameters,
  });
}

function parseFreshProvenance(value: unknown): FreshProvenance {
  const provenance = asRecord(value, "forward-data provenance");
  const dateRange = asRecord(provenance["dateRange"], "forward-data provenance.dateRange");
  const fetchedAtUtc = provenance["fetchedAtUtc"];
  const source = provenance["source"];
  const rowCount = provenance["rowCount"];
  const sha256 = provenance["sha256"];
  if (
    provenance["schemaVersion"] !== 1
    || provenance["artifactId"] !== "0050-forward-v1"
    || provenance["symbol"] !== "0050"
    || provenance["purpose"] !== "FORWARD_EVALUATION_ONLY"
  ) {
    throw new TypeError("forward-data provenance has an unsupported identity or purpose");
  }
  if (typeof source !== "string" || source.trim() === "") throw new TypeError("forward-data provenance source is required");
  if (typeof fetchedAtUtc !== "string" || !validUtcTimestamp(fetchedAtUtc)) {
    throw new TypeError("forward-data provenance fetchedAtUtc must be a canonical UTC timestamp");
  }
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new TypeError("forward-data provenance rowCount must be a non-negative safe integer");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new TypeError("forward-data provenance sha256 must be a lowercase SHA-256 digest");
  }
  const start = dateRange["start"];
  const end = dateRange["end"];
  if (rowCount === 0) {
    if (start !== null || end !== null) throw new TypeError("empty forward data must have a null date range");
  } else if (
    typeof start !== "string"
    || typeof end !== "string"
    || !validDate(start)
    || !validDate(end)
    || start > end
  ) {
    throw new TypeError("forward-data provenance dateRange is invalid");
  }
  return Object.freeze({
    artifactId: "0050-forward-v1",
    symbol: "0050",
    source,
    fetchedAtUtc,
    dateRange: Object.freeze({ start: start as string | null, end: end as string | null }),
    rowCount,
    sha256,
    historicalCutoff: typeof provenance["historicalCutoff"] === "string" ? provenance["historicalCutoff"] : "",
    purpose: "FORWARD_EVALUATION_ONLY",
  });
}

interface FreshCsvSummary {
  readonly rowCount: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

function validateFreshCsv(contents: string, historicalCutoff: string): FreshCsvSummary {
  if (contents.includes("\r") && /\r(?!\n)/.test(contents)) {
    throw new TypeError("fresh CSV must use LF or CRLF line endings");
  }
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "symbol,date,open,high,low,close,volume,source") {
    throw new TypeError("fresh CSV has an unsupported header");
  }
  const rows = lines.slice(1);
  let previousDate: string | null = null;
  for (const [index, line] of rows.entries()) {
    const fields = line.split(",");
    if (fields.length !== 8 || fields.some((field) => field === "" || field.trim() !== field)) {
      throw new TypeError(`fresh CSV row ${index + 2} must contain eight non-empty unquoted fields`);
    }
    const [symbol, date, open, high, low, close, volume, source] = fields as [string, string, string, string, string, string, string, string];
    if (symbol !== "0050") throw new TypeError(`fresh CSV row ${index + 2} is not for 0050`);
    if (!validDate(date)) throw new TypeError(`fresh CSV row ${index + 2} has an invalid date`);
    if (date <= historicalCutoff) {
      throw new TypeError(`fresh CSV row ${index + 2} is on or before the historical cutoff`);
    }
    if (previousDate !== null && date <= previousDate) {
      throw new TypeError(`fresh CSV row ${index + 2} is duplicate or out of chronological order`);
    }
    if (![open, high, low, close].every((price) => /^\d+(?:\.\d+)?$/.test(price))) {
      throw new TypeError(`fresh CSV row ${index + 2} contains an invalid OHLC price`);
    }
    if (!/^\d+$/.test(volume)) throw new TypeError(`fresh CSV row ${index + 2} contains an invalid volume`);
    if (source !== "twse/STOCK_DAY") throw new TypeError(`fresh CSV row ${index + 2} has an unsupported source`);
    previousDate = date;
  }
  return Object.freeze({
    rowCount: rows.length,
    startDate: rows[0]?.split(",")[1] ?? null,
    endDate: rows.at(-1)?.split(",")[1] ?? null,
  });
}

function forwardMetrics(stats: TradeCounts, freshDataSha256: string): ForwardMetrics {
  return Object.freeze({
    freshDataSha256,
    completedTradeCount: stats.completedTradeCount,
    freshCompletedTradeCount: stats.completedTradeCount,
    wins: stats.wins,
    losses: stats.losses,
    breakevens: stats.breakevens,
    rawNetWinRate: stats.netWinRate,
    wilsonLowerBound95: wilsonLowerBound95(stats.wins, stats.completedTradeCount),
  });
}

function emptyForwardMetrics(freshDataSha256: string): ForwardMetrics {
  return Object.freeze({
    freshDataSha256,
    completedTradeCount: 0,
    freshCompletedTradeCount: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    rawNetWinRate: null,
    wilsonLowerBound95: null,
  });
}

export function determineForwardPromotionStatus(
  champion: WinRateV2Metrics,
  challenger: WinRateV2Metrics,
  firstEvidenceDate: string,
  historicalCutoff: string,
): PromotionStatus {
  if (champion.completedTradeCount === 0 || challenger.completedTradeCount === 0) {
    return "INSUFFICIENT_FRESH_TRADES";
  }
  return determineFuturePromotionStatusV2(champion, challenger, firstEvidenceDate, historicalCutoff);
}

export function evaluateForwardWinRate(input: {
  readonly frozenArtifact: unknown;
  readonly freshDataBytes: Uint8Array;
  readonly freshProvenance: unknown;
}): ForwardWinRateEvaluation {
  const identities = loadFrozenForwardIdentities(input.frozenArtifact);
  const provenance = parseFreshProvenance(input.freshProvenance);
  if (provenance.historicalCutoff !== identities.historicalCutoff) {
    throw new TypeError("forward-data provenance historicalCutoff does not match the frozen V2 cutoff");
  }
  const freshDataSha256 = createHash("sha256").update(input.freshDataBytes).digest("hex");
  if (freshDataSha256 !== provenance.sha256) throw new TypeError("forward-data CSV SHA-256 does not match its provenance");
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(input.freshDataBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid UTF-8";
    throw new TypeError(`forward-data CSV is not valid UTF-8: ${detail}`);
  }

  const csvSummary = validateFreshCsv(contents, identities.historicalCutoff);
  if (csvSummary.rowCount !== provenance.rowCount) {
    throw new TypeError("forward-data provenance rowCount does not match its CSV");
  }
  if (csvSummary.rowCount === 0) {
    if (provenance.dateRange.start !== null || provenance.dateRange.end !== null) {
      throw new TypeError("empty forward data provenance must have a null date range");
    }
    const emptyMetrics = emptyForwardMetrics(freshDataSha256);
    return Object.freeze({
      schemaVersion: 1,
      objective: identities.objective,
      selectionPolicyVersion: identities.selectionPolicyVersion,
      historicalCutoff: identities.historicalCutoff,
      freshDataSha256,
      freshDateRange: null,
      freshRowCount: 0,
      freshCompletedTradeCount: Object.freeze({ champion: 0, challenger: 0 }),
      champion: Object.freeze({
        id: identities.strategyVersion,
        strategyVersion: identities.strategyVersion,
        parameters: publicParameters(identities.championParameters),
        ...emptyMetrics,
      }),
      challenger: Object.freeze({
        id: identities.challengerId,
        strategyVersion: identities.strategyVersion,
        parameters: publicParameters(identities.challengerParameters),
        ...emptyMetrics,
      }),
      promotionStatus: "NO_FRESH_DATA",
    });
  }
  if (csvSummary.startDate !== provenance.dateRange.start || csvSummary.endDate !== provenance.dateRange.end) {
    throw new TypeError("forward-data provenance dateRange does not match its CSV");
  }

  const parsed = parseHistoricalCsv(contents, "0050", "0050 forward evaluation evidence", TWSE_SOURCE_PROFILE_ARGUMENT);
  if (parsed.rowCount !== csvSummary.rowCount || parsed.startDate !== csvSummary.startDate || parsed.endDate !== csvSummary.endDate) {
    throw new Error("parsed forward-data rows do not reconcile with their source CSV");
  }
  const championMetrics = forwardMetrics(
    evaluateParametersOnAllRows(parsed, freshDataSha256, identities.championParameters),
    freshDataSha256,
  );
  const challengerMetrics = forwardMetrics(
    evaluateParametersOnAllRows(parsed, freshDataSha256, identities.challengerParameters),
    freshDataSha256,
  );
  const championV2Metrics: WinRateV2Metrics = championMetrics;
  const challengerV2Metrics: WinRateV2Metrics = challengerMetrics;
  const promotionStatus = determineForwardPromotionStatus(
    championV2Metrics,
    challengerV2Metrics,
    parsed.startDate,
    identities.historicalCutoff,
  );

  return Object.freeze({
    schemaVersion: 1,
    objective: identities.objective,
    selectionPolicyVersion: identities.selectionPolicyVersion,
    historicalCutoff: identities.historicalCutoff,
    freshDataSha256,
    freshDateRange: Object.freeze({ start: parsed.startDate, end: parsed.endDate }),
    freshRowCount: parsed.rowCount,
    freshCompletedTradeCount: Object.freeze({
      champion: championMetrics.completedTradeCount,
      challenger: challengerMetrics.completedTradeCount,
    }),
    champion: Object.freeze({
      id: identities.strategyVersion,
      strategyVersion: identities.strategyVersion,
      parameters: publicParameters(identities.championParameters),
      ...championMetrics,
    }),
    challenger: Object.freeze({
      id: identities.challengerId,
      strategyVersion: identities.strategyVersion,
      parameters: publicParameters(identities.challengerParameters),
      ...challengerMetrics,
    }),
    promotionStatus,
  });
}

export function assertNoForwardCliOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("forward evaluator accepts no strategy, data, or tuning overrides");
}

export async function runForwardWinRateEvaluationFiles(): Promise<ForwardWinRateEvaluation> {
  const root = process.cwd();
  const [frozenBytes, freshDataBytes, provenanceBytes] = await Promise.all([
    readFile(resolve(root, WIN_RATE_V2_ARTIFACT_PATH)),
    readFile(resolve(root, FORWARD_DATA_CSV_PATH)),
    readFile(resolve(root, FORWARD_DATA_PROVENANCE_PATH)),
  ]);
  const frozenArtifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frozenBytes)) as unknown;
  const freshProvenance = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes)) as unknown;
  const result = evaluateForwardWinRate({ frozenArtifact, freshDataBytes, freshProvenance });
  await writeFile(resolve(root, FORWARD_EVALUATION_OUTPUT_PATH), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(args: readonly string[]): Promise<void> {
  assertNoForwardCliOverrides(args);
  stdout.write(`${JSON.stringify(await runForwardWinRateEvaluationFiles())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    stderr.write(`${detail}\n`);
    process.exitCode = 1;
  });
}

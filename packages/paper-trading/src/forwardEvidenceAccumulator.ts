import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH,
  loadFrozenCrossSymbolChallenger,
} from "./crossSymbolWinRateValidationV1.js";
import { CROSS_SYMBOL_RESEARCH_RISK_V1 } from "./crossSymbolResearchRisk.js";
import {
  evaluateZScoreCrossSymbolForward,
  fetchZScoreForwardRowsAfter,
  serializeFreshCrossSymbolCsv,
  validateFreshCrossSymbolCsv,
  validateRiskNormalizedFrozenSelection,
  ZSCORE_FORWARD_EVALUATOR_VERSION,
  ZSCORE_FORWARD_SOURCE,
  ZSCORE_FORWARD_SYMBOLS,
  ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH,
  ZSCORE_RISK_NORMALIZED_FORWARD_PROVENANCE_PATH,
  ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID,
  type FreshMarketRow,
} from "./zscoreCrossSymbolForwardEvaluator.js";
import {
  ZSCORE_HISTORICAL_CUTOFF,
  ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
} from "./zscoreWinRateSelector.js";

export const FORWARD_EVIDENCE_BATCH_DIRECTORY = `${ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH.slice(0, ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH.lastIndexOf("/"))}/batches` as const;
export const FORWARD_EVIDENCE_STATUS_PATH = "packages/paper-trading/forward-evidence-status-v1.json" as const;
export const FORWARD_EVIDENCE_BATCH_ARTIFACT_ID = "cross-symbol-risk-normalized-forward-batch-v1" as const;
export const FORWARD_EVIDENCE_EXPECTED_CHALLENGER_ID = "lookback-40-entryz-1-exitz-0-hold-20" as const;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const P194_CSV_PATH = "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv" as const;
const P194_PROVENANCE_PATH = "data/market/p194-twstock-ohlcv-v1/provenance.json" as const;
const LEGACY_AUTHORITY_PATH = CROSS_SYMBOL_VALIDATION_AUTHORITY_PATH;
const ORIGINAL_FORWARD_CSV_PATH = ZSCORE_RISK_NORMALIZED_FORWARD_CSV_PATH;
const ORIGINAL_FORWARD_PROVENANCE_PATH = ZSCORE_RISK_NORMALIZED_FORWARD_PROVENANCE_PATH;
const ORIGINAL_FORWARD_RESULT_PATH = "packages/paper-trading/zscore-risk-normalized-cross-symbol-forward-v1.json" as const;
const FIXED_SYMBOLS: typeof ZSCORE_FORWARD_SYMBOLS = ZSCORE_FORWARD_SYMBOLS;

interface DateRange {
  readonly start: string;
  readonly end: string;
}

interface BatchProvenance {
  readonly schemaVersion: 1;
  readonly artifactId: typeof FORWARD_EVIDENCE_BATCH_ARTIFACT_ID;
  readonly symbols: typeof FIXED_SYMBOLS;
  readonly source: typeof ZSCORE_FORWARD_SOURCE;
  readonly providerVersion: typeof ZSCORE_FORWARD_EVALUATOR_VERSION;
  readonly fetchedAtUtc: string;
  readonly previousForwardEnd: string;
  readonly dateRange: DateRange;
  readonly perSymbolRowCounts: Readonly<Record<string, number>>;
  readonly rowCount: number;
  readonly sha256: string;
}

interface ForwardState {
  readonly historicalCutoff: string;
  readonly firstForwardDate: string;
  readonly latestForwardDate: string;
  readonly rows: readonly FreshMarketRow[];
  readonly batchHashes: readonly {
    readonly dateRange: DateRange;
    readonly sha256: string;
  }[];
  readonly originalProvenance: Record<string, unknown>;
  readonly legacyAuthority: unknown;
  readonly frozenSelection: unknown;
  readonly frozenSelectionCommit: string;
  readonly legacyIdentity: ReturnType<typeof loadFrozenCrossSymbolChallenger>;
  readonly challengerIdentity: ReturnType<typeof validateRiskNormalizedFrozenSelection>;
}

export interface ForwardEvidenceRunSummary {
  readonly previousForwardEnd: string;
  readonly fetchStatus: "NEW_DATA" | "NO_NEW_DATA";
  readonly newRowCount: number;
  readonly newDateRange: DateRange | null;
  readonly newBatchSha256: string | null;
  readonly cumulativeLatestDate: string;
  readonly cumulativeBatchCount: number;
  readonly forwardEvidenceStatus: "NO_NEW_DATA" | "ACCUMULATING_EVIDENCE" | "SUFFICIENT_EVIDENCE";
  readonly tradingWinRateImprovement: "YES" | "NO" | "NOT_EVALUABLE";
}

interface FetchResult {
  readonly rows: readonly FreshMarketRow[];
  readonly fetchedAtUtc: string;
}

interface RunOptions {
  readonly projectRoot?: string;
  readonly fetchRows?: (previousForwardEnd: string) => Promise<FetchResult>;
  readonly evaluate?: typeof evaluateZScoreCrossSymbolForward;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8`);
  }
}

async function readJson(root: string, path: string, label: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(resolve(root, path));
  try {
    return asRecord(JSON.parse(decodeUtf8(bytes, label)) as unknown, label);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new TypeError(`${label} is not valid JSON: ${detail}`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new TypeError(`${label} has unsupported fields`);
}

function countRows(rows: readonly FreshMarketRow[]): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(FIXED_SYMBOLS.map((symbol) => [
    symbol,
    rows.filter((row) => row.symbol === symbol).length,
  ])));
}

function rowRange(rows: readonly FreshMarketRow[]): DateRange {
  if (rows.length === 0) throw new TypeError("forward evidence batches must contain at least one row");
  const dates = rows.map(({ date }) => date).sort();
  return Object.freeze({ start: dates[0]!, end: dates.at(-1)! });
}

function sameRow(left: FreshMarketRow, right: FreshMarketRow): boolean {
  return left.symbol === right.symbol
    && left.date === right.date
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
    && left.source === right.source;
}

function rowKey(row: Pick<FreshMarketRow, "symbol" | "date">): string {
  return `${row.symbol}\u0000${row.date}`;
}

export function reconstructCumulativeForwardCsv(rows: readonly FreshMarketRow[]): string {
  const csv = serializeFreshCrossSymbolCsv(rows);
  validateFreshCrossSymbolCsv(csv);
  return csv;
}

export function selectUnseenForwardRows(
  fetchedRows: readonly FreshMarketRow[],
  knownRows: readonly FreshMarketRow[],
  previousForwardEnd: string,
): readonly FreshMarketRow[] {
  if (!validDate(previousForwardEnd)) throw new TypeError("previousForwardEnd must be a valid ISO date");
  const known = new Map(knownRows.map((row) => [rowKey(row), row]));
  const seen = new Map<string, FreshMarketRow>();
  const unseen: FreshMarketRow[] = [];
  for (const candidate of fetchedRows) {
    const singleRowCsv = serializeFreshCrossSymbolCsv([candidate]);
    const row = validateFreshCrossSymbolCsv(singleRowCsv)[0]!;
    const key = rowKey(row);
    const priorFetch = seen.get(key);
    if (priorFetch) {
      if (!sameRow(priorFetch, row)) throw new TypeError(`fetched rows contain a conflicting duplicate: ${row.symbol} ${row.date}`);
      continue;
    }
    seen.set(key, row);
    const priorEvidence = known.get(key);
    if (priorEvidence) {
      if (!sameRow(priorEvidence, row)) throw new TypeError(`fetched row conflicts with known evidence: ${row.symbol} ${row.date}`);
      continue;
    }
    if (row.date <= previousForwardEnd) {
      throw new TypeError(`new forward rows must be strictly after ${previousForwardEnd}: ${row.symbol} ${row.date}`);
    }
    unseen.push(row);
  }
  return validateFreshCrossSymbolCsv(serializeFreshCrossSymbolCsv(unseen));
}

function parseBatchProvenance(value: unknown, label: string): BatchProvenance {
  const provenance = asRecord(value, label);
  exactKeys(provenance, [
    "schemaVersion", "artifactId", "symbols", "source", "providerVersion", "fetchedAtUtc",
    "previousForwardEnd", "dateRange", "perSymbolRowCounts", "rowCount", "sha256",
  ], label);
  if (
    provenance["schemaVersion"] !== 1
    || provenance["artifactId"] !== FORWARD_EVIDENCE_BATCH_ARTIFACT_ID
    || JSON.stringify(provenance["symbols"]) !== JSON.stringify(FIXED_SYMBOLS)
    || provenance["source"] !== ZSCORE_FORWARD_SOURCE
    || provenance["providerVersion"] !== ZSCORE_FORWARD_EVALUATOR_VERSION
  ) {
    throw new TypeError(`${label} has an unsupported identity, source, provider, or symbol list`);
  }
  if (!validUtcTimestamp(provenance["fetchedAtUtc"])) throw new TypeError(`${label}.fetchedAtUtc must be a canonical UTC timestamp`);
  if (!validDate(provenance["previousForwardEnd"])) throw new TypeError(`${label}.previousForwardEnd must be a valid ISO date`);
  const range = asRecord(provenance["dateRange"], `${label}.dateRange`);
  exactKeys(range, ["start", "end"], `${label}.dateRange`);
  if (!validDate(range["start"]) || !validDate(range["end"]) || range["start"] > range["end"]) {
    throw new TypeError(`${label}.dateRange is invalid`);
  }
  const counts = asRecord(provenance["perSymbolRowCounts"], `${label}.perSymbolRowCounts`);
  if (JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify([...FIXED_SYMBOLS].sort())) {
    throw new TypeError(`${label}.perSymbolRowCounts must contain only the four fixed symbols`);
  }
  for (const symbol of FIXED_SYMBOLS) {
    const count = counts[symbol];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`${label}.perSymbolRowCounts.${symbol} must be a non-negative safe integer`);
    }
  }
  if (typeof provenance["rowCount"] !== "number" || !Number.isSafeInteger(provenance["rowCount"]) || provenance["rowCount"] <= 0) {
    throw new TypeError(`${label}.rowCount must be a positive safe integer`);
  }
  if (typeof provenance["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(provenance["sha256"])) {
    throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return provenance as unknown as BatchProvenance;
}

async function readBatchDirectories(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(resolve(root, FORWARD_EVIDENCE_BATCH_DIRECTORY), { withFileTypes: true });
    if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
      throw new TypeError("forward evidence batch root may contain only batch directories");
    }
    return Object.freeze(entries.map(({ name }) => name).sort());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

async function readImmutableAuthorities(root: string): Promise<{
  readonly hashes: Readonly<Record<string, string>>;
  readonly originalRows: readonly FreshMarketRow[];
  readonly originalProvenance: Record<string, unknown>;
  readonly legacyAuthority: Record<string, unknown>;
  readonly frozenSelection: Record<string, unknown>;
  readonly frozenSelectionCommit: string;
  readonly legacyIdentity: ReturnType<typeof loadFrozenCrossSymbolChallenger>;
  readonly challengerIdentity: ReturnType<typeof validateRiskNormalizedFrozenSelection>;
}> {
  const paths = [P194_CSV_PATH, P194_PROVENANCE_PATH, ORIGINAL_FORWARD_CSV_PATH,
    ORIGINAL_FORWARD_PROVENANCE_PATH, ORIGINAL_FORWARD_RESULT_PATH,
    LEGACY_AUTHORITY_PATH, ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH] as const;
  const bytes = await Promise.all(paths.map((path) => readFile(resolve(root, path))));
  const byPath = new Map<string, Uint8Array>(paths.map((path, index) => [path, bytes[index]!]));
  const json = (path: string): Record<string, unknown> => {
    const raw = JSON.parse(decodeUtf8(byPath.get(path)!, path)) as unknown;
    return asRecord(raw, path);
  };
  const p194Csv = byPath.get(P194_CSV_PATH)!;
  const p194Provenance = json(P194_PROVENANCE_PATH);
  const originalCsv = byPath.get(ORIGINAL_FORWARD_CSV_PATH)!;
  const originalProvenance = json(ORIGINAL_FORWARD_PROVENANCE_PATH);
  const originalResult = json(ORIGINAL_FORWARD_RESULT_PATH);
  const legacyAuthority = json(LEGACY_AUTHORITY_PATH);
  const frozenSelection = json(ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH);
  const p194Sha = digest(p194Csv);
  const originalSha = digest(originalCsv);
  const p194RecordedSha = p194Provenance["csvSha256"];
  if (p194RecordedSha !== p194Sha || frozenSelection["historicalInputSha256"] !== p194Sha) {
    throw new TypeError("P194 historical CSV hash does not match its provenance and frozen selection authority");
  }
  if (originalProvenance["sha256"] !== originalSha || originalResult["freshDataSha256"] !== originalSha) {
    throw new TypeError("first forward CSV hash does not match its provenance and frozen blind result");
  }
  const originalDateRange = asRecord(originalProvenance["actualDateRange"], "first forward actualDateRange");
  const resultDateRange = asRecord(originalResult["freshDateRange"], "first forward result freshDateRange");
  if (
    originalDateRange["start"] !== resultDateRange["start"]
    || originalDateRange["end"] !== resultDateRange["end"]
    || originalDateRange["start"] !== "2026-08-12"
    || originalDateRange["end"] !== "2026-09-30"
  ) {
    throw new TypeError("first forward date range does not match the frozen blind result and packet range");
  }
  if (JSON.stringify(originalProvenance["symbols"]) !== JSON.stringify(FIXED_SYMBOLS)) {
    throw new TypeError("first forward provenance does not preserve the four fixed symbols");
  }
  if (JSON.stringify(originalResult["freshSymbols"]) !== JSON.stringify(FIXED_SYMBOLS)) {
    throw new TypeError("first blind forward result does not preserve the four fixed symbols");
  }
  const originalRows = validateFreshCrossSymbolCsv(decodeUtf8(originalCsv, ORIGINAL_FORWARD_CSV_PATH));
  const computedRange = rowRange(originalRows);
  if (computedRange.start !== originalDateRange["start"] || computedRange.end !== originalDateRange["end"]) {
    throw new TypeError("first forward CSV date range does not match its provenance");
  }
  const recordedCounts = asRecord(originalProvenance["perSymbolRowCounts"], "first forward perSymbolRowCounts");
  if (JSON.stringify(countRows(originalRows)) !== JSON.stringify(Object.fromEntries(FIXED_SYMBOLS.map((symbol) => [symbol, recordedCounts[symbol]])))) {
    throw new TypeError("first forward CSV symbol counts do not match its provenance");
  }
  if (originalProvenance["historicalCutoff"] !== ZSCORE_HISTORICAL_CUTOFF) {
    throw new TypeError("first forward provenance has a different historical cutoff");
  }
  const legacyIdentity = loadFrozenCrossSymbolChallenger(legacyAuthority);
  const challengerIdentity = validateRiskNormalizedFrozenSelection(frozenSelection);
  if (challengerIdentity.id !== FORWARD_EVIDENCE_EXPECTED_CHALLENGER_ID) {
    throw new TypeError("frozen selection authority does not contain the expected challenger identity");
  }
  const frozenSelectionCommit = originalResult["frozenSelectionCommit"];
  if (typeof frozenSelectionCommit !== "string" || !/^[a-f0-9]{40}$/.test(frozenSelectionCommit)) {
    throw new TypeError("first blind forward result does not identify the frozen selection commit");
  }
  const hashes = Object.freeze(Object.fromEntries(paths.map((path, index) => [path, digest(bytes[index]!)])));
  return Object.freeze({
    hashes,
    originalRows,
    originalProvenance,
    legacyAuthority,
    frozenSelection,
    frozenSelectionCommit,
    legacyIdentity,
    challengerIdentity,
  });
}

async function readState(root: string): Promise<ForwardState> {
  const authority = await readImmutableAuthorities(root);
  const originalRange = asRecord(authority.originalProvenance["actualDateRange"], "first forward actualDateRange");
  const firstForwardDate = originalRange["start"] as string;
  let latestForwardDate = originalRange["end"] as string;
  const rows = [...authority.originalRows];
  const batchHashes: { dateRange: DateRange; sha256: string }[] = [{
    dateRange: Object.freeze({ start: firstForwardDate, end: latestForwardDate }),
    sha256: authority.hashes[ORIGINAL_FORWARD_CSV_PATH]!,
  }];
  const known = new Map(rows.map((row) => [rowKey(row), row]));

  for (const directoryName of await readBatchDirectories(root)) {
    if (!/^\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}$/.test(directoryName)) {
      throw new TypeError(`unsupported forward batch directory name: ${directoryName}`);
    }
    const directory = `${FORWARD_EVIDENCE_BATCH_DIRECTORY}/${directoryName}`;
    const csvBytes = await readFile(resolve(root, `${directory}/forward.csv`));
    const provenanceValue = await readJson(root, `${directory}/provenance.json`, `${directory}/provenance.json`);
    const provenance = parseBatchProvenance(provenanceValue, `${directory}/provenance.json`);
    if (provenance.previousForwardEnd !== latestForwardDate) {
      throw new TypeError(`${directory}/provenance.json does not continue the latest recorded forward date`);
    }
    if (digest(csvBytes) !== provenance.sha256) throw new TypeError(`${directory}/forward.csv SHA-256 does not match provenance`);
    const batchRows = validateFreshCrossSymbolCsv(decodeUtf8(csvBytes, `${directory}/forward.csv`));
    if (batchRows.length !== provenance.rowCount) throw new TypeError(`${directory}/forward.csv row count does not match provenance`);
    const actualRange = rowRange(batchRows);
    if (actualRange.start !== provenance.dateRange.start || actualRange.end !== provenance.dateRange.end) {
      throw new TypeError(`${directory}/forward.csv date range does not match provenance`);
    }
    if (`${actualRange.start}-${actualRange.end}` !== directoryName) throw new TypeError(`${directoryName} does not match its batch date range`);
    if (actualRange.start <= latestForwardDate) throw new TypeError(`${directory}/forward.csv contains rows on or before the previous forward end`);
    if (JSON.stringify(countRows(batchRows)) !== JSON.stringify(provenance.perSymbolRowCounts)) {
      throw new TypeError(`${directory}/forward.csv symbol counts do not match provenance`);
    }
    for (const row of batchRows) {
      const prior = known.get(rowKey(row));
      if (prior && !sameRow(prior, row)) throw new TypeError(`${directory}/forward.csv conflicts with previously recorded evidence`);
      if (prior) throw new TypeError(`${directory}/forward.csv duplicates previously recorded evidence`);
      known.set(rowKey(row), row);
      rows.push(row);
    }
    latestForwardDate = actualRange.end;
    batchHashes.push(Object.freeze({ dateRange: actualRange, sha256: provenance.sha256 }));
  }

  return Object.freeze({
    historicalCutoff: ZSCORE_HISTORICAL_CUTOFF,
    firstForwardDate,
    latestForwardDate,
    rows: validateFreshCrossSymbolCsv(reconstructCumulativeForwardCsv(rows)),
    batchHashes: Object.freeze(batchHashes),
    originalProvenance: authority.originalProvenance,
    legacyAuthority: authority.legacyAuthority,
    frozenSelection: authority.frozenSelection,
    frozenSelectionCommit: authority.frozenSelectionCommit,
    legacyIdentity: authority.legacyIdentity,
    challengerIdentity: authority.challengerIdentity,
  });
}

export async function loadForwardEvidenceState(projectRoot = PROJECT_ROOT): Promise<{
  readonly historicalCutoff: string;
  readonly firstForwardDate: string;
  readonly latestForwardDate: string;
  readonly cumulativeRows: number;
  readonly batchCount: number;
}> {
  const state = await readState(projectRoot);
  return Object.freeze({
    historicalCutoff: state.historicalCutoff,
    firstForwardDate: state.firstForwardDate,
    latestForwardDate: state.latestForwardDate,
    cumulativeRows: state.rows.length,
    batchCount: state.batchHashes.length,
  });
}

function metrics(value: unknown, label: string): Record<string, unknown> {
  const input = asRecord(value, label);
  const wins = input["WIN"];
  const losses = input["LOSS"];
  const breakevens = input["BREAKEVEN"];
  const completedTradeCount = input["completedTradeCount"];
  if (
    !Number.isSafeInteger(wins) || !Number.isSafeInteger(losses) || !Number.isSafeInteger(breakevens)
    || !Number.isSafeInteger(completedTradeCount)
    || (wins as number) + (losses as number) + (breakevens as number) !== completedTradeCount
  ) {
    throw new TypeError(`${label} has unreconciled completed trade counts`);
  }
  return Object.freeze({
    completedTradeCount,
    WIN: wins,
    LOSS: losses,
    BREAKEVEN: breakevens,
    rawNetWinRate: input["rawNetWinRate"],
    WilsonLowerBound95: input["WilsonLowerBound95"],
    netPnl: input["netPnl"],
    fees: input["fees"],
  });
}

function aggregateMetrics(value: unknown, label: string): Record<string, unknown> {
  const input = asRecord(value, label);
  return metrics({
    completedTradeCount: input["aggregateCompletedTrades"],
    WIN: input["aggregateW"],
    LOSS: input["aggregateL"],
    BREAKEVEN: input["aggregateBE"],
    rawNetWinRate: input["aggregateRawNetWinRate"],
    WilsonLowerBound95: input["aggregateWilsonLowerBound95"],
    netPnl: input["netPnl"],
    fees: input["fees"],
  }, label);
}

function evaluationMetrics(result: Record<string, unknown>, key: "legacyReference" | "newFrozenChallenger"):
  { readonly perSymbol: readonly Record<string, unknown>[]; readonly aggregate: Record<string, unknown> } {
  const strategy = asRecord(result[key], key);
  if (!Array.isArray(strategy["perSymbol"])) throw new TypeError(`${key}.perSymbol must be an array`);
  const perSymbol = Object.freeze((strategy["perSymbol"] as unknown[]).map((raw, index) => {
    const item = asRecord(raw, `${key}.perSymbol[${index}]`);
    if (typeof item["symbol"] !== "string") throw new TypeError(`${key}.perSymbol[${index}].symbol is required`);
    return Object.freeze({ symbol: item["symbol"], ...metrics(item, `${key}.perSymbol[${index}]`) });
  }));
  if (JSON.stringify(perSymbol.map(({ symbol }) => symbol)) !== JSON.stringify(FIXED_SYMBOLS)) {
    throw new TypeError(`${key}.perSymbol must preserve the four fixed symbols`);
  }
  return Object.freeze({ perSymbol, aggregate: aggregateMetrics(strategy["aggregate"], `${key}.aggregate`) });
}

function statusArtifact(
  state: ForwardState,
  result: Record<string, unknown>,
  forwardEvidenceStatus: ForwardEvidenceRunSummary["forwardEvidenceStatus"],
): Record<string, unknown> {
  const legacy = evaluationMetrics(result, "legacyReference");
  const challenger = evaluationMetrics(result, "newFrozenChallenger");
  const sufficiency = asRecord(result["freshEvidenceSufficiency"], "freshEvidenceSufficiency");
  const requirements = asRecord(sufficiency["requirements"], "freshEvidenceSufficiency.requirements");
  const legacySufficiency = asRecord(sufficiency["legacyReference"], "freshEvidenceSufficiency.legacyReference");
  const challengerSufficiency = asRecord(sufficiency["newFrozenChallenger"], "freshEvidenceSufficiency.newFrozenChallenger");
  const improvement = result["tradingWinRateImprovement"];
  if (improvement !== "YES" && improvement !== "NO" && improvement !== "NOT EVALUABLE") {
    throw new TypeError("forward evaluator returned an unsupported improvement status");
  }
  return Object.freeze({
    schemaVersion: 1,
    strategyAuthorities: Object.freeze({
      legacyReference: Object.freeze({
        path: LEGACY_AUTHORITY_PATH,
        identity: state.legacyIdentity.strategyFamily,
        candidateId: state.legacyIdentity.id,
        parameters: state.legacyIdentity.parameters,
      }),
      frozenChallenger: Object.freeze({
        path: ZSCORE_RISK_NORMALIZED_SELECTION_ARTIFACT_PATH,
        identity: "ROLLING_ZSCORE_MEAN_REVERSION_V1",
        candidateId: state.challengerIdentity.id,
        parameters: state.challengerIdentity.parameters,
      }),
    }),
    riskProfile: Object.freeze({
      id: CROSS_SYMBOL_RESEARCH_RISK_V1.id,
      initialCapitalMinor: Number(CROSS_SYMBOL_RESEARCH_RISK_V1.initialCapitalMinor),
      maxExposureMinor: Number(CROSS_SYMBOL_RESEARCH_RISK_V1.maxExposureMinor),
      maxExposureFractionOfInitialCapital: CROSS_SYMBOL_RESEARCH_RISK_V1.maxExposureFractionOfInitialCapital,
      currency: CROSS_SYMBOL_RESEARCH_RISK_V1.currency,
      minorUnitsPerMajor: CROSS_SYMBOL_RESEARCH_RISK_V1.minorUnitsPerMajor,
    }),
    historicalCutoff: state.historicalCutoff,
    firstForwardDate: state.firstForwardDate,
    latestForwardDate: state.latestForwardDate,
    batchCount: state.batchHashes.length,
    batchHashes: state.batchHashes,
    legacyReference: legacy,
    frozenChallenger: challenger,
    sufficiency: Object.freeze({
      minimumSymbolsWithAtLeastOneCompletedTrade: requirements["minimumSymbolsWithAtLeastOneCompletedTrade"],
      minimumAggregateCompletedTrades: requirements["minimumAggregateCompletedTrades"],
      legacyReference: Object.freeze({
        symbolsWithCompletedTrades: legacySufficiency["symbolsWithCompletedTrades"],
        aggregateCompletedTrades: legacySufficiency["aggregateCompletedTrades"],
        sufficient: legacySufficiency["sufficient"],
      }),
      frozenChallenger: Object.freeze({
        symbolsWithCompletedTrades: challengerSufficiency["symbolsWithCompletedTrades"],
        aggregateCompletedTrades: challengerSufficiency["aggregateCompletedTrades"],
        sufficient: challengerSufficiency["sufficient"],
      }),
    }),
    forwardEvidenceStatus,
    tradingWinRateImprovement: improvement === "NOT EVALUABLE" ? "NOT_EVALUABLE" : improvement,
  });
}

function cumulativeEvaluationInput(state: ForwardState): {
  readonly freshDataBytes: Uint8Array;
  readonly freshProvenance: Record<string, unknown>;
} {
  const csv = reconstructCumulativeForwardCsv(state.rows);
  const bytes = new TextEncoder().encode(csv);
  const dates = rowRange(state.rows);
  const sourceUrls = state.originalProvenance["sourceUrls"];
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) throw new TypeError("original forward provenance is missing sourceUrls");
  const fetchedAtUtc = state.originalProvenance["fetchedAtUtc"];
  if (!validUtcTimestamp(fetchedAtUtc)) throw new TypeError("original forward provenance has an invalid fetchedAtUtc");
  return Object.freeze({
    freshDataBytes: bytes,
    freshProvenance: Object.freeze({
      schemaVersion: 1,
      artifactId: ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID,
      symbols: FIXED_SYMBOLS,
      source: ZSCORE_FORWARD_SOURCE,
      providerVersion: ZSCORE_FORWARD_EVALUATOR_VERSION,
      fetchedAtUtc,
      historicalCutoff: state.historicalCutoff,
      actualDateRange: dates,
      perSymbolRowCounts: countRows(state.rows),
      sha256: digest(bytes),
      purpose: "BLIND_CROSS_SYMBOL_FORWARD_EVALUATION",
      sourceUrls,
    }),
  });
}

async function appendBatch(
  root: string,
  rows: readonly FreshMarketRow[],
  previousForwardEnd: string,
  fetchedAtUtc: string,
): Promise<{ readonly dateRange: DateRange; readonly sha256: string }> {
  if (!validUtcTimestamp(fetchedAtUtc)) throw new TypeError("fetch result fetchedAtUtc must be a canonical UTC timestamp");
  const csv = serializeFreshCrossSymbolCsv(rows);
  const validated = validateFreshCrossSymbolCsv(csv);
  if (validated.length !== rows.length || validated.some(({ date }) => date <= previousForwardEnd)) {
    throw new TypeError("new batch rows must be valid and strictly later than previousForwardEnd");
  }
  const dateRange = rowRange(validated);
  const bytes = new TextEncoder().encode(csv);
  const sha256 = digest(bytes);
  const provenance: BatchProvenance = Object.freeze({
    schemaVersion: 1,
    artifactId: FORWARD_EVIDENCE_BATCH_ARTIFACT_ID,
    symbols: FIXED_SYMBOLS,
    source: ZSCORE_FORWARD_SOURCE,
    providerVersion: ZSCORE_FORWARD_EVALUATOR_VERSION,
    fetchedAtUtc,
    previousForwardEnd,
    dateRange,
    perSymbolRowCounts: countRows(validated),
    rowCount: validated.length,
    sha256,
  });
  const batchDirectory = resolve(root, FORWARD_EVIDENCE_BATCH_DIRECTORY, `${dateRange.start}-${dateRange.end}`);
  await mkdir(resolve(root, FORWARD_EVIDENCE_BATCH_DIRECTORY), { recursive: true });
  await mkdir(batchDirectory);
  await writeFile(resolve(batchDirectory, "forward.csv"), bytes, { flag: "wx" });
  await writeFile(resolve(batchDirectory, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ dateRange, sha256 });
}

export async function runForwardEvidenceAccumulator(options: RunOptions = {}): Promise<ForwardEvidenceRunSummary> {
  const root = resolve(options.projectRoot ?? PROJECT_ROOT);
  const before = await readImmutableAuthorities(root);
  let state = await readState(root);
  const previousForwardEnd = state.latestForwardDate;
  const fetchResult = await (options.fetchRows ?? fetchZScoreForwardRowsAfter)(previousForwardEnd);
  if (!validUtcTimestamp(fetchResult.fetchedAtUtc)) throw new TypeError("fetch result fetchedAtUtc must be a canonical UTC timestamp");
  const unseenRows = selectUnseenForwardRows(fetchResult.rows, state.rows, previousForwardEnd);
  const fetchStatus = unseenRows.length > 0 ? "NEW_DATA" : "NO_NEW_DATA";
  let newBatch: { readonly dateRange: DateRange; readonly sha256: string } | null = null;
  if (unseenRows.length > 0) {
    newBatch = await appendBatch(root, unseenRows, previousForwardEnd, fetchResult.fetchedAtUtc);
    state = await readState(root);
  }
  const evaluationInput = cumulativeEvaluationInput(state);
  const result = (options.evaluate ?? evaluateZScoreCrossSymbolForward)({
    ...evaluationInput,
    legacyReferenceArtifact: state.legacyAuthority,
    frozenSelectionArtifact: state.frozenSelection,
    frozenSelectionCommit: state.frozenSelectionCommit,
    researchRiskProfile: CROSS_SYMBOL_RESEARCH_RISK_V1,
    freshArtifactId: ZSCORE_RISK_NORMALIZED_FRESH_ARTIFACT_ID,
  });
  const sufficient = state.rows.length > 0
    && asRecord(asRecord(result["freshEvidenceSufficiency"], "freshEvidenceSufficiency")["legacyReference"], "legacy sufficiency")["sufficient"] === true
    && asRecord(asRecord(result["freshEvidenceSufficiency"], "freshEvidenceSufficiency")["newFrozenChallenger"], "challenger sufficiency")["sufficient"] === true;
  const forwardEvidenceStatus: ForwardEvidenceRunSummary["forwardEvidenceStatus"] = fetchStatus === "NO_NEW_DATA"
    ? "NO_NEW_DATA"
    : sufficient ? "SUFFICIENT_EVIDENCE" : "ACCUMULATING_EVIDENCE";
  await writeFile(
    resolve(root, FORWARD_EVIDENCE_STATUS_PATH),
    `${JSON.stringify(statusArtifact(state, result, forwardEvidenceStatus), null, 2)}\n`,
    "utf8",
  );
  const after = await readImmutableAuthorities(root);
  if (JSON.stringify(before.hashes) !== JSON.stringify(after.hashes)) {
    throw new Error("one or more frozen historical or first-forward artifacts changed during accumulator execution");
  }
  const improvement = result["tradingWinRateImprovement"];
  if (improvement !== "YES" && improvement !== "NO" && improvement !== "NOT EVALUABLE") {
    throw new TypeError("forward evaluator returned an unsupported improvement status");
  }
  return Object.freeze({
    previousForwardEnd,
    fetchStatus,
    newRowCount: unseenRows.length,
    newDateRange: newBatch?.dateRange ?? null,
    newBatchSha256: newBatch?.sha256 ?? null,
    cumulativeLatestDate: state.latestForwardDate,
    cumulativeBatchCount: state.batchHashes.length,
    forwardEvidenceStatus,
    tradingWinRateImprovement: improvement === "NOT EVALUABLE" ? "NOT_EVALUABLE" : improvement,
  });
}

export function assertNoForwardEvidenceCliOverrides(args: readonly string[]): void {
  if (args.length > 0) throw new TypeError("forward evidence accumulator accepts no symbol, data, strategy, or tuning overrides");
}

async function main(args: readonly string[]): Promise<void> {
  assertNoForwardEvidenceCliOverrides(args);
  const result = await runForwardEvidenceAccumulator();
  stdout.write([
    `FORWARD_EVIDENCE_STATUS: ${result.forwardEvidenceStatus}`,
    `PREVIOUS_FORWARD_END: ${result.previousForwardEnd}`,
    `FETCH_STATUS: ${result.fetchStatus}`,
    `NEW_ROWS: ${result.newRowCount}`,
    `NEW_DATE_RANGE: ${result.newDateRange ? `${result.newDateRange.start} through ${result.newDateRange.end}` : "NONE"}`,
    `NEW_BATCH_SHA256: ${result.newBatchSha256 ?? "NONE"}`,
    `CUMULATIVE_LATEST_DATE: ${result.cumulativeLatestDate}`,
    `CUMULATIVE_BATCH_COUNT: ${result.cumulativeBatchCount}`,
    `TRADING_WIN_RATE_IMPROVEMENT: ${result.tradingWinRateImprovement}`,
  ].join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown forward evidence accumulator error";
    stderr.write(`paper:update-forward-evidence: ${message}\n`);
    process.exitCode = 1;
  });
}

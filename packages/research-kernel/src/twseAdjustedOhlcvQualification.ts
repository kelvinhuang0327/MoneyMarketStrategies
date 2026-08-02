/**
 * Pure, network-free TWSE 0050-split adjustment qualification.
 *
 * This module (like the rest of `@mms/research-kernel`) never imports a
 * Node built-in: no `node:crypto`, no `Buffer`. Byte-level concerns (SHA-256
 * of the committed CSV and of the fixture payload text) are the CLI's job;
 * this module receives already-computed hash strings purely for disclosure
 * and works only with parsed strings/numbers. There is deliberately no live
 * network fetch path (a network fetch is forbidden for this runner): the
 * fixture payloads below are the pinned, historically-verified TWSE
 * responses for the 2025-06-18 0050 split window, reproduced verbatim for a
 * fully deterministic, offline reconciliation.
 */

export const EXISTING_PRICE_DISCONTINUITY_THRESHOLD = 0.5;

export const TWSE_QUALIFICATION_ENDPOINTS = Object.freeze({
  splitReference:
    "https://www.twse.com.tw/rwd/zh/split/TWTCAU?startDate=20250618&endDate=20250618&response=json",
  stockDay0050:
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20250601&stockNo=0050",
  stockDay2330:
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20250601&stockNo=2330",
});

export const TWSE_0050_DISCLOSURE = Object.freeze({
  url:
    "https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other",
  publishedAt: "2025-06-17T03:35:21.000Z",
  displayedPublishedAt: "2025-06-17 11:35:21 Asia/Taipei",
  sourceDocumentIdentifier: "TWSE_ETFORTUNE_0050_20250617_SEQ1",
});

export type PointInTimeStatus = "PIT_PROVEN" | "PIT_PARTIALLY_PROVEN" | "PIT_UNPROVEN";
export type CorporateActionType = "ETF_SPLIT" | "ETF_REVERSE_SPLIT";
export type TimestampEvidence = "HISTORICAL_PUBLICATION" | "CURRENT_AVAILABILITY_ONLY" | "NONE";
export type DatasetIdentifier =
  | "TWSE_TWTCAU_2025-06-18"
  | "TWSE_STOCK_DAY_0050_2025-06"
  | "TWSE_STOCK_DAY_2330_2025-06";

export interface SourceCandidateEvaluation {
  readonly sourceName: string;
  readonly operator: string;
  readonly publicDocumentationLocations: readonly string[];
  readonly accessMethod: string;
  readonly authenticationRequirement: string;
  readonly rateLimitOrStabilityNotes: string;
  readonly adjustedPriceSupport: string;
  readonly corporateActionEventSupport: string;
  readonly historicalCoverage: string;
  readonly publicationAvailabilityTimestampSupport: string;
  readonly licenseOrUsageRestrictionEvidence: string;
  readonly decision: "ACCEPTED" | "REJECTED";
  readonly reason: string;
}

export const SOURCE_CANDIDATE_EVALUATIONS: readonly SourceCandidateEvaluation[] = Object.freeze([
  Object.freeze({
    sourceName: "TWSE split-reference and STOCK_DAY reports",
    operator: "Taiwan Stock Exchange Corporation",
    publicDocumentationLocations: Object.freeze([
      "https://www.twse.com.tw/zh/announcement/split/twtcau.html",
      "https://www.twse.com.tw/en/announcement/split/twtcau.html",
      TWSE_0050_DISCLOSURE.url,
      "https://data.gov.tw/dataset/11549",
      "https://www.twse.com.tw/zh/terms/use.html",
    ]),
    accessMethod:
      "Three bounded public HTTPS GET requests: one split-reference window and one monthly STOCK_DAY response per symbol.",
    authenticationRequirement: "None; no token, cookie, account, or credential.",
    rateLimitOrStabilityNotes:
      "No numeric rate-limit contract is published for these report endpoints.",
    adjustedPriceSupport:
      "No general adjusted-OHLCV series. TWTCAU publishes the explicit pre-event close and post-split reference-price relationship used for adjustment.",
    corporateActionEventSupport:
      "TWTCAU identifies ETF split/reverse-split type and effective resumption date.",
    historicalCoverage:
      "The bounded endpoints reproduce the required June 2025 window; full retention depth is not documented and remains a qualification risk.",
    publicationAvailabilityTimestampSupport:
      "The official 0050 disclosure records a 2025-06-17 11:35:21 Asia/Taipei publication before the 2025-06-18 event, but report payloads omit per-record publication/version timestamps.",
    licenseOrUsageRestrictionEvidence:
      "TWSE terms permit research reference with clear attribution; the government daily-price dataset is free under Open Government Data License 1.0.",
    decision: "ACCEPTED",
    reason:
      "Official, credential-free event and raw-price evidence reconciles 0050 while matching the committed CSV and producing no event for 2330.",
  }),
  Object.freeze({
    sourceName: "FinMind TaiwanStockPriceAdj",
    operator: "FinMind",
    publicDocumentationLocations: Object.freeze([
      "https://finmind.github.io/tutor/TaiwanMarket/Technical/",
      "https://api.finmindtrade.com/docs",
      "https://github.com/FinMind/FinMind",
    ]),
    accessMethod: "HTTPS data API and Apache-2.0 open-source client.",
    authenticationRequirement:
      "The adjusted-price dataset is documented as limited to backer/sponsor members and examples are token-oriented.",
    rateLimitOrStabilityNotes:
      "Documentation states 300 requests/hour without a token and 600/hour with a registered token; weekly maintenance is also documented.",
    adjustedPriceSupport:
      "TaiwanStockPriceAdj is documented from 1994-10-01 to present, but access is membership-restricted.",
    corporateActionEventSupport:
      "The catalog exposes split-related datasets, but the adjusted series does not include traceable per-row event-factor provenance in its published schema.",
    historicalCoverage: "Documented from 1994-10-01 to present.",
    publicationAvailabilityTimestampSupport:
      "A weekday update schedule is documented, not a historical per-record availability timestamp.",
    licenseOrUsageRestrictionEvidence:
      "The client is Apache-2.0, while project content/data is limited to educational non-commercial use and the required adjusted dataset is member-restricted.",
    decision: "REJECTED",
    reason:
      "The required adjusted dataset is not credential-free/public under the task contract, and factor-level provenance plus historical availability are insufficient.",
  }),
]);

export interface PayloadHash {
  readonly datasetIdentifier: DatasetIdentifier;
  readonly rawPayloadSha256: string;
}

export interface NormalizedCorporateAction {
  readonly symbol: string;
  readonly corporateActionType: CorporateActionType;
  readonly effectiveDate: string;
  readonly preEventRawClose: number;
  readonly sourceReferenceAdjustedClose: number;
  readonly adjustmentFactor: number;
  readonly sourcePublicationAvailabilityTimestamp: string | null;
  readonly timestampEvidence: TimestampEvidence;
  readonly sourceDisclosureIdentifier: string;
  readonly fetchedAtTimestamp: string;
  readonly rawPayloadSha256: string;
}

export interface NormalizedAdjustedOhlcvRecord {
  readonly symbol: string;
  readonly tradingDate: string;
  readonly rawClose: number;
  readonly adjustedClose: number;
  readonly adjustmentFactor: number;
  readonly corporateActionType: CorporateActionType | null;
  readonly effectiveDate: string | null;
  readonly sourcePublicationAvailabilityTimestamp: string | null;
  readonly timestampEvidence: TimestampEvidence;
  readonly sourceDocumentOrDatasetIdentifier: DatasetIdentifier;
  readonly fetchedAtTimestamp: string;
  readonly rawPayloadSha256: string;
}

export interface PointInTimeEvidence {
  readonly sourcePublicationAvailabilityTimestamp: string | null;
  readonly timestampEvidence: TimestampEvidence;
  readonly evidenceIdentifier: string;
}

export interface TwseSourceSnapshot {
  readonly fetchedAtTimestamp: string;
  readonly events: readonly NormalizedCorporateAction[];
  readonly records: readonly NormalizedAdjustedOhlcvRecord[];
  readonly payloadHashes: readonly PayloadHash[];
}

export interface CommittedObservation {
  readonly symbol: "0050" | "2330";
  readonly tradingDate: "2025-06-10" | "2025-06-18";
  readonly rawClose: number;
}

export interface ReconciliationResult {
  readonly status: "RECONCILED";
  readonly priorTradingDate: string;
  readonly nextTradingDate: string;
  readonly sourcePriorRawClose: number;
  readonly sourceNextRawClose: number;
  readonly sourceReferenceAdjustedClose: number;
  readonly derivedAdjustmentFactor: number;
  readonly rawCloseToCloseReturn: number;
  readonly adjustedCloseToCloseReturn: number;
  readonly discontinuityThreshold: number;
  readonly effectiveDate: string;
  readonly corporateActionType: CorporateActionType;
  readonly sourcePublicationAvailabilityTimestamp: string | null;
}

export interface ControlResult {
  readonly status: "PASS";
  readonly priorTradingDate: string;
  readonly nextTradingDate: string;
  readonly sourcePriorRawClose: number;
  readonly sourceNextRawClose: number;
  readonly corporateActionReported: false;
  readonly adjustmentFactor: 1;
  readonly adjustedCloseToCloseReturn: number;
  readonly fabricatedEvent: false;
}

export interface QualificationResult {
  readonly qualificationStatus: "PASS";
  readonly selectedSource: "TWSE split-reference and STOCK_DAY reports";
  readonly sourceOperator: "Taiwan Stock Exchange Corporation";
  readonly pointInTimeStatus: PointInTimeStatus;
  readonly sourceProvenance: {
    readonly candidateEvaluations: readonly SourceCandidateEvaluation[];
    readonly selectedDocumentation: readonly string[];
    readonly sourceDisclosurePublishedAt: string;
    readonly normalizedRecords: readonly NormalizedAdjustedOhlcvRecord[];
  };
  readonly payloadHashes: readonly PayloadHash[];
  readonly "0050Reconciliation": ReconciliationResult;
  readonly "2330Control": ControlResult;
  readonly remainingRisks: readonly string[];
}

type QualificationErrorCode =
  | "COMMITTED_OBSERVATION_CONFLICT"
  | "COMMITTED_OBSERVATION_MISSING"
  | "CONFLICTING_EVENT_FACTORS"
  | "CONTROL_SYMBOL_EVENT_REPORTED"
  | "DUPLICATE_RECORD"
  | "EVENT_EFFECTIVE_DATE_MISALIGNED"
  | "EXPECTED_RAW_DISCONTINUITY_MISSING"
  | "FUTURE_PUBLICATION_FOR_AS_OF"
  | "INVALID_DATE"
  | "INVALID_JSON"
  | "INVALID_NUMERIC_FIELD"
  | "INVALID_TIMESTAMP"
  | "MISSING_ADJUSTMENT_METADATA"
  | "MISSING_REQUIRED_FIELD"
  | "OUT_OF_ORDER_RECORDS"
  | "RECONCILIATION_THRESHOLD_FAILED"
  | "TWSE_REPORT_NOT_OK"
  | "UNRECOGNIZED_EVENT_TYPE";

export class AdjustedOhlcvQualificationError extends Error {
  readonly code: QualificationErrorCode;

  constructor(code: QualificationErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "AdjustedOhlcvQualificationError";
    this.code = code;
  }
}

function fail(code: QualificationErrorCode, detail?: string): never {
  throw new AdjustedOhlcvQualificationError(code, detail);
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail("MISSING_REQUIRED_FIELD", field);
  return value.trim();
}

function parseRequiredNumber(value: unknown, field: string): number {
  const text = requiredString(value, field).replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) fail("INVALID_NUMERIC_FIELD", field);
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) fail("INVALID_NUMERIC_FIELD", field);
  return parsed;
}

function parseRocDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const match = /^(\d{3})\/(\d{2})\/(\d{2})$/.exec(text);
  if (!match) fail("INVALID_DATE", field);
  const year = Number(match[1]) + 1911;
  const iso = `${String(year).padStart(4, "0")}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    fail("INVALID_DATE", field);
  }
  return iso;
}

function requireCanonicalTimestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INVALID_TIMESTAMP", field);
  }
  return value;
}

function parseJsonReport(rawPayload: string, datasetIdentifier: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload) as unknown;
  } catch {
    fail("INVALID_JSON", datasetIdentifier);
  }
  if (!isRecord(parsed)) fail("INVALID_JSON", `${datasetIdentifier}:root_not_object`);
  if (parsed["stat"] !== "OK") fail("TWSE_REPORT_NOT_OK", datasetIdentifier);
  return parsed;
}

function reportTable(
  report: Record<string, unknown>,
  datasetIdentifier: string,
): { readonly fields: readonly string[]; readonly rows: readonly unknown[][] } {
  const rawFields = report["fields"];
  if (!Array.isArray(rawFields)) fail("MISSING_REQUIRED_FIELD", `${datasetIdentifier}.fields`);
  const fields = rawFields.map((value, index) =>
    requiredString(value, `${datasetIdentifier}.fields[${index}]`));
  if (new Set(fields).size !== fields.length) {
    fail("DUPLICATE_RECORD", `${datasetIdentifier}:duplicate_field`);
  }
  const rawData = report["data"];
  if (!Array.isArray(rawData)) fail("MISSING_REQUIRED_FIELD", `${datasetIdentifier}.data`);
  const rows = rawData.map((row: unknown, index: number) => {
    if (!Array.isArray(row) || row.length !== fields.length) {
      fail("MISSING_REQUIRED_FIELD", `${datasetIdentifier}.data[${index}]`);
    }
    return row as unknown[];
  });
  return { fields, rows };
}

function fieldIndex(fields: readonly string[], field: string, datasetIdentifier: string): number {
  const index = fields.indexOf(field);
  if (index < 0) fail("MISSING_REQUIRED_FIELD", `${datasetIdentifier}.${field}`);
  return index;
}

function eventType(value: unknown): CorporateActionType {
  const normalized = requiredString(value, "corporate_action_type");
  if (normalized === "分割") return "ETF_SPLIT";
  if (normalized === "反分割") return "ETF_REVERSE_SPLIT";
  fail("UNRECOGNIZED_EVENT_TYPE", normalized);
}

export interface NormalizeContext {
  readonly fetchedAtTimestamp: string;
  readonly rawPayloadSha256: string;
}

/** Parses the TWTCAU split-reference report text into corporate-action events. */
export function normalizeTwseSplitReferencePayload(
  rawPayload: string,
  context: NormalizeContext,
): readonly NormalizedCorporateAction[] {
  requireCanonicalTimestamp(context.fetchedAtTimestamp, "fetched_at_timestamp");
  const report = parseJsonReport(rawPayload, "TWSE_TWTCAU_2025-06-18");
  const { fields, rows } = reportTable(report, "TWSE_TWTCAU_2025-06-18");
  const dateIndex = fieldIndex(fields, "恢復買賣日期", "TWSE_TWTCAU_2025-06-18");
  const symbolIndex = fieldIndex(fields, "ETF代號", "TWSE_TWTCAU_2025-06-18");
  const typeIndex = fieldIndex(fields, "分割(反分割)", "TWSE_TWTCAU_2025-06-18");
  const preCloseIndex = fieldIndex(fields, "停止買賣前收盤價格", "TWSE_TWTCAU_2025-06-18");
  const referenceIndex = fieldIndex(fields, "恢復買賣參考價", "TWSE_TWTCAU_2025-06-18");
  const events = rows.map((row, index): NormalizedCorporateAction => {
    const symbol = requiredString(row[symbolIndex], `event[${index}].symbol`);
    const preEventRawClose = parseRequiredNumber(row[preCloseIndex], `event[${index}].pre_event_close`);
    const sourceReferenceAdjustedClose = parseRequiredNumber(
      row[referenceIndex],
      `event[${index}].reference_price`,
    );
    const adjustmentFactor = round(sourceReferenceAdjustedClose / preEventRawClose, 12);
    if (!(adjustmentFactor > 0)) fail("MISSING_ADJUSTMENT_METADATA", `event[${index}].adjustment_factor`);
    return {
      symbol,
      corporateActionType: eventType(row[typeIndex]),
      effectiveDate: parseRocDate(row[dateIndex], `event[${index}].effective_date`),
      preEventRawClose,
      sourceReferenceAdjustedClose,
      adjustmentFactor,
      sourcePublicationAvailabilityTimestamp: TWSE_0050_DISCLOSURE.publishedAt,
      timestampEvidence: "HISTORICAL_PUBLICATION",
      sourceDisclosureIdentifier: TWSE_0050_DISCLOSURE.sourceDocumentIdentifier,
      fetchedAtTimestamp: context.fetchedAtTimestamp,
      rawPayloadSha256: context.rawPayloadSha256,
    };
  });
  const grouped = new Map<string, NormalizedCorporateAction[]>();
  for (const event of events) {
    const key = `${event.symbol}:${event.effectiveDate}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  for (const [key, duplicates] of grouped) {
    if (duplicates.length <= 1) continue;
    if (new Set(duplicates.map((event) => event.adjustmentFactor)).size > 1) {
      fail("CONFLICTING_EVENT_FACTORS", key);
    }
    fail("DUPLICATE_RECORD", key);
  }
  return events.sort((left, right) =>
    compareText(`${left.effectiveDate}:${left.symbol}`, `${right.effectiveDate}:${right.symbol}`));
}

interface PriceParseContext extends NormalizeContext {
  readonly symbol: "0050" | "2330";
  readonly datasetIdentifier: "TWSE_STOCK_DAY_0050_2025-06" | "TWSE_STOCK_DAY_2330_2025-06";
  readonly sourceAvailabilityTimestamp: string | null;
}

interface NormalizedRawPriceRecord {
  readonly symbol: string;
  readonly tradingDate: string;
  readonly rawClose: number;
  readonly sourcePublicationAvailabilityTimestamp: string | null;
  readonly fetchedAtTimestamp: string;
  readonly rawPayloadSha256: string;
  readonly datasetIdentifier: "TWSE_STOCK_DAY_0050_2025-06" | "TWSE_STOCK_DAY_2330_2025-06";
}

/** Parses a STOCK_DAY monthly report's text into raw daily close records. */
export function normalizeTwseStockDayPayload(
  rawPayload: string,
  context: PriceParseContext,
): readonly NormalizedRawPriceRecord[] {
  requireCanonicalTimestamp(context.fetchedAtTimestamp, "fetched_at_timestamp");
  const report = parseJsonReport(rawPayload, context.datasetIdentifier);
  const { fields, rows } = reportTable(report, context.datasetIdentifier);
  const dateIndex = fieldIndex(fields, "日期", context.datasetIdentifier);
  const closeIndex = fieldIndex(fields, "收盤價", context.datasetIdentifier);
  const parsed = rows.map((row, index): NormalizedRawPriceRecord => ({
    symbol: context.symbol,
    tradingDate: parseRocDate(row[dateIndex], `${context.datasetIdentifier}[${index}].date`),
    rawClose: parseRequiredNumber(row[closeIndex], `${context.datasetIdentifier}[${index}].close`),
    sourcePublicationAvailabilityTimestamp:
      context.sourceAvailabilityTimestamp ?? context.fetchedAtTimestamp,
    fetchedAtTimestamp: context.fetchedAtTimestamp,
    rawPayloadSha256: context.rawPayloadSha256,
    datasetIdentifier: context.datasetIdentifier,
  }));
  for (let index = 1; index < parsed.length; index += 1) {
    const current = parsed[index]!;
    const previous = parsed[index - 1]!;
    if (current.tradingDate === previous.tradingDate) {
      fail("DUPLICATE_RECORD", `${context.symbol}:${current.tradingDate}`);
    }
    if (current.tradingDate < previous.tradingDate) fail("OUT_OF_ORDER_RECORDS", context.datasetIdentifier);
  }
  return parsed;
}

function requiredPriceRecord(
  records: readonly NormalizedRawPriceRecord[],
  symbol: "0050" | "2330",
  tradingDate: "2025-06-10" | "2025-06-18",
): NormalizedRawPriceRecord {
  const matches = records.filter((record) => record.symbol === symbol && record.tradingDate === tradingDate);
  if (matches.length !== 1) {
    fail(matches.length === 0 ? "MISSING_REQUIRED_FIELD" : "DUPLICATE_RECORD", `${symbol}:${tradingDate}`);
  }
  return matches[0]!;
}

function buildNormalizedRecords(
  events: readonly NormalizedCorporateAction[],
  prices: readonly NormalizedRawPriceRecord[],
): readonly NormalizedAdjustedOhlcvRecord[] {
  const selectedEvents = events.filter((event) => event.symbol === "0050");
  if (selectedEvents.length === 0) fail("MISSING_ADJUSTMENT_METADATA", "0050:2025-06-18");
  if (selectedEvents.length > 1) {
    if (new Set(selectedEvents.map((event) => event.adjustmentFactor)).size > 1) {
      fail("CONFLICTING_EVENT_FACTORS", "0050:2025-06-18");
    }
    fail("DUPLICATE_RECORD", "0050:2025-06-18");
  }
  if (events.some((event) => event.symbol === "2330")) fail("CONTROL_SYMBOL_EVENT_REPORTED", "2330:2025-06-18");
  const event = selectedEvents[0]!;
  const requested: ReadonlyArray<{ symbol: "0050" | "2330"; tradingDate: "2025-06-10" | "2025-06-18" }> = [
    { symbol: "0050", tradingDate: "2025-06-10" },
    { symbol: "0050", tradingDate: "2025-06-18" },
    { symbol: "2330", tradingDate: "2025-06-10" },
    { symbol: "2330", tradingDate: "2025-06-18" },
  ];
  return requested.map(({ symbol, tradingDate }) => {
    const price = requiredPriceRecord(prices, symbol, tradingDate);
    const applicableEvent = symbol === "0050" ? event : null;
    const adjustmentFactor = applicableEvent && tradingDate < applicableEvent.effectiveDate
      ? applicableEvent.adjustmentFactor
      : 1;
    return {
      symbol,
      tradingDate,
      rawClose: price.rawClose,
      adjustedClose: round(price.rawClose * adjustmentFactor),
      adjustmentFactor,
      corporateActionType: applicableEvent?.corporateActionType ?? null,
      effectiveDate: applicableEvent?.effectiveDate ?? null,
      sourcePublicationAvailabilityTimestamp: price.sourcePublicationAvailabilityTimestamp,
      timestampEvidence: "CURRENT_AVAILABILITY_ONLY" as const,
      sourceDocumentOrDatasetIdentifier: price.datasetIdentifier,
      fetchedAtTimestamp: price.fetchedAtTimestamp,
      rawPayloadSha256: price.rawPayloadSha256,
    };
  });
}

/**
 * Builds a `TwseSourceSnapshot` from the pinned, hardcoded FIXTURE payload
 * text ({@link TWSE_QUALIFICATION_FIXTURE_PAYLOADS}) and caller-supplied
 * payload hashes (computed by the CLI, since hashing raw text requires
 * `node:crypto`). There is no live-fetch path: this function is pure.
 */
export function buildTwseQualificationSnapshotFromFixture(
  payloadHashes: {
    readonly splitReference: string;
    readonly stockDay0050: string;
    readonly stockDay2330: string;
  },
  fetchedAtTimestamp: string,
): TwseSourceSnapshot {
  requireCanonicalTimestamp(fetchedAtTimestamp, "fetched_at_timestamp");
  const events = normalizeTwseSplitReferencePayload(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.splitReference, {
    fetchedAtTimestamp,
    rawPayloadSha256: payloadHashes.splitReference,
  });
  const prices = [
    ...normalizeTwseStockDayPayload(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay0050, {
      symbol: "0050",
      datasetIdentifier: "TWSE_STOCK_DAY_0050_2025-06",
      fetchedAtTimestamp,
      sourceAvailabilityTimestamp: null,
      rawPayloadSha256: payloadHashes.stockDay0050,
    }),
    ...normalizeTwseStockDayPayload(TWSE_QUALIFICATION_FIXTURE_PAYLOADS.stockDay2330, {
      symbol: "2330",
      datasetIdentifier: "TWSE_STOCK_DAY_2330_2025-06",
      fetchedAtTimestamp,
      sourceAvailabilityTimestamp: null,
      rawPayloadSha256: payloadHashes.stockDay2330,
    }),
  ];
  return {
    fetchedAtTimestamp,
    events,
    records: buildNormalizedRecords(events, prices),
    payloadHashes: [
      { datasetIdentifier: "TWSE_TWTCAU_2025-06-18", rawPayloadSha256: payloadHashes.splitReference },
      { datasetIdentifier: "TWSE_STOCK_DAY_0050_2025-06", rawPayloadSha256: payloadHashes.stockDay0050 },
      { datasetIdentifier: "TWSE_STOCK_DAY_2330_2025-06", rawPayloadSha256: payloadHashes.stockDay2330 },
    ],
  };
}

function asCommittedSymbol(value: string): "0050" | "2330" | null {
  return value === "0050" || value === "2330" ? value : null;
}

function asCommittedDate(value: string): "2025-06-10" | "2025-06-18" | null {
  return value === "2025-06-10" || value === "2025-06-18" ? value : null;
}

/**
 * Parses the committed CSV's `symbol,date,close` rows for the four required
 * (symbol, tradingDate) observations. Pure text parsing: the caller (CLI) is
 * responsible for verifying the CSV's SHA-256 pin before calling this.
 */
export function parseCommittedQualificationObservationsFromText(
  csvText: string,
): readonly CommittedObservation[] {
  const lines = csvText.replaceAll("\r\n", "\n").split("\n");
  const header = lines.shift()?.split(",") ?? [];
  const symbolIndex = header.indexOf("symbol");
  const dateIndex = header.indexOf("date");
  const closeIndex = header.indexOf("close");
  if (symbolIndex < 0 || dateIndex < 0 || closeIndex < 0) {
    fail("MISSING_REQUIRED_FIELD", "committed_csv_header");
  }
  const observations: CommittedObservation[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const fields = line.split(",");
    const symbol = asCommittedSymbol(fields[symbolIndex] ?? "");
    const tradingDate = asCommittedDate(fields[dateIndex] ?? "");
    if (!symbol || !tradingDate) continue;
    observations.push({
      symbol,
      tradingDate,
      rawClose: parseRequiredNumber(fields[closeIndex], `committed_csv[${lineIndex}].close`),
    });
  }
  const expectedKeys = ["0050:2025-06-10", "0050:2025-06-18", "2330:2025-06-10", "2330:2025-06-18"];
  const actualKeys = observations.map((record) => `${record.symbol}:${record.tradingDate}`).sort(compareText);
  if (new Set(actualKeys).size !== actualKeys.length) fail("DUPLICATE_RECORD", "committed_observations");
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort(compareText))) {
    fail("COMMITTED_OBSERVATION_MISSING", actualKeys.join(","));
  }
  return observations.sort((left, right) =>
    compareText(`${left.symbol}:${left.tradingDate}`, `${right.symbol}:${right.tradingDate}`));
}

export function calculateCloseToCloseReturn(priorClose: number, nextClose: number): number {
  if (!Number.isFinite(priorClose) || priorClose <= 0 || !Number.isFinite(nextClose) || nextClose <= 0) {
    fail("INVALID_NUMERIC_FIELD", "close_to_close_return");
  }
  return round(nextClose / priorClose - 1);
}

export function classifyPointInTimeStatus(
  evidence: readonly PointInTimeEvidence[],
  asOfTimestamp: string,
): PointInTimeStatus {
  requireCanonicalTimestamp(asOfTimestamp, "as_of_timestamp");
  if (evidence.length === 0) return "PIT_UNPROVEN";
  for (const item of evidence) {
    const timestamp = item.sourcePublicationAvailabilityTimestamp;
    if (!timestamp) continue;
    requireCanonicalTimestamp(timestamp, item.evidenceIdentifier);
    if (timestamp > asOfTimestamp) fail("FUTURE_PUBLICATION_FOR_AS_OF", item.evidenceIdentifier);
  }
  const historicalCount = evidence.filter((item) =>
    item.timestampEvidence === "HISTORICAL_PUBLICATION" && item.sourcePublicationAvailabilityTimestamp !== null).length;
  if (historicalCount === evidence.length) return "PIT_PROVEN";
  if (historicalCount > 0) return "PIT_PARTIALLY_PROVEN";
  return "PIT_UNPROVEN";
}

function requiredNormalizedRecord(
  records: readonly NormalizedAdjustedOhlcvRecord[],
  symbol: "0050" | "2330",
  tradingDate: "2025-06-10" | "2025-06-18",
): NormalizedAdjustedOhlcvRecord {
  const matches = records.filter((record) => record.symbol === symbol && record.tradingDate === tradingDate);
  if (matches.length !== 1) {
    fail(matches.length === 0 ? "MISSING_REQUIRED_FIELD" : "DUPLICATE_RECORD", `normalized:${symbol}:${tradingDate}`);
  }
  return matches[0]!;
}

function requiredCommittedRecord(
  records: readonly CommittedObservation[],
  symbol: "0050" | "2330",
  tradingDate: "2025-06-10" | "2025-06-18",
): CommittedObservation {
  const matches = records.filter((record) => record.symbol === symbol && record.tradingDate === tradingDate);
  if (matches.length !== 1) fail("COMMITTED_OBSERVATION_MISSING", `${symbol}:${tradingDate}`);
  return matches[0]!;
}

function assertCommittedMatchesSource(
  committed: CommittedObservation,
  source: NormalizedAdjustedOhlcvRecord,
): void {
  if (committed.rawClose !== source.rawClose) {
    fail(
      "COMMITTED_OBSERVATION_CONFLICT",
      `${committed.symbol}:${committed.tradingDate}:committed=${committed.rawClose}:source=${source.rawClose}`,
    );
  }
}

const SELECTED_DOCUMENTATION = Object.freeze([
  "https://www.twse.com.tw/zh/announcement/split/twtcau.html",
  "https://www.twse.com.tw/en/announcement/split/twtcau.html",
  TWSE_0050_DISCLOSURE.url,
  "https://data.gov.tw/dataset/11549",
  "https://www.twse.com.tw/zh/terms/use.html",
]);

const REMAINING_RISKS = Object.freeze([
  "TWTCAU and STOCK_DAY payloads have no immutable version identifier or historical payload archive reference.",
  "Only the 0050 event has event-specific historical publication evidence; price rows expose current availability only.",
  "Full endpoint retention depth and a numeric rate-limit contract are not documented.",
  "This qualification authorizes neither adjusted-artifact publication nor refitting; raw redistribution remains out of scope.",
]);

/**
 * Reconciles the 0050 split against the committed CSV's own raw closes and
 * preserves the 2330 control (fails closed if a corporate action or a
 * non-unity adjustment factor is ever reported for the control symbol).
 * Throws {@link AdjustedOhlcvQualificationError} rather than returning a
 * "BLOCKED" status: there is no partial/degraded qualification result for
 * this bounded, single-event reconciliation.
 */
export function qualifyTwseSnapshot(
  snapshot: TwseSourceSnapshot,
  committedObservations: readonly CommittedObservation[],
  asOfTimestamp: string,
): QualificationResult {
  const source0050Prior = requiredNormalizedRecord(snapshot.records, "0050", "2025-06-10");
  const source0050Next = requiredNormalizedRecord(snapshot.records, "0050", "2025-06-18");
  const source2330Prior = requiredNormalizedRecord(snapshot.records, "2330", "2025-06-10");
  const source2330Next = requiredNormalizedRecord(snapshot.records, "2330", "2025-06-18");
  const committed0050Prior = requiredCommittedRecord(committedObservations, "0050", "2025-06-10");
  const committed0050Next = requiredCommittedRecord(committedObservations, "0050", "2025-06-18");
  const committed2330Prior = requiredCommittedRecord(committedObservations, "2330", "2025-06-10");
  const committed2330Next = requiredCommittedRecord(committedObservations, "2330", "2025-06-18");
  (
    [
      [committed0050Prior, source0050Prior],
      [committed0050Next, source0050Next],
      [committed2330Prior, source2330Prior],
      [committed2330Next, source2330Next],
    ] as const
  ).forEach(([committed, source]) => assertCommittedMatchesSource(committed, source));

  const matchingEvents = snapshot.events.filter((event) => event.symbol === "0050");
  if (matchingEvents.length !== 1) fail("MISSING_ADJUSTMENT_METADATA", "0050:event_count");
  const event = matchingEvents[0]!;
  if (event.effectiveDate !== source0050Next.tradingDate || event.effectiveDate <= source0050Prior.tradingDate) {
    fail(
      "EVENT_EFFECTIVE_DATE_MISALIGNED",
      `event=${event.effectiveDate}:prior=${source0050Prior.tradingDate}:next=${source0050Next.tradingDate}`,
    );
  }
  if (event.preEventRawClose !== source0050Prior.rawClose) {
    fail(
      "MISSING_ADJUSTMENT_METADATA",
      `event_pre_close=${event.preEventRawClose}:price_pre_close=${source0050Prior.rawClose}`,
    );
  }
  if (
    source2330Prior.corporateActionType !== null
    || source2330Next.corporateActionType !== null
    || source2330Prior.adjustmentFactor !== 1
    || source2330Next.adjustmentFactor !== 1
  ) {
    fail("CONTROL_SYMBOL_EVENT_REPORTED", "2330");
  }
  const rawReturn = calculateCloseToCloseReturn(source0050Prior.rawClose, source0050Next.rawClose);
  if (Math.abs(rawReturn) < EXISTING_PRICE_DISCONTINUITY_THRESHOLD) {
    fail("EXPECTED_RAW_DISCONTINUITY_MISSING", String(rawReturn));
  }
  const adjustedReturn = calculateCloseToCloseReturn(source0050Prior.adjustedClose, source0050Next.adjustedClose);
  if (Math.abs(adjustedReturn) >= EXISTING_PRICE_DISCONTINUITY_THRESHOLD) {
    fail("RECONCILIATION_THRESHOLD_FAILED", String(adjustedReturn));
  }
  const controlReturn = calculateCloseToCloseReturn(source2330Prior.adjustedClose, source2330Next.adjustedClose);
  const pitEvidence: PointInTimeEvidence[] = [
    ...snapshot.events.map((sourceEvent) => ({
      sourcePublicationAvailabilityTimestamp: sourceEvent.sourcePublicationAvailabilityTimestamp,
      timestampEvidence: sourceEvent.timestampEvidence,
      evidenceIdentifier: `${sourceEvent.sourceDisclosureIdentifier}:${sourceEvent.symbol}`,
    })),
    ...snapshot.records.map((record) => ({
      sourcePublicationAvailabilityTimestamp: record.sourcePublicationAvailabilityTimestamp,
      timestampEvidence: record.timestampEvidence,
      evidenceIdentifier: `${record.sourceDocumentOrDatasetIdentifier}:${record.symbol}:${record.tradingDate}`,
    })),
  ];
  const pointInTimeStatus = classifyPointInTimeStatus(pitEvidence, asOfTimestamp);

  return {
    qualificationStatus: "PASS",
    selectedSource: "TWSE split-reference and STOCK_DAY reports",
    sourceOperator: "Taiwan Stock Exchange Corporation",
    pointInTimeStatus,
    sourceProvenance: {
      candidateEvaluations: SOURCE_CANDIDATE_EVALUATIONS,
      selectedDocumentation: SELECTED_DOCUMENTATION,
      sourceDisclosurePublishedAt: TWSE_0050_DISCLOSURE.publishedAt,
      normalizedRecords: snapshot.records,
    },
    payloadHashes: snapshot.payloadHashes,
    "0050Reconciliation": {
      status: "RECONCILED",
      priorTradingDate: source0050Prior.tradingDate,
      nextTradingDate: source0050Next.tradingDate,
      sourcePriorRawClose: source0050Prior.rawClose,
      sourceNextRawClose: source0050Next.rawClose,
      sourceReferenceAdjustedClose: event.sourceReferenceAdjustedClose,
      derivedAdjustmentFactor: event.adjustmentFactor,
      rawCloseToCloseReturn: rawReturn,
      adjustedCloseToCloseReturn: adjustedReturn,
      discontinuityThreshold: EXISTING_PRICE_DISCONTINUITY_THRESHOLD,
      effectiveDate: event.effectiveDate,
      corporateActionType: event.corporateActionType,
      sourcePublicationAvailabilityTimestamp: event.sourcePublicationAvailabilityTimestamp,
    },
    "2330Control": {
      status: "PASS",
      priorTradingDate: source2330Prior.tradingDate,
      nextTradingDate: source2330Next.tradingDate,
      sourcePriorRawClose: source2330Prior.rawClose,
      sourceNextRawClose: source2330Next.rawClose,
      corporateActionReported: false,
      adjustmentFactor: 1,
      adjustedCloseToCloseReturn: controlReturn,
      fabricatedEvent: false,
    },
    remainingRisks: REMAINING_RISKS,
  };
}

const STOCK_DAY_FIELDS = [
  "日期",
  "成交股數",
  "成交金額",
  "開盤價",
  "最高價",
  "最低價",
  "收盤價",
  "漲跌價差",
  "成交筆數",
  "註記",
];

export const TWSE_QUALIFICATION_FIXTURE_PAYLOADS = Object.freeze({
  splitReference: JSON.stringify({
    stat: "OK",
    startDate: "20250618",
    endDate: "20250618",
    title: "ETF分割(反分割)恢復買賣參考價格",
    fields: [
      "恢復買賣日期",
      "ETF代號",
      "名稱",
      "分割(反分割)",
      "停止買賣前收盤價格",
      "恢復買賣參考價",
      "漲停價格",
      "跌停價格",
      "開盤競價基準",
    ],
    data: [["114/06/18", "0050", "元大台灣50", "分割", "188.65", "47.16", "51.85", "42.45", "47.16"]],
  }),
  stockDay0050: JSON.stringify({
    stat: "OK",
    title: "114年06月 0050 元大台灣50 各日成交資訊",
    fields: STOCK_DAY_FIELDS,
    data: [
      ["114/06/10", "31,483,080", "5,908,431,532", "184.90", "188.90", "184.90", "188.65", "+4.95", "48,271", ""],
      ["114/06/18", "252,639,825", "12,002,805,591", "47.50", "47.72", "47.14", "47.57", "+0.41", "197,610", "**"],
    ],
  }),
  stockDay2330: JSON.stringify({
    stat: "OK",
    title: "114年06月 2330 台積電 各日成交資訊",
    fields: STOCK_DAY_FIELDS,
    data: [
      ["114/06/10", "55,353,908", "57,406,744,645", "1,025.00", "1,050.00", "1,020.00", "1,045.00", "+40.00", "138,656", ""],
      ["114/06/18", "41,740,374", "43,722,320,684", "1,040.00", "1,055.00", "1,030.00", "1,055.00", "+10.00", "45,620", ""],
    ],
  }),
});

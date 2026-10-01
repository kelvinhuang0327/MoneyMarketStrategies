import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PaperTradingEngine } from "./engine.js";
import type {
  AccountSnapshot,
  CancelRequest,
  Clock,
  ExecutionReport,
  HaltRequest,
  MarketEvent,
  OperationResult,
  PaperOrder,
  PaperTradingEngineConfig,
  SimulationEvent,
} from "./types.js";

const JOURNAL_SCHEMA_VERSION = 1;
const HEADER_FILE = "header.json";
const EVENTS_DIRECTORY = "events";

type JournalCommand =
  | { readonly kind: "market"; readonly payload: MarketEvent }
  | { readonly kind: "cancel"; readonly payload: CancelRequest }
  | { readonly kind: "halt"; readonly payload: HaltRequest }
  | { readonly kind: "execution-report"; readonly payload: ExecutionReport };

interface JournalHeader {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly recordType: "paper-trading-journal";
  readonly journalId: string;
  readonly symbol: string;
  readonly initialCashMinor: string;
  readonly risk: {
    readonly maxPositionQuantity: number;
    readonly maxExposureMinor: string;
    readonly maxMarketAgeMs: number;
  };
  readonly terms: {
    readonly label: "SYNTHETIC_ONLY";
    readonly feeBps: number;
    readonly slippageBps: number;
  };
  readonly strategyVersion: string;
  readonly strategyParameters: Readonly<Record<string, string | number | boolean>> | null;
}

type JournalEntry = {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly recordType: "event";
  readonly sequence: number;
  /** The source event ID, or the fill ID for an execution report. */
  readonly eventId: string;
  readonly timestamp: number;
  /** The exact clock sample used by the engine; null means an invalid clock. */
  readonly clockTimestamp: number | null;
  readonly outcome: OperationResult;
  readonly events: readonly SimulationEvent[];
  readonly strategyVersion: string;
} & JournalCommand;

interface FillIdentity {
  readonly canonical: string;
  readonly outcome: OperationResult;
}

interface OrderIdentity {
  readonly side: "buy" | "sell";
  readonly quantity: number;
}

export class PaperJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaperJournalError";
  }
}

export class PaperJournalCorruptError extends PaperJournalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaperJournalCorruptError";
  }
}

export class PaperJournalConflictError extends PaperJournalError {
  constructor(message: string) {
    super(message);
    this.name = "PaperJournalConflictError";
  }
}

export class PaperJournalReplayError extends PaperJournalError {
  constructor(message: string) {
    super(message);
    this.name = "PaperJournalReplayError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failCorrupt(message: string, cause?: unknown): never {
  throw new PaperJournalCorruptError(message, cause instanceof Error ? { cause } : undefined);
}

function exactKeys(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) failCorrupt(`${path} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failCorrupt(`${path} contains unknown field ${key}`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") failCorrupt(`${path} must be a non-empty string`);
  return value;
}

function safeInteger(value: unknown, path: string, minimum = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    failCorrupt(`${path} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function decimalBigint(value: unknown, path: string, allowNegative: boolean): bigint {
  const pattern = allowNegative ? /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/;
  if (typeof value !== "string" || !pattern.test(value)) failCorrupt(`${path} must be an exact minor-unit decimal string`);
  return BigInt(value);
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function serializedJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => (
    typeof nested === "bigint" ? nested.toString() : nested
  ));
}

function normalizeStrategyParameters(
  value: PaperTradingEngineConfig["strategy"]["strategyParameters"],
): Readonly<Record<string, string | number | boolean>> | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("strategyParameters must be a JSON-compatible record");
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item === "string" || typeof item === "boolean") result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else throw new TypeError(`strategyParameters.${key} must be a finite JSON scalar`);
  }
  return Object.freeze(result);
}

function makeHeader(config: PaperTradingEngineConfig, journalId: string = randomUUID()): JournalHeader {
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    recordType: "paper-trading-journal",
    journalId,
    symbol: config.symbol,
    initialCashMinor: config.initialCashMinor.toString(),
    risk: Object.freeze({
      maxPositionQuantity: config.risk.maxPositionQuantity,
      maxExposureMinor: config.risk.maxExposureMinor.toString(),
      maxMarketAgeMs: config.risk.maxMarketAgeMs,
    }),
    terms: Object.freeze({ ...config.terms }),
    strategyVersion: config.strategy.strategyVersion,
    strategyParameters: normalizeStrategyParameters(config.strategy.strategyParameters),
  });
}

function headerConfiguration(header: JournalHeader): unknown {
  return {
    schemaVersion: header.schemaVersion,
    recordType: header.recordType,
    symbol: header.symbol,
    initialCashMinor: header.initialCashMinor,
    risk: header.risk,
    terms: header.terms,
    strategyVersion: header.strategyVersion,
    strategyParameters: header.strategyParameters,
  };
}

function decodeParameters(value: unknown): JournalHeader["strategyParameters"] {
  if (value === null) return null;
  if (!isRecord(value)) failCorrupt("journal header strategyParameters must be an object or null");
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "boolean") parameters[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) parameters[key] = item;
    else failCorrupt(`journal header strategyParameters.${key} is invalid`);
  }
  return Object.freeze(parameters);
}

function decodeHeader(value: unknown): JournalHeader {
  if (!isRecord(value)) failCorrupt("journal header must be an object");
  if (value["schemaVersion"] !== JOURNAL_SCHEMA_VERSION) {
    failCorrupt(`unknown paper journal schema version: ${String(value["schemaVersion"])}`);
  }
  exactKeys(value, "journal header", [
    "schemaVersion",
    "recordType",
    "journalId",
    "symbol",
    "initialCashMinor",
    "risk",
    "terms",
    "strategyVersion",
    "strategyParameters",
  ]);
  if (value["recordType"] !== "paper-trading-journal") failCorrupt("journal header recordType is unsupported");
  const journalId = nonEmptyString(value["journalId"], "journal header journalId");
  const symbol = nonEmptyString(value["symbol"], "journal header symbol");
  const initialCashMinor = value["initialCashMinor"];
  decimalBigint(initialCashMinor, "journal header initialCashMinor", false);

  const risk = value["risk"];
  if (!isRecord(risk)) failCorrupt("journal header risk must be an object");
  exactKeys(risk, "journal header risk", ["maxPositionQuantity", "maxExposureMinor", "maxMarketAgeMs"]);
  safeInteger(risk["maxPositionQuantity"], "journal header risk.maxPositionQuantity", 0);
  decimalBigint(risk["maxExposureMinor"], "journal header risk.maxExposureMinor", false);
  safeInteger(risk["maxMarketAgeMs"], "journal header risk.maxMarketAgeMs", 0);

  const terms = value["terms"];
  if (!isRecord(terms)) failCorrupt("journal header terms must be an object");
  exactKeys(terms, "journal header terms", ["label", "feeBps", "slippageBps"]);
  if (terms["label"] !== "SYNTHETIC_ONLY") failCorrupt("journal header terms label is unsupported");
  safeInteger(terms["feeBps"], "journal header terms.feeBps", 0);
  safeInteger(terms["slippageBps"], "journal header terms.slippageBps", 0);

  const strategyVersion = nonEmptyString(value["strategyVersion"], "journal header strategyVersion");
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    recordType: "paper-trading-journal",
    journalId,
    symbol,
    initialCashMinor: initialCashMinor as string,
    risk: Object.freeze({
      maxPositionQuantity: risk["maxPositionQuantity"] as number,
      maxExposureMinor: risk["maxExposureMinor"] as string,
      maxMarketAgeMs: risk["maxMarketAgeMs"] as number,
    }),
    terms: Object.freeze({
      label: "SYNTHETIC_ONLY",
      feeBps: terms["feeBps"] as number,
      slippageBps: terms["slippageBps"] as number,
    }),
    strategyVersion,
    strategyParameters: decodeParameters(value["strategyParameters"]),
  });
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    failCorrupt(`${path} is not valid UTF-8`, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    failCorrupt(`${path} contains corrupt or truncated JSON`, error);
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error["code"] === "EEXIST";
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicCreateFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.paper-journal-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    await syncDirectory(directory);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function readHeaderOrCreate(root: string, config: PaperTradingEngineConfig): Promise<JournalHeader> {
  const headerPath = join(root, HEADER_FILE);
  const eventsPath = join(root, EVENTS_DIRECTORY);
  let rawHeader: unknown;
  try {
    rawHeader = parseJson(await readFile(headerPath), headerPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const rootEntries = await readdir(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name !== EVENTS_DIRECTORY && !/^\.paper-journal-[a-z0-9-]+\.tmp$/i.test(entry.name)) {
        failCorrupt(`journal is missing its header but contains ${entry.name}`);
      }
      if (entry.name === EVENTS_DIRECTORY) {
        if (!entry.isDirectory()) failCorrupt("journal events path must be a directory");
        const eventEntries = await readdir(eventsPath);
        if (eventEntries.length > 0) failCorrupt("journal has events but no header");
      }
    }
    await mkdir(eventsPath, { recursive: true, mode: 0o700 });
    const candidate = makeHeader(config);
    try {
      await atomicCreateFile(headerPath, serializedJson(candidate));
      return candidate;
    } catch (createError) {
      if (!isAlreadyExists(createError)) {
        throw new PaperJournalError("could not atomically create the paper journal header", { cause: createError });
      }
      try {
        rawHeader = parseJson(await readFile(headerPath), headerPath);
      } catch {
        throw new PaperJournalError("could not atomically create the paper journal header", { cause: createError });
      }
    }
  }

  const header = decodeHeader(rawHeader);
  const expected = makeHeader(config, header.journalId);
  if (canonicalJson(headerConfiguration(header)) !== canonicalJson(headerConfiguration(expected))) {
    throw new PaperJournalConflictError("journal configuration does not match the supplied paper session");
  }
  const rootEntries = await readdir(root, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === HEADER_FILE) {
      if (!entry.isFile()) failCorrupt("journal header path must be a regular file");
    } else if (entry.name === EVENTS_DIRECTORY) {
      if (!entry.isDirectory()) failCorrupt("journal events path must be a directory");
    } else if (!/^\.paper-journal-[a-z0-9-]+\.tmp$/i.test(entry.name)) {
      failCorrupt(`journal contains unknown path ${entry.name}`);
    }
  }
  await mkdir(eventsPath, { recursive: true, mode: 0o700 });
  return header;
}

function commandEventId(command: JournalCommand): string {
  return command.kind === "execution-report" ? command.payload.fillId : command.payload.eventId;
}

function commandTimestamp(command: JournalCommand): number {
  return command.payload.timestamp;
}

function executionReportCanonical(report: ExecutionReport): string {
  return canonicalJson({
    fillId: report.fillId,
    clientOrderId: report.clientOrderId,
    marketEventId: report.marketEventId,
    timestamp: report.timestamp,
    quantity: report.quantity,
    executionPriceMinor: report.executionPriceMinor,
    feeMinor: report.feeMinor,
  });
}

function encodeCommand(command: JournalCommand): Record<string, unknown> {
  if (command.kind === "market") {
    return {
      eventId: command.payload.eventId,
      timestamp: command.payload.timestamp,
      symbol: command.payload.symbol,
      priceMinor: command.payload.priceMinor.toString(),
    };
  }
  if (command.kind === "cancel") {
    return {
      eventId: command.payload.eventId,
      timestamp: command.payload.timestamp,
      clientOrderId: command.payload.clientOrderId,
    };
  }
  if (command.kind === "halt") {
    return { eventId: command.payload.eventId, timestamp: command.payload.timestamp, reason: command.payload.reason };
  }
  return {
    fillId: command.payload.fillId,
    clientOrderId: command.payload.clientOrderId,
    marketEventId: command.payload.marketEventId,
    timestamp: command.payload.timestamp,
    quantity: command.payload.quantity,
    executionPriceMinor: command.payload.executionPriceMinor.toString(),
    feeMinor: command.payload.feeMinor.toString(),
  };
}

function decodeCommand(kind: JournalCommand["kind"], value: unknown): JournalCommand {
  if (!isRecord(value)) failCorrupt("journal event payload must be an object");
  if (kind === "market") {
    exactKeys(value, "market journal payload", ["eventId", "timestamp", "symbol", "priceMinor"]);
    return Object.freeze({
      kind,
      payload: Object.freeze({
        eventId: nonEmptyString(value["eventId"], "market journal payload eventId"),
        timestamp: safeInteger(value["timestamp"], "market journal payload timestamp"),
        symbol: nonEmptyString(value["symbol"], "market journal payload symbol"),
        priceMinor: decimalBigint(value["priceMinor"], "market journal payload priceMinor", true),
      }),
    });
  }
  if (kind === "cancel") {
    exactKeys(value, "cancel journal payload", ["eventId", "timestamp", "clientOrderId"]);
    return Object.freeze({
      kind,
      payload: Object.freeze({
        eventId: nonEmptyString(value["eventId"], "cancel journal payload eventId"),
        timestamp: safeInteger(value["timestamp"], "cancel journal payload timestamp"),
        clientOrderId: nonEmptyString(value["clientOrderId"], "cancel journal payload clientOrderId"),
      }),
    });
  }
  if (kind === "halt") {
    exactKeys(value, "halt journal payload", ["eventId", "timestamp", "reason"]);
    return Object.freeze({
      kind,
      payload: Object.freeze({
        eventId: nonEmptyString(value["eventId"], "halt journal payload eventId"),
        timestamp: safeInteger(value["timestamp"], "halt journal payload timestamp"),
        reason: nonEmptyString(value["reason"], "halt journal payload reason"),
      }),
    });
  }
  exactKeys(value, "execution-report journal payload", [
    "fillId",
    "clientOrderId",
    "marketEventId",
    "timestamp",
    "quantity",
    "executionPriceMinor",
    "feeMinor",
  ]);
  return Object.freeze({
    kind,
    payload: Object.freeze({
      fillId: nonEmptyString(value["fillId"], "execution-report journal payload fillId"),
      clientOrderId: nonEmptyString(value["clientOrderId"], "execution-report journal payload clientOrderId"),
      marketEventId: nonEmptyString(value["marketEventId"], "execution-report journal payload marketEventId"),
      timestamp: safeInteger(value["timestamp"], "execution-report journal payload timestamp"),
      quantity: safeInteger(value["quantity"], "execution-report journal payload quantity", 0),
      executionPriceMinor: decimalBigint(value["executionPriceMinor"], "execution-report journal payload executionPriceMinor", true),
      feeMinor: decimalBigint(value["feeMinor"], "execution-report journal payload feeMinor", true),
    }),
  });
}

function decodeOutcome(value: unknown): OperationResult {
  if (!isRecord(value)) failCorrupt("journal outcome must be an object");
  const status = value["status"];
  if (status === "accepted" || status === "duplicate") {
    exactKeys(value, "journal outcome", ["status"]);
    return Object.freeze({ status });
  }
  if (status === "stale" || status === "rejected") {
    exactKeys(value, "journal outcome", ["status", "reasonCode"]);
    return Object.freeze({ status, reasonCode: nonEmptyString(value["reasonCode"], "journal outcome reasonCode") });
  }
  return failCorrupt("journal outcome status is unsupported");
}

function optionalReason(value: Record<string, unknown>, path: string): string | undefined {
  return Object.hasOwn(value, "reasonCode")
    ? nonEmptyString(value["reasonCode"], `${path}.reasonCode`)
    : undefined;
}

function decodeSimulationEvent(value: unknown, index: number): SimulationEvent {
  const path = `journal event emitted event ${index}`;
  if (!isRecord(value)) failCorrupt(`${path} must be an object`);
  const kind = value["kind"];
  const eventId = nonEmptyString(value["eventId"], `${path}.eventId`);
  const timestamp = safeInteger(value["timestamp"], `${path}.timestamp`);
  if (kind === "market") {
    const hasReason = Object.hasOwn(value, "reasonCode");
    exactKeys(value, path, ["eventId", "timestamp", "kind", "sourceEventId", "symbol", "priceMinor", "status", ...(hasReason ? ["reasonCode"] : [])]);
    const status = value["status"];
    if (status !== "fresh" && status !== "stale") failCorrupt(`${path}.status is invalid`);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      sourceEventId: nonEmptyString(value["sourceEventId"], `${path}.sourceEventId`),
      symbol: nonEmptyString(value["symbol"], `${path}.symbol`),
      priceMinor: decimalBigint(value["priceMinor"], `${path}.priceMinor`, false),
      status,
      ...(hasReason ? { reasonCode: optionalReason(value, path)! } : {}),
    });
  }
  if (kind === "decision") {
    exactKeys(value, path, [
      "eventId", "timestamp", "kind", "sourceEventId", "strategyVersion", "currentPositionQuantity",
      "targetPositionQuantity", "status", "reasonCode",
    ]);
    const status = value["status"];
    if (status !== "no-trade" && status !== "order-submitted" && status !== "risk-rejected") {
      failCorrupt(`${path}.status is invalid`);
    }
    const target = value["targetPositionQuantity"];
    if (target !== null) safeInteger(target, `${path}.targetPositionQuantity`, 0);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      sourceEventId: nonEmptyString(value["sourceEventId"], `${path}.sourceEventId`),
      strategyVersion: nonEmptyString(value["strategyVersion"], `${path}.strategyVersion`),
      currentPositionQuantity: safeInteger(value["currentPositionQuantity"], `${path}.currentPositionQuantity`, 0),
      targetPositionQuantity: target as number | null,
      status,
      reasonCode: nonEmptyString(value["reasonCode"], `${path}.reasonCode`),
    });
  }
  if (kind === "order") {
    const hasReason = Object.hasOwn(value, "reasonCode");
    exactKeys(value, path, [
      "eventId", "timestamp", "kind", "sourceEventId", "clientOrderId", "status", "side", "quantity",
      "filledQuantity", "remainingQuantity", ...(hasReason ? ["reasonCode"] : []),
    ]);
    const status = value["status"];
    const side = value["side"];
    if (status !== "pending" && status !== "partially-filled" && status !== "filled" && status !== "rejected" && status !== "cancelled") {
      failCorrupt(`${path}.status is invalid`);
    }
    if (side !== "buy" && side !== "sell") failCorrupt(`${path}.side is invalid`);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      sourceEventId: nonEmptyString(value["sourceEventId"], `${path}.sourceEventId`),
      clientOrderId: nonEmptyString(value["clientOrderId"], `${path}.clientOrderId`),
      status,
      side,
      quantity: safeInteger(value["quantity"], `${path}.quantity`, 0),
      filledQuantity: safeInteger(value["filledQuantity"], `${path}.filledQuantity`, 0),
      remainingQuantity: safeInteger(value["remainingQuantity"], `${path}.remainingQuantity`, 0),
      ...(hasReason ? { reasonCode: optionalReason(value, path)! } : {}),
    });
  }
  if (kind === "fill") {
    exactKeys(value, path, [
      "eventId", "timestamp", "kind", "fillId", "clientOrderId", "sourceMarketEventId", "side", "quantity",
      "executionPriceMinor", "feeMinor",
    ]);
    const side = value["side"];
    if (side !== "buy" && side !== "sell") failCorrupt(`${path}.side is invalid`);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      fillId: nonEmptyString(value["fillId"], `${path}.fillId`),
      clientOrderId: nonEmptyString(value["clientOrderId"], `${path}.clientOrderId`),
      sourceMarketEventId: nonEmptyString(value["sourceMarketEventId"], `${path}.sourceMarketEventId`),
      side,
      quantity: safeInteger(value["quantity"], `${path}.quantity`, 0),
      executionPriceMinor: decimalBigint(value["executionPriceMinor"], `${path}.executionPriceMinor`, false),
      feeMinor: decimalBigint(value["feeMinor"], `${path}.feeMinor`, false),
    });
  }
  if (kind === "halt") {
    exactKeys(value, path, ["eventId", "timestamp", "kind", "sourceEventId", "reason"]);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      sourceEventId: nonEmptyString(value["sourceEventId"], `${path}.sourceEventId`),
      reason: nonEmptyString(value["reason"], `${path}.reason`),
    });
  }
  if (kind === "cancel") {
    exactKeys(value, path, ["eventId", "timestamp", "kind", "sourceEventId", "clientOrderId", "status", "reasonCode"]);
    const status = value["status"];
    if (status !== "cancelled" && status !== "rejected") failCorrupt(`${path}.status is invalid`);
    return Object.freeze({
      eventId,
      timestamp,
      kind,
      sourceEventId: nonEmptyString(value["sourceEventId"], `${path}.sourceEventId`),
      clientOrderId: nonEmptyString(value["clientOrderId"], `${path}.clientOrderId`),
      status,
      reasonCode: nonEmptyString(value["reasonCode"], `${path}.reasonCode`),
    });
  }
  return failCorrupt(`${path} has unknown kind ${String(kind)}`);
}

function decodeEntry(value: unknown, path: string): JournalEntry {
  if (!isRecord(value)) failCorrupt(`${path} must contain an object`);
  if (value["schemaVersion"] !== JOURNAL_SCHEMA_VERSION) {
    failCorrupt(`${path} has unknown paper journal schema version ${String(value["schemaVersion"])}`);
  }
  exactKeys(value, path, [
    "schemaVersion", "recordType", "sequence", "eventId", "timestamp", "kind", "payload", "clockTimestamp",
    "outcome", "events", "strategyVersion",
  ]);
  if (value["recordType"] !== "event") failCorrupt(`${path} recordType is unsupported`);
  const sequence = safeInteger(value["sequence"], `${path}.sequence`, 1);
  const kind = value["kind"];
  if (kind !== "market" && kind !== "cancel" && kind !== "halt" && kind !== "execution-report") {
    failCorrupt(`${path}.kind is unsupported`);
  }
  const payload = decodeCommand(kind, value["payload"]);
  const eventId = nonEmptyString(value["eventId"], `${path}.eventId`);
  const timestamp = safeInteger(value["timestamp"], `${path}.timestamp`);
  if (eventId !== commandEventId(payload) || timestamp !== commandTimestamp(payload)) {
    failCorrupt(`${path} identity or timestamp does not match its payload`);
  }
  const clockTimestamp = value["clockTimestamp"] === null
    ? null
    : safeInteger(value["clockTimestamp"], `${path}.clockTimestamp`);
  const rawEvents = value["events"];
  if (!Array.isArray(rawEvents)) failCorrupt(`${path}.events must be an array`);
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    recordType: "event",
    sequence,
    eventId,
    timestamp,
    ...payload,
    clockTimestamp,
    outcome: decodeOutcome(value["outcome"]),
    events: Object.freeze(rawEvents.map((event, index) => decodeSimulationEvent(event, index))),
    strategyVersion: nonEmptyString(value["strategyVersion"], `${path}.strategyVersion`),
  });
}

function entrySemantic(entry: JournalEntry): string {
  return canonicalJson({
    eventId: entry.eventId,
    timestamp: entry.timestamp,
    kind: entry.kind,
    payload: entry.payload,
    clockTimestamp: entry.clockTimestamp,
    outcome: entry.outcome,
    events: entry.events,
    strategyVersion: entry.strategyVersion,
  });
}

function fileNameForSequence(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

function validateOrderIdentities(
  events: readonly SimulationEvent[],
  strategyVersion: string,
  previous: ReadonlyMap<string, OrderIdentity>,
): Map<string, OrderIdentity> {
  const result = new Map(previous);
  for (const event of events) {
    if (event.kind !== "order") continue;
    const prior = result.get(event.clientOrderId);
    if (prior !== undefined) {
      if (prior.side !== event.side || prior.quantity !== event.quantity) {
        throw new PaperJournalConflictError(`clientOrderId ${event.clientOrderId} was reused with conflicting order details`);
      }
      continue;
    }
    const expectedId = `co:${encodeURIComponent(strategyVersion)}:${encodeURIComponent(event.sourceEventId)}`;
    if (event.clientOrderId !== expectedId) {
      throw new PaperJournalConflictError(`clientOrderId ${event.clientOrderId} conflicts with its creation event identity`);
    }
    result.set(event.clientOrderId, {
      side: event.side,
      quantity: event.quantity,
    });
  }
  return result;
}

function fillEventCanonical(event: Extract<SimulationEvent, { kind: "fill" }>): string {
  return canonicalJson({
    fillId: event.fillId,
    clientOrderId: event.clientOrderId,
    marketEventId: event.sourceMarketEventId,
    timestamp: event.timestamp,
    quantity: event.quantity,
    executionPriceMinor: event.executionPriceMinor,
    feeMinor: event.feeMinor,
  });
}

function encodeSequence(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("paper journal sequence is invalid");
  return fileNameForSequence(value);
}

async function appendEntry(eventsDirectory: string, entry: JournalEntry): Promise<void> {
  const sequenceName = encodeSequence(entry.sequence);
  const destination = join(eventsDirectory, sequenceName);
  const temporaryPath = join(eventsDirectory, `.paper-journal-${entry.sequence}-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serializedJson({
      schemaVersion: entry.schemaVersion,
      recordType: entry.recordType,
      sequence: entry.sequence,
      eventId: entry.eventId,
      timestamp: entry.timestamp,
      kind: entry.kind,
      payload: encodeCommand({ kind: entry.kind, payload: entry.payload } as JournalCommand),
      clockTimestamp: entry.clockTimestamp,
      outcome: entry.outcome,
      events: entry.events,
      strategyVersion: entry.strategyVersion,
    }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A committed event is linked into the sequence only after its complete bytes are synced.
    await link(temporaryPath, destination);
    await syncDirectory(eventsDirectory);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function loadEntries(eventsDirectory: string): Promise<JournalEntry[]> {
  const directoryEntries = await readdir(eventsDirectory, { withFileTypes: true });
  const files: { readonly sequence: number; readonly path: string }[] = [];
  for (const entry of directoryEntries) {
    if (entry.isFile() && /^\d{12,}\.json$/.test(entry.name)) {
      const sequence = Number(entry.name.slice(0, -5));
      if (!Number.isSafeInteger(sequence) || sequence < 1 || fileNameForSequence(sequence) !== entry.name) {
        failCorrupt(`journal contains invalid event filename ${entry.name}`);
      }
      files.push({ sequence, path: join(eventsDirectory, entry.name) });
    } else if (entry.isFile() && /^\.paper-journal-[a-z0-9-]+\.tmp$/i.test(entry.name)) {
      // Staging files have no sequence link and are not committed journal entries.
    } else {
      failCorrupt(`journal events directory contains unknown path ${entry.name}`);
    }
  }
  files.sort((left, right) => left.sequence - right.sequence);
  const records: JournalEntry[] = [];
  let expectedSequence = 1;
  for (const file of files) {
    if (file.sequence !== expectedSequence) {
      failCorrupt(`journal event sequence gap: expected ${expectedSequence}, found ${file.sequence}`);
    }
    const parsed = parseJson(await readFile(file.path), file.path);
    records.push(decodeEntry(parsed, file.path));
    expectedSequence += 1;
  }
  return records;
}

function commandCanonical(command: JournalCommand): string {
  return canonicalJson({ kind: command.kind, payload: command.payload });
}

function decodeCallerCommand(command: JournalCommand): JournalCommand {
  const payload = command.payload as unknown;
  if (!isRecord(payload)) throw new TypeError("paper journal command payload must be an object");
  if (command.kind === "market") {
    if (typeof payload["eventId"] !== "string" || payload["eventId"].trim() === "") throw new TypeError("market eventId is required for durable journaling");
    const timestamp = payload["timestamp"];
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) throw new TypeError("market timestamp must be a safe integer for durable journaling");
    if (typeof payload["symbol"] !== "string" || payload["symbol"].trim() === "" || typeof payload["priceMinor"] !== "bigint") {
      throw new TypeError("market command fields are not journalable");
    }
    return Object.freeze({
      kind: command.kind,
      payload: Object.freeze({
        eventId: payload["eventId"],
        timestamp,
        symbol: payload["symbol"],
        priceMinor: payload["priceMinor"],
      }),
    });
  }
  if (command.kind === "cancel") {
    if (typeof payload["eventId"] !== "string" || payload["eventId"].trim() === "") throw new TypeError("cancel eventId is required for durable journaling");
    const timestamp = payload["timestamp"];
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) throw new TypeError("cancel timestamp must be a safe integer for durable journaling");
    if (typeof payload["clientOrderId"] !== "string" || payload["clientOrderId"].trim() === "") {
      throw new TypeError("cancel clientOrderId must be a non-empty string");
    }
    return Object.freeze({
      kind: command.kind,
      payload: Object.freeze({
        eventId: payload["eventId"],
        timestamp,
        clientOrderId: payload["clientOrderId"],
      }),
    });
  }
  if (command.kind === "halt") {
    if (typeof payload["eventId"] !== "string" || payload["eventId"].trim() === "") throw new TypeError("halt eventId is required for durable journaling");
    const timestamp = payload["timestamp"];
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) throw new TypeError("halt timestamp must be a safe integer for durable journaling");
    if (typeof payload["reason"] !== "string" || payload["reason"].trim() === "") throw new TypeError("halt reason must be a non-empty string");
    return Object.freeze({
      kind: command.kind,
      payload: Object.freeze({ eventId: payload["eventId"], timestamp, reason: payload["reason"] }),
    });
  }
  if (typeof payload["fillId"] !== "string" || payload["fillId"].trim() === "") throw new TypeError("fillId is required for durable journaling");
  const timestamp = payload["timestamp"];
  const quantity = payload["quantity"];
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) throw new TypeError("execution report timestamp must be a safe integer for durable journaling");
  if (typeof payload["clientOrderId"] !== "string" || payload["clientOrderId"].trim() === ""
    || typeof payload["marketEventId"] !== "string" || payload["marketEventId"].trim() === "") {
    throw new TypeError("execution report order and market IDs must be non-empty strings");
  }
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError("execution report quantity must be a non-negative safe integer for durable journaling");
  }
  if (typeof payload["executionPriceMinor"] !== "bigint" || typeof payload["feeMinor"] !== "bigint") {
    throw new TypeError("execution report money fields must use bigint minor units for durable journaling");
  }
  return Object.freeze({
    kind: command.kind,
    payload: Object.freeze({
      fillId: payload["fillId"],
      clientOrderId: payload["clientOrderId"],
      marketEventId: payload["marketEventId"],
      timestamp,
      quantity,
      executionPriceMinor: payload["executionPriceMinor"],
      feeMinor: payload["feeMinor"],
    }),
  });
}

export class DurablePaperTradingSession {
  readonly journalDirectory: string;

  private readonly engine: PaperTradingEngine;
  private readonly sourceClock: Clock;
  private readonly clockState: { value: number };
  private readonly eventsDirectory: string;
  private readonly strategyVersion: string;
  private readonly entriesById = new Map<string, { readonly canonical: string; readonly entry: JournalEntry }>();
  private readonly fillsById = new Map<string, FillIdentity>();
  private readonly orderIdentities = new Map<string, OrderIdentity>();
  private lastSequence = 0;
  private writePending = false;
  private closed = false;
  private failure: unknown;

  private constructor(
    journalDirectory: string,
    config: PaperTradingEngineConfig,
    engine: PaperTradingEngine,
    clockState: { value: number },
  ) {
    this.journalDirectory = journalDirectory;
    this.eventsDirectory = join(journalDirectory, EVENTS_DIRECTORY);
    this.sourceClock = config.clock;
    this.strategyVersion = config.strategy.strategyVersion;
    this.clockState = clockState;
    this.engine = engine;
  }

  /**
   * Opens or creates a durable session at an explicit directory. Schema v1 stores a
   * configuration header and immutable, sequence-numbered event files. Replay uses
   * the supplied strategy and fill rule, then rejects any output that diverges.
   */
  static async open(config: PaperTradingEngineConfig, journalPath: string): Promise<DurablePaperTradingSession> {
    if (typeof journalPath !== "string" || journalPath.trim() === "") throw new TypeError("journalPath is required");
    const root = resolve(journalPath);
    const clockState = { value: Number.NaN };
    const replayClock: Clock = { now: () => clockState.value };
    const engine = new PaperTradingEngine({ ...config, clock: replayClock });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) throw new PaperJournalCorruptError("paper journal path must be a directory");
    const header = await readHeaderOrCreate(root, config);
    const eventsDirectory = join(root, EVENTS_DIRECTORY);
    const session = new DurablePaperTradingSession(root, config, engine, clockState);
    const entries = await loadEntries(eventsDirectory);
    for (const entry of entries) {
      session.replayEntry(entry, header);
    }
    return session;
  }

  getSnapshot(): AccountSnapshot {
    this.assertReadable();
    return this.engine.getSnapshot();
  }

  getOrders(): readonly PaperOrder[] {
    this.assertReadable();
    return this.engine.getOrders();
  }

  getFills(): readonly ExecutionReport[] {
    this.assertReadable();
    return this.engine.getFills();
  }

  getEvents(): readonly SimulationEvent[] {
    this.assertReadable();
    return this.engine.getEvents();
  }

  getJournalSequence(): number {
    this.assertReadable();
    return this.lastSequence;
  }

  async processMarketEvent(event: MarketEvent): Promise<OperationResult> {
    return this.execute({ kind: "market", payload: event });
  }

  async cancelOrder(request: CancelRequest): Promise<OperationResult> {
    return this.execute({ kind: "cancel", payload: request });
  }

  async halt(request: HaltRequest): Promise<OperationResult> {
    return this.execute({ kind: "halt", payload: request });
  }

  async acceptExecutionReport(report: ExecutionReport): Promise<OperationResult> {
    return this.execute({ kind: "execution-report", payload: report });
  }

  close(): void {
    if (this.writePending) throw new PaperJournalError("cannot close while a journal event is being committed");
    this.closed = true;
  }

  private assertReadable(): void {
    if (this.failure !== undefined) throw new PaperJournalError("paper session is unavailable after a journal failure", { cause: this.failure });
    if (this.writePending) throw new PaperJournalError("paper state is unavailable until the journal commit completes");
  }

  private assertWritable(): void {
    this.assertReadable();
    if (this.closed) throw new PaperJournalError("paper session is closed");
  }

  private sampleClock(): number | null {
    try {
      const value = this.sourceClock.now();
      return Number.isSafeInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async execute(rawCommand: JournalCommand): Promise<OperationResult> {
    this.assertWritable();
    const command = decodeCallerCommand(rawCommand);
    const eventId = commandEventId(command);
    const canonical = commandCanonical(command);
    const previous = this.entriesById.get(eventId);
    if (previous !== undefined) {
      if (previous.canonical !== canonical) {
        throw new PaperJournalConflictError(`event ID ${eventId} was reused with conflicting content`);
      }
      if (previous.entry.kind === "execution-report" && previous.entry.outcome.status === "rejected") {
        return previous.entry.outcome;
      }
      return Object.freeze({ status: "duplicate" });
    }
    if (command.kind === "execution-report") {
      const priorFill = this.fillsById.get(command.payload.fillId);
      if (priorFill !== undefined) {
        if (priorFill.canonical !== executionReportCanonical(command.payload)) {
          throw new PaperJournalConflictError(`fill ID ${command.payload.fillId} was reused with conflicting content`);
        }
        return priorFill.outcome.status === "accepted"
          ? Object.freeze({ status: "duplicate" })
          : priorFill.outcome;
      }
    }

    this.writePending = true;
    const clockTimestamp = this.sampleClock();
    this.clockState.value = clockTimestamp ?? Number.NaN;
    const beforeEvents = this.engine.getEvents().length;
    let outcome: OperationResult;
    let events: readonly SimulationEvent[];
    let orderIdentities: Map<string, OrderIdentity>;
    try {
      outcome = this.apply(command);
      events = this.engine.getEvents().slice(beforeEvents);
      orderIdentities = validateOrderIdentities(events, this.strategyVersion, this.orderIdentities);
      this.validateFillIdentities(command, events);
    } catch (error) {
      this.failure = error;
      this.writePending = false;
      throw error;
    }

    const entry = Object.freeze({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      recordType: "event",
      sequence: this.lastSequence + 1,
      eventId,
      timestamp: commandTimestamp(command),
      ...command,
      clockTimestamp,
      outcome,
      events: Object.freeze([...events]),
      strategyVersion: this.strategyVersion,
    }) as JournalEntry;
    try {
      await appendEntry(this.eventsDirectory, entry);
    } catch (error) {
      this.failure = error;
      this.writePending = false;
      throw new PaperJournalError("paper state changed in memory but its journal commit failed; session is fail-closed", { cause: error });
    }
    this.registerEntry(entry);
    this.replaceOrderIdentities(orderIdentities);
    this.lastSequence = entry.sequence;
    this.writePending = false;
    return outcome;
  }

  private apply(command: JournalCommand): OperationResult {
    switch (command.kind) {
      case "market": return this.engine.processMarketEvent(command.payload);
      case "cancel": return this.engine.cancelOrder(command.payload);
      case "halt": return this.engine.halt(command.payload);
      case "execution-report": return this.engine.acceptExecutionReport(command.payload);
    }
  }

  private validateFillIdentities(
    command: JournalCommand,
    events: readonly SimulationEvent[],
  ): void {
    for (const event of events) {
      if (event.kind !== "fill") continue;
      const canonical = fillEventCanonical(event);
      const previous = this.fillsById.get(event.fillId);
      if (previous !== undefined && previous.canonical !== canonical) {
        throw new PaperJournalConflictError(`fill ID ${event.fillId} conflicts with an earlier fill`);
      }
    }
    if (command.kind === "execution-report") {
      const previous = this.fillsById.get(command.payload.fillId);
      const canonical = executionReportCanonical(command.payload);
      if (previous !== undefined && previous.canonical !== canonical) {
        throw new PaperJournalConflictError(`fill ID ${command.payload.fillId} was reused with conflicting content`);
      }
    }
  }

  private registerEntry(entry: JournalEntry): void {
    this.entriesById.set(entry.eventId, { canonical: commandCanonical({ kind: entry.kind, payload: entry.payload } as JournalCommand), entry });
    for (const event of entry.events) {
      if (event.kind === "fill") {
        this.fillsById.set(event.fillId, {
          canonical: fillEventCanonical(event),
          outcome: Object.freeze({ status: "accepted" }),
        });
      }
    }
    if (entry.kind === "execution-report") {
      this.fillsById.set(entry.payload.fillId, {
        canonical: executionReportCanonical(entry.payload),
        outcome: entry.outcome,
      });
    }
  }

  private replaceOrderIdentities(orderIdentities: ReadonlyMap<string, OrderIdentity>): void {
    this.orderIdentities.clear();
    for (const [clientOrderId, identity] of orderIdentities) this.orderIdentities.set(clientOrderId, identity);
  }

  private replayEntry(entry: JournalEntry, header: JournalHeader): void {
    if (entry.sequence !== this.lastSequence + 1) {
      throw new PaperJournalCorruptError(`journal sequence expected ${this.lastSequence + 1}, found ${entry.sequence}`);
    }
    if (entry.strategyVersion !== header.strategyVersion) {
      throw new PaperJournalConflictError(`journal event ${entry.eventId} has a conflicting strategyVersion`);
    }
    const canonical = commandCanonical({ kind: entry.kind, payload: entry.payload } as JournalCommand);
    const prior = this.entriesById.get(entry.eventId);
    if (prior !== undefined) {
      if (prior.canonical !== canonical || entrySemantic(prior.entry) !== entrySemantic(entry)) {
        throw new PaperJournalConflictError(`journal event ID ${entry.eventId} has conflicting duplicate records`);
      }
      this.lastSequence = entry.sequence;
      return;
    }
    if (entry.kind === "execution-report") {
      const priorFill = this.fillsById.get(entry.payload.fillId);
      if (priorFill !== undefined && priorFill.canonical !== executionReportCanonical(entry.payload)) {
        throw new PaperJournalConflictError(`journal fill ID ${entry.payload.fillId} has conflicting duplicate records`);
      }
    }

    this.clockState.value = entry.clockTimestamp ?? Number.NaN;
    const beforeEvents = this.engine.getEvents().length;
    const outcome = this.apply({ kind: entry.kind, payload: entry.payload } as JournalCommand);
    const events = this.engine.getEvents().slice(beforeEvents);
    const orderIdentities = validateOrderIdentities(entry.events, header.strategyVersion, this.orderIdentities);
    if (canonicalJson(outcome) !== canonicalJson(entry.outcome) || canonicalJson(events) !== canonicalJson(entry.events)) {
      throw new PaperJournalReplayError(`journal replay diverged at sequence ${entry.sequence} (${entry.eventId})`);
    }
    this.validateFillIdentities({ kind: entry.kind, payload: entry.payload } as JournalCommand, entry.events);
    this.registerEntry(entry);
    this.replaceOrderIdentities(orderIdentities);
    this.lastSequence = entry.sequence;
  }
}

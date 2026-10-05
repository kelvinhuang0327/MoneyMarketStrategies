import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoForwardEvidenceCliOverrides,
  FORWARD_EVIDENCE_BATCH_DIRECTORY,
  FORWARD_EVIDENCE_STATUS_PATH,
  loadForwardEvidenceState,
  reconstructCumulativeForwardCsv,
  runForwardEvidenceAccumulator,
  selectUnseenForwardRows,
} from "./forwardEvidenceAccumulator.js";
import {
  evaluateZScoreCrossSymbolForward,
  validateFreshCrossSymbolCsv,
  ZSCORE_FORWARD_SYMBOLS,
  type FreshMarketRow,
} from "./zscoreCrossSymbolForwardEvaluator.js";

const REPO_ROOT = resolve(process.cwd());
const FIXTURE_FILES = [
  "data/market/p194-twstock-ohlcv-v1/p194_twstock_ohlcv_export.csv",
  "data/market/p194-twstock-ohlcv-v1/provenance.json",
  "data/market/forward/cross-symbol-risk-normalized-v1/cross_symbol_forward.csv",
  "data/market/forward/cross-symbol-risk-normalized-v1/provenance.json",
  "packages/paper-trading/zscore-risk-normalized-cross-symbol-forward-v1.json",
  "packages/paper-trading/zscore-win-rate-strategy-risk-normalized-v1.json",
  "packages/paper-trading/win-rate-strategy-family-v1.json",
] as const;

let fixtureRoot = "";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function marketRow(symbol: string, date: string, close: string): FreshMarketRow {
  return Object.freeze({
    symbol,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1000",
    source: "twse/STOCK_DAY",
  });
}

function fetchResult(rows: readonly FreshMarketRow[]) {
  return async () => ({
    rows,
    fetchedAtUtc: "2026-10-01T03:00:00.000Z",
  });
}

async function resetFixture(): Promise<void> {
  await rm(resolve(fixtureRoot, FORWARD_EVIDENCE_BATCH_DIRECTORY), { recursive: true, force: true });
  await rm(resolve(fixtureRoot, FORWARD_EVIDENCE_STATUS_PATH), { force: true });
  for (const relativePath of FIXTURE_FILES) {
    const target = resolve(fixtureRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(REPO_ROOT, relativePath), target);
  }
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mms-forward-evidence-"));
});

beforeEach(async () => {
  await resetFixture();
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("append-only forward evidence accumulator", () => {
  it("derives the fetch cutoff from original provenance and cumulative batches", async () => {
    const initial = await loadForwardEvidenceState(fixtureRoot);
    expect(initial).toMatchObject({
      historicalCutoff: "2026-08-11",
      firstForwardDate: "2026-08-12",
      latestForwardDate: "2026-09-30",
      cumulativeRows: 136,
      batchCount: 1,
    });

    const rows = ZSCORE_FORWARD_SYMBOLS.map((symbol, index) => marketRow(symbol, "2026-10-01", `${100 + index}.00`));
    await runForwardEvidenceAccumulator({ projectRoot: fixtureRoot, fetchRows: fetchResult(rows) });
    expect(await loadForwardEvidenceState(fixtureRoot)).toMatchObject({
      latestForwardDate: "2026-10-01",
      cumulativeRows: 140,
      batchCount: 2,
    });
  });

  it("rejects unknown rows on or before the derived cutoff", () => {
    const cutoffRow = marketRow("0056", "2026-09-30", "100.00");
    const earlierRow = marketRow("0056", "2026-09-29", "100.00");
    expect(() => selectUnseenForwardRows([cutoffRow], [], "2026-09-30")).toThrow(/strictly after 2026-09-30/);
    expect(() => selectUnseenForwardRows([earlierRow], [], "2026-09-30")).toThrow(/strictly after 2026-09-30/);
  });

  it("returns successful NO_NEW_DATA and writes the cumulative status", async () => {
    let observedCutoff: string | undefined;
    const result = await runForwardEvidenceAccumulator({
      projectRoot: fixtureRoot,
      fetchRows: async (previousForwardEnd) => {
        observedCutoff = previousForwardEnd;
        return fetchResult([])(previousForwardEnd);
      },
    });
    const status = JSON.parse(await readFile(resolve(fixtureRoot, FORWARD_EVIDENCE_STATUS_PATH), "utf8")) as Record<string, unknown>;

    expect(observedCutoff).toBe("2026-09-30");
    expect(result).toMatchObject({
      fetchStatus: "NO_NEW_DATA",
      newRowCount: 0,
      newDateRange: null,
      newBatchSha256: null,
      forwardEvidenceStatus: "NO_NEW_DATA",
      tradingWinRateImprovement: "NOT_EVALUABLE",
      cumulativeLatestDate: "2026-09-30",
      cumulativeBatchCount: 1,
    });
    expect(status["forwardEvidenceStatus"]).toBe("NO_NEW_DATA");
    expect(status["tradingWinRateImprovement"]).toBe("NOT_EVALUABLE");
    expect(status["batchCount"]).toBe(1);
    expect(await readdir(resolve(fixtureRoot, FORWARD_EVIDENCE_BATCH_DIRECTORY)).catch(() => [])).toEqual([]);
  });

  it("appends one immutable batch and ignores an identical provider re-read", async () => {
    const rows = ZSCORE_FORWARD_SYMBOLS.map((symbol, index) => marketRow(symbol, "2026-10-01", `${100 + index}.00`));
    const first = await runForwardEvidenceAccumulator({ projectRoot: fixtureRoot, fetchRows: fetchResult(rows) });
    const batchPath = resolve(fixtureRoot, FORWARD_EVIDENCE_BATCH_DIRECTORY, "2026-10-01-2026-10-01");
    const batchCsv = await readFile(resolve(batchPath, "forward.csv"));
    const provenanceBytes = await readFile(resolve(batchPath, "provenance.json"));
    const provenance = JSON.parse(provenanceBytes.toString("utf8")) as Record<string, unknown>;
    const second = await runForwardEvidenceAccumulator({ projectRoot: fixtureRoot, fetchRows: fetchResult(rows) });

    expect(first).toMatchObject({
      fetchStatus: "NEW_DATA",
      newRowCount: 4,
      newDateRange: { start: "2026-10-01", end: "2026-10-01" },
      newBatchSha256: hash(batchCsv),
      cumulativeBatchCount: 2,
    });
    expect(Object.keys(provenance).sort()).toEqual([
      "artifactId", "dateRange", "fetchedAtUtc", "perSymbolRowCounts", "previousForwardEnd",
      "providerVersion", "rowCount", "schemaVersion", "sha256", "source", "symbols",
    ].sort());
    expect(provenance).toMatchObject({
      previousForwardEnd: "2026-09-30",
      dateRange: { start: "2026-10-01", end: "2026-10-01" },
      rowCount: 4,
      sha256: hash(batchCsv),
      perSymbolRowCounts: { "0056": 1, "2317": 1, "2330": 1, "2454": 1 },
    });
    expect(provenance["symbols"]).toEqual(["0056", "2317", "2330", "2454"]);
    expect(second).toMatchObject({
      fetchStatus: "NO_NEW_DATA",
      newRowCount: 0,
      cumulativeLatestDate: "2026-10-01",
      cumulativeBatchCount: 2,
    });
    expect(await readFile(resolve(batchPath, "forward.csv"))).toEqual(batchCsv);
    expect(await readFile(resolve(batchPath, "provenance.json"))).toEqual(provenanceBytes);
    expect(await loadForwardEvidenceState(fixtureRoot)).toMatchObject({ cumulativeRows: 140, batchCount: 2 });
  });

  it("rejects conflicting duplicates and does not append known identical rows", () => {
    const known = marketRow("0056", "2026-09-30", "100.00");
    expect(selectUnseenForwardRows([known], [known], "2026-09-30")).toEqual([]);
    expect(() => selectUnseenForwardRows([marketRow("0056", "2026-09-30", "101.00")], [known], "2026-09-30"))
      .toThrow(/conflicts with known evidence/);
    expect(() => selectUnseenForwardRows([
      marketRow("0056", "2026-10-01", "100.00"),
      marketRow("0056", "2026-10-01", "101.00"),
    ], [], "2026-09-30")).toThrow(/conflicting duplicate/);
  });

  it("keeps the symbol list fixed and rejects malformed market rows", () => {
    expect(() => selectUnseenForwardRows([marketRow("0050", "2026-10-01", "100.00")], [], "2026-09-30"))
      .toThrow(/unsupported symbol/);
    const malformed = { ...marketRow("0056", "2026-10-01", "100.00"), high: "90.00" };
    expect(() => validateFreshCrossSymbolCsv(`symbol,date,open,high,low,close,volume,source\n${[
      malformed.symbol, malformed.date, malformed.open, malformed.high, malformed.low, malformed.close,
      malformed.volume, malformed.source,
    ].join(",")}\n`)).toThrow(/inconsistent OHLC values/);
    expect(() => assertNoForwardEvidenceCliOverrides(["--symbols", "0050"])).toThrow(/no symbol, data, strategy, or tuning overrides/);
  });

  it("loads both frozen strategies and risk from their checked-in authorities", async () => {
    const result = await runForwardEvidenceAccumulator({ projectRoot: fixtureRoot, fetchRows: fetchResult([]) });
    const status = JSON.parse(await readFile(resolve(fixtureRoot, FORWARD_EVIDENCE_STATUS_PATH), "utf8")) as Record<string, unknown>;
    const authorities = status["strategyAuthorities"] as Record<string, Record<string, unknown>>;
    const risk = status["riskProfile"] as Record<string, unknown>;

    expect(result.tradingWinRateImprovement).toBe("NOT_EVALUABLE");
    expect(authorities["legacyReference"]).toMatchObject({
      identity: "ROLLING_MEAN_REVERSION_V1",
      candidateId: "lookback-20-entry-0.04-take-0.04-hold-10",
      parameters: { lookback: 20, entryDiscount: 0.04, takeProfit: 0.04, maxHoldBars: 10 },
    });
    expect(authorities["frozenChallenger"]).toMatchObject({
      identity: "ROLLING_ZSCORE_MEAN_REVERSION_V1",
      candidateId: "lookback-40-entryz-1-exitz-0-hold-20",
      parameters: { lookback: 40, entryZ: 1, exitZ: 0, maxHoldBars: 20 },
    });
    expect(risk).toMatchObject({
      id: "CROSS_SYMBOL_RESEARCH_RISK_V1",
      initialCapitalMinor: 10_000_000,
      maxExposureMinor: 2_000_000,
      currency: "TWD",
      minorUnitsPerMajor: 100,
    });
  });

  it("passes one deterministic cumulative stream to the existing evaluator", async () => {
    const addedRows = ZSCORE_FORWARD_SYMBOLS.map((symbol, index) => marketRow(symbol, "2026-10-01", `${110 + index}.00`));
    const expectedCsv = reconstructCumulativeForwardCsv([
      ...validateFreshCrossSymbolCsv(await readFile(resolve(fixtureRoot, "data/market/forward/cross-symbol-risk-normalized-v1/cross_symbol_forward.csv"), "utf8")),
      ...addedRows,
    ]);
    const shuffled = [...addedRows].reverse();
    expect(reconstructCumulativeForwardCsv(shuffled)).toBe(reconstructCumulativeForwardCsv(addedRows));
    let observedCsv = "";
    let evaluatorCalls = 0;
    await runForwardEvidenceAccumulator({
      projectRoot: fixtureRoot,
      fetchRows: fetchResult(addedRows),
      evaluate: (input) => {
        evaluatorCalls += 1;
        observedCsv = new TextDecoder().decode(input.freshDataBytes);
        return evaluateZScoreCrossSymbolForward(input);
      },
    });
    expect(evaluatorCalls).toBe(1);
    expect(observedCsv).toBe(expectedCsv);
    expect(observedCsv.includes("2026-10-01")).toBe(true);
  });

  it("rejects CLI parameter overrides and preserves the checked-in first evidence bytes", async () => {
    const originalBytes = await Promise.all(FIXTURE_FILES.map((path) => readFile(resolve(fixtureRoot, path))));
    expect(() => assertNoForwardEvidenceCliOverrides([])).not.toThrow();
    await runForwardEvidenceAccumulator({ projectRoot: fixtureRoot, fetchRows: fetchResult([]) });
    const afterBytes = await Promise.all(FIXTURE_FILES.map((path) => readFile(resolve(fixtureRoot, path))));
    expect(afterBytes).toEqual(originalBytes);
  }, 10_000);
});

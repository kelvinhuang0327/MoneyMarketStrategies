import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { parseHistoricalCsv, runHistoricalCsvFile } from "./historicalBaseline.js";
import { runPaperSession } from "./sessionRunner.js";

const FIXTURE_PATH = "packages/paper-trading/fixtures/historical.synthetic.csv";
const TWSE_PROFILE = "twse-daily-ohlcv-close-v1";
let syntheticCsv = "";

function evaluateCsv(contents: string) {
  const parsed = parseHistoricalCsv(contents, "SYNTH", "synthetic test input");
  const digest = createHash("sha256").update(contents).digest("hex");
  return runPaperSession(parsed.session, digest);
}

function twseCsv(rows: readonly string[]): string {
  return ["symbol,date,open,high,low,close,volume", ...rows].join("\n");
}

function twsePriceMinor(close: string): bigint {
  const contents = twseCsv([`0050,2024-01-02,ignored,ignored,ignored,${close},ignored`]);
  const parsed = parseHistoricalCsv(contents, "0050", "TWSE test input", TWSE_PROFILE);
  return parsed.session.events[0]!.priceMinor;
}

function evaluateTwseCsv(contents: string) {
  const parsed = parseHistoricalCsv(contents, "0050", "TWSE test input", TWSE_PROFILE);
  const digest = createHash("sha256").update(contents).digest("hex");
  return runPaperSession(parsed.session, digest);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function engineResult(result: Record<string, unknown>) {
  return {
    eventProcessingResults: result["eventProcessingResults"],
    journal: result["journal"],
    tradingStatistics: result["tradingStatistics"],
    accountSummary: result["accountSummary"],
    accountReconciliation: result["accountReconciliation"],
  };
}

describe("historical CSV baseline adapter", () => {
  beforeAll(async () => {
    syntheticCsv = await readFile(FIXTURE_PATH, "utf8");
  });

  it("converts TWSE close decimal text exactly to TWD minor units", () => {
    expect(twsePriceMinor("51")).toBe(5100n);
    expect(twsePriceMinor("51.2")).toBe(5120n);
    expect(twsePriceMinor("51.25")).toBe(5125n);
    expect(twsePriceMinor("51.250")).toBe(5125n);
    expect(twsePriceMinor("90071992547409.93")).toBe(9007199254740993n);
  });

  it("rejects unsupported close precision and malformed, zero, or negative close values", () => {
    expect(() => twsePriceMinor("51.251")).toThrow("cannot be represented exactly");
    for (const close of ["", "NaN", "Infinity", "-1", "0", "0.00"]) {
      expect(() => twsePriceMinor(close)).toThrow();
    }
  });

  it("uses the declared daily-close event time and preserves next-event fills", () => {
    const contents = twseCsv([
      "0050,2024-01-02,90,91,89,90,100",
      "0050,2024-01-03,90,91,89,90,100",
      "0050,2024-01-04,110,111,109,110,100",
    ]);
    const parsed = parseHistoricalCsv(contents, "0050", "TWSE test input", TWSE_PROFILE);
    expect(parsed).toMatchObject({
      sourceProfile: "TWSE_DAILY_OHLCV_CLOSE_V1",
      minorUnitsPerMajor: 100,
      sourcePriceColumn: "close",
      startDate: "2024-01-02",
      endDate: "2024-01-04",
      rowCount: 3,
    });
    expect(parsed.session.asset).toMatchObject({ symbol: "0050", currencyCode: "TWD", minorUnit: "0.01" });
    expect(parsed.session.events.map((event) => event.timestamp)).toEqual([
      Date.parse("2024-01-02T13:30:00+08:00"),
      Date.parse("2024-01-03T13:30:00+08:00"),
      Date.parse("2024-01-04T13:30:00+08:00"),
    ]);

    const result = evaluateTwseCsv(contents);
    const fill = (result.journal as readonly Record<string, unknown>[]).find((event) => event.kind === "fill");
    expect(fill).toMatchObject({
      timestamp: Date.parse("2024-01-03T13:30:00+08:00"),
      sourceMarketEventId: "historical-0050-2024-01-03",
    });
  });

  it("rejects duplicate and descending dates for the selected TWSE symbol", () => {
    const selected = (date: string) => `0050,${date},1,2,1,1,10`;
    expect(() => parseHistoricalCsv(
      twseCsv([selected("2024-01-02"), selected("2024-01-02")]),
      "0050",
      "TWSE test input",
      TWSE_PROFILE,
    )).toThrow("duplicate or out of chronological order");
    expect(() => parseHistoricalCsv(
      twseCsv([selected("2024-01-03"), selected("2024-01-02")]),
      "0050",
      "TWSE test input",
      TWSE_PROFILE,
    )).toThrow("duplicate or out of chronological order");
  });

  it("does not use open, high, low, or volume as strategy inputs", () => {
    const closes = [
      "0050,2024-01-02,90,91,89,90,100",
      "0050,2024-01-03,90,91,89,90,100",
      "0050,2024-01-04,110,111,109,110,100",
    ];
    const changedOhlv = [
      "0050,2024-01-02,open-x,high-x,low-x,90,volume-x",
      "0050,2024-01-03,open-y,high-y,low-y,90,volume-y",
      "0050,2024-01-04,open-z,high-z,low-z,110,volume-z",
    ];
    expect(engineResult(evaluateTwseCsv(twseCsv(changedOhlv))))
      .toEqual(engineResult(evaluateTwseCsv(twseCsv(closes))));
  });

  it("keeps earlier decisions unchanged when a future TWSE close changes", () => {
    const original = twseCsv([
      "0050,2024-01-02,90,91,89,90,100",
      "0050,2024-01-03,95,96,94,95,100",
      "0050,2024-01-04,110,111,109,110,100",
      "0050,2024-01-05,105,106,104,105,100",
    ]);
    const changed = original.replace("2024-01-05,105,106,104,105,100", "2024-01-05,105,106,104,999,100");
    const originalResult = evaluateTwseCsv(original);
    const changedResult = evaluateTwseCsv(changed);
    const prefixTimestamp = Date.parse("2024-01-04T13:30:00+08:00");
    const earlierJournal = (result: Record<string, unknown>) =>
      (result["journal"] as readonly Record<string, unknown>[])
        .filter((event) => Number(event["timestamp"]) <= prefixTimestamp);
    expect(earlierJournal(changedResult)).toEqual(earlierJournal(originalResult));
  });

  it("runs chronological CSV rows through the fixed runner and produces reconciled W/L/BE results", async () => {
    const first = await runHistoricalCsvFile(FIXTURE_PATH, "SYNTH");
    const repeated = await runHistoricalCsvFile(FIXTURE_PATH, "SYNTH");
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      classification: "SIMULATION_ONLY",
      SIMULATION_ONLY: true,
      dataKind: "HISTORICAL",
      strategyVersion: "price-band-fixed-v1",
      symbol: "SYNTH",
      acceptedRowCount: 15,
      startDate: "2024-01-01",
      endDate: "2024-01-15",
    });
    expect(first.inputSha256).toBe(createHash("sha256").update(await readFile(FIXTURE_PATH)).digest("hex"));

    const processing = first.eventProcessingResults as readonly Record<string, unknown>[];
    expect(processing.map((event) => event.eventId)).toEqual(
      Array.from({ length: 15 }, (_, index) => `historical-SYNTH-2024-01-${String(index + 1).padStart(2, "0")}`),
    );
    expect(processing.map((event) => event.timestamp)).toEqual(
      Array.from({ length: 15 }, (_, index) => Date.UTC(2024, 0, index + 1)),
    );

    const stats = asRecord(first.tradingStatistics);
    expect(stats).toMatchObject({
      completeTradeCount: 3,
      wins: 1,
      losses: 1,
      breakevens: 1,
      netWinRate: 1 / 3,
      averageWinPnlMinor: { numeratorMinor: "5142", denominator: 1 },
      averageLossPnlMinor: { numeratorMinor: "-788", denominator: 1 },
      averageCompleteTradeNetPnlMinor: { numeratorMinor: "4354", denominator: 3 },
    });
    const account = asRecord(first.accountSummary);
    expect(account).toMatchObject({
      cashMinor: 73_963n,
      positionQuantity: 3,
      positionCostBasisMinor: 30_391n,
      realizedPnlMinor: 4_354n,
      unrealizedPnlMinor: 1_109n,
      feesPaidMinor: 654n,
      equityMinor: 105_463n,
    });
    expect(first.accountReconciliation).toMatchObject({
      fillFeesMatch: true,
      positionsMatch: true,
      realizedPnlMatches: true,
      equityMatches: true,
    });
    expect(first).toMatchObject({
      completedTradeCount: 3,
      winCount: 1,
      lossCount: 1,
      breakevenCount: 1,
      netWinRate: 1 / 3,
      averageWinningTradeNetPnl: { numeratorMinor: "5142", denominator: 1 },
      averageLosingTradeNetPnl: { numeratorMinor: "-788", denominator: 1 },
      averageCompletedTradeNetPnl: { numeratorMinor: "4354", denominator: 3 },
      fees: 654n,
      realizedPnl: 4_354n,
      unrealizedPnl: 1_109n,
      cash: 73_963n,
      equity: 105_463n,
      position: 3,
    });
  });

  it("ignores future outcome columns and does not let them change any engine result", () => {
    const baseline = evaluateCsv(syntheticCsv);
    const outcomesChanged = syntheticCsv
      .replaceAll("0.05,WIN", "912.50,LOSS")
      .replaceAll("-0.01,LOSS", "-912.50,WIN")
      .replaceAll("0.00,BREAKEVEN", "777.77,LOSS")
      .replaceAll("0.03,OPEN", "-777.77,WIN");
    const changed = evaluateCsv(outcomesChanged);
    expect(changed.journal).toEqual(baseline.journal);
    expect(changed.tradingStatistics).toEqual(baseline.tradingStatistics);
    expect(changed.accountSummary).toEqual(baseline.accountSummary);
    const serializedJournal = JSON.stringify(changed.journal, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serializedJournal).not.toContain("realizedForwardReturn");
    expect(serializedJournal).not.toContain("futureLabel");
  });

  it("leaves zero-completed-trade win rates and averages null for a one-row open session", () => {
    const oneRow = syntheticCsv.split(/\r?\n/).slice(0, 2).join("\n");
    const result = evaluateCsv(oneRow);
    const stats = asRecord(result.tradingStatistics);
    expect(stats).toMatchObject({
      completeTradeCount: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      netWinRate: null,
      averageWinPnlMinor: null,
      averageLossPnlMinor: null,
      averageCompleteTradeNetPnlMinor: null,
    });
    expect(asRecord(result.accountSummary)).toMatchObject({
      positionQuantity: 0,
      realizedPnlMinor: 0n,
      feesPaidMinor: 0n,
    });
  });

  it("rejects duplicate or descending dates, malformed prices, missing cells, and duplicate headers", () => {
    const lines = syntheticCsv.trimEnd().split("\n");
    const duplicateDate = [...lines];
    duplicateDate[2] = duplicateDate[2]!.replace("2024-01-02", "2024-01-01");
    expect(() => parseHistoricalCsv(duplicateDate.join("\n"), "SYNTH", "test.csv")).toThrow("duplicate or out of chronological order");

    const descendingDate = [...lines];
    descendingDate[2] = descendingDate[2]!.replace("2024-01-02", "2023-12-31");
    expect(() => parseHistoricalCsv(descendingDate.join("\n"), "SYNTH", "test.csv")).toThrow("duplicate or out of chronological order");

    const nonFinitePrice = syntheticCsv.replace("2024-01-01,SYNTH,TWD,0.01,10000", "2024-01-01,SYNTH,TWD,0.01,NaN");
    expect(() => parseHistoricalCsv(nonFinitePrice, "SYNTH", "test.csv")).toThrow("priceMinor must be a positive integer string");

    const missingPrice = syntheticCsv.replace("2024-01-01,SYNTH,TWD,0.01,10000,", "2024-01-01,SYNTH,TWD,0.01,,");
    expect(() => parseHistoricalCsv(missingPrice, "SYNTH", "test.csv")).toThrow("priceMinor must be non-empty");

    const duplicateHeader = syntheticCsv.replace("date,symbol,", "date,date,");
    expect(() => parseHistoricalCsv(duplicateHeader, "SYNTH", "test.csv")).toThrow("header date is duplicated");
  });

  it("reports only matching-symbol rows and rejects invalid dates, changed currency precision, and missing symbols", () => {
    const headerAndOther = `${syntheticCsv.split(/\r?\n/)[0]}\n2023-12-31,OTHER,USD,0.01,5000,0,IGNORED,\n${syntheticCsv.split(/\r?\n/).slice(1).join("\n")}`;
    const result = parseHistoricalCsv(headerAndOther, "SYNTH", "test.csv");
    expect(result.rowCount).toBe(15);

    const invalidDate = syntheticCsv.replace("2024-01-01", "2024-02-30");
    expect(() => parseHistoricalCsv(invalidDate, "SYNTH", "test.csv")).toThrow("not a valid calendar date");

    const changedPrecision = syntheticCsv.replace("2024-01-02,SYNTH,TWD,0.01", "2024-01-02,SYNTH,TWD,1");
    expect(() => parseHistoricalCsv(changedPrecision, "SYNTH", "test.csv")).toThrow("changes minorUnit");

    expect(() => parseHistoricalCsv(syntheticCsv, "ABSENT", "test.csv")).toThrow("no rows for requested symbol ABSENT");
  });

  it("prints one JSON document, supports help, and fails on a missing input instead of using another source", () => {
    const runner = spawnSync("npm", [
      "run", "--silent", "paper:baseline", "--", "--input-csv", FIXTURE_PATH, "--symbol", "SYNTH",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(runner.status).toBe(0);
    expect(runner.stderr).toBe("");
    const output = JSON.parse(runner.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({ SIMULATION_ONLY: true, dataKind: "HISTORICAL", acceptedRowCount: 15 });

    const missing = spawnSync("npm", [
      "run", "--silent", "paper:baseline", "--", "--input-csv", "packages/paper-trading/fixtures/does-not-exist.csv", "--symbol", "SYNTH",
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("ENOENT");

    const help = spawnSync("npm", ["run", "--silent", "paper:baseline", "--", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("priceMinor: positive integer");
  }, 90_000);
});

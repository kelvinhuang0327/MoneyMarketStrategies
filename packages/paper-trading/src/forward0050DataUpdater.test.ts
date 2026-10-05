import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORWARD_0050_HISTORICAL_CUTOFF,
  FORWARD_0050_V1_CSV_PATH,
  FORWARD_0050_V1_PROVENANCE_PATH,
  FORWARD_0050_V2_CSV_PATH,
  FORWARD_0050_V2_PROVENANCE_PATH,
  parseTwse0050MonthResponse,
  refresh0050ForwardSnapshot,
  twseStockDayUrl,
} from "./forward0050DataUpdater.js";

const CSV_HEADER = "symbol,date,open,high,low,close,volume,source";
const FIELDS = ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"];
const SOURCE = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=0050";

interface TestRow {
  readonly rocDate: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume?: string;
}

function twsePayload(rows: readonly TestRow[]) {
  return {
    stat: "OK",
    fields: FIELDS,
    data: rows.map((row) => [row.rocDate, row.volume ?? "12,345,678", row.open, row.high, row.low, row.close]),
  };
}

function csvRow(date: string, close: string): string {
  return `0050,${date},${close},${close},${close},${close},1000,twse/STOCK_DAY`;
}

async function createV1Root(rows: readonly { date: string; close: string }[]): Promise<{
  readonly root: string;
  readonly csvBytes: Uint8Array;
  readonly provenanceBytes: Uint8Array;
}> {
  const root = await mkdtemp(join(tmpdir(), "mms-0050-refresh-"));
  const csvPath = resolve(root, FORWARD_0050_V1_CSV_PATH);
  const provenancePath = resolve(root, FORWARD_0050_V1_PROVENANCE_PATH);
  await mkdir(join(root, "data/market/forward/0050-forward-v1"), { recursive: true });
  const csv = `${CSV_HEADER}\n${rows.map(({ date, close }) => csvRow(date, close)).join("\n")}\n`;
  const csvBytes = new TextEncoder().encode(csv);
  const sha256 = createHash("sha256").update(csvBytes).digest("hex");
  const provenance = {
    schemaVersion: 1,
    artifactId: "0050-forward-v1",
    symbol: "0050",
    source: "TWSE STOCK_DAY monthly report API",
    fetchedAtUtc: "2026-09-30T05:45:03.047Z",
    dateRange: { start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null },
    rowCount: rows.length,
    sha256,
    historicalCutoff: FORWARD_0050_HISTORICAL_CUTOFF,
    purpose: "FORWARD_EVALUATION_ONLY",
    sourceUrls: [
      "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260801&stockNo=0050",
      SOURCE,
    ],
  };
  const provenanceBytes = new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`);
  await Promise.all([writeFile(csvPath, csvBytes), writeFile(provenancePath, provenanceBytes)]);
  return { root, csvBytes, provenanceBytes };
}

describe("0050 forward snapshot updater", () => {
  it("rechecks September including 9/30, appends only returned dates, and leaves the frozen v1 bytes untouched", async () => {
    const base = await createV1Root([
      { date: "2026-08-12", close: "105.20" },
      { date: "2026-09-29", close: "106.70" },
    ]);
    const requested: string[] = [];
    try {
      const result = await refresh0050ForwardSnapshot({
        root: base.root,
        throughDate: "2026-10-04",
        fetchedAtUtc: "2026-10-04T06:00:00.000Z",
        fetchMonth: async (url) => {
          requested.push(url);
          if (url === twseStockDayUrl("202609")) {
            return twsePayload([
              { rocDate: "115/09/29", open: "106.70", high: "106.70", low: "106.70", close: "106.70", volume: "1000" },
              { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.20" },
              { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.20" },
            ]);
          }
          if (url === twseStockDayUrl("202610")) {
            return twsePayload([
              { rocDate: "115/10/01", open: "107.30", high: "108.00", low: "107.10", close: "107.80" },
              { rocDate: "115/10/02", open: "108.00", high: "108.25", low: "107.50", close: "107.90" },
              { rocDate: "115/10/05", open: "109.00", high: "109.10", low: "108.90", close: "109.00" },
            ]);
          }
          throw new Error(`unexpected URL ${url}`);
        },
      });
      const [v1CsvAfter, v1ProvenanceAfter, v2Csv, v2ProvenanceBytes] = await Promise.all([
        readFile(resolve(base.root, FORWARD_0050_V1_CSV_PATH)),
        readFile(resolve(base.root, FORWARD_0050_V1_PROVENANCE_PATH)),
        readFile(resolve(base.root, FORWARD_0050_V2_CSV_PATH), "utf8"),
        readFile(resolve(base.root, FORWARD_0050_V2_PROVENANCE_PATH), "utf8"),
      ]);
      const provenance = JSON.parse(v2ProvenanceBytes) as Record<string, unknown>;
      const range = provenance["dateRange"] as { start: string; end: string };
      expect(requested).toEqual([twseStockDayUrl("202609"), twseStockDayUrl("202610")]);
      expect(result.newRowCount).toBe(3);
      expect(result.rowCount).toBe(5);
      expect(range).toEqual({ start: "2026-08-12", end: "2026-10-02" });
      expect(v2Csv).toContain("0050,2026-09-30,106.80,107.35,106.60,107.20,12345678,twse/STOCK_DAY");
      expect(v2Csv).toContain("0050,2026-10-02,108.00,108.25,107.50,107.90,12345678,twse/STOCK_DAY");
      expect(v2Csv).not.toContain("2026-10-05");
      expect(sha256(v2Csv)).toBe(result.sha256);
      expect([...v1CsvAfter]).toEqual([...base.csvBytes]);
      expect([...v1ProvenanceAfter]).toEqual([...base.provenanceBytes]);
      expect(provenance["artifactId"]).toBe("0050-forward-v2");
      expect(provenance["historicalCutoff"]).toBe("2026-08-11");
    } finally {
      await rm(base.root, { recursive: true, force: true });
    }
  });

  it("stops on a changed overlapping September value without writing any v2 evidence", async () => {
    const base = await createV1Root([{ date: "2026-09-29", close: "106.70" }]);
    try {
      await expect(refresh0050ForwardSnapshot({
        root: base.root,
        throughDate: "2026-10-04",
        fetchedAtUtc: "2026-10-04T06:00:00.000Z",
        fetchMonth: async (url) => url === twseStockDayUrl("202609")
          ? twsePayload([
              { rocDate: "115/09/29", open: "106.55", high: "107.00", low: "106.15", close: "106.71" },
              { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.20" },
            ])
          : twsePayload([]),
      })).rejects.toThrow("TWSE_SOURCE_CORRECTION: 0050 2026-09-29");
      await expect(readFile(resolve(base.root, FORWARD_0050_V2_CSV_PATH))).rejects.toMatchObject({ code: "ENOENT" });
      expect([...(await readFile(resolve(base.root, FORWARD_0050_V1_CSV_PATH)))]).toEqual([...base.csvBytes]);
    } finally {
      await rm(base.root, { recursive: true, force: true });
    }
  });

  it("can be rerun against v2 and appends only newly available dates", async () => {
    const base = await createV1Root([{ date: "2026-09-29", close: "106.70" }]);
    const october = twsePayload([
      { rocDate: "115/10/01", open: "107.30", high: "108.00", low: "107.10", close: "107.80" },
      { rocDate: "115/10/02", open: "108.00", high: "108.25", low: "107.50", close: "107.90" },
    ]);
    try {
      await refresh0050ForwardSnapshot({
        root: base.root,
        throughDate: "2026-10-04",
        fetchedAtUtc: "2026-10-04T06:00:00.000Z",
        fetchMonth: async (url) => url === twseStockDayUrl("202609")
          ? twsePayload([
              { rocDate: "115/09/29", open: "106.70", high: "106.70", low: "106.70", close: "106.70", volume: "1000" },
              { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.20" },
            ])
          : october,
      });
      const requested: string[] = [];
      const repeated = await refresh0050ForwardSnapshot({
        root: base.root,
        throughDate: "2026-10-04",
        fetchedAtUtc: "2026-10-04T07:00:00.000Z",
        fetchMonth: async (url) => {
          requested.push(url);
          return october;
        },
      });
      expect(requested).toEqual([twseStockDayUrl("202610")]);
      expect(repeated.newRowCount).toBe(0);
      expect(repeated.rowCount).toBe(4);
    } finally {
      await rm(base.root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting duplicate dates and prices that exceed the configured TWD minor unit", () => {
    expect(() => parseTwse0050MonthResponse(twsePayload([
      { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.20" },
      { rocDate: "115/09/30", open: "106.80", high: "107.35", low: "106.60", close: "107.21" },
    ]), "202609", "2026-10-04")).toThrow("TWSE_SOURCE_DUPLICATE_CONFLICT");
    expect(() => parseTwse0050MonthResponse(twsePayload([
      { rocDate: "115/09/30", open: "106.800", high: "107.35", low: "106.60", close: "107.20" },
    ]), "202609", "2026-10-04")).toThrow("at most two decimal places");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

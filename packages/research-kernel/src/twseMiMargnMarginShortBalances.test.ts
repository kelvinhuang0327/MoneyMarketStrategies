import { describe, expect, it } from "vitest";

import {
  parseTwseMiMargnDailyReport,
  parseTwseMiMargnCsvText,
  serializeTwseMiMargnToCsv,
  parseNonNegativeBalanceInteger,
  isMiMargnRecordEligibleForFeatureDate,
  filterEligibleMiMargnRecords,
  isTwseMiMargnNoDataStat,
  TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
  TWSE_MI_MARGN_TARGET_SYMBOL,
  TWSE_MI_MARGN_STRICT_PIT_RULE,
  TWSE_MI_MARGN_NO_DATA_STAT,
  TwseMiMargnQualificationError,
  type TwseMiMargnBalanceRecord,
} from "./twseMiMargnMarginShortBalances.js";

const SECURITY_FIELDS = [
  "代號",
  "名稱",
  "買進",
  "賣出",
  "現金償還",
  "前日餘額",
  "今日餘額",
  "次一營業日限額",
  "買進",
  "賣出",
  "現券償還",
  "前日餘額",
  "今日餘額",
  "次一營業日限額",
  "資券互抵",
  "註記",
];

const SECURITY_GROUPS = [
  { title: "股票", span: 2 },
  { title: "融資", span: 6 },
  { title: "融券", span: 6 },
  { title: "", span: 1 },
  { title: "", span: 1 },
];

const ROW_0056 = [
  "0056",
  "元大高股息",
  "629",
  "299",
  "5",
  "4,100",
  "4,425",
  "3,421,133",
  "135",
  "10",
  "0",
  "370",
  "245",
  "3,421,133",
  "3",
  " ",
];

const ROW_0050 = [
  "0050",
  "元大台灣50",
  "1",
  "1",
  "0",
  "10",
  "10",
  "100",
  "1",
  "1",
  "0",
  "5",
  "5",
  "100",
  "0",
  " ",
];

function officialShapePayload(overrides: Record<string, unknown> = {}) {
  return {
    stat: "OK",
    date: "20250926",
    tables: [
      {
        title: "114年09月26日 信用交易統計",
        fields: ["項目", "買進", "賣出", "現金(券)償還", "前日餘額", "今日餘額"],
        data: [
          ["融資(交易單位)", "1", "1", "0", "100", "100"],
        ],
      },
      {
        title: "114年09月26日 融資融券彙總 (全部)",
        fields: SECURITY_FIELDS,
        groups: SECURITY_GROUPS,
        data: [ROW_0050, ROW_0056],
      },
    ],
    ...overrides,
  };
}

const SAMPLE_RECORD: TwseMiMargnBalanceRecord = Object.freeze({
  tradeDate: "2025-09-26",
  symbol: "0056",
  securityName: "元大高股息",
  marginPurchaseBalance: 4425,
  shortSaleBalance: 245,
  marginPurchasePreviousDayBalance: 4100,
  shortSalePreviousDayBalance: 370,
  sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
  sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
});

const SAMPLE_RECORD_NEXT: TwseMiMargnBalanceRecord = Object.freeze({
  tradeDate: "2025-09-29",
  symbol: "0056",
  securityName: "元大高股息",
  marginPurchaseBalance: 4500,
  shortSaleBalance: 200,
  marginPurchasePreviousDayBalance: 4425,
  shortSalePreviousDayBalance: 245,
  sourceIdentity: TWSE_MI_MARGN_OFFICIAL_SOURCE_IDENTITY,
  sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
});

describe("TWSE MI_MARGN margin/short balance pure kernel", () => {
  it("1. extracts the official 0056 current-day balances from a multi-table payload", () => {
    const record = parseTwseMiMargnDailyReport(officialShapePayload(), {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      expectedTradeDate: "2025-09-26",
    });
    expect(record).toEqual(SAMPLE_RECORD);
  });

  it("2. binds required columns by 融資/融券 group titles and header names, not sole positional indexes", () => {
    const record = parseTwseMiMargnDailyReport(officialShapePayload(), {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(record.marginPurchaseBalance).toBe(4425);
    expect(record.shortSaleBalance).toBe(245);
    expect(record.marginPurchasePreviousDayBalance).toBe(4100);
    expect(record.shortSalePreviousDayBalance).toBe(370);
    expect(record.marginPurchaseBalance).not.toBe(record.shortSaleBalance);
  });

  it("3. normalizes comma-formatted integer balances", () => {
    expect(parseNonNegativeBalanceInteger("4,425", "marginPurchaseBalance", "ctx")).toBe(4425);
    expect(parseNonNegativeBalanceInteger("3,421,133", "limit", "ctx")).toBe(3421133);
    expect(parseNonNegativeBalanceInteger("0", "shortSaleBalance", "ctx")).toBe(0);
    expect(parseNonNegativeBalanceInteger("245", "shortSaleBalance", "ctx")).toBe(245);
  });

  it("4. parses exact current-day 今日餘額 balances from the official-shape 0056 row", () => {
    const record = parseTwseMiMargnDailyReport(officialShapePayload(), {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(record.marginPurchaseBalance).toBe(4425);
    expect(record.shortSaleBalance).toBe(245);
  });

  it("5. rejects duplicate 0056 rows in one official response", () => {
    const payload = officialShapePayload();
    const table = (payload.tables[1] as { data: unknown[] });
    table.data = [ROW_0056, ROW_0056];
    expect(() =>
      parseTwseMiMargnDailyReport(payload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrow(TwseMiMargnQualificationError);
    expect(() =>
      parseTwseMiMargnDailyReport(payload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrow(/DUPLICATE_SYMBOL_ROWS/);
  });

  it("6. rejects malformed, blank, and negative required balances", () => {
    expect(() => parseNonNegativeBalanceInteger("12.5", "marginPurchaseBalance", "ctx")).toThrow(
      /INVALID_NUMERIC_FIELD/,
    );
    expect(() => parseNonNegativeBalanceInteger("N/A", "marginPurchaseBalance", "ctx")).toThrow(
      /INVALID_NUMERIC_FIELD/,
    );
    expect(() => parseNonNegativeBalanceInteger("", "marginPurchaseBalance", "ctx")).toThrow(
      /MISSING_REQUIRED_FIELD/,
    );
    expect(() => parseNonNegativeBalanceInteger("--", "marginPurchaseBalance", "ctx")).toThrow(
      /MISSING_REQUIRED_FIELD/,
    );
    expect(() => parseNonNegativeBalanceInteger("-1", "marginPurchaseBalance", "ctx")).toThrow(
      /INVALID_NUMERIC_FIELD|NEGATIVE_BALANCE_NOT_ALLOWED/,
    );

    const payload = officialShapePayload();
    const table = payload.tables[1] as { data: unknown[][] };
    const bad = [...ROW_0056];
    bad[6] = "abc";
    table.data = [bad];
    expect(() =>
      parseTwseMiMargnDailyReport(payload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrow(/INVALID_NUMERIC_FIELD/);
  });

  it("7. fail-closes when a security table is present but 0056 is absent", () => {
    const payload = officialShapePayload();
    const table = payload.tables[1] as { data: unknown[] };
    table.data = [ROW_0050];
    expect(() =>
      parseTwseMiMargnDailyReport(payload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrow(/ABSENT_SYMBOL_ROW/);
  });

  it("8. rejects structurally malformed responses and unknown schemas", () => {
    expect(() =>
      parseTwseMiMargnDailyReport("not-json", {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
      }),
    ).toThrow(/INVALID_JSON/);

    expect(() =>
      parseTwseMiMargnDailyReport(
        { stat: "OK", date: "20250926", tables: [] },
        { symbol: "0056", sourceRetrievedAt: "2026-08-20T00:00:00.000Z" },
      ),
    ).toThrow(/SOURCE_SCHEMA_UNRESOLVED/);

    expect(() =>
      parseTwseMiMargnDailyReport(
        { stat: TWSE_MI_MARGN_NO_DATA_STAT },
        { symbol: "0056", sourceRetrievedAt: "2026-08-20T00:00:00.000Z" },
      ),
    ).toThrow(/TWSE_REPORT_NOT_OK/);
    expect(isTwseMiMargnNoDataStat(TWSE_MI_MARGN_NO_DATA_STAT)).toBe(true);
  });

  it("9. PIT helper excludes same-day observations", () => {
    expect(isMiMargnRecordEligibleForFeatureDate(SAMPLE_RECORD, "2025-09-26")).toBe(false);
  });

  it("10. PIT helper excludes future-dated observations", () => {
    expect(isMiMargnRecordEligibleForFeatureDate(SAMPLE_RECORD_NEXT, "2025-09-26")).toBe(false);
    const eligible = filterEligibleMiMargnRecords([SAMPLE_RECORD, SAMPLE_RECORD_NEXT], "2025-09-26");
    expect(eligible.map((row) => row.tradeDate)).toEqual([]);
  });

  it("11. PIT helper accepts strictly prior observations", () => {
    expect(isMiMargnRecordEligibleForFeatureDate(SAMPLE_RECORD, "2025-09-30")).toBe(true);
    expect(TWSE_MI_MARGN_STRICT_PIT_RULE).toBe("tradeDate < featureDate");
    const eligible = filterEligibleMiMargnRecords([SAMPLE_RECORD, SAMPLE_RECORD_NEXT], "2025-09-30");
    expect(eligible.map((row) => row.tradeDate)).toEqual(["2025-09-26", "2025-09-29"]);
  });

  it("12. CSV serialization is deterministic and round-trips", () => {
    const records = [SAMPLE_RECORD, SAMPLE_RECORD_NEXT];
    const csv1 = serializeTwseMiMargnToCsv(records);
    const csv2 = serializeTwseMiMargnToCsv(records);
    expect(csv1).toBe(csv2);
    expect(parseTwseMiMargnCsvText(csv1)).toEqual(records);
  });

  it("13. does not mutate the input official-shape payload", () => {
    const payload = officialShapePayload();
    const before = JSON.stringify(payload);
    parseTwseMiMargnDailyReport(payload, {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("14. durable CSV would reject a second symbol if present", () => {
    const csv = [
      "tradeDate,symbol,securityName,marginPurchaseBalance,shortSaleBalance,marginPurchasePreviousDayBalance,shortSalePreviousDayBalance,sourceIdentity,sourceRetrievedAt",
      "2025-09-26,0050,元大台灣50,10,5,9,4,TWSE_MI_MARGN_DAILY_MARGIN_TRADING,2026-08-20T00:00:00.000Z",
    ].join("\n");
    expect(() => parseTwseMiMargnCsvText(csv)).toThrow(/INVALID_SYMBOL/);
    expect(TWSE_MI_MARGN_TARGET_SYMBOL).toBe("0056");
  });
});

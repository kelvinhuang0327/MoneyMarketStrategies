import { describe, expect, it } from "vitest";

import {
  parseTwseMiQfiisDailyReport,
  parseTwseMiQfiisDailyReportMultiSymbol,
  parseTwseMiQfiisCsvText,
  serializeTwseMiQfiisToCsv,
  parseNonNegativeSafeInteger,
  parseNonNegativePercentage,
  isMiQfiisRecordEligibleForFeatureDate,
  filterEligibleMiQfiisRecords,
  isTwseMiQfiisNoDataResponse,
  buildTwseMiQfiisSourceManifest,
  buildTwseMiQfiisMultiSymbolSourceManifest,
  TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
  TWSE_MI_QFIIS_SOURCE_OWNER,
  TWSE_MI_QFIIS_SOURCE_FAMILY,
  TWSE_MI_QFIIS_TARGET_SYMBOL,
  TWSE_MI_QFIIS_SUPPORTED_SYMBOLS,
  TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
  TWSE_MI_QFIIS_STRICT_PIT_RULE,
  TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE,
  TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
  TWSE_MI_QFIIS_SCHEMA_VERSION,
  TWSE_MI_QFIIS_MULTI_SYMBOL_SCHEMA_VERSION,
  TwseMiQfiisQualificationError,
  type TwseMiQfiisRecord,
} from "./twseMiQfiisForeignOwnership.js";

const OFFICIAL_FIELDS = [
  "證券代號",
  "證券名稱",
  "國際證券編碼",
  "發行股數",
  "外資及陸資尚可投資股數",
  "全體外資及陸資持有股數",
  "外資及陸資尚可投資比率",
  "全體外資及陸資持股比率",
  "外資及陸資共用法令投資上限比率",
  "陸資法令投資上限比率",
  "與前日異動原因(註)",
  "最近一次上市公司申報外資及陸資持股異動日期",
];

const ROW_0050 = [
  "0050",
  "元大台灣50",
  "TW0000050004",
  "1,100,000,000",
  "500,000,000",
  "600,000,000",
  45.45,
  54.55,
  "100.00",
  "100.00",
  "",
  "108/07/18",
];

const ROW_0056 = [
  "0056",
  "元大高股息",
  "TW0000056001",
  "1,075,034,000",
  "1,070,921,372",
  "4,112,628",
  99.61,
  0.38,
  "100.00",
  "100.00",
  "",
  "108/07/18",
];

const ROW_2317 = [
  "2317",
  "鴻海",
  "TW0002317005",
  "13,862,990,609",
  "8,000,000,000",
  "5,862,990,609",
  57.7,
  42.29,
  "100.00",
  "100.00",
  "",
  "108/07/18",
];

const ROW_2330 = [
  "2330",
  "台積電",
  "TW0002330008",
  "25,930,380,458",
  "5,000,000,000",
  "20,930,380,458",
  19.28,
  80.71,
  "100.00",
  "100.00",
  "",
  "108/07/18",
];

const ROW_2454 = [
  "2454",
  "聯發科",
  "TW0002454006",
  "1,598,735,744",
  "600,000,000",
  "998,735,744",
  37.53,
  62.47,
  "100.00",
  "100.00",
  "",
  "108/07/18",
];

function officialShapePayload(overrides: Record<string, unknown> = {}) {
  return {
    stat: "OK",
    date: "20200102",
    title: "109年01月02日 外資及陸資投資持股統計",
    fields: OFFICIAL_FIELDS,
    data: [ROW_0050, ROW_0056, ROW_2317, ROW_2330, ROW_2454],
    total: 5,
    ...overrides,
  };
}

describe("twseMiQfiisForeignOwnership", () => {
  describe("Numeric and Ratio Parsers", () => {
    it("parses comma-formatted and plain non-negative safe integers", () => {
      expect(parseNonNegativeSafeInteger("1,075,034,000", "issuedShares", "test")).toBe(1075034000);
      expect(parseNonNegativeSafeInteger("0", "foreignHeldShares", "test")).toBe(0);
      expect(parseNonNegativeSafeInteger(4112628, "foreignHeldShares", "test")).toBe(4112628);
    });

    it("rejects invalid share count numbers", () => {
      expect(() => parseNonNegativeSafeInteger("-10", "shares", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativeSafeInteger("12.34", "shares", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativeSafeInteger("--", "shares", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativeSafeInteger("", "shares", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativeSafeInteger(NaN, "shares", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativeSafeInteger(Infinity, "shares", "test")).toThrow(TwseMiQfiisQualificationError);
    });

    it("exports supported symbols array", () => {
      expect(TWSE_MI_QFIIS_SUPPORTED_SYMBOLS).toEqual(["0050", "0056", "2317", "2330", "2454"]);
    });

    it("parses non-negative percentage floats", () => {
      expect(parseNonNegativePercentage(0.38, "ratio", "test")).toBe(0.38);
      expect(parseNonNegativePercentage("99.61", "ratio", "test")).toBe(99.61);
      expect(parseNonNegativePercentage("100.00", "ratio", "test")).toBe(100);
      expect(parseNonNegativePercentage(0, "ratio", "test")).toBe(0);
    });

    it("rejects invalid percentage values", () => {
      expect(() => parseNonNegativePercentage("-0.5", "ratio", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativePercentage(100.5, "ratio", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativePercentage("150.00", "ratio", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativePercentage("--", "ratio", "test")).toThrow(TwseMiQfiisQualificationError);
      expect(() => parseNonNegativePercentage("abc", "ratio", "test")).toThrow(TwseMiQfiisQualificationError);
    });
  });

  describe("parseTwseMiQfiisDailyReport", () => {
    it("parses top-level official JSON payload for 0056", () => {
      const payload = officialShapePayload();
      const record = parseTwseMiQfiisDailyReport(payload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        expectedTradeDate: "2020-01-02",
      });

      expect(record.tradeDate).toBe("2020-01-02");
      expect(record.symbol).toBe("0056");
      expect(record.securityName).toBe("元大高股息");
      expect(record.issuedShares).toBe(1075034000);
      expect(record.foreignRemainingInvestableShares).toBe(1070921372);
      expect(record.foreignHeldShares).toBe(4112628);
      expect(record.foreignRemainingInvestableRatio).toBe(99.61);
      expect(record.foreignHoldingRatio).toBe(0.38);
      expect(record.statutoryInvestmentLimitRatio).toBe(100.0);
      expect(record.sourceIdentity).toBe(TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY);
      expect(record.sourceRetrievedAt).toBe("2026-08-20T08:00:00.000Z");
    });

    it("parses supported symbol 0050", () => {
      const payload = officialShapePayload();
      const record = parseTwseMiQfiisDailyReport(payload, {
        symbol: "0050",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      });

      expect(record.tradeDate).toBe("2020-01-02");
      expect(record.symbol).toBe("0050");
      expect(record.securityName).toBe("元大台灣50");
      expect(record.issuedShares).toBe(1100000000);
      expect(record.foreignHoldingRatio).toBe(54.55);
    });

    it("parses JSON string payload and multi-table structure", () => {
      const multiTablePayload = {
        stat: "OK",
        date: "115/08/11",
        tables: [
          {
            title: "外資及陸資投資持股統計",
            fields: OFFICIAL_FIELDS,
            data: [ROW_0056],
          },
        ],
      };

      const record = parseTwseMiQfiisDailyReport(JSON.stringify(multiTablePayload), {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      });

      expect(record.tradeDate).toBe("2026-08-11");
      expect(record.symbol).toBe("0056");
      expect(record.securityName).toBe("元大高股息");
    });

    it("fails closed when target symbol is absent from trading-day response", () => {
      const payload = officialShapePayload({ data: [ROW_0050] });
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0056",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/ABSENT_SYMBOL_ROW/);
    });

    it("rejects duplicate symbol rows", () => {
      const payload = officialShapePayload({ data: [ROW_0056, ROW_0056] });
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0056",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/DUPLICATE_SYMBOL_ROWS/);
    });

    it("rejects missing required header / schema drift", () => {
      const corruptedFields = OFFICIAL_FIELDS.filter((f) => f !== "全體外資及陸資持股比率");
      const payload = officialShapePayload({ fields: corruptedFields });
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0056",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/SOURCE_SCHEMA_UNRESOLVED/);
    });

    it("rejects non-OK status", () => {
      const payload = officialShapePayload({ stat: "很抱歉，沒有符合條件的資料" });
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0056",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/TWSE_REPORT_NOT_OK/);
    });

    it("rejects unsupported symbol", () => {
      const payload = officialShapePayload();
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "9999",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/INVALID_SYMBOL/);
    });
  });

  describe("parseTwseMiQfiisDailyReportMultiSymbol", () => {
    it("extracts all four target symbols (0050, 2317, 2330, 2454) from one dated payload", () => {
      const payload = officialShapePayload();
      const records = parseTwseMiQfiisDailyReportMultiSymbol(payload, {
        symbols: TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        expectedTradeDate: "2020-01-02",
      });

      expect(records.length).toBe(4);
      expect(records.map((r) => r.symbol)).toEqual(["0050", "2317", "2330", "2454"]);
      expect(records[0]!.securityName).toBe("元大台灣50");
      expect(records[1]!.securityName).toBe("鴻海");
      expect(records[2]!.securityName).toBe("台積電");
      expect(records[3]!.securityName).toBe("聯發科");
      expect(records[2]!.foreignHoldingRatio).toBe(80.71);
    });

    it("throws ABSENT_SYMBOL_ROW if any required symbol is missing", () => {
      const payload = officialShapePayload({ data: [ROW_0050, ROW_2317, ROW_2330] }); // 2454 missing
      expect(() =>
        parseTwseMiQfiisDailyReportMultiSymbol(payload, {
          symbols: TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/ABSENT_SYMBOL_ROW:2454/);
    });

    it("throws DUPLICATE_SYMBOL_ROWS if a symbol appears more than once", () => {
      const payload = officialShapePayload({
        data: [ROW_0050, ROW_2317, ROW_2330, ROW_2454, ROW_2330],
      });
      expect(() =>
        parseTwseMiQfiisDailyReportMultiSymbol(payload, {
          symbols: TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/DUPLICATE_SYMBOL_ROWS:2330/);
    });
  });

  describe("isTwseMiQfiisNoDataResponse", () => {
    it("recognizes no-data responses accurately", () => {
      expect(isTwseMiQfiisNoDataResponse("很抱歉，沒有符合條件的資料")).toBe(true);
      expect(isTwseMiQfiisNoDataResponse({ stat: "很抱歉，沒有符合條件的資料" })).toBe(true);
      expect(isTwseMiQfiisNoDataResponse({ stat: "OK", total: 0, data: [] })).toBe(true);
      expect(isTwseMiQfiisNoDataResponse({ stat: "OK", total: 100, data: [ROW_0056] })).toBe(false);
    });
  });

  describe("Point-in-Time (PIT) lag-1 contract", () => {
    const record: TwseMiQfiisRecord = {
      tradeDate: "2024-05-15",
      symbol: "2330",
      securityName: "台積電",
      issuedShares: 25930380458,
      foreignHeldShares: 19000000000,
      foreignHoldingRatio: 73.27,
      foreignRemainingInvestableShares: 6930380458,
      foreignRemainingInvestableRatio: 26.73,
      statutoryInvestmentLimitRatio: 100.0,
      sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
      sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
    };

    it("strictly forbids same-day observation use", () => {
      expect(isMiQfiisRecordEligibleForFeatureDate(record, "2024-05-15")).toBe(false);
    });

    it("strictly forbids future-dated observation use", () => {
      expect(isMiQfiisRecordEligibleForFeatureDate(record, "2024-05-14")).toBe(false);
    });

    it("permits prior-day observation use", () => {
      expect(isMiQfiisRecordEligibleForFeatureDate(record, "2024-05-16")).toBe(true);
      expect(isMiQfiisRecordEligibleForFeatureDate(record, "2024-05-20")).toBe(true);
    });

    it("filters lists of records strictly", () => {
      const rec1 = { ...record, tradeDate: "2024-05-14" };
      const rec2 = { ...record, tradeDate: "2024-05-15" };
      const rec3 = { ...record, tradeDate: "2024-05-16" };

      const eligible = filterEligibleMiQfiisRecords([rec1, rec2, rec3], "2024-05-16");
      expect(eligible.map((r) => r.tradeDate)).toEqual(["2024-05-14", "2024-05-15"]);
    });
  });

  describe("CSV Serialization & Parsing", () => {
    const sampleRecords: readonly TwseMiQfiisRecord[] = [
      {
        tradeDate: "2020-01-02",
        symbol: "0050",
        securityName: "元大台灣50",
        issuedShares: 1100000000,
        foreignHeldShares: 600000000,
        foreignHoldingRatio: 54.55,
        foreignRemainingInvestableShares: 500000000,
        foreignRemainingInvestableRatio: 45.45,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
      {
        tradeDate: "2020-01-02",
        symbol: "2330",
        securityName: "台積電",
        issuedShares: 25930380458,
        foreignHeldShares: 20930380458,
        foreignHoldingRatio: 80.71,
        foreignRemainingInvestableShares: 5000000000,
        foreignRemainingInvestableRatio: 19.28,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
      {
        tradeDate: "2020-01-03",
        symbol: "0050",
        securityName: "元大台灣50",
        issuedShares: 1100000000,
        foreignHeldShares: 601000000,
        foreignHoldingRatio: 54.64,
        foreignRemainingInvestableShares: 499000000,
        foreignRemainingInvestableRatio: 45.36,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
    ];

    it("serializes and parses back multi-symbol records identically", () => {
      const csv = serializeTwseMiQfiisToCsv(sampleRecords);
      expect(csv.startsWith("tradeDate,symbol,securityName,issuedShares")).toBe(true);
      expect(csv.endsWith("\n")).toBe(true);

      const parsed = parseTwseMiQfiisCsvText(csv);
      expect(parsed).toEqual(sampleRecords);
    });

    it("rejects duplicate (tradeDate, symbol) natural key in CSV", () => {
      const duplicateCsv = serializeTwseMiQfiisToCsv([sampleRecords[0]!, sampleRecords[0]!]);
      expect(() => parseTwseMiQfiisCsvText(duplicateCsv)).toThrowError(/DUPLICATE_TRADE_DATE/);
    });

    it("rejects out-of-order dates in CSV", () => {
      const outOfOrderCsv =
        "tradeDate,symbol,securityName,issuedShares,foreignHeldShares,foreignHoldingRatio,foreignRemainingInvestableShares,foreignRemainingInvestableRatio,statutoryInvestmentLimitRatio,sourceIdentity,sourceRetrievedAt\n" +
        "2020-01-03,0050,元大台灣50,1100000000,601000000,54.64,499000000,45.36,100,TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT,2026-08-20T08:00:00.000Z\n" +
        "2020-01-02,0050,元大台灣50,1100000000,600000000,54.55,500000000,45.45,100,TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT,2026-08-20T08:00:00.000Z\n";
      expect(() => parseTwseMiQfiisCsvText(outOfOrderCsv)).toThrowError(/OUT_OF_ORDER_RECORDS/);
    });

    it("rejects out-of-order symbol lexical order on same date in CSV", () => {
      const outOfOrderSymbolCsv =
        "tradeDate,symbol,securityName,issuedShares,foreignHeldShares,foreignHoldingRatio,foreignRemainingInvestableShares,foreignRemainingInvestableRatio,statutoryInvestmentLimitRatio,sourceIdentity,sourceRetrievedAt\n" +
        "2020-01-02,2330,台積電,25930380458,20930380458,80.71,5000000000,19.28,100,TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT,2026-08-20T08:00:00.000Z\n" +
        "2020-01-02,0050,元大台灣50,1100000000,600000000,54.55,500000000,45.45,100,TWSE_MI_QFIIS_DAILY_FOREIGN_INVESTMENT,2026-08-20T08:00:00.000Z\n";
      expect(() => parseTwseMiQfiisCsvText(outOfOrderSymbolCsv)).toThrowError(/OUT_OF_ORDER_RECORDS/);
    });
  });

  describe("Single Symbol Manifest Builder (0056)", () => {
    const records: readonly TwseMiQfiisRecord[] = [
      {
        tradeDate: "2020-01-02",
        symbol: "0056",
        securityName: "元大高股息",
        issuedShares: 1075034000,
        foreignHeldShares: 4112628,
        foreignHoldingRatio: 0.38,
        foreignRemainingInvestableShares: 1070921372,
        foreignRemainingInvestableRatio: 99.61,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
      {
        tradeDate: "2026-08-11",
        symbol: "0056",
        securityName: "元大高股息",
        issuedShares: 14286534000,
        foreignHeldShares: 157554387,
        foreignHoldingRatio: 1.1,
        foreignRemainingInvestableShares: 14128979613,
        foreignRemainingInvestableRatio: 98.89,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
    ];

    it("builds qualified manifest when all criteria pass", () => {
      const manifest = buildTwseMiQfiisSourceManifest({
        records,
        requestedStartDate: "2020-01-02",
        requestedEndDate: "2026-08-11",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        csvSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        successfulOfficialResponses: 2,
        nonTradingNoDataDates: 0,
        duplicateTradeDateCount: 0,
        malformedRowCount: 0,
        missing0056ObservationCount: 0,
      });

      expect(manifest.schemaVersion).toBe(TWSE_MI_QFIIS_SCHEMA_VERSION);
      expect(manifest.sourceIdentity).toBe(TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY);
      expect(manifest.sourceOwner).toBe(TWSE_MI_QFIIS_SOURCE_OWNER);
      expect(manifest.sourceFamily).toBe(TWSE_MI_QFIIS_SOURCE_FAMILY);
      expect(manifest.officialQueryPage).toBe(TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE);
      expect(manifest.officialEndpointTemplate).toBe(TWSE_MI_QFIIS_ENDPOINT_TEMPLATE);
      expect(manifest.symbol).toBe(TWSE_MI_QFIIS_TARGET_SYMBOL);
      expect(manifest.pitRule).toBe(TWSE_MI_QFIIS_STRICT_PIT_RULE);
      expect(manifest.sameDayEligibility).toBe(false);
      expect(manifest.exactHistoricalPublicationMinuteUsed).toBe(false);
      expect(manifest.cutoffCoverage.length).toBe(4);
      expect(manifest.qualificationClassification).toBe(
        "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED",
      );
    });

    it("blocks qualification when data quality violations exist", () => {
      const manifest = buildTwseMiQfiisSourceManifest({
        records,
        requestedStartDate: "2020-01-02",
        requestedEndDate: "2026-08-11",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        csvSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        successfulOfficialResponses: 2,
        nonTradingNoDataDates: 0,
        duplicateTradeDateCount: 1,
        malformedRowCount: 0,
        missing0056ObservationCount: 0,
      });

      expect(manifest.qualificationClassification).toBe(
        "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_BLOCKED",
      );
    });
  });

  describe("Multi-Symbol Manifest Builder (0050, 2317, 2330, 2454)", () => {
    function makeMultiSymbolRecords(dates: string[]): TwseMiQfiisRecord[] {
      const symbols = ["0050", "2317", "2330", "2454"];
      const names: Record<string, string> = {
        "0050": "元大台灣50",
        "2317": "鴻海",
        "2330": "台積電",
        "2454": "聯發科",
      };
      const recs: TwseMiQfiisRecord[] = [];
      for (const d of dates) {
        for (const s of symbols) {
          recs.push({
            tradeDate: d,
            symbol: s,
            securityName: names[s]!,
            issuedShares: 1000000,
            foreignHeldShares: 500000,
            foreignHoldingRatio: 50.0,
            foreignRemainingInvestableShares: 500000,
            foreignRemainingInvestableRatio: 50.0,
            statutoryInvestmentLimitRatio: 100.0,
            sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
            sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
          });
        }
      }
      return recs;
    }

    it("qualifies all four symbols when coverage and data quality are complete", () => {
      const dates = [
        "2020-01-02",
        "2025-09-20",
        "2025-12-20",
        "2026-03-20",
        "2026-06-20",
        "2026-08-11",
      ];
      const records = makeMultiSymbolRecords(dates);

      const manifest = buildTwseMiQfiisMultiSymbolSourceManifest({
        records,
        symbols: TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
        requestedStartDate: "2020-01-02",
        requestedEndDate: "2026-08-11",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        csvSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        successfulOfficialResponses: dates.length,
        nonTradingNoDataDates: 0,
        duplicateKeyCount: 0,
        malformedRowCount: 0,
      });

      expect(manifest.schemaVersion).toBe(TWSE_MI_QFIIS_MULTI_SYMBOL_SCHEMA_VERSION);
      expect(manifest.symbols).toEqual(["0050", "2317", "2330", "2454"]);
      expect(manifest.totalRowCount).toBe(dates.length * 4);
      expect(manifest.perSymbolQualifications.length).toBe(4);
      for (const psq of manifest.perSymbolQualifications) {
        expect(psq.qualificationClassification).toBe("MMS_SYMBOL_TWSE_MI_QFIIS_SOURCE_QUALIFIED");
        expect(psq.rowCount).toBe(dates.length);
        expect(psq.duplicateKeyCount).toBe(0);
        expect(psq.malformedRowCount).toBe(0);
        expect(psq.cutoffCoverage.length).toBe(4);
      }
      expect(manifest.overallQualification).toBe("PASS");
      expect(manifest.qualificationClassification).toBe(
        "MMS_MULTI_SYMBOL_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED",
      );
    });

    it("fails overall qualification if even one symbol fails (3/4 PASS = overall FAIL gate)", () => {
      const dates = [
        "2020-01-02",
        "2025-09-20",
        "2025-12-20",
        "2026-03-20",
        "2026-06-20",
        "2026-08-11",
      ];
      // Omit 2454 on 2026-08-11 so 2454 fails end-date coverage
      const allRecords = makeMultiSymbolRecords(dates);
      const recordsWith2454MissingLast = allRecords.filter(
        (r) => !(r.symbol === "2454" && r.tradeDate === "2026-08-11"),
      );

      const manifest = buildTwseMiQfiisMultiSymbolSourceManifest({
        records: recordsWith2454MissingLast,
        symbols: TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
        requestedStartDate: "2020-01-02",
        requestedEndDate: "2026-08-11",
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        csvSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        successfulOfficialResponses: dates.length,
        nonTradingNoDataDates: 0,
        duplicateKeyCount: 0,
        malformedRowCount: 0,
      });

      const sym0050 = manifest.perSymbolQualifications.find((p) => p.symbol === "0050")!;
      const sym2454 = manifest.perSymbolQualifications.find((p) => p.symbol === "2454")!;

      expect(sym0050.qualificationClassification).toBe("MMS_SYMBOL_TWSE_MI_QFIIS_SOURCE_QUALIFIED");
      expect(sym2454.qualificationClassification).toBe("MMS_SYMBOL_TWSE_MI_QFIIS_SOURCE_BLOCKED");
      expect(manifest.overallQualification).toBe("FAIL");
      expect(manifest.qualificationClassification).toBe(
        "MMS_MULTI_SYMBOL_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_BLOCKED",
      );
    });
  });
});

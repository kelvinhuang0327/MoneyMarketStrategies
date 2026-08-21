import { describe, expect, it } from "vitest";

import {
  parseTwseMiQfiisDailyReport,
  parseTwseMiQfiisCsvText,
  serializeTwseMiQfiisToCsv,
  parseNonNegativeSafeInteger,
  parseNonNegativePercentage,
  isMiQfiisRecordEligibleForFeatureDate,
  filterEligibleMiQfiisRecords,
  isTwseMiQfiisNoDataResponse,
  buildTwseMiQfiisSourceManifest,
  TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
  TWSE_MI_QFIIS_SOURCE_OWNER,
  TWSE_MI_QFIIS_SOURCE_FAMILY,
  TWSE_MI_QFIIS_TARGET_SYMBOL,
  TWSE_MI_QFIIS_STRICT_PIT_RULE,
  TWSE_MI_QFIIS_OFFICIAL_QUERY_PAGE,
  TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
  TWSE_MI_QFIIS_SCHEMA_VERSION,
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

function officialShapePayload(overrides: Record<string, unknown> = {}) {
  return {
    stat: "OK",
    date: "20200102",
    title: "109年01月02日 外資及陸資投資持股統計",
    fields: OFFICIAL_FIELDS,
    data: [ROW_0050, ROW_0056],
    total: 2,
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

    it("fails closed when 0056 is absent from trading-day response", () => {
      const payload = officialShapePayload({ data: [ROW_0050] });
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0056",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/ABSENT_SYMBOL_ROW/);
    });

    it("rejects duplicate 0056 rows", () => {
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

    it("rejects requested symbol mismatch", () => {
      const payload = officialShapePayload();
      expect(() =>
        parseTwseMiQfiisDailyReport(payload, {
          symbol: "0050",
          sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
        }),
      ).toThrowError(/INVALID_SYMBOL/);
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
      symbol: "0056",
      securityName: "元大高股息",
      issuedShares: 7300034000,
      foreignHeldShares: 124009535,
      foreignHoldingRatio: 1.69,
      foreignRemainingInvestableShares: 7176024465,
      foreignRemainingInvestableRatio: 98.3,
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
        tradeDate: "2020-01-03",
        symbol: "0056",
        securityName: "元大高股息",
        issuedShares: 1075034000,
        foreignHeldShares: 4150000,
        foreignHoldingRatio: 0.39,
        foreignRemainingInvestableShares: 1070884000,
        foreignRemainingInvestableRatio: 99.61,
        statutoryInvestmentLimitRatio: 100.0,
        sourceIdentity: TWSE_MI_QFIIS_OFFICIAL_SOURCE_IDENTITY,
        sourceRetrievedAt: "2026-08-20T08:00:00.000Z",
      },
    ];

    it("serializes and parses back identically", () => {
      const csv = serializeTwseMiQfiisToCsv(sampleRecords);
      expect(csv.startsWith("tradeDate,symbol,securityName,issuedShares")).toBe(true);
      expect(csv.endsWith("\n")).toBe(true);

      const parsed = parseTwseMiQfiisCsvText(csv);
      expect(parsed).toEqual(sampleRecords);
    });

    it("rejects duplicate tradeDate in CSV", () => {
      const duplicateCsv = serializeTwseMiQfiisToCsv([sampleRecords[0]!, sampleRecords[0]!]);
      expect(() => parseTwseMiQfiisCsvText(duplicateCsv)).toThrowError(/DUPLICATE_TRADE_DATE/);
    });

    it("rejects out-of-order trade dates in CSV", () => {
      const outOfOrderCsv = serializeTwseMiQfiisToCsv([sampleRecords[1]!, sampleRecords[0]!]);
      expect(() => parseTwseMiQfiisCsvText(outOfOrderCsv)).toThrowError(/OUT_OF_ORDER_RECORDS/);
    });
  });

  describe("Manifest Builder", () => {
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
        duplicateTradeDateCount: 1, // Error
        malformedRowCount: 0,
        missing0056ObservationCount: 0,
      });

      expect(manifest.qualificationClassification).toBe(
        "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_BLOCKED",
      );
    });
  });
});

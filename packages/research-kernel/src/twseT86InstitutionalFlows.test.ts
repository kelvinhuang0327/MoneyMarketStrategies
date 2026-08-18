import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseTwseT86DailyReport,
  parseTwseT86CsvText,
  serializeTwseT86ToCsv,
  isT86RecordEligibleForFeatureDate,
  filterEligibleT86Records,
  qualifyTwseT86Records,
  parseIntegerShareCount,
  TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
  TWSE_T86_TARGET_SYMBOL,
  TWSE_T86_STRICT_PIT_RULE,
  TWSE_T86_SCHEMA_VERSION,
  TWSE_T86_FIELD_DEFINITIONS,
  TWSE_T86_REVISION_SEMANTICS,
  TwseT86QualificationError,
  type TwseT86FlowRecord,
} from "./twseT86InstitutionalFlows.js";

const SAMPLE_PAYLOAD = {
  stat: "OK",
  date: "20200102",
  title: "109年01月02日 三大法人買賣超日報",
  fields: [
    "證券代號",
    "證券名稱",
    "外陸資買進股數(不含外資自營商)",
    "外陸資賣出股數(不含外資自營商)",
    "外陸資買賣超股數(不含外資自營商)",
    "外資自營商買進股數",
    "外資自營商賣出股數",
    "外資自營商買賣超股數",
    "投信買進股數",
    "投信賣出股數",
    "投信買賣超股數",
    "自營商買賣超股數",
    "自營商買進股數(自行買賣)",
    "自營商賣出股數(自行買賣)",
    "自營商買賣超股數(自行買賣)",
    "自營商買進股數(避險)",
    "自營商賣出股數(避險)",
    "自營商買賣超股數(避險)",
    "三大法人買賣超股數",
  ],
  data: [
    [
      "0056",
      "元大高股息      ",
      "11,000",
      "30,000",
      "-19,000",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "6,347,000",
      "0",
      "35,000",
      "-35,000",
      "6,382,000",
      "0",
      "6,382,000",
      "6,328,000",
    ],
  ],
};

const SAMPLE_RECORD_20200102: TwseT86FlowRecord = Object.freeze({
  symbol: "0056",
  tradeDate: "2020-01-02",
  foreignBuyShares: 11000,
  foreignSellShares: 30000,
  foreignNetShares: -19000,
  investmentTrustBuyShares: 0,
  investmentTrustSellShares: 0,
  investmentTrustNetShares: 0,
  dealerSelfBuyShares: 0,
  dealerSelfSellShares: 35000,
  dealerSelfNetShares: -35000,
  dealerHedgeBuyShares: 6382000,
  dealerHedgeSellShares: 0,
  dealerHedgeNetShares: 6382000,
  institutionalTotalNetShares: 6328000,
  sourceIdentity: TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
  sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
});

const SAMPLE_RECORD_20200103: TwseT86FlowRecord = Object.freeze({
  symbol: "0056",
  tradeDate: "2020-01-03",
  foreignBuyShares: 4180,
  foreignSellShares: 0,
  foreignNetShares: 4180,
  investmentTrustBuyShares: 50000,
  investmentTrustSellShares: 0,
  investmentTrustNetShares: 50000,
  dealerSelfBuyShares: 0,
  dealerSelfSellShares: 20000,
  dealerSelfNetShares: -20000,
  dealerHedgeBuyShares: 7995000,
  dealerHedgeSellShares: 897000,
  dealerHedgeNetShares: 7098000,
  institutionalTotalNetShares: 7132180,
  sourceIdentity: TWSE_T86_OFFICIAL_SOURCE_IDENTITY,
  sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
});

describe("TWSE T86 Institutional Flows Pure Kernel", () => {
  // 1. deterministic T86 row parsing
  it("1. parses official T86 daily payload deterministically", () => {
    const record = parseTwseT86DailyReport(SAMPLE_PAYLOAD, {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
      expectedTradeDate: "2020-01-02",
    });

    expect(record).toEqual(SAMPLE_RECORD_20200102);
  });

  // 2. comma-formatted integer normalization
  it("2. normalizes comma-formatted integer share counts", () => {
    expect(parseIntegerShareCount("11,000", "test", "context")).toBe(11000);
    expect(parseIntegerShareCount("6,347,000", "test", "context")).toBe(6347000);
    expect(parseIntegerShareCount("-35,000", "test", "context")).toBe(-35000);
    expect(parseIntegerShareCount("0", "test", "context")).toBe(0);
    expect(parseIntegerShareCount("--", "test", "context")).toBe(0);
  });

  // 3. negative net-share values
  it("3. handles negative net-share values correctly", () => {
    const record = parseTwseT86DailyReport(SAMPLE_PAYLOAD, {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
    });

    expect(record.foreignNetShares).toBe(-19000);
    expect(record.dealerSelfNetShares).toBe(-35000);
    expect(record.foreignNetShares).toBe(record.foreignBuyShares - record.foreignSellShares);
    expect(record.dealerSelfNetShares).toBe(record.dealerSelfBuyShares - record.dealerSelfSellShares);
  });

  // 4. dealer self vs hedge fields remain distinct
  it("4. preserves dealer proprietary self trading vs hedge fields distinct", () => {
    const record = parseTwseT86DailyReport(SAMPLE_PAYLOAD, {
      symbol: "0056",
      sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
    });

    expect(record.dealerSelfBuyShares).toBe(0);
    expect(record.dealerSelfSellShares).toBe(35000);
    expect(record.dealerSelfNetShares).toBe(-35000);

    expect(record.dealerHedgeBuyShares).toBe(6382000);
    expect(record.dealerHedgeSellShares).toBe(0);
    expect(record.dealerHedgeNetShares).toBe(6382000);

    expect(record.dealerSelfNetShares).not.toBe(record.dealerHedgeNetShares);
  });

  // 5. duplicate tradeDate rejection
  it("5. rejects duplicate tradeDate in CSV and records", () => {
    const duplicateCsv = [
      "symbol,tradeDate,foreignBuyShares,foreignSellShares,foreignNetShares,investmentTrustBuyShares,investmentTrustSellShares,investmentTrustNetShares,dealerSelfBuyShares,dealerSelfSellShares,dealerSelfNetShares,dealerHedgeBuyShares,dealerHedgeSellShares,dealerHedgeNetShares,institutionalTotalNetShares,sourceIdentity,sourceRetrievedAt",
      "0056,2020-01-02,11000,30000,-19000,0,0,0,0,35000,-35000,6382000,0,6382000,6328000,TWSE_T86_DAILY_INSTITUTIONAL_REPORT,2026-08-18T06:50:00.000Z",
      "0056,2020-01-02,11000,30000,-19000,0,0,0,0,35000,-35000,6382000,0,6382000,6328000,TWSE_T86_DAILY_INSTITUTIONAL_REPORT,2026-08-18T06:50:00.000Z",
    ].join("\n");

    expect(() => parseTwseT86CsvText(duplicateCsv)).toThrow(TwseT86QualificationError);
    expect(() => parseTwseT86CsvText(duplicateCsv)).toThrow(/duplicate trade date/i);
  });

  // 6. malformed row rejection
  it("6. rejects malformed numeric rows and invalid mathematical sums", () => {
    const malformedPayload = {
      stat: "OK",
      date: "20200102",
      fields: SAMPLE_PAYLOAD.fields,
      data: [
        [
          "0056",
          "元大高股息",
          "11,000",
          "30,000",
          "99,999", // Intentional wrong net
          "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
        ],
      ],
    };

    expect(() =>
      parseTwseT86DailyReport(malformedPayload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
      })
    ).toThrow(TwseT86QualificationError);
    expect(() =>
      parseTwseT86DailyReport(malformedPayload, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
      })
    ).toThrow(/foreignNetShares mismatch/i);
  });

  // 7. absent row is not silently converted to zero
  it("7. fails loud when target symbol row is absent from official report", () => {
    const payloadWithout0056 = {
      stat: "OK",
      date: "20200102",
      fields: SAMPLE_PAYLOAD.fields,
      data: [
        [
          "0050",
          "元大台灣50",
          "100,000", "50,000", "50,000",
          "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "50,000",
        ],
      ],
    };

    expect(() =>
      parseTwseT86DailyReport(payloadWithout0056, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
      })
    ).toThrow(TwseT86QualificationError);
    expect(() =>
      parseTwseT86DailyReport(payloadWithout0056, {
        symbol: "0056",
        sourceRetrievedAt: "2026-08-18T06:50:00.000Z",
      })
    ).toThrow(/ABSENT_SYMBOL_ROW/i);
  });

  // 8. strict PIT rule rejects tradeDate == featureDate
  it("8. strict PIT rule rejects same-day observation (tradeDate == featureDate)", () => {
    const record = SAMPLE_RECORD_20200102;
    expect(isT86RecordEligibleForFeatureDate(record, "2020-01-02")).toBe(false);
  });

  // 9. strict PIT rule accepts tradeDate < featureDate
  it("9. strict PIT rule accepts strictly prior observation (tradeDate < featureDate)", () => {
    const record = SAMPLE_RECORD_20200102;
    expect(isT86RecordEligibleForFeatureDate(record, "2020-01-03")).toBe(true);
    expect(isT86RecordEligibleForFeatureDate(record, "2025-09-30")).toBe(true);
  });

  // 10. future rows cannot alter earlier eligibility
  it("10. future rows cannot alter earlier eligibility", () => {
    const records = [SAMPLE_RECORD_20200102, SAMPLE_RECORD_20200103];
    const eligibleAt0103BeforeFuture = filterEligibleT86Records([SAMPLE_RECORD_20200102], "2020-01-03");
    const eligibleAt0103WithFuture = filterEligibleT86Records(records, "2020-01-03");

    expect(eligibleAt0103BeforeFuture).toEqual(eligibleAt0103WithFuture);
    expect(eligibleAt0103WithFuture.map((r) => r.tradeDate)).toEqual(["2020-01-02"]);
  });

  // 11. deterministic CSV serialization
  it("11. produces deterministic CSV serialization and round-trip parsing", () => {
    const records = [SAMPLE_RECORD_20200102, SAMPLE_RECORD_20200103];
    const csv1 = serializeTwseT86ToCsv(records);
    const csv2 = serializeTwseT86ToCsv(records);
    expect(csv1).toBe(csv2);

    const parsed = parseTwseT86CsvText(csv1);
    expect(parsed).toEqual(records);
  });

  // 12. manifest SHA matches CSV
  it("12. verifies committed canonical CSV and manifest SHA integrity", () => {
    const csvPath = path.resolve("outputs/retraining/p196_0056_twse_t86_institutional_flows.csv");
    const manifestPath = path.resolve("outputs/retraining/p196_0056_twse_t86_institutional_flows.manifest.json");

    if (fs.existsSync(csvPath) && fs.existsSync(manifestPath)) {
      const csvBuffer = fs.readFileSync(csvPath);
      const csvSha = crypto.createHash("sha256").update(csvBuffer).digest("hex");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      expect(manifest.csvSha256).toBe(csvSha);
      expect(manifest.rowCount).toBe(1604);
      expect(manifest.qualificationClassification).toBe("MMS_0056_T86_PIT_SOURCE_QUALIFIED");
      expect(manifest.strictPitRule).toBe("tradeDate < featureDate");
      expect(manifest.targetSymbol).toBe("0056");
      expect(manifest.requiredDateInterval).toEqual({
        start: "2020-01-02",
        end: "2026-08-11",
      });

      const parsedCsv = parseTwseT86CsvText(csvBuffer.toString("utf8"));
      expect(parsedCsv.length).toBe(1604);
      expect(parsedCsv[0]!.tradeDate).toBe("2020-01-02");
      expect(parsedCsv[1603]!.tradeDate).toBe("2026-08-11");
    }
  });

  it("13. rejects out-of-order records in CSV parsing", () => {
    const outOfOrderRecords = [SAMPLE_RECORD_20200103, SAMPLE_RECORD_20200102];
    const csv = serializeTwseT86ToCsv(outOfOrderRecords);

    expect(() => parseTwseT86CsvText(csv)).toThrow(TwseT86QualificationError);
    expect(() => parseTwseT86CsvText(csv)).toThrow(/OUT_OF_ORDER_RECORDS/i);
  });

  it("14. qualifyTwseT86Records correctly qualifies 100% complete dataset", () => {
    const calendar = ["2020-01-02", "2020-01-03"];
    const records = [SAMPLE_RECORD_20200102, SAMPLE_RECORD_20200103];

    const result = qualifyTwseT86Records(records, calendar, ["2020-01-03"], 1);
    expect(result.qualificationClassification).toBe("MMS_0056_T86_PIT_SOURCE_QUALIFIED");
    expect(result.missingTradingDates).toBe(0);
    expect(result.duplicateDates).toBe(0);
    expect(result.chronologicalOrdering).toBe("PASS");
    expect(result.temporalContextCoverage["2020-01-03"]?.passed).toBe(true);
  });

  it("15. qualifyTwseT86Records blocks on missing trading dates", () => {
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06"];
    const records = [SAMPLE_RECORD_20200102, SAMPLE_RECORD_20200103]; // missing 2020-01-06

    const result = qualifyTwseT86Records(records, calendar, ["2020-01-06"], 1);
    expect(result.qualificationClassification).toBe("MMS_0056_T86_PIT_SOURCE_BLOCKED");
    expect(result.missingTradingDates).toBe(1);
  });

  it("16. exports canonical constants matching specification", () => {
    expect(TWSE_T86_OFFICIAL_SOURCE_IDENTITY).toBe("TWSE_T86_DAILY_INSTITUTIONAL_REPORT");
    expect(TWSE_T86_TARGET_SYMBOL).toBe("0056");
    expect(TWSE_T86_STRICT_PIT_RULE).toBe("tradeDate < featureDate");
    expect(TWSE_T86_SCHEMA_VERSION).toBe("MMS_0056_TWSE_T86_INSTITUTIONAL_FLOWS_MANIFEST_V1");
    expect(Object.keys(TWSE_T86_FIELD_DEFINITIONS).length).toBe(17);
    expect(TWSE_T86_REVISION_SEMANTICS).toContain("original transaction activity");
  });
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORWARD_0050_V2_CSV_PATH,
  FORWARD_0050_V2_PROVENANCE_PATH,
} from "./forward0050DataUpdater.js";
import {
  FORWARD_EVALUATION_OUTPUT_PATH,
  FORWARD_EVALUATION_V2_OUTPUT_PATH,
  WIN_RATE_V2_ARTIFACT_PATH,
  runForwardWinRateEvaluationV2Files,
} from "./forwardWinRateEvaluator.js";

const HEADER = "symbol,date,open,high,low,close,volume,source";
const V1_REPORT_SENTINEL = "untouched-v1-report\n";

describe("0050 forward evaluation v2 file runner", () => {
  it("evaluates the isolated v2 snapshot and leaves the v1 report untouched", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mms-0050-eval-v2-"));
    try {
      const csvPath = resolve(root, FORWARD_0050_V2_CSV_PATH);
      const provenancePath = resolve(root, FORWARD_0050_V2_PROVENANCE_PATH);
      const optimizerPath = resolve(root, WIN_RATE_V2_ARTIFACT_PATH);
      const v1ReportPath = resolve(root, FORWARD_EVALUATION_OUTPUT_PATH);
      const v2ReportPath = resolve(root, FORWARD_EVALUATION_V2_OUTPUT_PATH);
      await mkdir(resolve(root, "packages/paper-trading"), { recursive: true });
      await mkdir(resolve(root, "data/market/forward/0050-forward-v2"), { recursive: true });
      const frozenBytes = await readFile(resolve(process.cwd(), WIN_RATE_V2_ARTIFACT_PATH));
      await writeFile(optimizerPath, frozenBytes);
      await writeFile(v1ReportPath, V1_REPORT_SENTINEL);
      const csv = `${HEADER}\n0050,2026-09-29,106.55,107.00,106.15,106.70,1000,twse/STOCK_DAY\n0050,2026-09-30,106.80,107.35,106.60,107.20,1000,twse/STOCK_DAY\n`;
      const csvBytes = new TextEncoder().encode(csv);
      const provenance = {
        schemaVersion: 1,
        artifactId: "0050-forward-v2",
        symbol: "0050",
        source: "TWSE STOCK_DAY monthly report API",
        fetchedAtUtc: "2026-10-04T06:00:00.000Z",
        dateRange: { start: "2026-09-29", end: "2026-09-30" },
        rowCount: 2,
        sha256: createHash("sha256").update(csvBytes).digest("hex"),
        historicalCutoff: "2026-08-11",
        purpose: "FORWARD_EVALUATION_ONLY",
        sourceUrls: ["https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo=0050"],
      };
      await Promise.all([
        writeFile(csvPath, csvBytes),
        writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`),
      ]);

      const result = await runForwardWinRateEvaluationV2Files(root);
      const output = JSON.parse(await readFile(v2ReportPath, "utf8")) as Record<string, unknown>;
      expect(result.forwardDataArtifactId).toBe("0050-forward-v2");
      expect(result.freshDataSha256).toBe(provenance.sha256);
      expect(result.promotionStatus).toBe("INSUFFICIENT_FRESH_TRADES");
      expect(result.champion.rawNetWinRate).toBeNull();
      expect(result.challenger.rawNetWinRate).toBeNull();
      expect(output["forwardDataArtifactId"]).toBe("0050-forward-v2");
      expect(await readFile(v1ReportPath, "utf8")).toBe(V1_REPORT_SENTINEL);
      expect([...(await readFile(resolve(root, FORWARD_0050_V2_CSV_PATH)))]).toEqual([...csvBytes]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

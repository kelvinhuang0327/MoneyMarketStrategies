#!/usr/bin/env node
/**
 * Bounded TWSE MI_QFIIS acquisition for 0056 only.
 * official dated JSON → normalize 0056 → deterministic CSV + manifest.
 * Not a generic crawler, daemon, or scheduler.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTwseMiQfiisSourceManifest,
  isTwseMiQfiisNoDataResponse,
  parseTwseMiQfiisDailyReport,
  serializeTwseMiQfiisToCsv,
  TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
  TWSE_MI_QFIIS_TARGET_SYMBOL,
  TwseMiQfiisQualificationError,
} from "@mms/research-kernel";

const START_DATE = "2020-01-02";
const END_DATE = "2026-08-11";
const PACE_MS = 4000;
const BATCH_SIZE = 30;
const BATCH_REST_MS = 35000;
const MAX_RETRIES = 10;
const WAF_COOLDOWN_MS = 1800000; // 30 minutes full quiet cooldown if WAF encountered
const REQUEST_TIMEOUT_MS = 45000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = path.join(repoRoot, "outputs/retraining/p198_0056_twse_mi_qfiis_foreign_ownership.csv");
const manifestPath = path.join(
  repoRoot,
  "outputs/retraining/p198_0056_twse_mi_qfiis_foreign_ownership.manifest.json",
);
const checkpointPath = process.env.MMS_MI_QFIIS_CHECKPOINT ?? "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoToYyyymmdd(iso) {
  return iso.replaceAll("-", "");
}

function nextIsoDate(iso) {
  const utc = Date.parse(`${iso}T12:00:00.000Z`);
  const next = new Date(utc + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

function isWeekend(iso) {
  const day = new Date(`${iso}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function eachCalendarDate(start, end) {
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = nextIsoDate(cursor)) {
    dates.push(cursor);
  }
  return dates;
}

function endpointFor(isoDate) {
  return TWSE_MI_QFIIS_ENDPOINT_TEMPLATE.replace("YYYYMMDD", isoToYyyymmdd(isoDate));
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`TIMEOUT:${url}`)), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 307 || response.status === 429 || response.status === 503) {
        throw new Error(`WAF_RATE_LIMIT_${response.status}:${url}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}:${url}`);
      }
      const text = await response.text();
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        if (trimmed.includes("SECURITY REASONS") || trimmed.includes("安全性考量")) {
          throw new Error(`WAF_RATE_LIMIT_BODY:${url}`);
        }
        throw new Error(`NON_JSON_BODY:${url}:prefix=${trimmed.slice(0, 80)}`);
      }
      return text;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      const message = String(error?.message ?? error);
      const isWaf =
        message.includes("WAF_RATE_LIMIT") ||
        message.includes("307") ||
        message.includes("429") ||
        message.includes("SECURITY REASONS");
      const delay = isWaf ? WAF_COOLDOWN_MS : 8000 * attempt;
      console.warn(
        JSON.stringify({
          retry: attempt,
          maxRetries: MAX_RETRIES,
          delayMs: delay,
          reason: isWaf ? "WAF_COOLDOWN" : "NETWORK_RETRY",
          error: message,
        }),
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

async function main() {
  const sourceRetrievedAt = new Date().toISOString();
  const allDates = eachCalendarDate(START_DATE, END_DATE);
  const requestDates = allDates.filter((iso) => !isWeekend(iso));

  let records = [];
  let successfulOfficialResponses = 0;
  let nonTradingNoDataDates = 0;
  let malformedRowCount = 0;
  let missing0056ObservationCount = 0;
  let duplicateTradeDateCount = 0;
  let resumeAfter = "";
  if (checkpointPath && existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (checkpoint.requestedStartDate === START_DATE && checkpoint.requestedEndDate === END_DATE) {
      records = checkpoint.records;
      successfulOfficialResponses = checkpoint.successfulOfficialResponses;
      nonTradingNoDataDates = checkpoint.nonTradingNoDataDates;
      resumeAfter = checkpoint.lastCompletedDate ?? "";
    }
  }

  function writeCheckpoint(lastCompletedDate) {
    if (!checkpointPath) return;
    mkdirSync(path.dirname(checkpointPath), { recursive: true });
    writeFileSync(
      checkpointPath,
      JSON.stringify({
        requestedStartDate: START_DATE,
        requestedEndDate: END_DATE,
        lastCompletedDate,
        records,
        successfulOfficialResponses,
        nonTradingNoDataDates,
      }),
    );
  }

  console.log(
    JSON.stringify({
      phase: "start",
      endpointTemplate: TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
      symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
      requestedStartDate: START_DATE,
      requestedEndDate: END_DATE,
      weekdayRequestCount: requestDates.length,
      resumingAfter: resumeAfter || "NONE",
      paceMs: PACE_MS,
      batchSize: BATCH_SIZE,
      batchRestMs: BATCH_REST_MS,
    }),
  );

  let batchCount = 0;
  for (let i = 0; i < requestDates.length; i += 1) {
    const iso = requestDates[i];
    if (resumeAfter && iso <= resumeAfter) continue;
    const url = endpointFor(iso);
    const body = await fetchWithRetry(url);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      malformedRowCount += 1;
      throw new Error(`INVALID_JSON:${iso}`);
    }

    if (isTwseMiQfiisNoDataResponse(payload)) {
      nonTradingNoDataDates += 1;
    } else if (payload.stat !== "OK") {
      malformedRowCount += 1;
      throw new Error(`TWSE_REPORT_NOT_OK:${iso}:${String(payload.stat)}`);
    } else {
      try {
        const record = parseTwseMiQfiisDailyReport(payload, {
          symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
          sourceRetrievedAt,
          expectedTradeDate: iso,
        });
        records.push(record);
        successfulOfficialResponses += 1;
      } catch (error) {
        if (error instanceof TwseMiQfiisQualificationError && error.code === "ABSENT_SYMBOL_ROW") {
          missing0056ObservationCount += 1;
          throw error;
        }
        if (error instanceof TwseMiQfiisQualificationError && error.code === "DUPLICATE_SYMBOL_ROWS") {
          duplicateTradeDateCount += 1;
          throw error;
        }
        malformedRowCount += 1;
        throw error;
      }
    }

    writeCheckpoint(iso);
    batchCount += 1;

    if (batchCount % BATCH_SIZE === 0) {
      console.log(
        JSON.stringify({
          phase: "batch_rest",
          completed: i + 1,
          total: requestDates.length,
          normalized0056Rows: records.length,
          nonTradingNoDataDates,
          restingMs: BATCH_REST_MS,
        }),
      );
      await sleep(BATCH_REST_MS);
    } else if (i + 1 < requestDates.length) {
      await sleep(PACE_MS);
    }
  }

  records.sort((left, right) => (left.tradeDate < right.tradeDate ? -1 : left.tradeDate > right.tradeDate ? 1 : 0));
  records = records.map((record) => ({ ...record, sourceRetrievedAt }));
  const csvText = serializeTwseMiQfiisToCsv(records);
  const csvSha256 = createHash("sha256").update(csvText, "utf8").digest("hex");
  const manifest = buildTwseMiQfiisSourceManifest({
    records,
    requestedStartDate: START_DATE,
    requestedEndDate: END_DATE,
    sourceRetrievedAt,
    csvSha256,
    successfulOfficialResponses,
    nonTradingNoDataDates,
    duplicateTradeDateCount,
    malformedRowCount,
    missing0056ObservationCount,
  });

  mkdirSync(path.dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csvText, "utf8");
  writeFileSync(`${manifestPath}`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        phase: "done",
        csvPath,
        manifestPath,
        rowCount: records.length,
        earliestObservedDate: manifest.earliestObservedDate,
        latestObservedDate: manifest.latestObservedDate,
        csvSha256,
        qualificationClassification: manifest.qualificationClassification,
        cutoffCoverage: manifest.cutoffCoverage,
        successfulOfficialResponses,
        nonTradingNoDataDates,
        missing0056ObservationCount,
        malformedRowCount,
      },
      null,
      2,
    ),
  );

  if (manifest.qualificationClassification !== "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

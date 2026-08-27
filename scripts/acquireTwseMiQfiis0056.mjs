#!/usr/bin/env node
/**
 * Bounded TWSE MI_QFIIS acquisition for qualified symbols.
 * Supports:
 * - Multi-symbol p199: 0050, 2317, 2330, 2454 (default or --multi)
 * - Single-symbol p198: 0056 (--symbol 0056 or --p198)
 *
 * Official dated JSON → local untracked raw cache → deterministic CSV + manifest.
 * Not a generic crawler, daemon, or scheduler.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTwseMiQfiisMultiSymbolSourceManifest,
  buildTwseMiQfiisSourceManifest,
  isTwseMiQfiisNoDataResponse,
  parseTwseMiQfiisDailyReport,
  parseTwseMiQfiisDailyReportMultiSymbol,
  serializeTwseMiQfiisToCsv,
  TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
  TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS,
  TWSE_MI_QFIIS_TARGET_SYMBOL,
  TwseMiQfiisQualificationError,
} from "@mms/research-kernel";

const START_DATE = "2020-01-02";
const END_DATE = "2026-08-11";
const PACE_MS = 3500;
const BATCH_SIZE = 30;
const BATCH_REST_MS = 25000;
const MAX_RETRIES = 10;
const WAF_COOLDOWN_MS = 1800000; // 30 minutes full quiet cooldown if WAF encountered
const REQUEST_TIMEOUT_MS = 45000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawCacheDir = path.join(repoRoot, "outputs/.rawcache/mi-qfiis");

const args = process.argv.slice(2);
const isP198Single = args.includes("--symbol") && args.includes("0056") || args.includes("--p198");

const targetSymbols = isP198Single ? [TWSE_MI_QFIIS_TARGET_SYMBOL] : [...TWSE_MI_QFIIS_MULTI_SYMBOL_TARGETS];

const csvPath = isP198Single
  ? path.join(repoRoot, "outputs/retraining/p198_0056_twse_mi_qfiis_foreign_ownership.csv")
  : path.join(repoRoot, "outputs/retraining/p199_0050_2317_2330_2454_twse_mi_qfiis_foreign_ownership.csv");

const manifestPath = isP198Single
  ? path.join(repoRoot, "outputs/retraining/p198_0056_twse_mi_qfiis_foreign_ownership.manifest.json")
  : path.join(repoRoot, "outputs/retraining/p199_0050_2317_2330_2454_twse_mi_qfiis_foreign_ownership.manifest.json");

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
  mkdirSync(rawCacheDir, { recursive: true });

  const allDates = eachCalendarDate(START_DATE, END_DATE);
  const requestDates = allDates.filter((iso) => !isWeekend(iso));

  let records = [];
  let successfulOfficialResponses = 0;
  let nonTradingNoDataDates = 0;
  let malformedRowCount = 0;
  let duplicateKeyCount = 0;
  const missingObservationsBySymbol = {};
  for (const s of targetSymbols) {
    missingObservationsBySymbol[s] = 0;
  }

  console.log(
    JSON.stringify({
      phase: "start",
      mode: isP198Single ? "p198_single_0056" : "p199_multi_symbol",
      endpointTemplate: TWSE_MI_QFIIS_ENDPOINT_TEMPLATE,
      symbols: targetSymbols,
      requestedStartDate: START_DATE,
      requestedEndDate: END_DATE,
      weekdayRequestCount: requestDates.length,
      rawCacheDir,
      paceMs: PACE_MS,
      batchSize: BATCH_SIZE,
      batchRestMs: BATCH_REST_MS,
    }),
  );

  let networkRequestsCount = 0;
  let cachedRequestsCount = 0;

  for (let i = 0; i < requestDates.length; i += 1) {
    const iso = requestDates[i];
    const yyyymmdd = isoToYyyymmdd(iso);
    const cacheFilePath = path.join(rawCacheDir, `${yyyymmdd}.json`);

    let body = "";
    let fromCache = false;

    if (existsSync(cacheFilePath)) {
      body = readFileSync(cacheFilePath, "utf8");
      fromCache = true;
      cachedRequestsCount += 1;
    } else {
      const url = endpointFor(iso);
      body = await fetchWithRetry(url);
      writeFileSync(cacheFilePath, body, "utf8");
      networkRequestsCount += 1;
    }

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
        if (isP198Single) {
          const record = parseTwseMiQfiisDailyReport(payload, {
            symbol: TWSE_MI_QFIIS_TARGET_SYMBOL,
            sourceRetrievedAt,
            expectedTradeDate: iso,
          });
          records.push(record);
          successfulOfficialResponses += 1;
        } else {
          const symRecords = parseTwseMiQfiisDailyReportMultiSymbol(payload, {
            symbols: targetSymbols,
            sourceRetrievedAt,
            expectedTradeDate: iso,
          });
          records.push(...symRecords);
          successfulOfficialResponses += 1;
        }
      } catch (error) {
        if (error instanceof TwseMiQfiisQualificationError && error.code === "ABSENT_SYMBOL_ROW") {
          for (const s of targetSymbols) {
            if (error.message.includes(s)) {
              missingObservationsBySymbol[s] = (missingObservationsBySymbol[s] ?? 0) + 1;
            }
          }
          throw error;
        }
        if (error instanceof TwseMiQfiisQualificationError && error.code === "DUPLICATE_SYMBOL_ROWS") {
          duplicateKeyCount += 1;
          throw error;
        }
        malformedRowCount += 1;
        throw error;
      }
    }

    if (!fromCache) {
      if (networkRequestsCount % BATCH_SIZE === 0) {
        console.log(
          JSON.stringify({
            phase: "batch_rest",
            completed: i + 1,
            total: requestDates.length,
            networkRequests: networkRequestsCount,
            cachedRequests: cachedRequestsCount,
            normalizedRows: records.length,
            successfulOfficialResponses,
            nonTradingNoDataDates,
            restingMs: BATCH_REST_MS,
          }),
        );
        await sleep(BATCH_REST_MS);
      } else {
        await sleep(PACE_MS);
      }
    } else if ((i + 1) % 200 === 0 || i + 1 === requestDates.length) {
      console.log(
        JSON.stringify({
          phase: "cache_replay_progress",
          completed: i + 1,
          total: requestDates.length,
          cachedRequests: cachedRequestsCount,
          networkRequests: networkRequestsCount,
          normalizedRows: records.length,
          successfulOfficialResponses,
          nonTradingNoDataDates,
        }),
      );
    }
  }

  // Deterministic sort: tradeDate ASC, then symbol ASC
  records.sort((left, right) => {
    if (left.tradeDate !== right.tradeDate) {
      return left.tradeDate < right.tradeDate ? -1 : 1;
    }
    return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
  });

  records = records.map((record) => ({ ...record, sourceRetrievedAt }));
  const csvText = serializeTwseMiQfiisToCsv(records);
  const csvSha256 = createHash("sha256").update(csvText, "utf8").digest("hex");

  let manifest;
  if (isP198Single) {
    manifest = buildTwseMiQfiisSourceManifest({
      records,
      requestedStartDate: START_DATE,
      requestedEndDate: END_DATE,
      sourceRetrievedAt,
      csvSha256,
      successfulOfficialResponses,
      nonTradingNoDataDates,
      duplicateTradeDateCount: duplicateKeyCount,
      malformedRowCount,
      missing0056ObservationCount: missingObservationsBySymbol["0056"] ?? 0,
    });
  } else {
    manifest = buildTwseMiQfiisMultiSymbolSourceManifest({
      records,
      symbols: targetSymbols,
      requestedStartDate: START_DATE,
      requestedEndDate: END_DATE,
      sourceRetrievedAt,
      csvSha256,
      successfulOfficialResponses,
      nonTradingNoDataDates,
      duplicateKeyCount,
      malformedRowCount,
      missingSymbolObservationsBySymbol: missingObservationsBySymbol,
    });
  }

  mkdirSync(path.dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csvText, "utf8");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        phase: "done",
        csvPath,
        manifestPath,
        totalRowCount: records.length,
        earliestObservedDate: manifest.earliestObservedDate,
        latestObservedDate: manifest.latestObservedDate,
        csvSha256,
        qualificationClassification: manifest.qualificationClassification,
        overallQualification: manifest.overallQualification ?? (manifest.qualificationClassification.includes("QUALIFIED") ? "PASS" : "FAIL"),
        successfulOfficialResponses,
        nonTradingNoDataDates,
        duplicateKeyCount,
        malformedRowCount,
        cachedRequestsCount,
        networkRequestsCount,
        perSymbolQualifications: manifest.perSymbolQualifications,
      },
      null,
      2,
    ),
  );

  if (
    manifest.qualificationClassification !== "MMS_0056_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED" &&
    manifest.qualificationClassification !== "MMS_MULTI_SYMBOL_TWSE_MI_QFIIS_FOREIGN_OWNERSHIP_SOURCE_QUALIFIED"
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

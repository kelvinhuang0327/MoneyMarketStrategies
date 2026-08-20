#!/usr/bin/env node
/**
 * Bounded TWSE MI_MARGN acquisition for 0056 only.
 * official dated JSON → normalize 0056 → deterministic CSV + manifest.
 * Not a generic crawler, daemon, or scheduler.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTwseMiMargnSourceManifest,
  isTwseMiMargnNoDataStat,
  parseTwseMiMargnDailyReport,
  serializeTwseMiMargnToCsv,
  TWSE_MI_MARGN_ENDPOINT_TEMPLATE,
  TWSE_MI_MARGN_TARGET_SYMBOL,
  TwseMiMargnQualificationError,
} from "@mms/research-kernel";

const START_DATE = "2020-01-02";
const END_DATE = "2026-08-11";
const PACE_MS = 400;
const MAX_RETRIES = 8;
const REQUEST_TIMEOUT_MS = 45000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = path.join(repoRoot, "outputs/retraining/p197_0056_twse_mi_margn_margin_short_balances.csv");
const manifestPath = path.join(
  repoRoot,
  "outputs/retraining/p197_0056_twse_mi_margn_margin_short_balances.manifest.json",
);
const checkpointPath = process.env.MMS_MI_MARGN_CHECKPOINT ?? "";

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
  return TWSE_MI_MARGN_ENDPOINT_TEMPLATE.replace("YYYYMMDD", isoToYyyymmdd(isoDate));
}

function fetchText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "MoneyMarketStrategies-MI_MARGN-qualification/1.0",
          Accept: "application/json",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (response.headers.location) {
            if (redirectCount >= 5) {
              reject(new Error(`REDIRECT_LIMIT:${url}`));
              return;
            }
            const nextUrl = new URL(response.headers.location, url).toString();
            resolve(fetchText(nextUrl, redirectCount + 1));
            return;
          }
          reject(new Error(`RATE_LIMIT_${status}:${url}`));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (status === 429 || status === 503) {
            reject(new Error(`RATE_LIMIT_${status}:${url}`));
            return;
          }
          if (status !== 200) {
            reject(new Error(`HTTP_${status}:${url}`));
            return;
          }
          resolve(body);
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`TIMEOUT:${url}`));
    });
    request.on("error", reject);
  });
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const body = await fetchText(url);
      const trimmed = body.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        throw new Error(`NON_JSON_BODY:${url}:prefix=${trimmed.slice(0, 80)}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      const message = String(error?.message ?? error);
      const delay = message.includes("RATE_LIMIT") ? 8000 * attempt : 1500 * 2 ** (attempt - 1);
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
  let missingSymbolObservationCount = 0;
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
      endpointTemplate: TWSE_MI_MARGN_ENDPOINT_TEMPLATE,
      symbol: TWSE_MI_MARGN_TARGET_SYMBOL,
      requestedStartDate: START_DATE,
      requestedEndDate: END_DATE,
      weekdayRequestCount: requestDates.length,
    }),
  );

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

    if (isTwseMiMargnNoDataStat(payload.stat) || payload.stat !== "OK") {
      if (isTwseMiMargnNoDataStat(payload.stat)) {
        nonTradingNoDataDates += 1;
      } else {
        malformedRowCount += 1;
        throw new Error(`TWSE_REPORT_NOT_OK:${iso}:${String(payload.stat)}`);
      }
    } else {
      try {
        const record = parseTwseMiMargnDailyReport(payload, {
          symbol: TWSE_MI_MARGN_TARGET_SYMBOL,
          sourceRetrievedAt,
          expectedTradeDate: iso,
        });
        records.push(record);
        successfulOfficialResponses += 1;
      } catch (error) {
        if (error instanceof TwseMiMargnQualificationError && error.code === "ABSENT_SYMBOL_ROW") {
          missingSymbolObservationCount += 1;
          throw error;
        }
        if (error instanceof TwseMiMargnQualificationError && error.code === "DUPLICATE_SYMBOL_ROWS") {
          duplicateTradeDateCount += 1;
          throw error;
        }
        malformedRowCount += 1;
        throw error;
      }
    }

    if ((i + 1) % 10 === 0 || i + 1 === requestDates.length) {
      writeCheckpoint(iso);
    }
    if ((i + 1) % 50 === 0 || i + 1 === requestDates.length) {
      console.log(
        JSON.stringify({
          phase: "progress",
          completed: i + 1,
          total: requestDates.length,
          normalized0056Rows: records.length,
          nonTradingNoDataDates,
        }),
      );
    }

    if (i + 1 < requestDates.length) await sleep(PACE_MS);
  }

  records.sort((left, right) => (left.tradeDate < right.tradeDate ? -1 : left.tradeDate > right.tradeDate ? 1 : 0));
  records = records.map((record) => ({ ...record, sourceRetrievedAt }));
  const csvText = serializeTwseMiMargnToCsv(records);
  const csvSha256 = createHash("sha256").update(csvText, "utf8").digest("hex");
  const manifest = buildTwseMiMargnSourceManifest({
    records,
    requestedStartDate: START_DATE,
    requestedEndDate: END_DATE,
    sourceRetrievedAt,
    csvSha256,
    successfulOfficialResponses,
    nonTradingNoDataDates,
    duplicateTradeDateCount,
    malformedRowCount,
    missingSymbolObservationCount,
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
        missingSymbolObservationCount,
        malformedRowCount,
      },
      null,
      2,
    ),
  );

  if (manifest.qualificationClassification !== "MMS_0056_TWSE_MI_MARGN_MARGIN_SHORT_BALANCE_SOURCE_QUALIFIED") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

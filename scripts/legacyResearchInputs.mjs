import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const MANAGED_LEGACY_INPUT_DIRECTORY = "data/private/stock-research-inputs-v1";
export const MANAGED_REFIT_REPORT_PATH = `${MANAGED_LEGACY_INPUT_DIRECTORY}/p193_real_ohlcv_refit_report.json`;
export const MANAGED_FEATURE_SOURCE_PATH = `${MANAGED_LEGACY_INPUT_DIRECTORY}/stock_features.py`;
export const ORIGINAL_LEGACY_REPOSITORY = "/Users/kelvin/Kelvin-WorkSpace/Stock-Prediction-System";
export const ORIGINAL_REFIT_REPORT_PATH = "outputs/retraining/p193_real_ohlcv_refit_report.json";
export const ORIGINAL_FEATURE_SOURCE_PATH = "gbgf/domain/stock_features.py";

export function readPinnedResearchBytes(repository, ref, relativePath) {
  if (ref === "WORKTREE") return readFileSync(path.resolve(repository, relativePath));
  return execFileSync("git", ["show", `${ref}:${relativePath}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
}

/** Local archive manifest pins exact bytes. Explicit legacy/Git overrides retain
 * their original behavior. Feature Python is evidence only, never executed. */
export function readLegacyResearchInput(args, kind) {
  if (!["REFIT_REPORT", "FEATURE_SOURCE"].includes(kind)) throw new TypeError("unknown legacy input kind");
  const relativePath = kind === "REFIT_REPORT" ? args.refitReportPath : args.featureSourcePath;
  let entry;
  if (args.managedLegacyInputs) {
    if (args.ref !== "WORKTREE") throw new Error("MANAGED_LEGACY_INPUTS_REQUIRE_WORKTREE");
    const manifest = JSON.parse(readFileSync(path.resolve(args.legacyRepo, MANAGED_LEGACY_INPUT_DIRECTORY, "manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.classification !== "PRIVATE_LOCAL_LEGACY_SNAPSHOT" || !Array.isArray(manifest.files)) {
      throw new Error("INVALID_MANAGED_LEGACY_MANIFEST");
    }
    const entries = manifest.files.filter((record) => record.kind === kind);
    entry = entries[0];
    if (entries.length !== 1 || entry.relativePath !== relativePath || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || typeof entry.originalRepository !== "string"
      || typeof entry.originalPath !== "string" || typeof entry.originalRef !== "string") throw new Error("INVALID_MANAGED_LEGACY_MANIFEST_ENTRY");
  }
  const bytes = readPinnedResearchBytes(args.legacyRepo, args.ref, relativePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (entry && (entry.sha256 !== sha256 || entry.bytes !== bytes.length)) throw new Error(`MANAGED_LEGACY_INPUT_HASH_OR_SIZE_MISMATCH:${kind}`);
  const provenance = {
    kind, repository: args.legacyRepo, ref: args.ref, path: relativePath, sha256, bytes: bytes.length,
    mode: args.managedLegacyInputs ? "PRIVATE_MANAGED_SNAPSHOT" : "EXPLICIT_SOURCE_OVERRIDE",
    ...(entry ? { originalSource: { repository: entry.originalRepository, path: entry.originalPath, ref: entry.originalRef } } : {}),
  };
  return { bytes, provenance };
}

export function parseLegacyRefitReport(bytes) {
  const report = JSON.parse(bytes.toString("utf8"));
  const run = report?.run;
  const metrics = run?.holdoutMetrics;
  if (!run || typeof run.runId !== "string" || !run.runId.trim() || typeof run.interpretation !== "string" || !run.interpretation.trim()
    || [metrics?.accuracy, metrics?.majorityBaselineAccuracy].some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
    throw new Error("INVALID_LEGACY_REFIT_REPORT_REQUIRED_FIELDS");
  }
  return report;
}

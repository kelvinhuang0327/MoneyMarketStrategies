import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MANAGED_LEGACY_INPUT_DIRECTORY, MANAGED_REFIT_REPORT_PATH, MANAGED_FEATURE_SOURCE_PATH,
  ORIGINAL_LEGACY_REPOSITORY, ORIGINAL_REFIT_REPORT_PATH, ORIGINAL_FEATURE_SOURCE_PATH,
  readLegacyResearchInput, parseLegacyRefitReport,
} from "./legacyResearchInputs.mjs";
import { parseArgs } from "./runTwStrategyResearchStudy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const syntheticReport = Buffer.from(JSON.stringify({ run: { runId: "synthetic-only", interpretation: "synthetic diagnostic",
  holdoutMetrics: { accuracy: 0.4, majorityBaselineAccuracy: 0.6 } } }));

function fixture() {
  const repository = mkdtempSync(path.join(tmpdir(), "mms-legacy-input-"));
  const directory = path.join(repository, MANAGED_LEGACY_INPUT_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const feature = Buffer.from("# synthetic evidence only; must never execute\nraise Exception('do not execute')\n");
  writeFileSync(path.join(repository, MANAGED_REFIT_REPORT_PATH), syntheticReport);
  writeFileSync(path.join(repository, MANAGED_FEATURE_SOURCE_PATH), feature);
  const files = [["REFIT_REPORT", MANAGED_REFIT_REPORT_PATH, syntheticReport], ["FEATURE_SOURCE", MANAGED_FEATURE_SOURCE_PATH, feature]]
    .map(([kind, relativePath, bytes]) => ({ kind, relativePath, bytes: bytes.length, sha256: hash(bytes),
      originalRepository: "fixture://synthetic-origin", originalPath: kind === "REFIT_REPORT" ? ORIGINAL_REFIT_REPORT_PATH : ORIGINAL_FEATURE_SOURCE_PATH,
      originalRef: "WORKTREE" }));
  const manifest = { schemaVersion: 1, classification: "PRIVATE_LOCAL_LEGACY_SNAPSHOT", files };
  const manifestPath = path.join(directory, "manifest.json");
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  return { repository, manifest, save, args: { legacyRepo: repository, ref: "WORKTREE", refitReportPath: MANAGED_REFIT_REPORT_PATH,
    featureSourcePath: MANAGED_FEATURE_SOURCE_PATH, managedLegacyInputs: true }, dispose: () => rmSync(repository, { recursive: true, force: true }) };
}

test("defaults use private managed inputs while explicit legacy/Git overrides retain their paths and refs", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.legacyRepo, root);
  assert.equal(defaults.refitReportPath, MANAGED_REFIT_REPORT_PATH);
  assert.equal(defaults.featureSourcePath, MANAGED_FEATURE_SOURCE_PATH);
  assert.equal(defaults.managedLegacyInputs, true);
  for (const flags of [["--legacy-repo", "/caller/legacy", "--ref", "pinned"], ["--ref", "pinned", "--legacy-repo", "/caller/legacy"]]) {
    const args = parseArgs(flags);
    assert.equal(args.legacyRepo, "/caller/legacy");
    assert.equal(args.ref, "pinned");
    assert.equal(args.managedLegacyInputs, false);
    assert.equal(args.refitReportPath, ORIGINAL_REFIT_REPORT_PATH);
    assert.equal(args.featureSourcePath, ORIGINAL_FEATURE_SOURCE_PATH);
  }
  const refOnly = parseArgs(["--ref", "old-ref"]);
  assert.equal(refOnly.legacyRepo, ORIGINAL_LEGACY_REPOSITORY);
  assert.equal(refOnly.csvRef, "old-ref");
  const selected = parseArgs(["--legacy-repo", "/caller/source", "--refit-report-path", "report.json", "--feature-source-path", "feature.py",
    "--csv-repo", root, "--csv-ref", "WORKTREE"]);
  assert.equal(selected.refitReportPath, "report.json");
  assert.equal(selected.featureSourcePath, "feature.py");
  assert.equal(selected.csvRepo, root);
});

test("managed report/source reads preserve exact bytes and origin metadata without executing Python", () => {
  const f = fixture();
  try {
    const report = readLegacyResearchInput(f.args, "REFIT_REPORT");
    assert.deepEqual(report.bytes, syntheticReport);
    assert.equal(parseLegacyRefitReport(report.bytes).run.runId, "synthetic-only");
    assert.equal(report.provenance.originalSource.path, ORIGINAL_REFIT_REPORT_PATH);
    assert.equal(readLegacyResearchInput(f.args, "FEATURE_SOURCE").provenance.sha256, f.manifest.files[1].sha256);
    assert.deepEqual(readdirSync(path.join(f.repository, MANAGED_LEGACY_INPUT_DIRECTORY)).sort(), ["manifest.json", "p193_real_ohlcv_refit_report.json", "stock_features.py"]);
  } finally { f.dispose(); }
});

test("managed inputs reject tampered bytes, wrong size, absent/ambiguous identity and manifest paths", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repository, MANAGED_REFIT_REPORT_PATH), Buffer.from("tampered synthetic"));
    assert.throws(() => readLegacyResearchInput(f.args, "REFIT_REPORT"), /HASH_OR_SIZE_MISMATCH/);
    writeFileSync(path.join(f.repository, MANAGED_REFIT_REPORT_PATH), syntheticReport);
    f.manifest.files[0].bytes += 1; f.save();
    assert.throws(() => readLegacyResearchInput(f.args, "REFIT_REPORT"), /HASH_OR_SIZE_MISMATCH/);
    f.manifest.files[0].bytes -= 1; f.manifest.files[0].relativePath = "wrong-path"; f.save();
    assert.throws(() => readLegacyResearchInput(f.args, "REFIT_REPORT"), /INVALID_MANAGED_LEGACY_MANIFEST_ENTRY/);
    f.manifest.files = []; f.save();
    assert.throws(() => readLegacyResearchInput(f.args, "REFIT_REPORT"), /INVALID_MANAGED_LEGACY_MANIFEST_ENTRY/);
    assert.throws(() => readLegacyResearchInput({ ...f.args, ref: "old-commit" }, "REFIT_REPORT"), /REQUIRE_WORKTREE/);
  } finally { f.dispose(); }
});

test("explicit Git-ref input reads the pinned committed bytes rather than a later worktree edit", () => {
  const f = fixture();
  const git = (argv) => execFileSync("git", argv, { cwd: f.repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["init", "--quiet"]);
    git(["add", MANAGED_REFIT_REPORT_PATH]);
    git(["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "-m", "synthetic input fixture"]);
    const ref = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(f.repository, MANAGED_REFIT_REPORT_PATH), "later synthetic change");
    const result = readLegacyResearchInput({ ...f.args, managedLegacyInputs: false, ref }, "REFIT_REPORT");
    assert.deepEqual(result.bytes, syntheticReport);
    assert.equal(result.provenance.ref, ref);
    assert.equal(result.provenance.mode, "EXPLICIT_SOURCE_OVERRIDE");
  } finally { f.dispose(); }
});

test("legacy report parsing rejects missing fields, malformed JSON and nonfinite/out-of-range metrics", () => {
  assert.throws(() => parseLegacyRefitReport(Buffer.from("{}")), /REQUIRED_FIELDS/);
  assert.throws(() => parseLegacyRefitReport(Buffer.from("not-json")), SyntaxError);
  const report = JSON.parse(syntheticReport.toString());
  report.run.holdoutMetrics.accuracy = 4;
  assert.throws(() => parseLegacyRefitReport(Buffer.from(JSON.stringify(report))), /REQUIRED_FIELDS/);
});

test("actual CLI verifies isolated synthetic legacy inputs from another cwd without CSV/models/artifacts", () => {
  const f = fixture();
  try {
    const before = readdirSync(path.join(f.repository, MANAGED_LEGACY_INPUT_DIRECTORY));
    const result = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/runTwStrategyResearchStudy.mjs"), "--check-legacy-inputs",
      "--legacy-repo", f.repository, "--refit-report-path", MANAGED_REFIT_REPORT_PATH, "--feature-source-path", MANAGED_FEATURE_SOURCE_PATH],
    { cwd: tmpdir(), encoding: "utf8" }));
    assert.equal(result.status, "LEGACY_INPUTS_VERIFIED");
    assert.equal(result.inputs.length, 2);
    assert.equal(result.inputs[0].sha256, hash(syntheticReport));
    assert.equal(result.researchExecuted, false);
    assert.equal(result.featureSourceExecuted, false);
    assert.equal(result.artifactsWritten, false);
    assert.deepEqual(readdirSync(path.join(f.repository, MANAGED_LEGACY_INPUT_DIRECTORY)), before);
    assert.deepEqual(readFileSync(path.join(f.repository, MANAGED_REFIT_REPORT_PATH)), syntheticReport);
  } finally { f.dispose(); }
});

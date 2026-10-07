import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep the registered data/replay implementation unchanged. Read an existing
// immutable result before opening Vite. On a new run, observe our child's exit
// and archive only its own lock directory; never delete an ownership record.
const root = fileURLToPath(new URL("../", import.meta.url));
const planPath = "packages/paper-trading/experiments/cost-covered-exit-history-development-v1/plan.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const compact = (aggregate) => Object.fromEntries(Object.entries(aggregate).map(([arm, values]) => [arm, Object.fromEntries(Object.entries(values).filter(([key]) => key !== "equityAndExposureCurve"))]));
const emit = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

try {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--run", "--check-inputs"].includes(mode)) throw new TypeError("Usage: --check-inputs OR --run; registered symbols/window/costs cannot be overridden");
  const planBytes = await readFile(resolve(root, planPath)), plan = JSON.parse(planBytes), planSha256 = digest(planBytes);
  const registration = execFileSync("git", ["-C", root, "log", "--diff-filter=A", "--format=%H", "--", planPath], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  if (registration.length !== 1 || !execFileSync("git", ["-C", root, "show", `${registration[0]}:${planPath}`]).equals(planBytes)) throw new Error("registered development plan differs");
  const protocol = await readJson(resolve(root, plan.frozenProtocol.path));
  for (const [path, expected] of Object.entries({ ...protocol.implementationSha256, ...plan.sourceSha256, [plan.csv.path]: plan.csv.sha256 })) {
    if (digest(await readFile(resolve(root, path))) !== expected) throw new Error(`registered source differs: ${path}`);
  }
  const outputDir = resolve(root, plan.outputDirectory);
  async function cachedResult() {
    let files;
    try { files = (await readdir(outputDir)).filter((name) => /^[a-f0-9]{64}\.result\.json$/.test(name)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (files.length > 1) throw new Error("multiple development results; refusing to select by performance");
    if (files.length === 0) return null;
    const path = join(outputDir, files[0]), report = await readJson(path);
    const inputBytes = await readFile(join(outputDir, `${report.inputSha256}.input.json`)), input = JSON.parse(inputBytes);
    if (report.planSha256 !== planSha256 || input.planSha256 !== planSha256 || digest(inputBytes) !== report.inputSha256
      || files[0] !== `${report.inputSha256}.result.json` || input.csvSha256 !== plan.csv.sha256
      || report.classification !== "RETROSPECTIVE_DEVELOPMENT_NOT_UNSEEN_FORWARD"
      || report.originalFrozenProtocolCommit !== plan.frozenProtocol.commit) throw new Error("cached development artifact identity differs");
    return { report, input, path };
  }
  let cached = await cachedResult(), operationalWarning = null;
  if (!cached) {
    const childStartedTimestamp = Date.now();
    const child = spawn(process.execPath, [resolve(root, "scripts/runCostCoveredExitHistoryDevelopment.mjs"), mode], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
    const lock = join(outputDir, ".run.lock");
    try {
      const owner = await readJson(join(lock, "owner.json"));
      if (owner.pid !== child.pid || owner.planSha256 !== planSha256 || !Number.isFinite(Date.parse(owner.startedAtUtc)) || Date.parse(owner.startedAtUtc) < childStartedTimestamp) throw new Error("child lock ownership differs; left untouched");
      const archive = join(outputDir, ".completed-child-locks"); await mkdir(archive, { recursive: true });
      await rename(lock, join(archive, `${child.pid}-${Date.now()}`));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    cached = await cachedResult();
    if (code !== 0) {
      const exactCleanupFailure = code === 1 && stderr.includes("EPERM: operation not permitted, unlink") && stderr.includes(join(lock, "owner.json"));
      if (!cached || !exactCleanupFailure) throw new Error(`registered child failed (${code}): ${stderr || stdout}`);
      operationalWarning = "Completed report verified; registered child could not unlink its ownership marker. Supervisor observed child exit and archived only its matching lock.";
      const archive = join(outputDir, ".completed-child-locks"); await mkdir(archive, { recursive: true });
      await writeFile(join(archive, `${child.pid}.cleanup-failure.json`), JSON.stringify({ childPid: child.pid, exitCode: code, stderr, planSha256, resultPath: cached.path }, null, 2), { flag: "wx", mode: 0o600 });
    }
    if (!cached && mode === "--check-inputs") { emit(JSON.parse(stdout)); process.exitCode = 0; }
    else if (!cached) throw new Error("registered child produced no completed development result");
  }
  if (cached) {
    if (mode === "--check-inputs") emit({ status: "VERIFIED_CACHED_DEVELOPMENT_INPUTS_NO_NEW_REPLAY", planSha256, inputSha256: cached.report.inputSha256, window: cached.input.window, datasets: cached.input.datasets.map(({ symbol, warmupRows, evaluationRows }) => ({ symbol, warmupRows, evaluationRows })), operationalWarning });
    else emit({ status: cached.report.status, classification: cached.report.classification, persistence: "REUSED_VERIFIED_DEVELOPMENT_RESULT_NO_VITE_OR_REPLAY", resultPath: cached.path, planSha256, inputSha256: cached.report.inputSha256, aggregate: compact(cached.report.aggregate), sideEffects: cached.report.sideEffects, operationalWarning });
  }
} catch (error) {
  emit({ status: "ERROR", code: "CACHED_HISTORICAL_DEVELOPMENT_ENTRY_FAILED", reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

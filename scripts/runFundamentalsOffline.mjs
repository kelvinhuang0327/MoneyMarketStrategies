import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
let server;
let cache;
try {
  if (process.argv.length !== 4 || process.argv[2] !== "--input" || !process.argv[3]?.trim()) {
    throw new TypeError("Usage: node scripts/runFundamentalsOffline.mjs --input <local.json>");
  }
  const bytes = await readFile(resolve(process.cwd(), process.argv[3]));
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  cache = await mkdtemp(join(tmpdir(), "mms-fundamentals-offline-"));
  server = await createServer({
    root, configFile: false, cacheDir: cache,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true },
  });
  const module = await server.ssrLoadModule("/packages/research-kernel/src/fundamentalOfflineDiagnostic.ts");
  const result = module.buildFundamentalOfflineDiagnostic(input);
  process.stdout.write(`${JSON.stringify({ ...result, inputSha256: createHash("sha256").update(bytes).digest("hex") }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "ERROR", code: "OFFLINE_FUNDAMENTALS_INPUT_INVALID", reason: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (cache) await rm(cache, { recursive: true, force: true });
}

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: Object.fromEntries([
      "contracts", "execution-gateway", "research-kernel", "experiment-registry",
      "research-runner", "strategy-simulator", "paper-trading",
    ].map((name) => [`@mms/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))])),
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});

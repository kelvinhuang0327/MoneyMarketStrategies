import { describe, expect, it } from "vitest";

import { researchKernelBootstrapIdentity } from "./index.js";

describe("researchKernelBootstrapIdentity", () => {
  it("keeps the bootstrap diagnostic-only and non-executing", () => {
    expect(researchKernelBootstrapIdentity).toEqual({
      researchMode: "diagnostic-only",
      providesInvestmentAdvice: false,
      supportsTradingExecution: false,
    });
  });
});

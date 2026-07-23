import { describe, expect, it } from "vitest";

import { projectIdentity } from "./index.js";

describe("projectIdentity", () => {
  it("identifies the canonical modular monolith", () => {
    expect(projectIdentity).toEqual({
      name: "MoneyMarketStrategies",
      architecture: "modular-monolith",
    });
  });
});

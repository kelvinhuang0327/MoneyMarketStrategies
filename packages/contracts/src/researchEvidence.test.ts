import { describe, expect, it } from "vitest";

import { PROMOTION_STATUSES, type PromotionDecision } from "./researchEvidence.js";

describe("research evidence contracts", () => {
  it("keeps every promotion outcome diagnostic and manually gated", () => {
    expect(PROMOTION_STATUSES).toEqual([
      "BLOCKED_DATA_QUALITY",
      "BLOCKED_INSUFFICIENT_EVIDENCE",
      "BLOCKED_UNDERPERFORMS_BASELINE",
      "RESEARCH_CANDIDATE",
    ]);

    const decision: PromotionDecision = {
      status: "RESEARCH_CANDIDATE",
      automaticPromotion: false,
      manualApprovalRequired: true,
      requiredBaseline: "FINAL_TEST_MAJORITY_CLASS_ACCURACY",
      reasons: ["Final-test accuracy exceeds its majority-class baseline."],
    };

    expect(decision.automaticPromotion).toBe(false);
    expect(decision.manualApprovalRequired).toBe(true);
  });
});

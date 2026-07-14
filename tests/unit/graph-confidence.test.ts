import { describe, expect, test } from "bun:test";
import { assessConfidence } from "../../src/domains/graph/index.ts";

describe("Graph confidence", () => {
  test("independent direct evidence raises confidence", () => {
    const one = assessConfidence({
      directness: "direct",
      independentSourceCount: 1,
      extractionQuality: 0.9,
      disputed: false,
      userVerification: "none",
    });
    const two = assessConfidence({
      directness: "direct",
      independentSourceCount: 2,
      extractionQuality: 0.9,
      disputed: false,
      userVerification: "confirmed",
    });
    expect(two.score).toBeGreaterThan(one.score);
    expect(two.dimensions.corroboration).toBeGreaterThan(one.dimensions.corroboration);
    expect(two.dimensions.user_verification).toBe(1);
  });

  test("unresolved contradiction is never hidden by a high score", () => {
    const result = assessConfidence({
      sourceQuality: 1,
      directness: "direct",
      independentSourceCount: 4,
      ageDays: 0,
      extractionQuality: 1,
      disputed: true,
      userVerification: "confirmed",
    });
    expect(result.level).toBe("disputed");
    expect(result.reasons).toContain("unresolved contradictory evidence");
  });
});

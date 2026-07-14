import { describe, expect, test } from "bun:test";
import { createRetrievalPlan } from "../../src/domains/retrieval/index.ts";

describe("RetrievalPlan", () => {
  test("expands depth without changing the immutable Query hash", () => {
    const shallow = createRetrievalPlan({
      query: "Self evidence",
      queryHash: "a".repeat(64),
      mode: "text",
      depth: "shallow",
    });
    const deep = createRetrievalPlan({
      query: "Self evidence",
      queryHash: shallow.queryHash,
      mode: "text",
      depth: "deep",
    });
    expect(shallow.version).toBe("retrieval-plan-v1");
    expect(deep.queryHash).toBe(shallow.queryHash);
    expect(deep.seedLimit).toBeGreaterThan(shallow.seedLimit);
    expect(deep.graphDepth).toBeGreaterThan(shallow.graphDepth);
    expect(deep.contextTokenBudget).toBeGreaterThan(shallow.contextTokenBudget);
  });

  test("accepts an explicit bounded context budget", () => {
    const plan = createRetrievalPlan({
      query: "evidence",
      queryHash: "b".repeat(64),
      mode: "hybrid",
      depth: "normal",
      tokenBudget: 4096,
      filters: { sourceId: "source:src_fixture" },
    });
    expect(plan.contextTokenBudget).toBe(4096);
    expect(plan.filters.sourceId).toBe("source:src_fixture");
  });
});

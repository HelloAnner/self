import type { AskDepth, RetrievalPlan, SearchFilters, SearchMode } from "../model/types.ts";

const DEPTHS = {
  shallow: { seedLimit: 6, graphDepth: 1, graphMaxClaims: 8, contextTokenBudget: 2_400 },
  normal: { seedLimit: 12, graphDepth: 1, graphMaxClaims: 20, contextTokenBudget: 6_000 },
  deep: { seedLimit: 20, graphDepth: 2, graphMaxClaims: 40, contextTokenBudget: 12_000 },
} as const;

export function createRetrievalPlan(input: {
  query: string;
  queryHash: string;
  mode: SearchMode;
  depth: AskDepth;
  filters?: SearchFilters;
  tokenBudget?: number;
}): RetrievalPlan {
  const preset = DEPTHS[input.depth];
  return {
    version: "retrieval-plan-v1",
    query: input.query,
    queryHash: input.queryHash,
    mode: input.mode,
    depth: input.depth,
    seedLimit: preset.seedLimit,
    graphDepth: preset.graphDepth,
    graphMaxClaims: preset.graphMaxClaims,
    contextTokenBudget: input.tokenBudget ?? preset.contextTokenBudget,
    filters: input.filters ?? {},
  };
}

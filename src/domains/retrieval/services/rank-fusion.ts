import type { RouteCandidate } from "../model/types.ts";

export function reciprocalRankFusion(
  routes: RouteCandidate[][],
  weights: { fts: number; vector: number } = { fts: 1, vector: 1 },
): Array<{ chunk_id: string; score: number; routes: RouteCandidate[] }> {
  const merged = new Map<string, { score: number; routes: RouteCandidate[] }>();
  for (const route of routes) {
    for (const candidate of route) {
      const current = merged.get(candidate.chunk_id) ?? { score: 0, routes: [] };
      current.score += weights[candidate.route] / (60 + candidate.rank);
      current.routes.push(candidate);
      merged.set(candidate.chunk_id, current);
    }
  }
  return [...merged.entries()]
    .map(([chunk_id, value]) => ({ chunk_id, ...value }))
    .sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id));
}

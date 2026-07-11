import type { ChunkDraft } from "../../domains/knowledge/index.ts";

export type PreviousChunk = {
  chunk_id: string;
  content_hash: string;
  content_text: string;
  anchor_key: string;
  ordinal: number;
};

export function alignChunks(previous: PreviousChunk[], drafts: ChunkDraft[]) {
  const byHash = new Map<string, PreviousChunk[]>();
  for (const item of previous) {
    const bucket = byHash.get(item.content_hash) ?? [];
    bucket.push(item);
    byHash.set(item.content_hash, bucket);
  }
  const used = new Set<string>();
  const exactMatches = drafts.map((draft) => {
    const exact = byHash.get(draft.content_hash)?.find((item) => !used.has(item.chunk_id));
    if (exact) used.add(exact.chunk_id);
    return { draft, exact: exact ?? null };
  });
  const lineageUsed = new Set<string>();
  const aligned = exactMatches.map(({ draft, exact }) => {
    if (exact) return { draft, exact, replaced: null };
    const available = previous.filter(
      (item) => !used.has(item.chunk_id) && !lineageUsed.has(item.chunk_id),
    );
    const anchored = available.find((item) => item.anchor_key === draft.anchor_key) ?? null;
    const ranked = available
      .map((item) => ({ item, score: textSimilarity(item.content_text, draft.content_text) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          Math.abs(left.item.ordinal - draft.ordinal) -
            Math.abs(right.item.ordinal - draft.ordinal),
      );
    const replaced =
      anchored ?? ((ranked[0]?.score ?? 0) >= 0.15 ? (ranked[0]?.item ?? null) : null);
    if (replaced) lineageUsed.add(replaced.chunk_id);
    return { draft, exact: null, replaced };
  });
  return { aligned, unused: previous.filter((item) => !used.has(item.chunk_id)) };
}

export function textSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

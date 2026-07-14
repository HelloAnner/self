import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "../../src/domains/retrieval/index.ts";

describe("reciprocal rank fusion", () => {
  test("rewards agreement without mixing raw route scores", () => {
    const merged = reciprocalRankFusion([
      [
        { chunk_id: "both", rank: 1, raw_score: 1000, route: "fts" },
        { chunk_id: "text", rank: 2, raw_score: 9999, route: "fts" },
      ],
      [
        { chunk_id: "both", rank: 2, raw_score: -0.5, distance: 0.2, route: "vector" },
        { chunk_id: "vector", rank: 1, raw_score: 0.9, distance: 0.1, route: "vector" },
      ],
    ]);
    expect(merged[0]?.chunk_id).toBe("both");
    expect(merged[0]?.routes.map((route) => route.route).sort()).toEqual(["fts", "vector"]);
  });

  test("uses stable Chunk ID tie-breaking", () => {
    const merged = reciprocalRankFusion([
      [
        { chunk_id: "chunk-b", rank: 1, raw_score: 1, route: "fts" },
        { chunk_id: "chunk-a", rank: 1, raw_score: 1, route: "fts" },
      ],
    ]);
    expect(merged.map((item) => item.chunk_id)).toEqual(["chunk-a", "chunk-b"]);
  });
});

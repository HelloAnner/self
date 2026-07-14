import {
  reciprocalRankFusion,
  type SearchFilters,
  type SearchMode,
} from "../../domains/retrieval/index.ts";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import {
  embeddingInputHash,
  queryEmbeddingInput,
  vectorCoverage,
} from "../../infrastructure/knowledge/vector-space-repository.ts";
import { embedModelTexts, vectorHash } from "../../infrastructure/model/embedding-provider.ts";
import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import {
  activeVectorForSearch,
  hydrateCandidates,
  searchFts,
  searchVectorIndex,
} from "../../infrastructure/retrieval/search-repository.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";

export async function searchKnowledge(
  root: string,
  input: {
    query: string;
    mode?: SearchMode;
    limit?: number;
    filters?: SearchFilters;
    explain?: boolean;
  },
) {
  const config = await loadSelfConfig(root);
  const query = input.query.normalize("NFKC").trim();
  if (!query || query.includes("\0"))
    throw failure("search_input_invalid", "Search Query is invalid", "usage");
  const limit = input.limit ?? config.retrieval.result_limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw failure("search_limit_invalid", "Search limit must be between 1 and 100", "usage");
  const filters = input.filters ?? {};
  validateDates(filters);
  const mode = input.mode ?? config.retrieval.mode;
  const started = performance.now();
  const timings: Record<string, number> = {};
  let database = await readonlyModelDatabase(root);
  const ftsStarted = performance.now();
  const fts =
    mode === "vector"
      ? { generationId: "skipped", candidates: [] }
      : searchFts(database, query, filters, limit);
  timings.fts_ms = round(performance.now() - ftsStarted);
  let vector = [] as ReturnType<typeof searchVectorIndex>;
  let activeSpace = activeVectorForSearch(database);
  const warnings: string[] = [];
  if (mode !== "vector" && fts.generationId === "none") warnings.push("fts_unavailable");
  database.close();
  if (mode !== "text") {
    try {
      if (activeSpace?.state !== "ready")
        throw failure(
          "vector_space_not_active",
          "No ready active VectorSpace is available",
          "state",
        );
      if (activeSpace.provider_state !== "active" || activeSpace.circuit_state !== "closed")
        throw failure(
          "model_provider_unavailable",
          "Active Embedding Provider is unavailable",
          "external",
        );
      database = await readonlyModelDatabase(root);
      const coverage = vectorCoverage(database, activeSpace);
      database.close();
      if (coverage.expected === 0 || coverage.covered !== coverage.expected)
        throw failure(
          "vector_coverage_incomplete",
          "Active VectorSpace coverage is incomplete",
          "state",
          {
            details: coverage,
          },
        );
      const embeddingStarted = performance.now();
      const queryVector = await queryEmbedding(root, activeSpace, query);
      timings.query_embedding_ms = round(performance.now() - embeddingStarted);
      const vectorStarted = performance.now();
      database = await readonlyModelDatabase(root);
      vector = searchVectorIndex(database, activeSpace, queryVector, limit);
      database.close();
      timings.vector_ms = round(performance.now() - vectorStarted);
    } catch (cause) {
      if (mode === "vector") throw cause;
      warnings.push("vector_degraded");
      activeSpace = null;
      if (!(cause instanceof SelfFailure)) throw cause;
    }
  }
  const mergeStarted = performance.now();
  const merged = reciprocalRankFusion([fts.candidates, vector]);
  timings.merge_ms = round(performance.now() - mergeStarted);
  database = await readonlyModelDatabase(root);
  const hydrated = hydrateCandidates(
    database,
    merged.map((item) => item.chunk_id),
    filters,
  );
  database.close();
  const byId = new Map(hydrated.map((item) => [String(item.chunk_id), item]));
  const results = merged
    .flatMap((item) => {
      const evidence = byId.get(item.chunk_id);
      if (!evidence) return [];
      const titleBoost = String(evidence.title ?? "")
        .toLowerCase()
        .includes(query.toLowerCase())
        ? 0.01
        : 0;
      return [
        {
          rank: 0,
          score: item.score + titleBoost,
          routes: item.routes.map((route) => ({
            route: route.route,
            rank: route.rank,
            raw_score: route.raw_score,
            ...(route.distance !== undefined ? { distance: route.distance } : {}),
          })),
          excerpt: excerpt(String(evidence.content_text), query),
          ...evidence,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score || String(left.chunk_id).localeCompare(String(right.chunk_id)),
    )
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  timings.hydrate_ms = round(performance.now() - mergeStarted - timings.merge_ms);
  timings.total_ms = round(performance.now() - started);
  return {
    query,
    mode,
    effective_mode: warnings.includes("vector_degraded") ? "text" : mode,
    warnings,
    results,
    ...(input.explain
      ? {
          trace: {
            fts_generation_id: fts.generationId,
            vector_space_id: activeSpace?.vector_space_id ?? null,
            space_fingerprint: activeSpace?.space_fingerprint ?? null,
            candidates: {
              fts: fts.candidates.length,
              vector: vector.length,
              merged: merged.length,
            },
            filters,
            timings,
          },
        }
      : {}),
  };
}

async function queryEmbedding(
  root: string,
  space: NonNullable<ReturnType<typeof activeVectorForSearch>>,
  query: string,
): Promise<Float32Array> {
  const queryHash = sha256Text(query);
  const prepared = queryEmbeddingInput(space, query);
  const inputHash = embeddingInputHash(prepared);
  let database = await writableModelDatabase(root);
  try {
    const cached = database
      .query<{ embedding_blob: Uint8Array }, [string, string, string]>(
        `SELECT embedding_blob FROM retrieval_query_cache WHERE vector_space_id = ?
         AND query_hash = ? AND input_hash = ?`,
      )
      .get(space.vector_space_id, queryHash, inputHash);
    if (cached) {
      database
        .prepare(
          `UPDATE retrieval_query_cache SET hit_count = hit_count + 1, last_used_at = ?
           WHERE vector_space_id = ? AND query_hash = ? AND input_hash = ?`,
        )
        .run(new Date().toISOString(), space.vector_space_id, queryHash, inputHash);
      return Float32Array.from(
        new Float32Array(
          cached.embedding_blob.buffer,
          cached.embedding_blob.byteOffset,
          space.dimensions,
        ),
      );
    }
  } finally {
    database.close();
  }
  const call = await embedModelTexts(root, {
    modelId: space.model_id,
    vectorSpaceId: space.vector_space_id,
    dimensions: space.dimensions,
    texts: [prepared],
    operationKind: "retrieval.query-embedding",
  });
  const vector = call.vectors[0];
  if (!vector) throw failure("model_response_invalid", "Query Embedding is missing", "external");
  database = await writableModelDatabase(root);
  try {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT OR REPLACE INTO retrieval_query_cache(vector_space_id, query_hash, input_hash,
         embedding_blob, vector_hash, provider_actual_model_id, created_at, last_used_at, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        space.vector_space_id,
        queryHash,
        inputHash,
        vector,
        vectorHash(vector),
        call.provider_actual_model_id,
        now,
        now,
      );
  } finally {
    database.close();
  }
  return vector;
}

function validateDates(filters: SearchFilters): void {
  for (const value of [filters.since, filters.until])
    if (value && !Number.isFinite(Date.parse(value)))
      throw failure("search_filter_invalid", "Search time filter is invalid", "usage");
  if (filters.since && filters.until && Date.parse(filters.since) > Date.parse(filters.until))
    throw failure("search_filter_invalid", "Search --since must not be after --until", "usage");
}

function excerpt(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 80);
  const value = content.slice(start, start + 320).trim();
  return `${start > 0 ? "…" : ""}${value}${start + 320 < content.length ? "…" : ""}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

import type { Database } from "bun:sqlite";
import type { RouteCandidate, SearchFilters } from "../../domains/retrieval/index.ts";
import { activeFtsGeneration } from "../knowledge/fts-index.ts";
import { queryVectors } from "../knowledge/vector-index.ts";
import type { VectorSpaceRow } from "../knowledge/vector-space-repository.ts";

export function searchFts(
  database: Database,
  query: string,
  filters: SearchFilters,
  limit: number,
): { generationId: string; candidates: RouteCandidate[] } {
  const generationId = activeFtsGeneration(database);
  if (!generationId) return { generationId: "none", candidates: [] };
  const expression = ftsExpression(query);
  const rows = expression
    ? database
        .query<{ chunk_id: string; rank: number }, [string, string, string | null, string | null]>(
          `SELECT chunk_id, bm25(knowledge_fts, 0, 0, 0, 0, 1.0, 1.5, 0.8, 0.6) rank
           FROM knowledge_fts WHERE knowledge_fts MATCH ? AND index_generation_id = ?
           AND (? IS NULL OR source_id = ?) ORDER BY rank, chunk_id LIMIT 100`,
        )
        .all(expression, generationId, filters.sourceId ?? null, filters.sourceId ?? null)
    : database
        .query<{ chunk_id: string; rank: number }, [string, string, string | null, string | null]>(
          `SELECT f.chunk_id, 0.0 rank FROM knowledge_fts f
           WHERE f.index_generation_id = ? AND instr(lower(f.content_text), lower(?)) > 0
           AND (? IS NULL OR f.source_id = ?) ORDER BY f.chunk_id LIMIT 100`,
        )
        .all(generationId, query, filters.sourceId ?? null, filters.sourceId ?? null);
  return {
    generationId,
    candidates: rows.slice(0, Math.max(limit * 4, 20)).map((row, index) => ({
      chunk_id: row.chunk_id,
      rank: index + 1,
      raw_score: 1 / (1 + Math.abs(row.rank)),
      route: "fts" as const,
    })),
  };
}

export function searchVectorIndex(
  database: Database,
  space: VectorSpaceRow,
  vector: Float32Array,
  limit: number,
): RouteCandidate[] {
  const rows = queryVectors(database, {
    dimensions: space.dimensions,
    vectorSpaceId: space.vector_space_id,
    vector,
    limit: Math.min(100, Math.max(limit * 4, 20)),
  });
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => "?").join(",");
  const mappings = database
    .query<{ embedding_id: string; chunk_id: string }, string[]>(
      `SELECT embedding_id, chunk_id FROM knowledge_embeddings WHERE embedding_id IN (${placeholders})`,
    )
    .all(...rows.map((row) => row.embedding_id));
  const byEmbedding = new Map(mappings.map((row) => [row.embedding_id, row.chunk_id]));
  return rows.flatMap((row, index) => {
    const chunkId = byEmbedding.get(row.embedding_id);
    return chunkId
      ? [
          {
            chunk_id: chunkId,
            rank: index + 1,
            raw_score: 1 - row.distance,
            distance: row.distance,
            route: "vector" as const,
          },
        ]
      : [];
  });
}

export function hydrateCandidates(database: Database, chunkIds: string[], filters: SearchFilters) {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = database
    .query<SearchEvidenceRow, string[]>(
      `SELECT c.chunk_id, c.content_text, c.block_kind, c.token_estimate,
       d.document_id, d.source_id, d.logical_path, d.media_type,
       r.revision_id, r.snapshot_id, r.blob_sha256, r.title, r.created_at revision_created_at,
       r.metadata_json, rc.heading_path_json, rc.source_start_line, rc.source_end_line,
       s.name source_name, b.relative_path blob_relative_path
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
       JOIN knowledge_revision_chunks rc ON rc.revision_id = r.revision_id AND rc.chunk_id = c.chunk_id
       JOIN sources s ON s.source_id = d.source_id
       JOIN source_blobs b ON b.sha256 = r.blob_sha256
       WHERE c.chunk_id IN (${placeholders}) AND c.state = 'active' AND d.state = 'active'`,
    )
    .all(...chunkIds);
  return rows
    .filter((row) => matchesFilters(row, filters))
    .map((row) => ({
      ...row,
      heading_path: JSON.parse(String(row.heading_path_json ?? "[]")),
      tags: tags(row.metadata_json),
    }));
}

export type SearchEvidenceRow = Record<string, unknown> & {
  chunk_id: string;
  content_text: string;
  title: string | null;
  logical_path: string;
  media_type: string;
  source_id: string;
  metadata_json: string;
  revision_created_at: string;
  heading_path_json: string;
};

export function activeVectorForSearch(database: Database):
  | (VectorSpaceRow & {
      provider_id: string;
      provider_state: string;
      circuit_state: string;
    })
  | null {
  return (
    database
      .query<
        VectorSpaceRow & {
          provider_id: string;
          provider_state: string;
          circuit_state: string;
        },
        []
      >(
        `SELECT v.*, p.provider_id, p.state provider_state, p.circuit_state
         FROM knowledge_active_vector_space a JOIN vector_spaces v
         ON v.vector_space_id = a.active_vector_space_id
         JOIN models m ON m.model_id = v.model_id JOIN model_providers p ON p.provider_id = m.provider_id
         WHERE a.singleton_id = 1`,
      )
      .get() ?? null
  );
}

function ftsExpression(query: string): string | null {
  const tokens = query
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', '""'))
    .filter((token) => token.length >= 3);
  return tokens.length > 0 ? tokens.map((token) => `"${token}"`).join(" OR ") : null;
}

function matchesFilters(row: Record<string, unknown>, filters: SearchFilters): boolean {
  if (filters.sourceId && row.source_id !== filters.sourceId) return false;
  if (filters.pathPrefix && !String(row.logical_path).startsWith(filters.pathPrefix)) return false;
  if (filters.mediaType && row.media_type !== filters.mediaType) return false;
  if (filters.tag && !tags(row.metadata_json).includes(filters.tag)) return false;
  const time = Date.parse(String(row.revision_created_at));
  if (filters.since && time < Date.parse(filters.since)) return false;
  if (filters.until && time > Date.parse(filters.until)) return false;
  return true;
}

function tags(value: unknown): string[] {
  try {
    const metadata = JSON.parse(String(value ?? "{}")) as { tags?: unknown };
    return Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
  } catch {
    return [];
  }
}

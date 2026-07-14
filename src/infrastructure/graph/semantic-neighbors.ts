import { failure } from "../../shared/errors/self-error.ts";
import { queryVectors, vectorTableName } from "../knowledge/vector-index.ts";
import { writableGraphDatabase } from "./graph-db.ts";

const MAX_SOURCE_NODES = 1_000;
const TOP_K = 8;

export async function buildSemanticNeighbors(
  root: string,
  generationId: string,
  vectorSpaceId: string,
) {
  const database = await writableGraphDatabase(root);
  try {
    const space = database
      .query<{ dimensions: number; state: string }, [string]>(
        "SELECT dimensions, state FROM vector_spaces WHERE vector_space_id = ?",
      )
      .get(vectorSpaceId);
    if (!space || !["ready", "deprecated"].includes(space.state))
      throw failure(
        "vector_space_not_ready",
        "Semantic Neighbor requires a ready VectorSpace",
        "state",
      );
    const rows = database
      .query<
        { embedding_id: string; chunk_id: string; content_hash: string; node_id: string },
        [string, string, number]
      >(
        `SELECT e.embedding_id, e.chunk_id, c.content_hash, n.node_id FROM knowledge_embeddings e
       JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
       JOIN graph_nodes n ON n.node_kind = 'chunk' AND n.external_ref_id = e.chunk_id
       JOIN graph_generation_nodes gn ON gn.node_id = n.node_id AND gn.generation_id = ?
       WHERE e.vector_space_id = ? AND e.state = 'active' AND c.state = 'active'
       ORDER BY e.chunk_id LIMIT ?`,
      )
      .all(generationId, vectorSpaceId, MAX_SOURCE_NODES);
    const byEmbedding = new Map(rows.map((row) => [row.embedding_id, row]));
    const table = vectorTableName(space.dimensions);
    let written = 0;
    for (const row of rows) {
      const vector = database
        .query<{ embedding: Uint8Array }, [string]>(
          `SELECT embedding FROM ${table} WHERE embedding_id = ?`,
        )
        .get(row.embedding_id)?.embedding;
      if (!vector) continue;
      const candidates = queryVectors(database, {
        dimensions: space.dimensions,
        vectorSpaceId,
        vector: new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength / 4),
        limit: TOP_K + 8,
      });
      let rank = 0;
      for (const candidate of candidates) {
        const target = byEmbedding.get(candidate.embedding_id);
        if (!target || target.chunk_id === row.chunk_id) continue;
        rank += 1;
        if (rank > TOP_K) break;
        database
          .prepare(
            `INSERT OR REPLACE INTO graph_semantic_neighbors(vector_space_id, generation_id,
           source_node_id, target_node_id, source_content_hash, target_content_hash, score,
           rank, scope_key, algorithm_version, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'workspace', 'knn-cosine-v1', ?)`,
          )
          .run(
            vectorSpaceId,
            generationId,
            row.node_id,
            target.node_id,
            row.content_hash,
            target.content_hash,
            1 - candidate.distance,
            rank,
            new Date().toISOString(),
          );
        written += 1;
      }
    }
    return {
      vector_space_id: vectorSpaceId,
      source_nodes: rows.length,
      neighbors: written,
      top_k: TOP_K,
      truncated: rows.length === MAX_SOURCE_NODES,
    };
  } finally {
    database.close();
  }
}

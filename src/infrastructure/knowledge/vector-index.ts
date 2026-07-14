import type { Database } from "bun:sqlite";

export function ensureVectorTable(database: Database, dimensions: number): string {
  const table = vectorTableName(dimensions);
  database.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      embedding_id TEXT PRIMARY KEY,
      vector_space_id TEXT PARTITION KEY,
      embedding FLOAT[${dimensions}] distance_metric=cosine
    )`,
  );
  return table;
}

export function upsertVector(
  database: Database,
  input: { dimensions: number; embeddingId: string; vectorSpaceId: string; vector: Float32Array },
): void {
  const table = ensureVectorTable(database, input.dimensions);
  database.prepare(`DELETE FROM ${table} WHERE embedding_id = ?`).run(input.embeddingId);
  database
    .prepare(`INSERT INTO ${table}(embedding_id, vector_space_id, embedding) VALUES (?, ?, ?)`)
    .run(input.embeddingId, input.vectorSpaceId, input.vector);
}

export function queryVectors(
  database: Database,
  input: { dimensions: number; vectorSpaceId: string; vector: Float32Array; limit: number },
) {
  const table = vectorTableName(input.dimensions);
  return database
    .query<{ embedding_id: string; distance: number }, [Float32Array, number, string]>(
      `SELECT embedding_id, distance FROM ${table}
       WHERE embedding MATCH ? AND k = ? AND vector_space_id = ? ORDER BY distance`,
    )
    .all(input.vector, input.limit, input.vectorSpaceId);
}

export function countVectors(
  database: Database,
  dimensions: number,
  vectorSpaceId: string,
): number {
  const table = ensureVectorTable(database, dimensions);
  return (
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM ${table} WHERE vector_space_id = ?`,
      )
      .get(vectorSpaceId)?.count ?? 0
  );
}

export function vectorTableName(dimensions: number): string {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
    throw new Error("Invalid vector dimensions");
  return `knowledge_vec_f32_${dimensions}`;
}

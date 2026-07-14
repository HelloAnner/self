import { resolve } from "node:path";
import { openSqlite } from "../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../src/infrastructure/runtime/assets.ts";

export async function verifySynthetic(root: string) {
  return withDatabase(root, (database) => {
    const active = database
      .query<
        { vector_space_id: string; dimensions: number; state: string; space_fingerprint: string },
        []
      >(
        `SELECT v.vector_space_id, v.dimensions, v.state, v.space_fingerprint
         FROM knowledge_active_vector_space a JOIN vector_spaces v
         ON v.vector_space_id = a.active_vector_space_id WHERE a.singleton_id = 1`,
      )
      .get();
    if (active?.state !== "ready") throw new Error("Synthetic active VectorSpace is not ready");
    const chunks = scalar(
      database,
      "SELECT COUNT(*) count FROM knowledge_chunks WHERE state = 'active'",
    );
    const embeddings =
      database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
         WHERE e.vector_space_id = ? AND e.state = 'active' AND c.state = 'active'
         AND e.chunk_content_hash = c.content_hash`,
        )
        .get(active.vector_space_id)?.count ?? 0;
    const fts = activeFtsCount(database);
    const unfinished = scalar(
      database,
      "SELECT COUNT(*) count FROM vector_build_runs WHERE state IN ('queued','building','verifying')",
    );
    const maxBatch =
      database
        .query<{ maximum: number }, []>(
          "SELECT COALESCE(MAX(item_count), 0) maximum FROM connection_change_batches",
        )
        .get()?.maximum ?? 0;
    if (
      chunks < 500 ||
      embeddings !== chunks ||
      fts !== chunks ||
      unfinished !== 0 ||
      maxBatch > 500
    )
      throw new Error("Synthetic Search evidence is incomplete");
    return {
      active_vector_space_id: active.vector_space_id,
      active_space_fingerprint: active.space_fingerprint,
      dimensions: active.dimensions,
      active_chunks: chunks,
      active_embeddings: embeddings,
      active_fts_rows: fts,
      unfinished_builds: unfinished,
      maximum_connection_batch: maxBatch,
    };
  });
}

export async function verifyRealVault(root: string) {
  return withDatabase(root, (database) => {
    const documents = scalar(
      database,
      "SELECT COUNT(*) count FROM knowledge_documents WHERE state = 'active'",
    );
    const chunks = scalar(
      database,
      "SELECT COUNT(*) count FROM knowledge_chunks WHERE state = 'active'",
    );
    const fts = activeFtsCount(database);
    const observations = scalar(
      database,
      "SELECT COUNT(*) count FROM connection_observations WHERE state = 'active'",
    );
    const ingested = scalar(
      database,
      "SELECT COUNT(*) count FROM connection_change_items WHERE state = 'ingested'",
    );
    const latestScan = database
      .query<{ state: string; files_hashed: number; files_seen: number }, []>(
        "SELECT state, files_hashed, files_seen FROM connection_scan_runs ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    if (
      documents < 5_000 ||
      chunks < documents ||
      fts !== chunks ||
      observations !== documents ||
      ingested !== documents ||
      latestScan?.state !== "succeeded" ||
      latestScan.files_hashed !== 0
    )
      throw new Error("Real Vault evidence is incomplete or reconciliation is not idempotent");
    return {
      documents,
      chunks,
      active_fts_rows: fts,
      observations,
      ingested_change_items: ingested,
      unchanged_scan: latestScan,
      external_target_modified: false,
    };
  });
}

export async function verifyLiveModel(root: string) {
  return withDatabase(root, (database) => {
    const active = database
      .query<
        {
          vector_space_id: string;
          dimensions: number;
          state: string;
          provider_model_id: string;
          coverage_count: number;
          expected_chunk_count: number;
        },
        []
      >(
        `SELECT v.vector_space_id, v.dimensions, v.state, v.provider_model_id,
         v.coverage_count, v.expected_chunk_count FROM knowledge_active_vector_space a
         JOIN vector_spaces v ON v.vector_space_id = a.active_vector_space_id WHERE a.singleton_id = 1`,
      )
      .get();
    const actual = database
      .query<{ provider_actual_model_id: string }, []>(
        `SELECT provider_actual_model_id FROM model_invocations WHERE status = 'succeeded'
         AND provider_actual_model_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get()?.provider_actual_model_id;
    if (
      active?.state !== "ready" ||
      active.dimensions !== 1024 ||
      active.provider_model_id !== "text-embedding-v4" ||
      active.coverage_count !== active.expected_chunk_count ||
      actual !== "text-embedding-v4"
    )
      throw new Error("Live text-embedding-v4 VectorSpace is incomplete");
    return {
      vector_space_id: active.vector_space_id,
      provider_model_id: active.provider_model_id,
      provider_actual_model_id: actual,
      dimensions: active.dimensions,
      coverage_count: active.coverage_count,
      expected_chunk_count: active.expected_chunk_count,
      credential_storage: "environment-only",
    };
  });
}

export async function immutableCounts(root: string) {
  return withDatabase(root, (database) => ({
    fts: scalar(database, "SELECT COUNT(*) count FROM knowledge_fts"),
    spaces: scalar(database, "SELECT COUNT(*) count FROM vector_spaces"),
    embeddings: scalar(database, "SELECT COUNT(*) count FROM knowledge_embeddings"),
    invocations: scalar(database, "SELECT COUNT(*) count FROM model_invocations"),
    evaluations: scalar(database, "SELECT COUNT(*) count FROM vector_space_evaluations"),
  }));
}

export async function queryPlanEvidence(root: string, vectorSpaceId: string) {
  return withDatabase(root, (database) => ({
    source_revision_chunks: database
      .query<Record<string, unknown>, []>(
        `EXPLAIN QUERY PLAN SELECT rc.chunk_id FROM knowledge_documents d
         JOIN knowledge_revision_chunks rc ON rc.revision_id = d.current_revision_id
         WHERE d.source_id = 'source:fixture' AND d.state = 'active'`,
      )
      .all(),
    active_embeddings: database
      .query<Record<string, unknown>, [string]>(
        `EXPLAIN QUERY PLAN SELECT e.embedding_id FROM knowledge_embeddings e
         WHERE e.vector_space_id = ? AND e.state = 'active'`,
      )
      .all(vectorSpaceId),
    fts_virtual_index: database
      .query<Record<string, unknown>, [string, string]>(
        `EXPLAIN QUERY PLAN SELECT chunk_id FROM knowledge_fts
         WHERE knowledge_fts MATCH ? AND index_generation_id = ? LIMIT 20`,
      )
      .all("evidence", "generation:fixture"),
  }));
}

async function withDatabase<T>(
  root: string,
  query: (database: ReturnType<typeof openSqlite>) => T,
) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`Database integrity failed: ${root}`);
    return query(database);
  } finally {
    database.close();
  }
}

function activeFtsCount(database: ReturnType<typeof openSqlite>): number {
  return scalar(
    database,
    `SELECT COUNT(*) count FROM knowledge_fts WHERE index_generation_id = (
    SELECT active_generation_id FROM knowledge_active_indexes WHERE index_kind = 'fts')`,
  );
}

function scalar(database: ReturnType<typeof openSqlite>, sql: string): number {
  return database.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

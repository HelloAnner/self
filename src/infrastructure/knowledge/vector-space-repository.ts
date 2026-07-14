import type { Database } from "bun:sqlite";
import { type VectorSpaceDefinition, vectorSpaceFingerprint } from "../../domains/model/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { readonlyModelDatabase, writableModelDatabase } from "../model/model-db.ts";
import { countVectors, ensureVectorTable, upsertVector } from "./vector-index.ts";

export const QUERY_INSTRUCTIONS: Record<string, string> = {
  "personal-knowledge-retrieval-v1":
    "Given a personal knowledge-base query, retrieve passages that provide direct evidence, relevant context, contradictions, or updates for the query.",
};

export type VectorSpaceRow = VectorSpaceDefinition & {
  vector_space_id: string;
  model_id: string;
  state: "building" | "verifying" | "ready" | "failed" | "deprecated" | "deleted";
  space_fingerprint: string;
  sentinel_fingerprint: string | null;
  coverage_count: number;
  expected_chunk_count: number;
  version: number;
};

export async function createVectorSpaceRecord(
  root: string,
  input: { modelId: string; dimensions: number; queryInstructionId: string },
) {
  const database = await writableModelDatabase(root);
  try {
    const model = modelWithProvider(database, input.modelId);
    const dimensions = JSON.parse(model.dimensions_json) as number[];
    if (!dimensions.includes(input.dimensions))
      throw failure(
        "model_dimension_mismatch",
        "Model does not support requested dimensions",
        "state",
      );
    const queryInstruction = QUERY_INSTRUCTIONS[input.queryInstructionId];
    if (!queryInstruction)
      throw failure("vector_space_input_invalid", "Unknown Query Instruction", "usage");
    const definition: VectorSpaceDefinition = {
      provider_type: model.provider_type,
      provider_endpoint_identity: model.endpoint_identity,
      provider_model_id: model.provider_model_id,
      model_revision: model.model_revision,
      revision_stability: model.revision_stability,
      tokenizer_revision: "provider-default-v1",
      dimensions: input.dimensions,
      scalar_type: "float32",
      pooling: "provider-default",
      normalization: "l2",
      distance_metric: "cosine",
      query_instruction_id: input.queryInstructionId,
      query_instruction_text: queryInstruction,
      document_instruction_id: null,
      document_instruction_text: null,
      embedding_input_version: "chunk-title-path-content-v1",
    };
    const fingerprint = vectorSpaceFingerprint(definition);
    const existing = database
      .query<VectorSpaceRow, [string]>("SELECT * FROM vector_spaces WHERE space_fingerprint = ?")
      .get(fingerprint);
    if (existing) return { ...spaceDto(existing), reused: true };
    const vectorSpaceId = createResourceId("vector-space");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO vector_spaces(vector_space_id, model_id, state, space_fingerprint,
         provider_type, provider_endpoint_identity, provider_model_id, model_revision,
         revision_stability, tokenizer_revision, dimensions, scalar_type, pooling, normalization,
         distance_metric, query_instruction_id, query_instruction_text, document_instruction_id,
         document_instruction_text, embedding_input_version, created_at, updated_at)
         VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(vectorSpaceId, input.modelId, fingerprint, ...Object.values(definition), now, now);
    ensureVectorTable(database, input.dimensions);
    return { ...spaceDto(getSpace(database, vectorSpaceId)), reused: false };
  } finally {
    database.close();
  }
}

export async function listVectorSpaces(root: string) {
  const database = await readonlyModelDatabase(root);
  try {
    const active = activeVectorSpaceId(database);
    return database
      .query<VectorSpaceRow, []>("SELECT * FROM vector_spaces ORDER BY created_at, vector_space_id")
      .all()
      .map((row) => ({ ...spaceDto(row), active: row.vector_space_id === active }));
  } finally {
    database.close();
  }
}

export async function showVectorSpace(root: string, vectorSpaceId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    const row = getSpace(database, vectorSpaceId);
    const active = activeVectorSpaceId(database);
    const latestBuild = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM vector_build_runs WHERE vector_space_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(vectorSpaceId);
    return {
      ...spaceDto(row),
      active: active === vectorSpaceId,
      latest_build: latestBuild ?? null,
    };
  } finally {
    database.close();
  }
}

export async function activeVectorSpace(root: string) {
  const database = await readonlyModelDatabase(root);
  try {
    const id = activeVectorSpaceId(database);
    return id ? spaceDto(getSpace(database, id)) : null;
  } finally {
    database.close();
  }
}

export function getSpace(database: Database, vectorSpaceId: string): VectorSpaceRow {
  const row = database
    .query<VectorSpaceRow, [string]>("SELECT * FROM vector_spaces WHERE vector_space_id = ?")
    .get(vectorSpaceId);
  if (!row) throw failure("vector_space_not_found", "VectorSpace does not exist", "not_found");
  return row;
}

export function activeVectorSpaceId(database: Database): string | null {
  return (
    database
      .query<{ active_vector_space_id: string | null }, []>(
        "SELECT active_vector_space_id FROM knowledge_active_vector_space WHERE singleton_id = 1",
      )
      .get()?.active_vector_space_id ?? null
  );
}

export function activeChunks(database: Database, sourceId?: string) {
  return database
    .query<
      {
        chunk_id: string;
        content_hash: string;
        content_text: string;
        logical_path: string;
        title: string | null;
      },
      [string | null, string | null]
    >(
      `SELECT c.chunk_id, c.content_hash, c.content_text, d.logical_path, r.title
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
       JOIN knowledge_revision_chunks rc ON rc.revision_id = r.revision_id AND rc.chunk_id = c.chunk_id
       WHERE c.state = 'active' AND d.state = 'active' AND (? IS NULL OR d.source_id = ?)
       ORDER BY c.chunk_id`,
    )
    .all(sourceId ?? null, sourceId ?? null);
}

export function documentEmbeddingInput(chunk: {
  title: string | null;
  logical_path: string;
  content_text: string;
}): string {
  return [chunk.title, chunk.logical_path, chunk.content_text].filter(Boolean).join("\n");
}

export function queryEmbeddingInput(space: VectorSpaceRow, query: string): string {
  return `${space.query_instruction_text}\nQuery: ${query.normalize("NFKC").trim()}`;
}

export function embeddingInputHash(text: string): string {
  return sha256Text(text);
}

export function saveEmbedding(
  database: Database,
  input: {
    space: VectorSpaceRow;
    chunkId: string;
    contentHash: string;
    inputHash: string;
    vectorHash: string;
    vector: Float32Array;
    invocationId: string;
    actualModel: string;
  },
) {
  const existing = database
    .query<{ embedding_id: string }, [string, string, string]>(
      `SELECT embedding_id FROM knowledge_embeddings WHERE vector_space_id = ?
       AND chunk_id = ? AND chunk_content_hash = ?`,
    )
    .get(input.space.vector_space_id, input.chunkId, input.contentHash);
  if (existing) return { embedding_id: existing.embedding_id, reused: true };
  const embeddingId = createResourceId("evidence");
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE knowledge_embeddings SET state = 'stale', updated_at = ?
         WHERE vector_space_id = ? AND chunk_id = ? AND state = 'active'`,
      )
      .run(now, input.space.vector_space_id, input.chunkId);
    database
      .prepare(
        `INSERT INTO knowledge_embeddings(embedding_id, vector_space_id, chunk_id,
         chunk_content_hash, input_hash, vector_hash, provider_actual_model_id, invocation_id,
         state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        embeddingId,
        input.space.vector_space_id,
        input.chunkId,
        input.contentHash,
        input.inputHash,
        input.vectorHash,
        input.actualModel,
        input.invocationId,
        now,
        now,
      );
    upsertVector(database, {
      dimensions: input.space.dimensions,
      embeddingId,
      vectorSpaceId: input.space.vector_space_id,
      vector: input.vector,
    });
  })();
  return { embedding_id: embeddingId, reused: false };
}

export function vectorCoverage(database: Database, space: VectorSpaceRow) {
  const expected = activeChunks(database).length;
  const covered =
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
         WHERE e.vector_space_id = ? AND e.state = 'active' AND c.state = 'active'
         AND e.chunk_content_hash = c.content_hash`,
      )
      .get(space.vector_space_id)?.count ?? 0;
  return {
    expected,
    covered,
    stored: countVectors(database, space.dimensions, space.vector_space_id),
  };
}

function modelWithProvider(database: Database, modelId: string) {
  const row = database
    .query<
      {
        model_id: string;
        provider_model_id: string;
        model_revision: string;
        revision_stability: "fixed" | "floating";
        dimensions_json: string;
        provider_type: string;
        endpoint_identity: string;
      },
      [string]
    >(
      `SELECT m.*, p.provider_type, p.endpoint_identity FROM models m
       JOIN model_providers p ON p.provider_id = m.provider_id
       WHERE m.model_id = ? AND m.capability = 'embedding' AND m.state = 'active'`,
    )
    .get(modelId);
  if (!row) throw failure("model_not_found", "Embedding Model does not exist", "not_found");
  return row;
}

function spaceDto(row: VectorSpaceRow) {
  return {
    vector_space_id: row.vector_space_id,
    model_id: row.model_id,
    state: row.state,
    space_fingerprint: row.space_fingerprint,
    provider_type: row.provider_type,
    provider_endpoint_identity: row.provider_endpoint_identity,
    provider_model_id: row.provider_model_id,
    model_revision: row.model_revision,
    revision_stability: row.revision_stability,
    tokenizer_revision: row.tokenizer_revision,
    dimensions: row.dimensions,
    scalar_type: row.scalar_type,
    pooling: row.pooling,
    normalization: row.normalization,
    distance_metric: row.distance_metric,
    query_instruction_id: row.query_instruction_id,
    document_instruction_id: row.document_instruction_id,
    embedding_input_version: row.embedding_input_version,
    sentinel_fingerprint: row.sentinel_fingerprint,
    coverage_count: row.coverage_count,
    expected_chunk_count: row.expected_chunk_count,
    version: row.version,
  };
}

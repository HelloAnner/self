import { failure } from "../../shared/errors/self-error.ts";
import { readableKnowledgeDatabase } from "./knowledge-db.ts";

export async function publicationForRun(root: string, runId: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const documents = database
      .query<
        {
          document_id: string;
          revision_id: string;
          logical_path: string;
          chunk_count: number;
        },
        [string]
      >(
        `SELECT rd.document_id, rd.revision_id, rd.logical_path, COUNT(rc.chunk_id) chunk_count
         FROM knowledge_run_documents rd LEFT JOIN knowledge_revision_chunks rc ON rc.revision_id = rd.revision_id
         WHERE rd.ingestion_run_id = ? GROUP BY rd.document_id ORDER BY rd.logical_path`,
      )
      .all(runId);
    return { documents };
  } finally {
    database.close();
  }
}

export async function listKnowledgeDocuments(root: string, sourceId?: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const sql = `SELECT d.document_id, d.source_id, d.logical_path, d.media_type, d.state,
      d.current_revision_id, d.version, r.title, r.language, r.normalized_content_hash,
      (SELECT COUNT(*) FROM knowledge_revision_chunks rc WHERE rc.revision_id = d.current_revision_id) chunk_count
      FROM knowledge_documents d LEFT JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id`;
    return sourceId
      ? database
          .query<Record<string, unknown>, [string]>(
            `${sql} WHERE d.source_id = ? ORDER BY d.logical_path`,
          )
          .all(sourceId)
      : database
          .query<Record<string, unknown>, []>(`${sql} ORDER BY d.source_id, d.logical_path`)
          .all();
  } finally {
    database.close();
  }
}

export async function showKnowledgeDocument(root: string, documentId: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const document = database
      .query<Record<string, unknown>, [string]>(
        `SELECT d.*, r.snapshot_id, r.logical_path revision_logical_path, r.blob_sha256,
         r.sequence revision_sequence, r.parser_id, r.parser_version, r.normalizer_version,
         r.normalized_content_hash, r.structure_hash, r.title, r.language, r.content_text,
         r.metadata_json, r.ingestion_run_id
         FROM knowledge_documents d LEFT JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
         WHERE d.document_id = ?`,
      )
      .get(documentId);
    if (!document)
      throw failure("document_not_found", `Unknown Document: ${documentId}`, "not_found");
    const revisions = database
      .query<Record<string, unknown>, [string]>(
        "SELECT revision_id, snapshot_id, sequence, normalized_content_hash, created_at FROM knowledge_revisions WHERE document_id = ? ORDER BY sequence DESC",
      )
      .all(documentId);
    return { ...document, revisions };
  } finally {
    database.close();
  }
}

export async function listKnowledgeChunks(
  root: string,
  options: { documentId?: string; sourceId?: string; includeTombstoned?: boolean } = {},
) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const conditions = [options.includeTombstoned ? "1 = 1" : "c.state = 'active'"];
    const parameters: string[] = [];
    if (options.documentId) {
      conditions.push("c.document_id = ?");
      parameters.push(options.documentId);
    }
    if (options.sourceId) {
      conditions.push("d.source_id = ?");
      parameters.push(options.sourceId);
    }
    return database
      .query<Record<string, unknown>, string[]>(
        `SELECT c.chunk_id, c.document_id, d.source_id, d.logical_path, c.content_hash,
         c.block_kind, c.token_estimate, c.state, c.content_text, rc.ordinal,
         rc.heading_path_json, rc.source_start_line, rc.source_end_line, d.current_revision_id revision_id
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id
         LEFT JOIN knowledge_revision_chunks rc ON rc.chunk_id = c.chunk_id AND rc.revision_id = d.current_revision_id
         WHERE ${conditions.join(" AND ")} ORDER BY d.logical_path, rc.ordinal`,
      )
      .all(...parameters);
  } finally {
    database.close();
  }
}

export async function showKnowledgeChunk(root: string, chunkId: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const chunk = database
      .query<Record<string, unknown>, [string]>(
        `SELECT c.*, d.source_id, d.logical_path, d.current_revision_id,
         r.snapshot_id, r.blob_sha256, rc.ordinal, rc.heading_path_json,
         rc.source_start_line, rc.source_end_line
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id
         LEFT JOIN knowledge_revision_chunks rc ON rc.chunk_id = c.chunk_id AND rc.revision_id = d.current_revision_id
         LEFT JOIN knowledge_revisions r ON r.revision_id = rc.revision_id WHERE c.chunk_id = ?`,
      )
      .get(chunkId);
    if (!chunk) throw failure("chunk_not_found", `Unknown Chunk: ${chunkId}`, "not_found");
    const lineage = database
      .query<Record<string, unknown>, [string, string]>(
        `SELECT * FROM knowledge_chunk_lineage WHERE previous_chunk_id = ? OR next_chunk_id = ?
         ORDER BY created_at`,
      )
      .all(chunkId, chunkId);
    return { ...chunk, lineage };
  } finally {
    database.close();
  }
}

export async function verifyKnowledge(root: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const checks = {
      active_documents_without_revision: scalar(
        database,
        "SELECT COUNT(*) count FROM knowledge_documents WHERE state = 'active' AND current_revision_id IS NULL",
      ),
      active_chunks_without_current_mapping: scalar(
        database,
        `SELECT COUNT(*) count FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id
         LEFT JOIN knowledge_revision_chunks rc ON rc.chunk_id = c.chunk_id AND rc.revision_id = d.current_revision_id
         WHERE c.state = 'active' AND rc.chunk_id IS NULL`,
      ),
      revisions_without_snapshot_entry: scalar(
        database,
        `SELECT COUNT(*) count FROM knowledge_revisions r LEFT JOIN source_snapshot_entries e
         ON e.snapshot_id = r.snapshot_id AND e.logical_path = r.logical_path WHERE e.snapshot_id IS NULL`,
      ),
      ready_runs_without_revision: scalar(
        database,
        `SELECT COUNT(*) count FROM (
           SELECT i.ingestion_run_id FROM ingestion_runs i LEFT JOIN knowledge_run_documents r
           ON r.ingestion_run_id = i.ingestion_run_id
           WHERE i.state = 'ready' AND i.files_parsed > 0
           GROUP BY i.ingestion_run_id HAVING COUNT(r.document_id) = 0
         ) missing`,
      ),
    };
    const failed = Object.entries(checks).filter(([, count]) => count > 0);
    return { status: failed.length === 0 ? "pass" : "fail", checks };
  } finally {
    database.close();
  }
}

function scalar(
  database: Awaited<ReturnType<typeof readableKnowledgeDatabase>>,
  sql: string,
): number {
  return database.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

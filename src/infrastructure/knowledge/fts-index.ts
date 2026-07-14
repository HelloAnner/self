import type { Database } from "bun:sqlite";
import { createResourceId } from "../../shared/ids/id.ts";
import { writableKnowledgeDatabase } from "./knowledge-db.ts";

const FTS_ALGORITHM = "trigram-v1";

export async function rebuildFtsIndex(root: string) {
  const database = await writableKnowledgeDatabase(root);
  const generationId = createResourceId("index-generation");
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `UPDATE knowledge_index_generations SET state = 'failed',
         last_error_code = 'fts_build_interrupted', updated_at = ?
         WHERE index_kind = 'fts' AND state IN ('building', 'verifying')`,
      )
      .run(now);
    const chunks = activeFtsRows(database);
    const watermark = indexWatermark(chunks);
    database
      .prepare(
        `INSERT INTO knowledge_index_generations(index_generation_id, index_kind, state,
         algorithm_version, input_watermark, expected_chunk_count, created_at, updated_at)
         VALUES (?, 'fts', 'building', ?, ?, ?, ?, ?)`,
      )
      .run(generationId, FTS_ALGORITHM, watermark, chunks.length, now, now);
    try {
      insertRows(database, generationId, chunks);
      const indexed = countGeneration(database, generationId);
      if (indexed !== chunks.length) throw new Error("FTS coverage mismatch");
      if (process.env.SELF_TEST_CRASH_FTS_BEFORE_SWAP === "1") process.exit(98);
      database.transaction(() => {
        const previous = activeFtsGeneration(database);
        database
          .prepare(
            `UPDATE knowledge_index_generations SET state = 'ready', indexed_chunk_count = ?,
             verified_at = ?, updated_at = ? WHERE index_generation_id = ?`,
          )
          .run(indexed, now, now, generationId);
        if (previous)
          database
            .prepare(
              `UPDATE knowledge_index_generations SET state = 'deprecated', deprecated_at = ?,
               updated_at = ? WHERE index_generation_id = ? AND state = 'ready'`,
            )
            .run(now, now, previous);
        database
          .prepare(
            `UPDATE knowledge_active_indexes SET active_generation_id = ?,
             previous_generation_id = ?, updated_at = ? WHERE index_kind = 'fts'`,
          )
          .run(generationId, previous, now);
      })();
      return {
        index_generation_id: generationId,
        state: "ready" as const,
        indexed_chunk_count: indexed,
        previous_generation_id: activePrevious(database),
      };
    } catch (cause) {
      database
        .prepare(
          `UPDATE knowledge_index_generations SET state = 'failed', last_error_code = 'fts_build_failed',
           updated_at = ? WHERE index_generation_id = ?`,
        )
        .run(new Date().toISOString(), generationId);
      throw cause;
    }
  } finally {
    database.close();
  }
}

export async function syncFtsForSource(root: string, sourceId: string) {
  const database = await writableKnowledgeDatabase(root);
  let rebuild = false;
  let result: { index_generation_id: string; state: "ready"; refreshed: number } | undefined;
  try {
    const generationId = activeFtsGeneration(database);
    if (!generationId) {
      rebuild = true;
    } else {
      const rows = activeFtsRows(database, sourceId);
      database.transaction(() => {
        database
          .prepare("DELETE FROM knowledge_fts WHERE index_generation_id = ? AND source_id = ?")
          .run(generationId, sourceId);
        insertRows(database, generationId, rows);
        const total = countGeneration(database, generationId);
        database
          .prepare(
            `UPDATE knowledge_index_generations SET expected_chunk_count = ?, indexed_chunk_count = ?,
             input_watermark = ?, updated_at = ? WHERE index_generation_id = ?`,
          )
          .run(total, total, currentWatermark(database), new Date().toISOString(), generationId);
      })();
      result = { index_generation_id: generationId, state: "ready", refreshed: rows.length };
    }
  } finally {
    database.close();
  }
  if (rebuild) return rebuildFtsIndex(root);
  return result;
}

export function activeFtsGeneration(database: Database): string | null {
  return (
    database
      .query<{ active_generation_id: string | null }, []>(
        "SELECT active_generation_id FROM knowledge_active_indexes WHERE index_kind = 'fts'",
      )
      .get()?.active_generation_id ?? null
  );
}

type FtsRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  revision_id: string;
  content_text: string;
  title_text: string;
  path_text: string;
  tags_text: string;
};

function activeFtsRows(database: Database, sourceId?: string): FtsRow[] {
  return database
    .query<FtsRow, [string | null, string | null]>(
      `SELECT c.chunk_id, c.document_id, d.source_id, r.revision_id, c.content_text,
       COALESCE(r.title, '') title_text, d.logical_path path_text,
       COALESCE(json_extract(r.metadata_json, '$.tags'), '') tags_text
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
       JOIN knowledge_revision_chunks rc ON rc.revision_id = r.revision_id AND rc.chunk_id = c.chunk_id
       WHERE c.state = 'active' AND d.state = 'active' AND (? IS NULL OR d.source_id = ?)
       ORDER BY c.chunk_id`,
    )
    .all(sourceId ?? null, sourceId ?? null);
}

function insertRows(database: Database, generationId: string, rows: FtsRow[]): void {
  const insert = database.prepare(
    `INSERT INTO knowledge_fts(index_generation_id, chunk_id, document_id, source_id, revision_id,
     content_text, title_text, path_text, tags_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      generationId,
      row.chunk_id,
      row.document_id,
      row.source_id,
      row.revision_id,
      row.content_text,
      row.title_text,
      row.path_text,
      row.tags_text,
    );
}

function countGeneration(database: Database, generationId: string): number {
  return (
    database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM knowledge_fts WHERE index_generation_id = ?",
      )
      .get(generationId)?.count ?? 0
  );
}

function currentWatermark(database: Database): string {
  return (
    database
      .query<{ watermark: string }, []>(
        "SELECT COALESCE(MAX(updated_at), 'empty') watermark FROM knowledge_chunks WHERE state = 'active'",
      )
      .get()?.watermark ?? "empty"
  );
}

function indexWatermark(rows: FtsRow[]): string {
  return `${rows.length}:${rows.at(-1)?.chunk_id ?? "empty"}`;
}

function activePrevious(database: Database): string | null {
  return (
    database
      .query<{ previous_generation_id: string | null }, []>(
        "SELECT previous_generation_id FROM knowledge_active_indexes WHERE index_kind = 'fts'",
      )
      .get()?.previous_generation_id ?? null
  );
}

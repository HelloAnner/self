import type { Database } from "bun:sqlite";
import type {
  KnowledgeDocumentDraft,
  KnowledgePublishResult,
  PublishedDocument,
} from "../../domains/knowledge/index.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { alignChunks, type PreviousChunk, textSimilarity } from "./chunk-alignment.ts";
import { writableKnowledgeDatabase } from "./knowledge-db.ts";

type DocumentRow = {
  document_id: string;
  logical_path: string;
  normalized_path_key: string;
  current_revision_id: string | null;
  state: "active" | "deleted";
};

export async function publishKnowledgeSnapshot(
  root: string,
  input: {
    ingestionRunId: string;
    sourceId: string;
    snapshotId: string;
    algorithmFingerprint: string;
    drafts: KnowledgeDocumentDraft[];
    presentPaths: string[];
    renames: Map<string, string>;
  },
): Promise<KnowledgePublishResult> {
  const database = await writableKnowledgeDatabase(root);
  try {
    return database.transaction(() => publish(database, input))();
  } finally {
    database.close();
  }
}

function publish(
  database: Database,
  input: {
    ingestionRunId: string;
    sourceId: string;
    snapshotId: string;
    algorithmFingerprint: string;
    drafts: KnowledgeDocumentDraft[];
    presentPaths: string[];
    renames: Map<string, string>;
  },
): KnowledgePublishResult {
  const now = new Date().toISOString();
  applyRenames(database, input.sourceId, input.renames, now);
  const published: PublishedDocument[] = [];
  let createdChunks = 0;
  let reusedChunks = 0;
  let tombstonedChunks = 0;
  for (const draft of input.drafts) {
    const result = publishDocument(database, {
      runId: input.ingestionRunId,
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      algorithmFingerprint: input.algorithmFingerprint,
      draft,
      now,
    });
    published.push(result.document);
    database
      .prepare(
        `INSERT OR REPLACE INTO knowledge_run_documents(ingestion_run_id, document_id,
         revision_id, logical_path, reused_revision, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ingestionRunId,
        result.document.document_id,
        result.document.revision_id,
        result.document.logical_path,
        result.document.reused_revision ? 1 : 0,
        now,
      );
    createdChunks += result.created;
    reusedChunks += result.reused;
    tombstonedChunks += result.tombstoned;
  }
  tombstonedChunks += tombstoneMissingDocuments(
    database,
    input.sourceId,
    new Set(input.presentPaths.map(normalizePath)),
    now,
  );
  return {
    documents: published,
    documents_published: published.length,
    chunks_published: createdChunks,
    chunks_reused: reusedChunks,
    chunks_tombstoned: tombstonedChunks,
  };
}

function publishDocument(
  database: Database,
  input: {
    runId: string;
    sourceId: string;
    snapshotId: string;
    algorithmFingerprint: string;
    draft: KnowledgeDocumentDraft;
    now: string;
  },
) {
  const pathKey = normalizePath(input.draft.document.logical_path);
  const document = findOrCreateDocument(database, input.sourceId, input.draft, pathKey, input.now);
  const unchanged = document.current_revision_id
    ? database
        .query<{ revision_id: string }, [string, string, string]>(
          `SELECT revision_id FROM knowledge_revisions WHERE revision_id = ?
           AND blob_sha256 = ? AND algorithm_fingerprint = ?`,
        )
        .get(document.current_revision_id, input.draft.blob_sha256, input.algorithmFingerprint)
    : null;
  if (unchanged) {
    const chunkIds = revisionChunkIds(database, unchanged.revision_id);
    activateDocument(database, document.document_id, unchanged.revision_id, input.now);
    return reusedDocument(
      document.document_id,
      unchanged.revision_id,
      input.draft.document.logical_path,
      chunkIds,
    );
  }
  const existing = database
    .query<{ revision_id: string }, [string, string, string]>(
      `SELECT revision_id FROM knowledge_revisions
       WHERE document_id = ? AND snapshot_id = ? AND algorithm_fingerprint = ?`,
    )
    .get(document.document_id, input.snapshotId, input.algorithmFingerprint);
  if (existing) {
    const chunkIds = revisionChunkIds(database, existing.revision_id);
    activateDocument(database, document.document_id, existing.revision_id, input.now);
    return reusedDocument(
      document.document_id,
      existing.revision_id,
      input.draft.document.logical_path,
      chunkIds,
    );
  }
  const revisionId = createResourceId("revision");
  const sequence = nextRevisionSequence(database, document.document_id);
  insertRevision(database, { ...input, document, revisionId, sequence });
  const previous = previousChunks(database, document.current_revision_id);
  const alignment = alignChunks(previous, input.draft.chunks);
  const chunkIds: string[] = [];
  let created = 0;
  let reused = 0;
  for (const item of alignment.aligned) {
    const chunkId = item.exact?.chunk_id ?? createResourceId("chunk");
    chunkIds.push(chunkId);
    if (item.exact) {
      reused += 1;
      database
        .prepare(
          `UPDATE knowledge_chunks SET state = 'active', last_seen_revision_id = ?, updated_at = ?,
           tombstoned_at = NULL WHERE chunk_id = ?`,
        )
        .run(revisionId, input.now, chunkId);
    } else {
      created += 1;
      insertChunk(database, document.document_id, revisionId, chunkId, item.draft, input.now);
      if (item.replaced)
        insertLineage(
          database,
          item.replaced,
          chunkId,
          item.draft.content_text,
          input.runId,
          input.now,
        );
    }
    insertRevisionChunk(database, revisionId, chunkId, item.draft, input.now);
  }
  let tombstoned = 0;
  for (const unused of alignment.unused) {
    if (chunkIds.includes(unused.chunk_id)) continue;
    const changed = database
      .prepare(
        `UPDATE knowledge_chunks SET state = 'tombstoned', tombstoned_at = ?, updated_at = ?
         WHERE chunk_id = ? AND state = 'active'`,
      )
      .run(input.now, input.now, unused.chunk_id).changes;
    tombstoned += changed;
  }
  activateDocument(database, document.document_id, revisionId, input.now);
  return {
    document: {
      document_id: document.document_id,
      revision_id: revisionId,
      logical_path: input.draft.document.logical_path,
      reused_revision: false,
      chunk_ids: chunkIds,
    },
    created,
    reused,
    tombstoned,
  };
}

function revisionChunkIds(database: Database, revisionId: string): string[] {
  return database
    .query<{ chunk_id: string }, [string]>(
      "SELECT chunk_id FROM knowledge_revision_chunks WHERE revision_id = ? ORDER BY ordinal",
    )
    .all(revisionId)
    .map((row) => row.chunk_id);
}

function reusedDocument(
  documentId: string,
  revisionId: string,
  logicalPath: string,
  chunkIds: string[],
) {
  return {
    document: {
      document_id: documentId,
      revision_id: revisionId,
      logical_path: logicalPath,
      reused_revision: true,
      chunk_ids: chunkIds,
    },
    created: 0,
    reused: chunkIds.length,
    tombstoned: 0,
  };
}

function findOrCreateDocument(
  database: Database,
  sourceId: string,
  draft: KnowledgeDocumentDraft,
  pathKey: string,
  now: string,
): DocumentRow {
  const existing = database
    .query<DocumentRow, [string, string]>(
      "SELECT * FROM knowledge_documents WHERE source_id = ? AND normalized_path_key = ?",
    )
    .get(sourceId, pathKey);
  if (existing) return existing;
  const documentId = createResourceId("document");
  database
    .prepare(
      `INSERT INTO knowledge_documents(document_id, source_id, logical_path, normalized_path_key,
       media_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      documentId,
      sourceId,
      draft.document.logical_path,
      pathKey,
      draft.document.media_type,
      now,
      now,
    );
  return {
    document_id: documentId,
    logical_path: draft.document.logical_path,
    normalized_path_key: pathKey,
    current_revision_id: null,
    state: "active",
  };
}

function insertRevision(
  database: Database,
  input: {
    runId: string;
    snapshotId: string;
    algorithmFingerprint: string;
    draft: KnowledgeDocumentDraft;
    document: DocumentRow;
    revisionId: string;
    sequence: number;
    now: string;
  },
): void {
  const doc = input.draft.document;
  database
    .prepare(
      `INSERT INTO knowledge_revisions(revision_id, document_id, snapshot_id, logical_path,
       blob_sha256, sequence, previous_revision_id, parser_id, parser_version, normalizer_version,
       algorithm_fingerprint,
       normalized_content_hash, structure_hash, title, language, content_text, metadata_json,
       ingestion_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.revisionId,
      input.document.document_id,
      input.snapshotId,
      doc.logical_path,
      input.draft.blob_sha256,
      input.sequence,
      input.document.current_revision_id,
      doc.parser_id,
      doc.parser_version,
      doc.normalizer_version,
      input.algorithmFingerprint,
      doc.normalized_content_hash,
      doc.structure_hash,
      doc.title,
      doc.language,
      doc.text,
      JSON.stringify({
        ...doc.metadata,
        links: doc.links,
        tags: doc.tags,
        frontmatter: doc.frontmatter,
      }),
      input.runId,
      input.now,
    );
}

function insertChunk(
  database: Database,
  documentId: string,
  revisionId: string,
  chunkId: string,
  draft: KnowledgeDocumentDraft["chunks"][number],
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO knowledge_chunks(chunk_id, document_id, content_hash, content_text, block_kind,
       token_estimate, state, first_seen_revision_id, last_seen_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      chunkId,
      documentId,
      draft.content_hash,
      draft.content_text,
      draft.block_kind,
      draft.token_estimate,
      revisionId,
      revisionId,
      now,
      now,
    );
}

function insertRevisionChunk(
  database: Database,
  revisionId: string,
  chunkId: string,
  draft: KnowledgeDocumentDraft["chunks"][number],
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO knowledge_revision_chunks(revision_id, chunk_id, ordinal, heading_path_json,
       source_start_line, source_end_line, anchor_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revisionId,
      chunkId,
      draft.ordinal,
      JSON.stringify(draft.heading_path),
      draft.source_start_line,
      draft.source_end_line,
      draft.anchor_key,
      now,
    );
}

function insertLineage(
  database: Database,
  previous: PreviousChunk,
  nextChunkId: string,
  nextText: string,
  runId: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO knowledge_chunk_lineage(previous_chunk_id, next_chunk_id,
       ingestion_run_id, relationship, score, created_at) VALUES (?, ?, ?, 'modified', ?, ?)`,
    )
    .run(
      previous.chunk_id,
      nextChunkId,
      runId,
      textSimilarity(previous.content_text, nextText),
      now,
    );
}

function previousChunks(database: Database, revisionId: string | null): PreviousChunk[] {
  if (!revisionId) return [];
  return database
    .query<PreviousChunk, [string]>(
      `SELECT c.chunk_id, c.content_hash, c.content_text, rc.anchor_key, rc.ordinal
       FROM knowledge_revision_chunks rc JOIN knowledge_chunks c ON c.chunk_id = rc.chunk_id
       WHERE rc.revision_id = ? ORDER BY rc.ordinal`,
    )
    .all(revisionId);
}

function nextRevisionSequence(database: Database, documentId: string): number {
  return (
    (database
      .query<{ sequence: number }, [string]>(
        "SELECT sequence FROM knowledge_revisions WHERE document_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(documentId)?.sequence ?? 0) + 1
  );
}

function activateDocument(
  database: Database,
  documentId: string,
  revisionId: string,
  now: string,
): void {
  database
    .prepare(
      `UPDATE knowledge_documents SET state = 'active', current_revision_id = ?, deleted_at = NULL,
       updated_at = ?, version = version + 1 WHERE document_id = ?`,
    )
    .run(revisionId, now, documentId);
}

function tombstoneMissingDocuments(
  database: Database,
  sourceId: string,
  present: Set<string>,
  now: string,
): number {
  const documents = database
    .query<DocumentRow, [string]>(
      "SELECT * FROM knowledge_documents WHERE source_id = ? AND state = 'active'",
    )
    .all(sourceId);
  let chunks = 0;
  for (const document of documents) {
    if (present.has(document.normalized_path_key)) continue;
    database
      .prepare(
        "UPDATE knowledge_documents SET state = 'deleted', deleted_at = ?, updated_at = ?, version = version + 1 WHERE document_id = ?",
      )
      .run(now, now, document.document_id);
    chunks += database
      .prepare(
        "UPDATE knowledge_chunks SET state = 'tombstoned', tombstoned_at = ?, updated_at = ? WHERE document_id = ? AND state = 'active'",
      )
      .run(now, now, document.document_id).changes;
  }
  return chunks;
}

function applyRenames(
  database: Database,
  sourceId: string,
  renames: Map<string, string>,
  now: string,
): void {
  for (const [previous, current] of renames) {
    const conflict = database
      .query<{ document_id: string }, [string, string]>(
        "SELECT document_id FROM knowledge_documents WHERE source_id = ? AND normalized_path_key = ?",
      )
      .get(sourceId, normalizePath(current));
    if (conflict) continue;
    database
      .prepare(
        `UPDATE knowledge_documents SET logical_path = ?, normalized_path_key = ?, updated_at = ?,
         version = version + 1 WHERE source_id = ? AND normalized_path_key = ?`,
      )
      .run(current, normalizePath(current), now, sourceId, normalizePath(previous));
  }
}

function normalizePath(path: string): string {
  return path.normalize("NFC");
}

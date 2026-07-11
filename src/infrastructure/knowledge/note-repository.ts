import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { readableKnowledgeDatabase, writableKnowledgeDatabase } from "./knowledge-db.ts";

export async function createNoteRecord(
  root: string,
  input: {
    noteId: string;
    sourceId: string;
    documentId: string;
    relativePath: string;
    title: string;
    operationId: string;
    requestId: string;
  },
) {
  const database = await writableKnowledgeDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO knowledge_notes(note_id, source_id, document_id, relative_path, title,
           state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.noteId,
          input.sourceId,
          input.documentId,
          input.relativePath,
          input.title,
          now,
          now,
        );
      recordOperation(
        database,
        input.operationId,
        input.requestId,
        "note.create",
        input.noteId,
        input.relativePath,
        now,
      );
    })();
    return { ...(await getNote(root, input.noteId)), operation_id: input.operationId };
  } finally {
    database.close();
  }
}

export async function updateNoteRecord(
  root: string,
  input: {
    noteId: string;
    expectedVersion: number;
    documentId: string;
    title: string;
    operationId: string;
    requestId: string;
  },
) {
  const database = await writableKnowledgeDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE knowledge_notes SET document_id = ?, title = ?, version = version + 1,
           updated_at = ? WHERE note_id = ? AND version = ? AND state = 'active'`,
        )
        .run(input.documentId, input.title, now, input.noteId, input.expectedVersion);
      if (result.changes !== 1)
        throw failure("note_version_conflict", "Note changed after it was read", "conflict");
      recordOperation(
        database,
        input.operationId,
        input.requestId,
        "note.update",
        input.noteId,
        input.title,
        now,
      );
    })();
    return { ...(await getNote(root, input.noteId)), operation_id: input.operationId };
  } finally {
    database.close();
  }
}

export async function getNote(root: string, noteId: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    const note = database
      .query<Record<string, unknown>, [string]>(
        `SELECT n.*, d.current_revision_id, r.snapshot_id, r.normalized_content_hash
         FROM knowledge_notes n LEFT JOIN knowledge_documents d ON d.document_id = n.document_id
         LEFT JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id WHERE n.note_id = ?`,
      )
      .get(noteId);
    if (!note) throw failure("note_not_found", `Unknown Note: ${noteId}`, "not_found");
    return note;
  } finally {
    database.close();
  }
}

export async function listNotes(root: string) {
  const database = await readableKnowledgeDatabase(root);
  try {
    return database
      .query<Record<string, unknown>, []>(
        "SELECT note_id, source_id, document_id, relative_path, title, state, version, updated_at FROM knowledge_notes ORDER BY updated_at DESC",
      )
      .all();
  } finally {
    database.close();
  }
}

function recordOperation(
  database: Awaited<ReturnType<typeof writableKnowledgeDatabase>>,
  operationId: string,
  requestId: string,
  kind: string,
  targetId: string,
  input: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash,
       result_json, created_at, completed_at) VALUES (?, ?, ?, 'succeeded', ?, ?, '{}', ?, ?)`,
    )
    .run(operationId, requestId, kind, targetId, sha256Text(input), now, now);
}

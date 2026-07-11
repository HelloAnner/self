import { join } from "node:path";
import { z } from "zod";
import { recordManagedWriteReceipt } from "../../infrastructure/connection/managed-write-repository.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { listKnowledgeDocuments } from "../../infrastructure/knowledge/knowledge-reader.ts";
import {
  createNoteRecord,
  getNote,
  listNotes,
  updateNoteRecord,
} from "../../infrastructure/knowledge/note-repository.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { addSource, syncSource } from "../source/source-archive.ts";

const noteRow = z.object({
  note_id: z.string(),
  source_id: z.string(),
  relative_path: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
});

export async function createNote(
  root: string,
  input: { title: string; content: string },
  requestId: string,
) {
  const noteId = createResourceId("note");
  const operationId = createResourceId("operation");
  const relativePath = `content/notes/${slug(input.title)}-${noteId.slice(-8)}.md`;
  const absolutePath = join(root, relativePath);
  const content = noteContent(noteId, input.title, input.content);
  await recordManagedWriteReceipt(root, {
    absolutePath,
    expectedHash: sha256Text(content),
    operationId,
  });
  await atomicWrite(absolutePath, content);
  const source = await addSource(
    root,
    {
      input: absolutePath,
      kind: "markdown",
      mode: "snapshot",
      name: input.title,
      recursive: false,
      include: [],
      exclude: [],
      noBuild: false,
    },
    requestId,
  );
  const documentId = await documentForSource(
    root,
    source.source_id,
    relativePath.split("/").at(-1) ?? "",
  );
  return createNoteRecord(root, {
    noteId,
    sourceId: source.source_id,
    documentId,
    relativePath,
    title: input.title,
    operationId,
    requestId,
  });
}

export async function updateNote(
  root: string,
  noteId: string,
  input: { title?: string; content: string; ifVersion: number },
  requestId: string,
) {
  const note = noteRow.parse(await getNote(root, noteId));
  if (note.version !== input.ifVersion) {
    const { failure } = await import("../../shared/errors/self-error.ts");
    throw failure("note_version_conflict", "Note version precondition did not match", "conflict");
  }
  const title = input.title ?? note.title;
  const absolutePath = join(root, note.relative_path);
  const operationId = createResourceId("operation");
  const content = noteContent(note.note_id, title, input.content);
  await recordManagedWriteReceipt(root, {
    absolutePath,
    expectedHash: sha256Text(content),
    operationId,
  });
  await atomicWrite(absolutePath, content);
  await syncSource(root, note.source_id, requestId);
  const documentId = await documentForSource(
    root,
    note.source_id,
    note.relative_path.split("/").at(-1) ?? "",
  );
  return updateNoteRecord(root, {
    noteId,
    expectedVersion: input.ifVersion,
    documentId,
    title,
    operationId,
    requestId,
  });
}

export { getNote, listNotes };

async function documentForSource(
  root: string,
  sourceId: string,
  filename: string,
): Promise<string> {
  const documents = await listKnowledgeDocuments(root, sourceId);
  const selected = documents.find(
    (document) => document.logical_path === filename && typeof document.document_id === "string",
  );
  if (!selected || typeof selected.document_id !== "string") {
    throw new Error("Note ingestion did not publish its Document");
  }
  return selected.document_id;
}

function noteContent(noteId: string, title: string, body: string): string {
  return `---\nself_note_id: ${noteId}\ntitle: ${JSON.stringify(title)}\n---\n# ${title}\n\n${body.trim()}\n`;
}

function slug(title: string): string {
  const value = title
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return value || "note";
}

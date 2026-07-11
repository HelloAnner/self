import type { CommandSpec } from "./command-specs.ts";

type JsonSchema = Record<string, unknown>;
const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const object = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const root = { root: string("Workspace Root"), json: boolean("Emit JSON") };

export const KNOWLEDGE_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "knowledge.build": object(
    {
      ...root,
      source: string("Optional Source public ID"),
      snapshot: string("Optional Snapshot public ID"),
      all: boolean("Build every current Snapshot"),
    },
    ["root"],
  ),
  "knowledge.rebuild": object(
    {
      ...root,
      layer: { type: "string", enum: ["parse", "chunks", "all"] },
      source: string("Optional Source public ID"),
      all: boolean("Rebuild every current Snapshot"),
    },
    ["root", "layer"],
  ),
  "knowledge.status": object({ ...root, source: string("Optional Source public ID") }, ["root"]),
  "knowledge.failures": object({ ...root, source: string("Optional Source public ID") }, ["root"]),
  "knowledge.verify": object({ ...root, deep: boolean("Run deep evidence checks") }, ["root"]),
  "knowledge.explain": object({ ...root, chunk_id: string("Chunk public ID") }, [
    "root",
    "chunk_id",
  ]),
  "knowledge.document.list": object({ ...root, source: string("Optional Source public ID") }, [
    "root",
  ]),
  "knowledge.document.show": object({ ...root, document_id: string("Document public ID") }, [
    "root",
    "document_id",
  ]),
  "knowledge.chunk.list": object(
    {
      ...root,
      source: string("Optional Source public ID"),
      document: string("Optional Document public ID"),
      include_tombstoned: boolean("Include tombstoned Chunks"),
    },
    ["root"],
  ),
  "knowledge.chunk.show": object({ ...root, chunk_id: string("Chunk public ID") }, [
    "root",
    "chunk_id",
  ]),
  "ingestion.show": object({ ...root, ingestion_id: string("IngestionRun public ID") }, [
    "root",
    "ingestion_id",
  ]),
  "ingestion.retry": object({ ...root, ingestion_id: string("IngestionRun public ID") }, [
    "root",
    "ingestion_id",
  ]),
  "note.create": object(
    { ...root, title: string("Note title"), content: string("Markdown body") },
    ["root", "title", "content"],
  ),
  "note.update": object(
    {
      ...root,
      note_id: string("Note public ID"),
      title: string("Optional new title"),
      content: string("Complete Markdown body"),
      if_version: string("Required optimistic Note version"),
    },
    ["root", "note_id", "content", "if_version"],
  ),
  "note.list": object(root, ["root"]),
  "note.show": object({ ...root, note_id: string("Note public ID") }, ["root", "note_id"]),
};

export const KNOWLEDGE_COMMAND_SPECS: CommandSpec[] = [
  {
    id: "knowledge.build",
    summary: "Ingest archived Snapshots into Knowledge",
    root: "required",
    execution: "write",
  },
  {
    id: "knowledge.rebuild",
    summary: "Deterministically rebuild parse or Chunk layers",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "knowledge.status",
    summary: "Show Source-specific ingestion state",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.failures",
    summary: "List failed IngestionRuns and entries",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.verify",
    summary: "Verify Snapshot-to-Chunk evidence invariants",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.explain",
    summary: "Explain one Chunk and its evidence path",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.document.list",
    summary: "List normalized Documents",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.document.show",
    summary: "Show a Document and Revision history",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.chunk.list",
    summary: "List stable Knowledge Chunks",
    root: "required",
    execution: "read",
  },
  {
    id: "knowledge.chunk.show",
    summary: "Show a Chunk and Revision evidence",
    root: "required",
    execution: "read",
  },
  {
    id: "ingestion.show",
    summary: "Show an IngestionRun and entry results",
    root: "required",
    execution: "read",
  },
  {
    id: "ingestion.retry",
    summary: "Retry a failed or interrupted IngestionRun",
    root: "required",
    execution: "write",
  },
  {
    id: "note.create",
    summary: "Create and ingest a managed Markdown Note",
    root: "required",
    execution: "write",
  },
  {
    id: "note.update",
    summary: "Version a managed Note with an optimistic precondition",
    root: "required",
    execution: "write",
  },
  { id: "note.list", summary: "List managed Notes", root: "required", execution: "read" },
  {
    id: "note.show",
    summary: "Show a managed Note and current evidence",
    root: "required",
    execution: "read",
  },
];

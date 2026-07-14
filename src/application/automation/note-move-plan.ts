import type { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { automationInputHash } from "../../domains/automation/index.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { type MutationDescription, plannedChange } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export async function describeNoteMove(
  database: Database,
  root: string,
  noteId: string,
  target: string,
): Promise<MutationDescription> {
  const note = database
    .query<Row, [string]>(
      `SELECT note_id, source_id, relative_path, state, version FROM knowledge_notes
       WHERE note_id = ?`,
    )
    .get(noteId);
  if (!note) throw failure("note_not_found", "Note does not exist", "not_found");
  if (note.state !== "active")
    throw failure("note_state_invalid", "Only an active Note can move", "state");
  const sourceId = String(note.source_id);
  const source = database
    .query<Row, [string]>(
      "SELECT source_id, spec_json, state, version FROM sources WHERE source_id = ?",
    )
    .get(sourceId);
  if (source?.state !== "active")
    throw failure("source_state_invalid", "Managed Note Source is not active", "state");
  const oldRelativePath = String(note.relative_path);
  const oldAbsolutePath = resolve(root, oldRelativePath);
  const newRelativePath = targetNotePath(root, oldRelativePath, target);
  if (newRelativePath === oldRelativePath)
    throw failure("note_move_invalid", "Note already belongs to the requested directory", "usage");
  const newAbsolutePath = resolve(root, newRelativePath);
  if (await Bun.file(newAbsolutePath).exists())
    throw failure("note_move_conflict", "Note move target already exists", "conflict");
  await assertSafeParents(root, dirname(newAbsolutePath));
  if (!(await Bun.file(oldAbsolutePath).exists()))
    throw failure("note_file_missing", "Managed Note file is missing", "state");
  const fileHash = await sha256File(oldAbsolutePath);
  const oldSpec = JSON.parse(String(source.spec_json)) as Record<string, unknown>;
  const newSpec = {
    ...oldSpec,
    locator_type: "managed_path",
    locator: newRelativePath,
  };
  const changes = [
    plannedChange(
      "note",
      noteId,
      { note_id: noteId },
      { relative_path: oldRelativePath, version: note.version },
      { relative_path: newRelativePath, version: Number(note.version) + 1 },
      "moved",
    ),
    plannedChange(
      "source",
      sourceId,
      { source_id: sourceId },
      { spec_json: oldSpec, version: source.version },
      { spec_json: newSpec, version: Number(source.version) + 1 },
      "locator_changed",
    ),
  ];
  const impactHash = automationInputHash({ changes, file_hash: fileHash });
  return {
    preconditions: {
      note_version: note.version,
      source_version: source.version,
      old_relative_path: oldRelativePath,
      new_relative_path: newRelativePath,
      file_hash: fileHash,
      impact_hash: impactHash,
    },
    impact: {
      files: [{ from: oldRelativePath, to: newRelativePath, sha256: fileHash }],
      source_id: sourceId,
      snapshots_changed: 0,
      revisions_changed: 0,
      change_count: changes.length,
      impact_hash: impactHash,
    },
    changes,
    inverse: {
      action: "note_move",
      note_id: noteId,
      from: newRelativePath,
      to: oldRelativePath,
      file_hash: fileHash,
    },
    reversible: true,
    targets: [
      {
        resourceId: noteId,
        resourceKind: "note",
        role: "primary",
        expectedVersion: Number(note.version),
        expectedState: "active",
      },
      {
        resourceId: sourceId,
        resourceKind: "source",
        role: "precondition",
        expectedVersion: Number(source.version),
        expectedState: "active",
      },
    ],
  };
}

function targetNotePath(root: string, oldRelativePath: string, target: string): string {
  const clean = target
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/gu, "");
  if (!clean || clean.includes("\0"))
    throw failure("note_move_invalid", "Note target directory is invalid", "usage");
  const directory = clean.startsWith("content/notes/") ? clean : `content/notes/${clean}`;
  const absolute = resolve(root, directory, basename(oldRelativePath));
  const notesRoot = resolve(root, "content/notes");
  const fromNotes = relative(notesRoot, absolute).replaceAll("\\", "/");
  if (fromNotes.startsWith("../") || fromNotes === ".." || fromNotes.startsWith("/")) {
    throw failure("note_move_invalid", "Note target must remain under content/notes", "usage");
  }
  return relative(resolve(root), absolute).replaceAll("\\", "/");
}

async function assertSafeParents(root: string, directory: string): Promise<void> {
  const notesRoot = resolve(root, "content/notes");
  let current = directory;
  while (current.startsWith(notesRoot) && current !== notesRoot) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw failure("note_move_invalid", "Note target contains a symbolic link", "usage");
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      throw cause;
    }
    current = dirname(current);
  }
}

import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";

export async function readableKnowledgeDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_only");
  if (!opened.compatible) {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Knowledge reads",
      "state",
    );
  }
  return opened.database;
}

export async function writableKnowledgeDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Knowledge writes",
      "state",
    );
  }
  return opened.database;
}

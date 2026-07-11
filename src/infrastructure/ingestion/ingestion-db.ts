import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";

export async function readableIngestionDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_only");
  if (!opened.compatible) {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Ingestion reads",
      "state",
    );
  }
  return opened.database;
}

export async function writableIngestionDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Ingestion writes",
      "state",
    );
  }
  return opened.database;
}

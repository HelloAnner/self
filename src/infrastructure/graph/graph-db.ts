import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";

export async function readableGraphDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_only");
  return opened.database;
}

export async function writableGraphDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Schema 6 migration is required for Graph",
      "state",
    );
  }
  return opened.database;
}

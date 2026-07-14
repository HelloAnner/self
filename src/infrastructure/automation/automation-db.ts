import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";

export async function readableAutomationDatabase(root: string): Promise<Database> {
  return compatible(root, "read_only");
}

export async function writableAutomationDatabase(root: string): Promise<Database> {
  return compatible(root, "read_write");
}

async function compatible(root: string, mode: "read_only" | "read_write"): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, mode);
  if (!opened.compatible || (mode === "read_write" && opened.mode !== "read_write")) {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Automation operations",
      "state",
    );
  }
  return opened.database;
}

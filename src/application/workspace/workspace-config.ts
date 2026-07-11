import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { loadSelfConfig, stringifySelfConfig } from "../../domains/workspace/config/codec.ts";
import { type SelfConfig, selfConfigSchema } from "../../domains/workspace/config/schema.ts";
import { openWorkspaceDatabase } from "../../infrastructure/db/workspace-database.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";

export async function listConfig(root: string): Promise<SelfConfig> {
  return loadSelfConfig(root);
}

export async function getConfigValue(root: string, path: string): Promise<unknown> {
  return readPath(await loadSelfConfig(root), segments(path));
}

export async function mutateConfig(options: {
  root: string;
  path: string;
  value?: unknown;
  unset?: boolean;
  requestId: string;
}): Promise<{ operation_id: string; path: string; value: unknown; restart_required: boolean }> {
  const configPath = join(options.root, "self.toml");
  const oldContent = await Bun.file(configPath).text();
  const parsed: unknown = parse(oldContent);
  if (!isRecord(parsed)) throw failure("config_invalid", "self.toml root must be a table", "state");
  const path = segments(options.path);
  if (options.unset) deletePath(parsed, path);
  else writePath(parsed, path, options.value);
  const next = selfConfigSchema.parse(parsed);
  const newContent = stringifySelfConfig(next);
  const resultValue = options.unset ? null : readPath(next, path);
  if (newContent === oldContent) {
    return {
      operation_id: createResourceId("operation"),
      path: options.path,
      value: resultValue,
      restart_required: false,
    };
  }

  const opened = await openWorkspaceDatabase(options.root, "read_write");
  if (opened.mode !== "read_write") {
    const tooNew = opened.schemaVersion > VERSION.databaseSchema;
    opened.database.close();
    throw failure(
      tooNew ? "workspace_format_too_new" : "workspace_migration_required",
      tooNew
        ? "Configuration is read-only for this database version"
        : "Database migration is required before changing configuration",
      "state",
    );
  }
  const operationId = createResourceId("operation");
  const latest = opened.database
    .query<{ version: number }, []>(
      "SELECT COALESCE(MAX(version), 0) version FROM workspace_config_versions",
    )
    .get();
  const nextVersion = (latest?.version ?? 0) + 1;
  const historyRelative = `runtime/config-history/${String(nextVersion).padStart(4, "0")}-${sha256Text(newContent).slice(0, 12)}.toml`;
  const historyPath = join(options.root, historyRelative);
  await atomicWrite(historyPath, newContent);
  try {
    await atomicWrite(configPath, newContent);
    opened.database.transaction(() => {
      const workspace = opened.database
        .query<{ workspace_id: string }, []>("SELECT workspace_id FROM workspace")
        .get();
      if (!workspace) throw new Error("Workspace row is missing");
      opened.database
        .prepare(
          `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash, result_json, created_at, completed_at)
           VALUES (?, ?, 'workspace.config', 'succeeded', ?, ?, '{}', ?, ?)`,
        )
        .run(
          operationId,
          options.requestId,
          workspace.workspace_id,
          sha256Text(newContent),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      opened.database
        .prepare(
          `INSERT INTO workspace_config_versions(workspace_id, version, content_hash, relative_path, created_at, operation_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.workspace_id,
          nextVersion,
          sha256Text(newContent),
          historyRelative,
          new Date().toISOString(),
          operationId,
        );
    })();
  } catch (cause) {
    await atomicWrite(configPath, oldContent);
    await rm(historyPath, { force: true });
    throw cause;
  } finally {
    opened.database.close();
  }
  return {
    operation_id: operationId,
    path: options.path,
    value: resultValue,
    restart_required: ["storage", "database", "security"].includes(path[0] ?? ""),
  };
}

export function parseConfigCliValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function segments(path: string): string[] {
  const values = path.split(".").filter(Boolean);
  if (
    values.length === 0 ||
    values.some((item) => ["__proto__", "prototype", "constructor"].includes(item))
  ) {
    throw failure("config_path_invalid", "Configuration path is invalid", "usage");
  }
  return values;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) {
      throw failure(
        "config_path_not_found",
        `Configuration path does not exist: ${path.join(".")}`,
        "not_found",
      );
    }
    current = current[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string[], value: unknown): void {
  const parent = parentRecord(target, path);
  parent[path.at(-1) ?? ""] = value;
}

function deletePath(target: Record<string, unknown>, path: string[]): void {
  const parent = parentRecord(target, path);
  delete parent[path.at(-1) ?? ""];
}

function parentRecord(target: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (next === undefined) current[segment] = {};
    else if (!isRecord(next))
      throw failure("config_path_invalid", `${segment} is not a table`, "usage");
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

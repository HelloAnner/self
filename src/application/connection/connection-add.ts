import { basename } from "node:path";
import { z } from "zod";
import {
  defaultFilterPolicy,
  defaultResourcePolicy,
  defaultScanPolicy,
} from "../../domains/connection/index.ts";
import {
  createConnectionRecord,
  getConnection,
  listActiveTargets,
} from "../../infrastructure/connection/connection-repository.ts";
import { pathsOverlap, prepareConnectionTarget } from "../../infrastructure/connection/target.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { addSource } from "../source/source-archive.ts";
import { scanConnection } from "./connection-scan.ts";

const inputSchema = z.object({
  input: z.string().min(1),
  kind: z.enum(["file", "directory", "project", "obsidian"]),
  scope: z.enum(["external", "managed_content"]).default("external"),
  name: z.string().trim().min(1).max(200).optional(),
  preset: z.enum(["docs", "obsidian", "project", "custom"]).default("docs"),
  watchMode: z.enum(["poll", "native", "watch_and_reconcile"]).default("watch_and_reconcile"),
  recursive: z.boolean().default(true),
  include: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
  intervalMs: z.number().int().min(0).optional(),
  settleMs: z.number().int().min(0).optional(),
  deleteGraceMs: z.number().int().min(0).optional(),
  paused: z.boolean().default(false),
  initialScan: z.boolean().default(true),
  noDaemon: z.boolean().default(false),
});

export async function addConnection(root: string, raw: unknown, requestId: string) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw failure(
      "connection_input_invalid",
      "Connection input did not match the command schema",
      "usage",
      {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  const input = parsed.data;
  const target = await prepareConnectionTarget({
    root,
    input: input.input,
    kind: input.kind,
    scope: input.scope,
    recursive: input.recursive,
  });
  const scanPolicy = defaultScanPolicy({
    ...(input.intervalMs !== undefined ? { reconcile_interval_ms: input.intervalMs } : {}),
    ...(input.settleMs !== undefined ? { write_settle_window_ms: input.settleMs } : {}),
    ...(input.deleteGraceMs !== undefined ? { delete_grace_period_ms: input.deleteGraceMs } : {}),
  });
  const filters = defaultFilterPolicy(input.preset, {
    ...(input.include.length > 0 ? { include_globs: input.include } : {}),
    exclude_globs: effectiveExcludes(input.kind, input.exclude),
  });
  const duplicate = (await listActiveTargets(root)).find(
    (candidate) => candidate.target_identity_key === target.target_identity_key,
  );
  if (duplicate) {
    const connection = await getConnection(root, duplicate.connection_id);
    if (
      connection.kind !== input.kind ||
      JSON.stringify(connection.scan_policy) !== JSON.stringify(scanPolicy) ||
      JSON.stringify(connection.filter_policy) !== JSON.stringify(filters)
    ) {
      throw failure(
        "connection_target_conflict",
        "Target already has a Connection with different policy",
        "conflict",
      );
    }
    return {
      connection_id: connection.connection_id,
      source_id: connection.source_id,
      state: connection.state,
      reused: true,
    };
  }
  const overlap = (await listActiveTargets(root)).find((candidate) =>
    pathsOverlap(candidate.canonical_path, target.canonical_path),
  );
  if (overlap) {
    throw failure(
      "connection_target_overlap",
      "Connection Target overlaps an active Target",
      "conflict",
      {
        details: { connection_id: overlap.connection_id },
      },
    );
  }

  const source = await addSource(
    root,
    {
      input: target.canonical_path,
      kind: sourceKind(input.kind),
      mode: "mirror",
      name: input.name ?? basename(target.canonical_path),
      recursive: target.recursive,
      include: filters.include_globs,
      exclude: filters.exclude_globs,
      noBuild: true,
    },
    requestId,
  );
  const connectionId = createResourceId("connection");
  const targetId = createResourceId("target");
  const operationId = createResourceId("operation");
  await createConnectionRecord(root, {
    connectionId,
    targetId,
    sourceId: source.source_id,
    name: input.name ?? basename(target.canonical_path),
    kind: input.kind,
    watchMode: input.watchMode,
    scanPolicy,
    filterPolicy: filters,
    resourcePolicy: defaultResourcePolicy(),
    target,
    paused: input.paused || !input.initialScan,
    requestId,
    operationId,
  });
  const scan =
    input.paused || !input.initialScan
      ? null
      : await scanConnection(root, connectionId, { trigger: "initial" }, requestId);
  const daemon =
    input.noDaemon || input.paused
      ? null
      : await (await import("./connection-daemon.ts")).startConnectionDaemon(root);
  return {
    operation_id: operationId,
    job_id: null,
    connection_id: connectionId,
    source_id: source.source_id,
    scan_run_id: scan?.scan_run_id ?? null,
    change_batch_id: scan?.change_batch_id ?? null,
    snapshot_id: scan?.snapshot_id ?? source.snapshot_id,
    state: input.paused || !input.initialScan ? "paused" : "active",
    ingestion_status: "not_started" as const,
    daemon,
    reused: false,
    warnings: input.noDaemon ? ["Connection is not being scheduled by a Daemon."] : [],
  };
}

function effectiveExcludes(kind: string, requested: string[]): string[] {
  const hidden = kind === "obsidian" ? [] : [".*", "**/.*", "**/.*/**"];
  return [
    ...defaultFilterPolicy(kind === "obsidian" ? "obsidian" : "docs").exclude_globs,
    ...hidden,
    ".env*",
    "**/.env*",
    "**/*.pem",
    "**/*.key",
    "**/credentials.json",
    "**/secrets.json",
    ...requested,
  ];
}

function sourceKind(kind: string): "file" | "directory" | "obsidian" {
  if (kind === "file") return "file";
  if (kind === "obsidian") return "obsidian";
  return "directory";
}

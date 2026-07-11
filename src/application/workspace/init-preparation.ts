import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseSelfConfig } from "../../domains/workspace/config/codec.ts";
import { saveInitJournal } from "../../domains/workspace/init/journal.ts";
import type { InitJournal, InitResult } from "../../domains/workspace/init/types.ts";
import { openWorkspaceDatabase } from "../../infrastructure/db/workspace-database.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import type { ResourceId } from "../../shared/ids/registry.ts";
import { VERSION } from "../../shared/version.ts";
import { pathExists } from "./init-files.ts";
import type { InitWorkspaceOptions } from "./init-workspace.ts";

export async function prepareJournal(
  root: string,
  options: InitWorkspaceOptions,
): Promise<InitJournal> {
  const existed = await pathExists(root);
  const existingPaths = existed ? await readdir(root) : [];
  if (existingPaths.length > 0 && !options.approvedPlan) {
    await rejectNonEmptyTarget(root, existingPaths);
  }

  await mkdir(join(root, "runtime/init"), { recursive: true });
  await mkdir(join(root, "runtime/tmp"), { recursive: true });
  const identity = await stat(root);
  const now = new Date().toISOString();
  const journal: InitJournal = {
    operation_id: options.approvedPlan?.operation_id ?? createResourceId("operation"),
    request_id: options.requestId,
    workspace_id: options.approvedPlan?.workspace_id ?? createResourceId("workspace"),
    target_root: root,
    root_identity: { device: identity.dev, inode: identity.ino },
    created_root: !existed,
    state: "running",
    current_step: "prepared",
    completed_steps: [],
    created_paths: [
      ...(!existed ? [{ path: ".", kind: "directory" as const }] : []),
      { path: "runtime", kind: "directory" },
      { path: "runtime/init", kind: "directory" },
      { path: "runtime/tmp", kind: "directory" },
    ],
    offline: options.approvedPlan?.offline ?? options.offline ?? true,
    created_at: now,
    updated_at: now,
  };
  await saveInitJournal(journal);
  return journal;
}

export async function existingWorkspace(root: string): Promise<InitResult> {
  const config = parseSelfConfig(await Bun.file(join(root, "self.toml")).text());
  const opened = await openWorkspaceDatabase(root, "read_only");
  try {
    if (!opened.compatible) {
      throw failure(
        opened.schemaVersion > VERSION.databaseSchema
          ? "workspace_format_too_new"
          : "workspace_migration_required",
        "Existing Workspace requires a separate compatibility operation",
        "state",
      );
    }
    const operation = opened.database
      .query<{ operation_id: ResourceId<"operation"> }, []>(
        "SELECT operation_id FROM operations WHERE kind='workspace.init' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (!operation) throw failure("workspace_damaged", "Init operation is missing", "state");
    return {
      workspace_id: config.workspace.id as ResourceId<"workspace">,
      operation_id: operation.operation_id,
      root,
      state: "active",
      resumed: false,
      offline: config.models.offline,
    };
  } finally {
    opened.database.close();
  }
}

export async function assertRootIdentity(journal: InitJournal): Promise<void> {
  const identity = await stat(journal.target_root);
  if (
    identity.dev !== journal.root_identity.device ||
    identity.ino !== journal.root_identity.inode
  ) {
    throw failure("init_path_conflict", "Workspace target identity changed", "conflict");
  }
}

async function rejectNonEmptyTarget(root: string, existingPaths: string[]): Promise<void> {
  if (existingPaths.includes("runtime") && (await hasInitJournal(root))) {
    throw failure("init_incomplete", "An unfinished initialization already exists", "state", {
      suggestedActions: [`Run \`self init resume ${root}\` or request a rollback plan.`],
    });
  }
  throw failure("init_requires_plan", "A non-empty directory requires an Init Plan", "state", {
    details: { existing_paths: existingPaths.sort() },
    suggestedActions: [`Run \`self init ${root} --plan\`.`],
    exitCode: 10,
  });
}

async function hasInitJournal(root: string): Promise<boolean> {
  try {
    return (await readdir(join(root, "runtime/init"))).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

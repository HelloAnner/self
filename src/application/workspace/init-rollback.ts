import { readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  journalPath,
  loadLatestInitJournal,
  saveInitJournal,
} from "../../domains/workspace/init/journal.ts";
import { canonicalizePotentialPath } from "../../domains/workspace/root/discovery.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { ensureDirectory } from "./init-files.ts";

const rollbackPlanSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("workspace.init.rollback"),
  root: z.string(),
  init_operation_id: z.string().startsWith("operation:op_"),
  journal_sha256: z.string(),
  created_paths: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["file", "directory"]),
      sha256: z.string().optional(),
    }),
  ),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export type InitRollbackPlan = z.infer<typeof rollbackPlanSchema>;

export async function createInitRollbackPlan(target: string): Promise<InitRollbackPlan> {
  const root = await canonicalizePotentialPath(target);
  const journal = await loadLatestInitJournal(root);
  if (journal.state === "completed") {
    throw failure(
      "workspace_already_exists",
      "Completed Workspaces use Workspace deletion, not Init rollback",
      "state",
    );
  }
  await ensureDirectory(journal, join(root, "runtime/plans"));
  await saveInitJournal(journal);
  const now = new Date();
  const plan = rollbackPlanSchema.parse({
    plan_id: createResourceId("plan"),
    kind: "workspace.init.rollback",
    root,
    init_operation_id: journal.operation_id,
    journal_sha256: await sha256File(journalPath(root, journal.operation_id)),
    created_paths: journal.created_paths,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  await atomicWrite(planPath(root, plan.plan_id), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyInitRollback(
  target: string,
  planId: string,
): Promise<{ operation_id: string; removed: string[]; retained: string[] }> {
  const root = await canonicalizePotentialPath(target);
  const path = planPath(root, planId);
  const parsed = rollbackPlanSchema.safeParse(JSON.parse(await Bun.file(path).text()));
  if (!parsed.success)
    throw failure("plan_not_found", "Rollback Plan is invalid or missing", "not_found");
  const plan = parsed.data;
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now()) {
    throw failure("plan_expired", "Rollback Plan is stale or belongs to another root", "conflict");
  }

  const journal = await loadLatestInitJournal(root);
  const currentJournal = journalPath(root, journal.operation_id);
  if (
    journal.operation_id !== plan.init_operation_id ||
    (await sha256File(currentJournal)) !== plan.journal_sha256
  ) {
    throw failure(
      "plan_conflict",
      "Init state changed after the rollback Plan was created",
      "conflict",
    );
  }

  const removed: string[] = [];
  const retained: string[] = [];
  for (const item of plan.created_paths.filter((entry) => entry.kind === "file")) {
    const absolute = safePlanPath(root, item.path);
    if (!(await Bun.file(absolute).exists())) continue;
    if (!item.sha256 || (await sha256File(absolute)) !== item.sha256) {
      throw failure("plan_conflict", `Self-owned file changed: ${item.path}`, "conflict");
    }
    await rm(absolute);
    removed.push(item.path);
  }

  await rm(currentJournal);
  await rm(path);
  removed.push(relativeLabel(root, currentJournal), relativeLabel(root, path));

  const directories = plan.created_paths
    .filter((entry) => entry.kind === "directory")
    .map((entry) => entry.path)
    .sort((left, right) => depth(right) - depth(left));
  for (const directory of directories) {
    const absolute = safePlanPath(root, directory);
    try {
      if ((await readdir(absolute)).length > 0) {
        retained.push(directory);
        continue;
      }
      await rmdir(absolute);
      removed.push(directory);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      retained.push(directory);
    }
  }
  return { operation_id: createResourceId("operation"), removed, retained };
}

function planPath(root: string, planId: string): string {
  return join(root, "runtime/plans", `${planId.replace(":", "_")}.json`);
}

function safePlanPath(root: string, relativePath: string): string {
  const path = relativePath === "." ? root : resolve(root, relativePath);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw failure(
      "plan_conflict",
      "Rollback Plan contains a path outside the Workspace",
      "conflict",
    );
  }
  return path;
}

function depth(path: string): number {
  return path === "." ? 0 : path.split("/").length;
}

function relativeLabel(root: string, path: string): string {
  return path
    .slice(root.length + 1)
    .split("\\")
    .join("/");
}

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { InitPlan } from "../../domains/workspace/init/types.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";

const initPlanSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("workspace.init"),
  request_id: z.string().startsWith("req_"),
  operation_id: z.string().startsWith("operation:op_"),
  workspace_id: z.string().startsWith("workspace:ws_"),
  target_root: z.string(),
  existing_paths: z.array(z.string()),
  create_paths: z.array(z.string()),
  network_calls: z.tuple([]),
  can_rollback: z.literal(true),
  offline: z.boolean(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export async function createAndSaveInitPlan(
  root: string,
  requestId: string,
  offline: boolean,
  directories: readonly string[],
): Promise<InitPlan> {
  const existingPaths = await listRoot(root);
  const now = new Date();
  const plan = initPlanSchema.parse({
    plan_id: createResourceId("plan"),
    kind: "workspace.init",
    request_id: requestId,
    operation_id: createResourceId("operation"),
    workspace_id: createResourceId("workspace"),
    target_root: root,
    existing_paths: existingPaths,
    create_paths: ["self.toml", ...directories, "data/self.sqlite3"],
    network_calls: [],
    can_rollback: true,
    offline,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  }) as InitPlan;
  await mkdir(join(root, "runtime/plans"), { recursive: true });
  await atomicWrite(initPlanPath(root, plan.plan_id), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function loadApplicableInitPlan(root: string, planId: string): Promise<InitPlan> {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "Init Plan does not exist", "not_found");
  const parsed = initPlanSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) throw failure("plan_not_found", "Init Plan is invalid", "not_found");
  const plan = parsed.data as InitPlan;
  if (plan.target_root !== root || Date.parse(plan.expires_at) < Date.now()) {
    throw failure("plan_expired", "Init Plan is stale or belongs to another root", "conflict");
  }
  await assertRootUnchanged(root, plan);
  return plan;
}

export function initPlanPath(root: string, planId: string): string {
  return join(root, "runtime/plans", `${planId.replace(":", "_")}.json`);
}

async function assertRootUnchanged(root: string, plan: InitPlan): Promise<void> {
  const current = await listRoot(root);
  const allowed = new Set([...plan.existing_paths, "runtime"]);
  const unexpected = current.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw failure("plan_conflict", "Target changed after Init Plan creation", "conflict", {
      details: { unexpected_paths: unexpected },
    });
  }
  if (!plan.existing_paths.includes("runtime")) {
    const runtimeEntries = await readdir(join(root, "runtime"));
    if (runtimeEntries.some((name) => name !== "plans")) {
      throw failure("plan_conflict", "Runtime path changed after Init Plan creation", "conflict");
    }
  }
}

async function listRoot(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

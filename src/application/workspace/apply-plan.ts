import { canonicalizePotentialPath } from "../../domains/workspace/root/discovery.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { initPlanPath, loadApplicableInitPlan } from "./init-plan.ts";
import { applyInitRollback } from "./init-rollback.ts";
import { initWorkspace } from "./init-workspace.ts";

export async function applyWorkspacePlan(target: string, planId: string) {
  const root = await canonicalizePotentialPath(target);
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists())) throw failure("plan_not_found", "Plan does not exist", "not_found");
  const value: unknown = JSON.parse(await file.text());
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw failure("plan_not_found", "Plan has no recognized kind", "not_found");
  }
  if (value.kind === "workspace.init") {
    const plan = await loadApplicableInitPlan(root, planId);
    return initWorkspace({
      target: root,
      requestId: plan.request_id,
      offline: plan.offline,
      approvedPlan: plan,
    });
  }
  if (value.kind === "workspace.init.rollback") return applyInitRollback(root, planId);
  if (value.kind === "operations.database.migrate") {
    const { applyDatabaseMigrationPlan } = await import("../operations/database-migration.ts");
    return applyDatabaseMigrationPlan(root, planId);
  }
  if (value.kind === "operations.backup.restore") {
    const { applyBackupRestorePlan } = await import("../operations/backup-restore.ts");
    return applyBackupRestorePlan(root, planId);
  }
  if (value.kind === "operations.gc") {
    const { applyGcPlan } = await import("../operations/gc.ts");
    return applyGcPlan(root, planId);
  }
  if (value.kind === "source.delete") {
    const { applySourceDeletePlan } = await import("../source/source-lifecycle.ts");
    return applySourceDeletePlan(root, planId);
  }
  if (value.kind === "connection.rebind") {
    const { applyConnectionRebindPlan } = await import("../connection/connection-rebind.ts");
    return applyConnectionRebindPlan(root, planId);
  }
  if (value.kind === "knowledge.vector-space") {
    const { applyVectorSpacePlan } = await import("../knowledge/vector-space-plans.ts");
    return applyVectorSpacePlan(root, planId);
  }
  if (value.kind === "graph.mutation") {
    const { applyGraphPlan } = await import("../graph/graph-plans.ts");
    return applyGraphPlan(root, planId);
  }
  if (value.kind === "automation.mutation") {
    const { applyAutomationMutation } = await import("../automation/apply-mutation.ts");
    return applyAutomationMutation(root, planId);
  }
  throw failure("plan_kind_unsupported", `Unsupported Plan kind: ${String(value.kind)}`, "state");
}

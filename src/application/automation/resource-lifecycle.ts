import { createSafetyPlan, type MutationAction } from "./plan-workflows.ts";
import { restoreDeletedResource } from "./restore-workflows.ts";

export async function createResourceMutationPlan(
  root: string,
  action: MutationAction,
  resourceId: string,
  requestId: string,
  options: { values?: Record<string, unknown>; idempotencyKey?: string } = {},
) {
  return createSafetyPlan(
    root,
    {
      action,
      resourceId,
      ...(options.values ? { values: options.values } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    },
    requestId,
  );
}

export { restoreDeletedResource };

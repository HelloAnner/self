export const AUTOMATION_PLAN_STATES = [
  "ready",
  "applied",
  "cancelled",
  "expired",
  "failed",
] as const;

export type AutomationPlanState = (typeof AUTOMATION_PLAN_STATES)[number];
export type OperationAtomicity = "atomic" | "per_item";

export type PlanTarget = {
  resourceId: string;
  resourceKind: string;
  role: "primary" | "precondition" | "affected";
  expectedVersion?: number | null;
  expectedState?: string | null;
};

export type OperationChange = {
  resourceId: string;
  resourceKind: string;
  changeKind: string;
  status?: "succeeded" | "failed" | "skipped";
  versionBefore?: number | null;
  versionAfter?: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  inverse?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
};

export type AutomationPlanManifest = {
  plan_id: string;
  kind: string;
  action: string;
  state: AutomationPlanState;
  request_id: string;
  operation_id: string;
  resource_id: string | null;
  idempotency_key: string | null;
  input_hash: string;
  input: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  impact: Record<string, unknown>;
  changes: Record<string, unknown>[];
  inverse: Record<string, unknown> | null;
  reversible: boolean;
  atomicity: OperationAtomicity;
  targets: PlanTarget[];
  created_at: string;
  expires_at: string;
};

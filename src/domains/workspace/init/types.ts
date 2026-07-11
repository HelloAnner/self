import type { ResourceId } from "../../../shared/ids/registry.ts";

export const INIT_STEPS = [
  "directories",
  "runtime_assets",
  "database",
  "verification",
  "config_publish",
] as const;

export type InitStep = (typeof INIT_STEPS)[number];

export type CreatedPath = {
  path: string;
  kind: "file" | "directory";
  sha256?: string;
};

export type InitJournal = {
  operation_id: ResourceId<"operation">;
  request_id: string;
  workspace_id: ResourceId<"workspace">;
  target_root: string;
  root_identity: { device: number; inode: number };
  created_root: boolean;
  state: "running" | "failed" | "completed" | "rolled_back";
  current_step: InitStep | "prepared";
  completed_steps: InitStep[];
  created_paths: CreatedPath[];
  offline: boolean;
  created_at: string;
  updated_at: string;
  error_code?: string;
};

export type InitPlan = {
  plan_id: ResourceId<"plan">;
  kind: "workspace.init";
  request_id: string;
  operation_id: ResourceId<"operation">;
  workspace_id: ResourceId<"workspace">;
  target_root: string;
  existing_paths: string[];
  create_paths: string[];
  network_calls: [];
  can_rollback: true;
  offline: boolean;
  created_at: string;
  expires_at: string;
};

export type InitResult = {
  workspace_id: ResourceId<"workspace">;
  operation_id: ResourceId<"operation">;
  root: string;
  state: "active";
  resumed: boolean;
  offline: boolean;
};

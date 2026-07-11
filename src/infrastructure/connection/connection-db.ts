import type { Database } from "bun:sqlite";
import type {
  ConnectionKind,
  ConnectionRow,
  ConnectionTarget,
  FilterPolicy,
  ResourcePolicy,
  ScanPolicy,
  WatchMode,
} from "../../domains/connection/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";

export type RawConnection = Omit<
  ConnectionRow,
  | "kind"
  | "state"
  | "watch_mode"
  | "scan_policy"
  | "filter_policy"
  | "resource_policy"
  | "reconcile_required"
> & {
  kind: ConnectionKind;
  state: ConnectionRow["state"];
  watch_mode: WatchMode;
  scan_policy_json: string;
  filter_policy_json: string;
  resource_policy_json: string;
  reconcile_required: number;
};

export type RawTarget = {
  target_id: string;
  connection_id: string;
  uri: string;
  target_kind: "file" | "directory";
  location_scope: "external" | "managed_content";
  canonical_path: string;
  target_identity_key: string;
  path_fingerprint_json: string | null;
  recursive: number;
  follow_symlinks: number;
  case_sensitivity: ConnectionTarget["case_sensitivity"];
  status: ConnectionTarget["status"];
  revision: number;
};

export function mapConnection(row: RawConnection): ConnectionRow {
  const { scan_policy_json, filter_policy_json, resource_policy_json, ...rest } = row;
  return {
    ...rest,
    reconcile_required: row.reconcile_required === 1,
    scan_policy: JSON.parse(scan_policy_json) as ScanPolicy,
    filter_policy: JSON.parse(filter_policy_json) as FilterPolicy,
    resource_policy: JSON.parse(resource_policy_json) as ResourcePolicy,
  };
}

export function mapTarget(row: RawTarget): ConnectionTarget {
  const { path_fingerprint_json, recursive, follow_symlinks, ...rest } = row;
  return {
    ...rest,
    path_fingerprint: path_fingerprint_json
      ? (JSON.parse(path_fingerprint_json) as Record<string, unknown>)
      : null,
    recursive: recursive === 1,
    follow_symlinks: follow_symlinks === 1,
  };
}

export async function readableConnectionDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_only");
  if (!opened.compatible) {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Connection reads",
      "state",
    );
  }
  return opened.database;
}

export async function writableConnectionDatabase(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Connection writes",
      "state",
    );
  }
  return opened.database;
}

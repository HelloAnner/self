export type ConnectionKind = "file" | "directory" | "project" | "obsidian";
export type ConnectionState =
  | "draft"
  | "initializing"
  | "active"
  | "paused"
  | "degraded"
  | "error"
  | "detached"
  | "deleted";
export type WatchMode = "poll" | "native" | "watch_and_reconcile";

export type ScanPolicy = {
  reconcile_interval_ms: number;
  full_hash_interval_ms: number;
  event_debounce_ms: number;
  write_settle_window_ms: number;
  delete_grace_period_ms: number;
  max_settle_retries: number;
};

export type FilterPolicy = {
  include_globs: string[];
  exclude_globs: string[];
  include_hidden: boolean;
  sensitive_file_mode: "deny" | "confirm" | "allow";
  max_file_bytes: number;
};

export type ResourcePolicy = { max_batch_size: number; max_hash_concurrency: number };

export type ConnectionRow = {
  connection_id: string;
  workspace_id: string;
  source_id: string;
  name: string;
  kind: ConnectionKind;
  state: ConnectionState;
  watch_mode: WatchMode;
  scan_policy: ScanPolicy;
  filter_policy: FilterPolicy;
  resource_policy: ResourcePolicy;
  reconcile_required: boolean;
  revision: number;
  last_scan_at: string | null;
  last_success_at: string | null;
  next_scan_at: string | null;
  consecutive_failures: number;
};

export type ConnectionTarget = {
  target_id: string;
  connection_id: string;
  uri: string;
  target_kind: "file" | "directory";
  location_scope: "external" | "managed_content";
  canonical_path: string;
  target_identity_key: string;
  path_fingerprint: Record<string, unknown> | null;
  recursive: boolean;
  follow_symlinks: boolean;
  case_sensitivity: "sensitive" | "insensitive" | "unknown";
  status: "active" | "unavailable" | "permission_denied" | "rebind_required" | "deleted";
  revision: number;
};

export type Observation = {
  observation_id: string;
  connection_id: string;
  target_id: string;
  relative_path: string;
  normalized_path_key: string;
  file_identity: string | null;
  size_bytes: number;
  mtime_ns: string;
  quick_fingerprint: string;
  content_hash: string;
  snapshot_id: string | null;
  state: "active" | "missing_pending" | "ignored" | "deleted";
  missing_since: string | null;
  version: number;
};

export type InventoryEntry = {
  relative_path: string;
  normalized_path_key: string;
  file_identity: string | null;
  size_bytes: number;
  mtime_ns: string;
  quick_fingerprint: string;
  content_hash: string;
};

export type ConnectionChange = {
  kind: "created" | "modified" | "deleted" | "renamed" | "restored";
  relative_path: string;
  previous_path: string | null;
  previous_hash: string | null;
  current_hash: string | null;
  observation_id: string | null;
  observation_version: number;
};

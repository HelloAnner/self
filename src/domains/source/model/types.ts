export const SOURCE_KINDS = [
  "auto",
  "file",
  "markdown",
  "directory",
  "obsidian",
  "web",
  "text",
  "jsonl",
] as const;
export const SOURCE_MODES = ["import", "snapshot", "mirror"] as const;

export type SourceKind = Exclude<(typeof SOURCE_KINDS)[number], "auto">;
export type SourceMode = (typeof SOURCE_MODES)[number];

export type SourceSpec = {
  kind: SourceKind;
  mode: SourceMode;
  locator_type: "external_path" | "managed_path" | "url" | "stdin";
  locator: string | null;
  original_locator: string | null;
  recursive: boolean;
  include: string[];
  exclude: string[];
};

export type SourceRow = {
  source_id: string;
  identity_key: string;
  kind: SourceKind;
  mode: SourceMode;
  name: string;
  state: "active" | "failed" | "deleted";
  archive_status: "registered" | "archiving" | "published" | "failed";
  spec: SourceSpec;
  current_snapshot_id: string | null;
  ingestion_status: "not_started" | "queued" | "running" | "ready" | "failed";
  current_ingestion_run_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type InputEntry = {
  logical_path: string;
  mime_type: string;
  origin_uri: string | null;
  acquired_at: string;
  content: { kind: "file"; path: string } | { kind: "bytes"; bytes: Uint8Array };
};

export type ArchivedEntry = Omit<InputEntry, "content"> & {
  blob_sha256: string;
  size_bytes: number;
  blob_relative_path: string;
};

export type SnapshotChange = {
  logical_path: string;
  change_kind: "added" | "modified" | "deleted";
  previous_blob_sha256: string | null;
  blob_sha256: string | null;
};

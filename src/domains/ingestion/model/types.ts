export type NormalizedBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "code"
  | "table"
  | "record";

export type NormalizedBlock = {
  kind: NormalizedBlockKind;
  text: string;
  heading_path: string[];
  source_start_line: number;
  source_end_line: number;
  metadata: Record<string, string>;
};

export type NormalizedLink = {
  kind: "markdown" | "wiki" | "html";
  target: string;
  label: string | null;
  source_line: number | null;
};

export type NormalizedDocument = {
  logical_path: string;
  media_type: string;
  parser_id: string;
  parser_version: string;
  normalizer_version: string;
  title: string | null;
  language: string;
  text: string;
  blocks: NormalizedBlock[];
  links: NormalizedLink[];
  tags: string[];
  frontmatter: Record<string, string>;
  metadata: Record<string, unknown>;
  normalized_content_hash: string;
  structure_hash: string;
};

export type ParsedSnapshotEntry = {
  logical_path: string;
  blob_sha256: string;
  mime_type: string;
  state: "parsed" | "skipped";
  parser_id: string | null;
  document: NormalizedDocument | null;
  skip_reason: string | null;
};

export type IngestionRunState =
  | "queued"
  | "parsing"
  | "normalized"
  | "chunked"
  | "publishing"
  | "ready"
  | "failed"
  | "retrying"
  | "cancelled";

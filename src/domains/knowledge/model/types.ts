import type { NormalizedBlockKind, NormalizedDocument } from "../../ingestion/index.ts";

export type ChunkDraft = {
  ordinal: number;
  content_text: string;
  content_hash: string;
  block_kind: NormalizedBlockKind | "composite";
  token_estimate: number;
  heading_path: string[];
  source_start_line: number | null;
  source_end_line: number | null;
  anchor_key: string;
};

export type KnowledgeDocumentDraft = {
  document: NormalizedDocument;
  blob_sha256: string;
  chunks: ChunkDraft[];
};

export type PublishedDocument = {
  document_id: string;
  revision_id: string;
  logical_path: string;
  reused_revision: boolean;
  chunk_ids: string[];
};

export type KnowledgePublishResult = {
  documents: PublishedDocument[];
  documents_published: number;
  chunks_published: number;
  chunks_reused: number;
  chunks_tombstoned: number;
};

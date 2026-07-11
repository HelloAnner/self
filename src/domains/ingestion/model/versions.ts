import { sha256Text } from "../../../shared/hash/sha256.ts";

export const INGESTION_VERSIONS = {
  parser: "parser-set-v1",
  normalizer: "normalized-document-v1",
  chunker: "semantic-v1",
} as const;

export type ChunkerConfig = {
  max_tokens: number;
  overlap_tokens: number;
};

export function ingestionConfigFingerprint(config: ChunkerConfig): string {
  return sha256Text(JSON.stringify({ ...INGESTION_VERSIONS, config }));
}

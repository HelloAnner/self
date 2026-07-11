import type {
  NormalizedBlock,
  NormalizedDocument,
  NormalizedLink,
} from "../../domains/ingestion/index.ts";
import { INGESTION_VERSIONS } from "../../domains/ingestion/index.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";

export function buildNormalizedDocument(input: {
  logicalPath: string;
  mediaType: string;
  parserId: string;
  title: string | null;
  blocks: NormalizedBlock[];
  links?: NormalizedLink[];
  tags?: string[];
  frontmatter?: Record<string, string>;
  metadata?: Record<string, unknown>;
}): NormalizedDocument {
  const blocks = input.blocks
    .map((block) => ({ ...block, text: normalizeText(block.text) }))
    .filter((block) => block.text.length > 0);
  const text = blocks.map((block) => block.text).join("\n\n");
  return {
    logical_path: input.logicalPath,
    media_type: input.mediaType,
    parser_id: input.parserId,
    parser_version: INGESTION_VERSIONS.parser,
    normalizer_version: INGESTION_VERSIONS.normalizer,
    title: input.title ? normalizeText(input.title) : null,
    language: detectLanguage(text),
    text,
    blocks,
    links: input.links ?? [],
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort(),
    frontmatter: input.frontmatter ?? {},
    metadata: input.metadata ?? {},
    normalized_content_hash: sha256Text(text),
    structure_hash: sha256Text(
      JSON.stringify(
        blocks.map((block) => [
          block.kind,
          block.heading_path,
          block.source_start_line,
          block.source_end_line,
        ]),
      ),
    ),
  };
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  } catch {
    throw new Error("Content is not valid UTF-8");
  }
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .normalize("NFC");
}

function detectLanguage(text: string): string {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (han === 0 && latin === 0) return "und";
  if (han > latin * 0.2) return "zh";
  return "en";
}

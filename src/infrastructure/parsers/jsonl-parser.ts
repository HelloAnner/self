import type { NormalizedBlock } from "../../domains/ingestion/index.ts";
import { buildNormalizedDocument, decodeUtf8 } from "./document-builder.ts";

export function parseJsonLines(input: {
  logicalPath: string;
  mediaType: string;
  bytes: Uint8Array;
}) {
  const blocks: NormalizedBlock[] = [];
  const lines = decodeUtf8(input.bytes).replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL at line ${index + 1}`);
    }
    blocks.push({
      kind: "record",
      text: JSON.stringify(canonicalize(value)),
      heading_path: [],
      source_start_line: index + 1,
      source_end_line: index + 1,
      metadata: {},
    });
  }
  return buildNormalizedDocument({
    logicalPath: input.logicalPath,
    mediaType: input.mediaType,
    parserId: "jsonl",
    title: input.logicalPath,
    blocks,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

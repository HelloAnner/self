import { basename, extname } from "node:path";
import type { NormalizedBlock } from "../../domains/ingestion/index.ts";
import { buildNormalizedDocument, decodeUtf8, normalizeText } from "./document-builder.ts";

export function parsePlainText(input: {
  logicalPath: string;
  mediaType: string;
  bytes: Uint8Array;
}) {
  const text = decodeUtf8(input.bytes).replace(/\r\n?/gu, "\n");
  const blocks: NormalizedBlock[] = [];
  let start = 1;
  let buffer: string[] = [];
  const flush = (end: number) => {
    const value = normalizeText(buffer.join("\n"));
    if (value) {
      blocks.push({
        kind: "paragraph",
        text: value,
        heading_path: [],
        source_start_line: start,
        source_end_line: end,
        metadata: {},
      });
    }
    buffer = [];
  };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      flush(index);
      start = index + 2;
    } else {
      if (buffer.length === 0) start = index + 1;
      buffer.push(line);
    }
  }
  flush(lines.length);
  const first = blocks[0]?.text.split("\n")[0] ?? "";
  return buildNormalizedDocument({
    logicalPath: input.logicalPath,
    mediaType: input.mediaType,
    parserId: "plain-text",
    title: first.length > 0 && first.length <= 120 ? first : fileTitle(input.logicalPath),
    blocks,
  });
}

function fileTitle(path: string): string {
  const name = basename(path);
  return name.slice(0, Math.max(0, name.length - extname(name).length));
}

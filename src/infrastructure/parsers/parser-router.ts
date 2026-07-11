import { extname } from "node:path";
import type { ParsedSnapshotEntry } from "../../domains/ingestion/index.ts";
import { parseHtml } from "./html-parser.ts";
import { parseJsonLines } from "./jsonl-parser.ts";
import { parseMarkdown } from "./markdown-parser.ts";
import { parsePlainText } from "./plain-text-parser.ts";

const MAX_PARSE_BYTES = 25 * 1024 * 1024;

export async function parseSnapshotEntry(input: {
  root: string;
  logicalPath: string;
  blobSha256: string;
  blobRelativePath: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<ParsedSnapshotEntry> {
  const parser = parserKind(input.logicalPath, input.mimeType);
  if (!parser) return skipped(input, "unsupported_media_type");
  if (input.sizeBytes > MAX_PARSE_BYTES) throw new Error("Entry exceeds the parser size limit");
  const bytes = new Uint8Array(
    await Bun.file(`${input.root}/${input.blobRelativePath}`).arrayBuffer(),
  );
  const common = { logicalPath: input.logicalPath, mediaType: input.mimeType, bytes };
  const document =
    parser === "markdown"
      ? parseMarkdown(common)
      : parser === "html"
        ? parseHtml(common)
        : parser === "jsonl"
          ? parseJsonLines(common)
          : parser === "pdf"
            ? await parsePdf(common)
            : parsePlainText(common);
  return {
    logical_path: input.logicalPath,
    blob_sha256: input.blobSha256,
    mime_type: input.mimeType,
    state: "parsed",
    parser_id: document.parser_id,
    document,
    skip_reason: null,
  };
}

function parserKind(
  path: string,
  mime: string,
): "markdown" | "html" | "text" | "jsonl" | "pdf" | null {
  const extension = extname(path).toLowerCase();
  if (mime === "text/markdown" || [".md", ".mdx"].includes(extension)) return "markdown";
  if (mime === "text/html" || [".html", ".htm"].includes(extension)) return "html";
  if (mime === "application/x-ndjson" || extension === ".jsonl") return "jsonl";
  if (mime === "application/pdf" || extension === ".pdf") return "pdf";
  if (mime.startsWith("text/") || [".txt", ".json", ".csv", ".tsv"].includes(extension))
    return "text";
  return null;
}

async function parsePdf(input: { logicalPath: string; mediaType: string; bytes: Uint8Array }) {
  const adapter = await import("./pdf-parser.ts");
  return adapter.parsePdf(input);
}

function skipped(
  input: { logicalPath: string; blobSha256: string; mimeType: string },
  reason: string,
): ParsedSnapshotEntry {
  return {
    logical_path: input.logicalPath,
    blob_sha256: input.blobSha256,
    mime_type: input.mimeType,
    state: "skipped",
    parser_id: null,
    document: null,
    skip_reason: reason,
  };
}

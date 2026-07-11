import { basename, extname } from "node:path";
import type {
  NormalizedBlock,
  NormalizedBlockKind,
  NormalizedLink,
} from "../../domains/ingestion/index.ts";
import { buildNormalizedDocument, decodeUtf8, normalizeText } from "./document-builder.ts";

export function parseMarkdown(input: {
  logicalPath: string;
  mediaType: string;
  bytes: Uint8Array;
}) {
  const lines = decodeUtf8(input.bytes).replace(/\r\n?/gu, "\n").split("\n");
  const frontmatter = readFrontmatter(lines);
  const blocks: NormalizedBlock[] = [];
  const headingPath: string[] = [];
  let buffer: { lines: string[]; start: number; kind: NormalizedBlockKind } | null = null;
  let fence: { marker: string; language: string; lines: string[]; start: number } | null = null;
  const flush = (end: number) => {
    if (!buffer) return;
    const text = normalizeText(buffer.lines.join("\n"));
    if (text) blocks.push(block(buffer.kind, text, headingPath, buffer.start, end));
    buffer = null;
  };
  for (let index = frontmatter.endLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    if (fence) {
      if (line.trimStart().startsWith(fence.marker)) {
        blocks.push({
          ...block("code", fence.lines.join("\n"), headingPath, fence.start, lineNumber),
          metadata: { language: fence.language },
        });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const fenceMatch = /^\s*(```+|~~~+)\s*([^\s]*)/u.exec(line);
    if (fenceMatch) {
      flush(lineNumber - 1);
      fence = {
        marker: fenceMatch[1] ?? "```",
        language: fenceMatch[2] ?? "",
        lines: [],
        start: lineNumber,
      };
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      flush(lineNumber - 1);
      const level = heading[1]?.length ?? 1;
      const title = normalizeText(heading[2] ?? "");
      headingPath.splice(level - 1);
      headingPath[level - 1] = title;
      blocks.push(block("heading", title, headingPath, lineNumber, lineNumber));
      continue;
    }
    if (!line.trim()) {
      flush(lineNumber - 1);
      continue;
    }
    const kind = classifyLine(line);
    if (buffer && buffer.kind !== kind) flush(lineNumber - 1);
    buffer ??= { lines: [], start: lineNumber, kind };
    buffer.lines.push(line);
  }
  flush(lines.length);
  if (fence) {
    blocks.push({
      ...block("code", fence.lines.join("\n"), headingPath, fence.start, lines.length),
      metadata: { language: fence.language, unterminated: "true" },
    });
  }
  const links = extractLinks(lines);
  const tags = extractTags(frontmatter.values, lines);
  const firstHeading = blocks.find((item) => item.kind === "heading")?.text;
  return buildNormalizedDocument({
    logicalPath: input.logicalPath,
    mediaType: input.mediaType,
    parserId: "markdown",
    title: firstHeading ?? fileTitle(input.logicalPath),
    blocks,
    links,
    tags,
    frontmatter: frontmatter.values,
  });
}

function readFrontmatter(lines: string[]): { values: Record<string, string>; endLine: number } {
  if (lines[0]?.trim() !== "---") return { values: {}, endLine: 0 };
  const values: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") return { values, endLine: index + 1 };
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (match?.[1]) values[match[1]] = match[2] ?? "";
  }
  return { values: {}, endLine: 0 };
}

function extractLinks(lines: string[]): NormalizedLink[] {
  const output: NormalizedLink[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/gu)) {
      output.push({
        kind: "markdown",
        label: match[1] || null,
        target: match[2] ?? "",
        source_line: index + 1,
      });
    }
    for (const match of line.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu)) {
      output.push({
        kind: "wiki",
        label: match[2] || null,
        target: match[1] ?? "",
        source_line: index + 1,
      });
    }
  }
  return output;
}

function extractTags(frontmatter: Record<string, string>, lines: string[]): string[] {
  const configured = frontmatter.tags ?? frontmatter.tag ?? "";
  const tags = configured
    .replace(/^\[|\]$/gu, "")
    .split(",")
    .map((item) => item.trim());
  for (const line of lines) {
    for (const match of line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu))
      if (match[1]) tags.push(match[1]);
  }
  return tags.filter(Boolean);
}

function classifyLine(line: string): NormalizedBlockKind {
  if (/^\s*(?:[-*+] |\d+[.)] )/u.test(line)) return "list";
  if (/^\s*>/u.test(line)) return "quote";
  if (line.includes("|") && /^\s*\|?.+\|.+\|?\s*$/u.test(line)) return "table";
  return "paragraph";
}

function block(
  kind: NormalizedBlockKind,
  text: string,
  headingPath: string[],
  start: number,
  end: number,
): NormalizedBlock {
  return {
    kind,
    text,
    heading_path: [...headingPath],
    source_start_line: start,
    source_end_line: end,
    metadata: {},
  };
}

function fileTitle(path: string): string {
  const name = basename(path);
  return name.slice(0, Math.max(0, name.length - extname(name).length));
}

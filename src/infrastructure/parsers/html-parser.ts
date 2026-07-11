import type { NormalizedBlock, NormalizedLink } from "../../domains/ingestion/index.ts";
import { buildNormalizedDocument, decodeUtf8, normalizeText } from "./document-builder.ts";

export function parseHtml(input: { logicalPath: string; mediaType: string; bytes: Uint8Array }) {
  const html = decodeUtf8(input.bytes);
  const title = decodeEntities(
    /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.replace(/<[^>]+>/gu, "") ?? "",
  );
  const links = extractLinks(html);
  const safe = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<h([1-6])\b[^>]*>/giu, (_match, level: string) => `\n@@H${level} `)
    .replace(/<\/(h[1-6]|p|div|section|article|li|tr|pre|blockquote)>/giu, "\n")
    .replace(/<(br|hr)\b[^>]*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<blockquote\b[^>]*>/giu, "\n> ")
    .replace(/<[^>]+>/gu, " ");
  const lines = decodeEntities(safe).replace(/\r\n?/gu, "\n").split("\n");
  const blocks: NormalizedBlock[] = [];
  const headingPath: string[] = [];
  let buffer: string[] = [];
  let start = 1;
  const flush = (end: number) => {
    const value = normalizeText(buffer.join(" ").replace(/\s+/gu, " "));
    if (value) {
      const kind = value.startsWith("- ") ? "list" : value.startsWith("> ") ? "quote" : "paragraph";
      blocks.push({
        kind,
        text: value,
        heading_path: [...headingPath],
        source_start_line: start,
        source_end_line: end,
        metadata: {},
      });
    }
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeText(lines[index] ?? "");
    const heading = /^@@H([1-6])\s+(.+)$/u.exec(line);
    if (heading) {
      flush(index);
      const level = Number(heading[1]);
      const value = heading[2] ?? "";
      headingPath.splice(level - 1);
      headingPath[level - 1] = value;
      blocks.push({
        kind: "heading",
        text: value,
        heading_path: [...headingPath],
        source_start_line: index + 1,
        source_end_line: index + 1,
        metadata: {},
      });
      continue;
    }
    if (!line) {
      flush(index);
      start = index + 2;
    } else {
      if (buffer.length === 0) start = index + 1;
      buffer.push(line);
    }
  }
  flush(lines.length);
  return buildNormalizedDocument({
    logicalPath: input.logicalPath,
    mediaType: input.mediaType,
    parserId: "html",
    title: title || blocks.find((block) => block.kind === "heading")?.text || input.logicalPath,
    blocks,
    links,
    metadata: { scripts_removed: true },
  });
}

function extractLinks(html: string): NormalizedLink[] {
  const output: NormalizedLink[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )) {
    output.push({
      kind: "html",
      target: decodeEntities(match[1] ?? ""),
      label: normalizeText(decodeEntities((match[2] ?? "").replace(/<[^>]+>/gu, " "))) || null,
      source_line: null,
    });
  }
  return output;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

import { sha256Text } from "../../../shared/hash/sha256.ts";
import type { NormalizedBlock, NormalizedDocument } from "../../ingestion/index.ts";
import type { ChunkDraft } from "../model/types.ts";

export function chunkDocument(
  document: NormalizedDocument,
  config: { max_tokens: number; overlap_tokens: number },
): ChunkDraft[] {
  if (document.blocks.length === 0) return [];
  const fragments = document.blocks.flatMap((block) => splitBlock(block, config.max_tokens));
  const groups: NormalizedBlock[][] = [];
  let current: NormalizedBlock[] = [];
  let tokens = 0;
  for (const fragment of fragments) {
    const nextTokens = estimateTokens(fragment.text);
    if (current.length > 0 && tokens + nextTokens > config.max_tokens) {
      groups.push(current);
      current = overlapTail(current, config.overlap_tokens);
      tokens = current.reduce((total, item) => total + estimateTokens(item.text), 0);
      while (current.length > 0 && tokens + nextTokens > config.max_tokens) {
        const removed = current.shift();
        tokens -= removed ? estimateTokens(removed.text) : 0;
      }
    }
    current.push(fragment);
    tokens += nextTokens;
  }
  if (current.length > 0) groups.push(current);
  const headingOccurrences = new Map<string, number>();
  return groups.map((group, ordinal) => {
    const content = group
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    const headingPath = group.findLast((item) => item.heading_path.length > 0)?.heading_path ?? [];
    const headingKey = headingPath.join(" > ");
    const occurrence = headingOccurrences.get(headingKey) ?? 0;
    headingOccurrences.set(headingKey, occurrence + 1);
    const kinds = new Set(group.map((item) => item.kind));
    return {
      ordinal,
      content_text: content,
      content_hash: sha256Text(content),
      block_kind: kinds.size === 1 ? (group[0]?.kind ?? "paragraph") : "composite",
      token_estimate: estimateTokens(content),
      heading_path: headingPath,
      source_start_line: Math.min(...group.map((item) => item.source_start_line)),
      source_end_line: Math.max(...group.map((item) => item.source_end_line)),
      anchor_key: sha256Text(`${headingKey}\n${occurrence}`),
    };
  });
}

export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  const other = text.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]/gu,
    "",
  ).length;
  return cjk + Math.ceil(other / 4);
}

function splitBlock(block: NormalizedBlock, maxTokens: number): NormalizedBlock[] {
  if (estimateTokens(block.text) <= maxTokens) return [block];
  const lines = block.text.split("\n");
  const output: NormalizedBlock[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (buffer.length > 0 && estimateTokens([...buffer, line].join("\n")) > maxTokens) {
      output.push({ ...block, text: buffer.join("\n") });
      buffer = [];
    }
    if (estimateTokens(line) <= maxTokens) buffer.push(line);
    else output.push(...splitLongLine(block, line, maxTokens));
  }
  if (buffer.length > 0) output.push({ ...block, text: buffer.join("\n") });
  return output;
}

function splitLongLine(block: NormalizedBlock, text: string, maxTokens: number): NormalizedBlock[] {
  const pieces = text.split(/(?<=[。！？.!?])\s*/u).filter(Boolean);
  const output: NormalizedBlock[] = [];
  let buffer = "";
  for (const piece of pieces.length > 1 ? pieces : [...text]) {
    if (estimateTokens(piece) > maxTokens) {
      if (buffer) output.push({ ...block, text: buffer });
      buffer = "";
      output.push(...splitCharacters(block, piece, maxTokens));
      continue;
    }
    if (buffer && estimateTokens(buffer + piece) > maxTokens) {
      output.push({ ...block, text: buffer });
      buffer = "";
    }
    buffer += piece;
  }
  if (buffer) output.push({ ...block, text: buffer });
  return output;
}

function splitCharacters(
  block: NormalizedBlock,
  text: string,
  maxTokens: number,
): NormalizedBlock[] {
  const output: NormalizedBlock[] = [];
  let buffer = "";
  for (const character of text) {
    if (buffer && estimateTokens(buffer + character) > maxTokens) {
      output.push({ ...block, text: buffer });
      buffer = "";
    }
    buffer += character;
  }
  if (buffer) output.push({ ...block, text: buffer });
  return output;
}

function overlapTail(blocks: NormalizedBlock[], budget: number): NormalizedBlock[] {
  if (budget <= 0) return [];
  const output: NormalizedBlock[] = [];
  let tokens = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block) continue;
    const next = estimateTokens(block.text);
    if (tokens + next > budget) break;
    output.unshift(block);
    tokens += next;
  }
  return output;
}

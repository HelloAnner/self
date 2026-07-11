import { describe, expect, test } from "bun:test";
import { chunkDocument } from "../../src/domains/knowledge/index.ts";
import { parseMarkdown } from "../../src/infrastructure/parsers/markdown-parser.ts";

describe("semantic Chunker", () => {
  test("is deterministic and limits Chunk size", () => {
    const document = parseMarkdown({
      logicalPath: "long.md",
      mediaType: "text/markdown",
      bytes: new TextEncoder().encode(
        "# One\n\nAlpha evidence sentence. Another stable sentence.\n\n## Two\n\n中文证据用于验证切片边界。第二句话保持确定性。\n",
      ),
    });
    const config = { max_tokens: 12, overlap_tokens: 2 };
    const first = chunkDocument(document, config);
    const second = chunkDocument(document, config);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.token_estimate <= config.max_tokens)).toBe(true);
    expect(new Set(first.map((chunk) => chunk.anchor_key)).size).toBe(first.length);
  });
});

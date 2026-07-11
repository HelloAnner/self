import { describe, expect, test } from "bun:test";
import { parseHtml } from "../../src/infrastructure/parsers/html-parser.ts";
import { parseJsonLines } from "../../src/infrastructure/parsers/jsonl-parser.ts";
import { parseMarkdown } from "../../src/infrastructure/parsers/markdown-parser.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("deterministic document parsers", () => {
  test("Markdown preserves structure, evidence lines, links, tags, and code", () => {
    const document = parseMarkdown({
      logicalPath: "guide.md",
      mediaType: "text/markdown",
      bytes: bytes(
        "---\ntags: [agent, memory]\nowner: self\n---\n# Guide\n\nSee [[Evidence|proof]] and [source](https://example.test).\n\n```ts\nconst stable = true;\n```\n",
      ),
    });
    expect(document.title).toBe("Guide");
    expect(document.frontmatter.owner).toBe("self");
    expect(document.tags).toEqual(["agent", "memory"]);
    expect(document.links.map((link) => link.kind)).toEqual(["markdown", "wiki"]);
    expect(document.blocks.find((block) => block.kind === "code")?.text).toContain("stable");
    expect(document.blocks.every((block) => block.source_start_line > 0)).toBe(true);
  });

  test("HTML removes executable content while retaining text and links", () => {
    const document = parseHtml({
      logicalPath: "page.html",
      mediaType: "text/html",
      bytes: bytes(
        "<html><head><title>Evidence</title><script>steal()</script></head><body><h1>Title</h1><p>Safe &amp; local.</p><a href='/proof'>proof</a></body></html>",
      ),
    });
    expect(document.title).toBe("Evidence");
    expect(document.text).toContain("Safe & local");
    expect(document.text).not.toContain("steal");
    expect(document.links[0]?.target).toBe("/proof");
  });

  test("JSONL canonicalizes key order and rejects a broken record", () => {
    const document = parseJsonLines({
      logicalPath: "events.jsonl",
      mediaType: "application/x-ndjson",
      bytes: bytes('{"z":1,"a":2}\n'),
    });
    expect(document.text).toBe('{"a":2,"z":1}');
    expect(() =>
      parseJsonLines({
        logicalPath: "broken.jsonl",
        mediaType: "application/x-ndjson",
        bytes: bytes("{broken}\n"),
      }),
    ).toThrow("Invalid JSONL");
  });
});

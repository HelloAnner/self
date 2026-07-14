import { describe, expect, test } from "bun:test";
import { validatePageIr } from "../../src/domains/artifact/index.ts";

describe("Page IR v1", () => {
  test("rejects unknown components and malformed Citation hashes", () => {
    const result = validatePageIr({
      schema: "self.page-ir",
      version: 1,
      artifact: {},
      topic: {},
      template: {},
      theme: {},
      components: [
        {
          key: "unsafe",
          type: "raw_html",
          contentHash: "0".repeat(64),
          dependencyHash: "0".repeat(64),
          payload: {},
        },
      ],
      citations: [{ citationId: "c1", excerpt: "evidence", excerptHash: "broken" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("component_0_type_invalid");
    expect(result.errors).toContain("citation_0_hash_invalid");
  });
});

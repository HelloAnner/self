import { describe, expect, test } from "bun:test";
import { createResourceId, isResourceId } from "../../src/shared/ids/id.ts";
import { RESOURCE_PREFIXES } from "../../src/shared/ids/registry.ts";

describe("stable resource IDs", () => {
  test("creates a UUID v7 ID for every registered resource", () => {
    for (const resource of Object.keys(RESOURCE_PREFIXES) as (keyof typeof RESOURCE_PREFIXES)[]) {
      const id = createResourceId(resource);
      expect(isResourceId(id, resource)).toBe(true);
      expect(id.split("_")[1]?.at(14)).toBe("7");
    }
  });

  test("does not accept another resource prefix", () => {
    expect(isResourceId(createResourceId("source"), "chunk")).toBe(false);
  });
});

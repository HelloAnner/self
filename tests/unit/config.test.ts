import { describe, expect, test } from "bun:test";
import { parseSelfConfig, stringifySelfConfig } from "../../src/domains/workspace/config/codec.ts";
import { createDefaultConfig } from "../../src/domains/workspace/config/defaults.ts";
import { createResourceId } from "../../src/shared/ids/id.ts";

describe("self.toml schema", () => {
  test("round trips the strict default configuration", () => {
    const config = createDefaultConfig(
      "/tmp/example",
      createResourceId("workspace"),
      "2026-07-11T00:00:00.000Z",
      true,
    );
    expect(parseSelfConfig(stringifySelfConfig(config))).toEqual(config);
  });

  test("rejects plaintext provider secrets and unknown fields", () => {
    const config = createDefaultConfig(
      "/tmp/example",
      createResourceId("workspace"),
      "2026-07-11T00:00:00.000Z",
      false,
    );
    const unsafe = stringifySelfConfig(config).replace(
      "[models]\n",
      '[models]\napi_key = "plaintext"\n',
    );
    expect(() => parseSelfConfig(unsafe)).toThrow();
  });
});

import { expect, test } from "bun:test";
import { successEnvelope } from "../../src/cli/protocol/envelope.ts";

test("success envelope keeps the stable shape", () => {
  expect(successEnvelope({ value: 1 }, "req_test")).toEqual({
    ok: true,
    data: { value: 1 },
    meta: {
      request_id: "req_test",
      operation_id: null,
      root: null,
      warnings: [],
      next_actions: [],
    },
    error: null,
  });
});

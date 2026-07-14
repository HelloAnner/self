import { describe, expect, test } from "bun:test";
import { COMMAND_SPECS, commandSchema } from "../../src/cli/protocol/command-specs.ts";

describe("machine-readable command contracts", () => {
  test("every published command has a closed input schema", () => {
    for (const spec of COMMAND_SPECS) {
      expect(commandSchema(spec.id)).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: spec.id,
        type: "object",
        additionalProperties: false,
        "x-self-root": spec.root,
        "x-self-execution": spec.execution,
      });
    }
  });

  test("write commands expose required safety inputs", () => {
    expect(commandSchema("config.set")).toMatchObject({
      required: ["root", "path", "value"],
      properties: {
        root: { type: "string" },
        path: { type: "string" },
        value: { type: "string" },
      },
    });
    expect(commandSchema("init.rollback")).toMatchObject({
      required: ["directory", "plan"],
      properties: { plan: { const: true } },
    });
    expect(commandSchema("source.add")).toMatchObject({
      required: ["root", "input"],
      properties: { no_build: { const: true } },
    });
    expect(commandSchema("source.delete")).toMatchObject({
      required: ["root", "source_id", "plan"],
      properties: { plan: { const: true } },
    });
    expect(commandSchema("vector-space.activate")).toMatchObject({
      required: ["root", "vector_space_id", "plan"],
      properties: { plan: { const: true } },
    });
    expect(commandSchema("vector-space.migrate")).toMatchObject({
      properties: { from_local_chunks: { const: true }, plan: { const: true } },
    });
    expect(commandSchema("graph.activate")).toMatchObject({
      required: ["root", "generation_id", "plan"],
      properties: { plan: { const: true } },
    });
    expect(commandSchema("entity.merge")).toMatchObject({
      required: ["root", "source_id", "target_id", "plan"],
      properties: { plan: { const: true } },
    });
    expect(commandSchema("relation.create")).toMatchObject({
      required: ["root", "subject_id", "predicate", "object_id", "plan"],
      properties: { plan: { const: true } },
    });
  });
});

import type { CommandSpec } from "./command-specs.ts";

type JsonSchema = Record<string, unknown>;
const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const root = { root: string("Workspace Root"), json: boolean("Emit JSON") };

export const RETRIEVAL_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  ask: object(
    {
      ...root,
      query: string("Question or - for stdin"),
      mode: { type: "string", enum: ["text", "vector", "hybrid"] },
      depth: { type: "string", enum: ["shallow", "normal", "deep"] },
      model: string("Optional Chat Model ID"),
      source: string("Optional Source ID"),
      tokens: string("EvidenceContext token budget"),
      allow_model_knowledge: boolean("Allow separately labeled knowledge outside Self"),
    },
    ["root", "query"],
  ),
  related: object(
    {
      ...root,
      target: string("Resource ID or query"),
      depth: string("Graph depth"),
      limit: string("Limit"),
    },
    ["root", "target"],
  ),
  trace: object({ ...root, id: string("Answer, Section, Claim, or Chunk ID") }, ["root", "id"]),
};

export const RETRIEVAL_COMMAND_SPECS: CommandSpec[] = [
  {
    id: "ask",
    summary: "Answer only from validated evidence",
    root: "required",
    execution: "write",
  },
  { id: "related", summary: "Find bounded related knowledge", root: "required", execution: "read" },
  {
    id: "trace",
    summary: "Trace evidence to Source Snapshot",
    root: "required",
    execution: "read",
  },
];

import type { CommandSpec } from "./command-specs.ts";

type JsonSchema = Record<string, unknown>;
const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const root = { root: string("Workspace Root"), json: boolean("Emit JSON") };

export const SEARCH_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "model.add": object(
    {
      ...root,
      provider: string("Provider name"),
      capability: { type: "string", enum: ["embedding", "chat"] },
      model: string("Provider Model ID"),
      revision: string("Fixed revision or floating"),
      dimensions: string("Comma-separated dimensions"),
    },
    ["root", "provider", "capability", "model", "revision"],
  ),
  "model.list": object({ ...root, capability: string("Optional capability") }, ["root"]),
  "model.show": object({ ...root, model_id: string("Model public ID") }, ["root", "model_id"]),
  "model.test": object(
    { ...root, model_id: string("Model public ID"), suite: { const: "embedding-compat" } },
    ["root", "model_id", "suite"],
  ),
  "vector-space.create": object(
    {
      ...root,
      model: string("Embedding Model public ID"),
      dimensions: string("Vector dimensions"),
      distance: { const: "cosine" },
      normalize: { const: "l2" },
      query_instruction: string("Versioned Query Instruction ID"),
      plan: { const: true },
    },
    ["root", "model", "dimensions", "plan"],
  ),
  "vector-space.list": object(root, ["root"]),
  "vector-space.show": vectorId(),
  "vector-space.active": object(root, ["root"]),
  "vector-space.build": object(
    { ...root, vector_space_id: string("VectorSpace public ID"), batch_size: string("Batch size") },
    ["root", "vector_space_id"],
  ),
  "vector-space.verify": object(
    { ...root, vector_space_id: string("VectorSpace public ID"), deep: boolean("Deep checks") },
    ["root", "vector_space_id"],
  ),
  "vector-space.compare": object(
    {
      ...root,
      left_id: string("Left VectorSpace ID"),
      right_id: string("Right VectorSpace ID"),
      fixture: string("Retrieval Fixture ID"),
    },
    ["root", "left_id", "right_id", "fixture"],
  ),
  "vector-space.activate": plannedVectorId(),
  "vector-space.delete": plannedVectorId(),
  "vector-space.migrate": object(
    {
      ...root,
      from: string("Existing VectorSpace ID"),
      to_model: string("Replacement Model ID"),
      dimensions: string("Replacement dimensions"),
      from_local_chunks: { const: true },
      query_instruction: string("Query Instruction ID"),
      plan: { const: true },
    },
    ["root", "from", "to_model", "dimensions", "from_local_chunks", "plan"],
  ),
  search: object(
    {
      ...root,
      query: string("Search Query"),
      mode: { type: "string", enum: ["text", "vector", "hybrid"] },
      limit: string("Result limit"),
      source: string("Source filter"),
      path: string("Path prefix"),
      type: string("Media type"),
      tag: string("Tag"),
      since: string("Inclusive ISO time"),
      until: string("Inclusive ISO time"),
      explain: boolean("Include Retrieval Trace"),
    },
    ["root", "query"],
  ),
};

export const SEARCH_COMMAND_SPECS: CommandSpec[] = [
  { id: "model.add", summary: "Register an Embedding Model", root: "required", execution: "write" },
  { id: "model.list", summary: "List registered Models", root: "required", execution: "read" },
  { id: "model.show", summary: "Show one Model and Provider", root: "required", execution: "read" },
  {
    id: "model.test",
    summary: "Run an explicit Model compatibility test",
    root: "required",
    execution: "write",
  },
  {
    id: "vector-space.create",
    summary: "Plan an immutable VectorSpace",
    root: "required",
    execution: "plan",
  },
  { id: "vector-space.list", summary: "List VectorSpaces", root: "required", execution: "read" },
  { id: "vector-space.show", summary: "Show one VectorSpace", root: "required", execution: "read" },
  {
    id: "vector-space.active",
    summary: "Show the active VectorSpace",
    root: "required",
    execution: "read",
  },
  {
    id: "vector-space.build",
    summary: "Build VectorSpace embeddings",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "vector-space.verify",
    summary: "Verify coverage and compatibility",
    root: "required",
    execution: "read",
  },
  {
    id: "vector-space.compare",
    summary: "Compare two verified spaces",
    root: "required",
    execution: "read",
  },
  {
    id: "vector-space.activate",
    summary: "Plan an active pointer switch",
    root: "required",
    execution: "plan",
  },
  {
    id: "vector-space.migrate",
    summary: "Plan rebuild from local Chunks",
    root: "required",
    execution: "plan",
  },
  {
    id: "vector-space.delete",
    summary: "Plan VectorSpace deletion",
    root: "required",
    execution: "plan",
  },
  {
    id: "search",
    summary: "Search text, vector, or hybrid evidence",
    root: "required",
    execution: "read",
  },
];

function vectorId(): JsonSchema {
  return object({ ...root, vector_space_id: string("VectorSpace public ID") }, [
    "root",
    "vector_space_id",
  ]);
}

function plannedVectorId(): JsonSchema {
  return object(
    { ...root, vector_space_id: string("VectorSpace public ID"), plan: { const: true } },
    ["root", "vector_space_id", "plan"],
  );
}

import type { CommandSpec } from "./command-specs.ts";

type JsonSchema = Record<string, unknown>;
const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const object = (
  properties: Record<string, JsonSchema>,
  required: string[] = ["root"],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const root = { root: string("Workspace Root"), json: boolean("Emit JSON") };
const id = (name: string) => object({ ...root, id: string(`${name} public ID`) }, ["root", "id"]);
const moderation = (name: string) =>
  object(
    {
      ...root,
      id: string(`${name} public ID`),
      reason: string("Moderation reason"),
      if_version: string("Expected resource version"),
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "id"],
  );
const remove = (name: string) =>
  object(
    {
      ...root,
      id: string(`${name} public ID`),
      plan: { const: true },
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "id", "plan"],
  );
const restore = (name: string) =>
  object(
    {
      ...root,
      id: string(`${name} public ID`),
      if_version: string("Expected deleted resource version"),
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "id"],
  );

export const GRAPH_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "graph.status": object(root),
  "graph.verify": object({
    ...root,
    deep: boolean("Deep validation"),
    generation: string("Generation ID"),
  }),
  "graph.build": object({
    ...root,
    changed_only: boolean("Incremental build"),
    model: string("Extraction Model ID"),
    max_chunks: string("Extraction cap"),
    vector_space: string("VectorSpace ID"),
    detach: boolean("Request detached execution"),
  }),
  "graph.rebuild": object(
    {
      ...root,
      layer: string("Graph layer"),
      model: string("Extraction Model ID"),
      max_chunks: string("Extraction cap"),
      vector_space: string("VectorSpace ID"),
      detach: boolean("Request detached execution"),
    },
    ["root", "layer"],
  ),
  "graph.neighbors": object(
    {
      ...root,
      id: string("Seed object ID"),
      depth: string("Depth 1-4"),
      predicate: string("Predicate allowlist"),
      nodes: string("Node limit"),
      edges: string("Edge limit"),
    },
    ["root", "id"],
  ),
  "graph.path": object(
    {
      ...root,
      from_id: string("Start object ID"),
      to_id: string("Target object ID"),
      max_depth: string("Depth 1-4"),
    },
    ["root", "from_id", "to_id"],
  ),
  "graph.subgraph": object({
    ...root,
    seed: string("Optional seed"),
    nodes: string("Node limit"),
    edges: string("Edge limit"),
  }),
  "graph.links": object({ ...root, document_id: string("Document ID") }, ["root", "document_id"]),
  "graph.backlinks": object({ ...root, document_id: string("Document ID") }, [
    "root",
    "document_id",
  ]),
  "graph.diff": object(
    { ...root, left_id: string("Left Generation"), right_id: string("Right Generation") },
    ["root", "left_id", "right_id"],
  ),
  "graph.activate": object(
    { ...root, generation_id: string("Generation ID"), plan: { const: true } },
    ["root", "generation_id", "plan"],
  ),
  "graph.unresolved.list": object({ ...root, status: string("Resolution state") }),
  "graph.unresolved.show": id("Reference"),
  "graph.unresolved.retry": object({ ...root, all: { const: true } }, ["root", "all"]),
  "graph.predicate.list": object(root),
  "graph.predicate.show": object({ ...root, key: string("Predicate key") }, ["root", "key"]),
  "graph.export": object(
    {
      ...root,
      format: { type: "string", enum: ["json", "jsonld", "graphml"] },
      output: string("Export path"),
      scope: string("Export scope"),
    },
    ["root", "format", "output"],
  ),
  "entity.list": object({ ...root, type: string("Entity type") }),
  "entity.show": id("Entity"),
  "entity.aliases": id("Entity"),
  "entity.mentions": id("Entity"),
  "entity.candidates": object(
    { ...root, name: string("Candidate name"), type: string("Entity type") },
    ["root", "name"],
  ),
  "entity.create": object(
    {
      ...root,
      type: string("Entity type"),
      name: string("Canonical name"),
      user_asserted: { const: true },
      description: string("Description"),
      identity_key: string("Strong identity key"),
      plan: { const: true },
    },
    ["root", "type", "name", "user_asserted", "plan"],
  ),
  "entity.merge": object(
    {
      ...root,
      source_id: string("Redirected Entity"),
      target_id: string("Canonical Entity"),
      reason: string("Merge reason"),
      plan: { const: true },
    },
    ["root", "source_id", "target_id", "plan"],
  ),
  "entity.confirm": moderation("Entity"),
  "entity.reject": moderation("Entity"),
  "entity.delete": remove("Entity"),
  "entity.restore": restore("Entity"),
  "relation.show": id("Relation"),
  "relation.evidence": id("Relation"),
  "relation.create": object(
    {
      ...root,
      subject_id: string("Subject"),
      predicate: string("Predicate key"),
      object_id: string("Object"),
      evidence: string("Chunk evidence"),
      user_asserted: boolean("Allow evidence-free user assertion"),
      plan: { const: true },
    },
    ["root", "subject_id", "predicate", "object_id", "plan"],
  ),
  "relation.confirm": moderation("Relation"),
  "relation.reject": moderation("Relation"),
  "relation.delete": remove("Relation"),
  "relation.restore": restore("Relation"),
  "claim.show": id("Claim"),
  "claim.evidence": id("Claim"),
  "claim.relations": id("Claim"),
  "claim.conflicts": id("Claim"),
  "claim.confirm": moderation("Claim"),
  "claim.reject": moderation("Claim"),
  "claim.delete": remove("Claim"),
  "claim.restore": restore("Claim"),
  "conflict.show": id("Conflict"),
};

const read = (id: string, summary: string): CommandSpec => ({
  id,
  summary,
  root: "required",
  execution: "read",
});
const write = (id: string, summary: string): CommandSpec => ({
  id,
  summary,
  root: "required",
  execution: "write",
});
const planned = (id: string, summary: string): CommandSpec => ({
  id,
  summary,
  root: "required",
  execution: "plan",
});

export const GRAPH_COMMAND_SPECS: CommandSpec[] = [
  read("graph.status", "Show active Graph Generation"),
  read("graph.verify", "Verify Graph invariants"),
  {
    id: "graph.build",
    summary: "Build and optionally activate the Graph",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "graph.rebuild",
    summary: "Build a shadow Graph Generation",
    root: "required",
    execution: "maintenance",
  },
  read("graph.neighbors", "Traverse bounded neighbors"),
  read("graph.path", "Find a bounded path"),
  read("graph.subgraph", "Return a bounded Cytoscape subgraph"),
  read("graph.links", "List explicit document links"),
  read("graph.backlinks", "List incoming document links"),
  read("graph.diff", "Diff Graph Generations"),
  planned("graph.activate", "Plan Graph Generation activation"),
  read("graph.unresolved.list", "List unresolved references"),
  read("graph.unresolved.show", "Show unresolved reference"),
  write("graph.unresolved.retry", "Retry all unresolved references"),
  read("graph.predicate.list", "List Predicate Registry"),
  read("graph.predicate.show", "Show Predicate definition"),
  write("graph.export", "Export active Graph"),
  read("entity.list", "List Entities"),
  read("entity.show", "Show Entity"),
  read("entity.aliases", "List Entity aliases"),
  read("entity.mentions", "List Entity mentions"),
  read("entity.candidates", "Find Entity candidates"),
  planned("entity.create", "Plan user Entity creation"),
  planned("entity.merge", "Plan Entity merge"),
  write("entity.confirm", "Confirm Entity candidate"),
  write("entity.reject", "Reject Entity candidate"),
  planned("entity.delete", "Plan Entity soft deletion and dependency invalidation"),
  write("entity.restore", "Restore an Entity and exact dependent states"),
  read("relation.show", "Show Relation"),
  read("relation.evidence", "Show Relation evidence"),
  planned("relation.create", "Plan typed Relation creation"),
  write("relation.confirm", "Confirm Relation candidate"),
  write("relation.reject", "Reject Relation candidate"),
  planned("relation.delete", "Plan Relation soft deletion and dependency invalidation"),
  write("relation.restore", "Restore a Relation and exact dependent states"),
  read("claim.show", "Show Claim"),
  read("claim.evidence", "Show Claim evidence"),
  read("claim.relations", "Show Claim relations"),
  read("claim.conflicts", "Show Claim conflicts"),
  write("claim.confirm", "Confirm Claim candidate"),
  write("claim.reject", "Reject Claim candidate"),
  planned("claim.delete", "Plan Claim soft deletion and dependency invalidation"),
  write("claim.restore", "Restore a Claim and exact dependent states"),
  read("conflict.show", "Show Conflict Set"),
];

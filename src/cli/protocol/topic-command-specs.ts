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

export const TOPIC_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "topic.create": object(
    {
      ...root,
      name: string("Topic name"),
      scope: string("Topic inclusion scope"),
      exclude: string("Topic exclusion conditions"),
      description: string("Human-readable description"),
      aliases: { type: "array", items: { type: "string" } },
    },
    ["root", "name"],
  ),
  "topic.list": object(
    { ...root, status: string("Optional lifecycle status"), limit: string("Result limit") },
    ["root"],
  ),
  "topic.show": object({ ...root, topic_id: string("Topic ID") }, ["root", "topic_id"]),
  "topic.update": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      scope: string("Replacement scope"),
      exclude: string("Replacement exclusions"),
      add_alias: string("Alias to add"),
      if_version: string("Expected Topic version"),
    },
    ["root", "topic_id"],
  ),
  "topic.build": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      mode: { type: "string", enum: ["text", "vector", "hybrid"] },
      limit: string("Candidate limit"),
      tokens: string("Evidence token budget"),
      template: string("Artifact template ID"),
      wait: boolean("Wait for completion"),
    },
    ["root", "topic_id"],
  ),
  "topic.refresh": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      mode: { type: "string", enum: ["text", "vector", "hybrid"] },
      limit: string("Candidate limit"),
      tokens: string("Evidence token budget"),
      template: string("Artifact template ID"),
      since_last_build: boolean("Compare against the latest Build"),
      explain_changes: boolean("Return the incremental decision"),
    },
    ["root", "topic_id"],
  ),
  "topic.report": object(
    { ...root, topic_id: string("Topic ID"), snapshot: string("Optional Topic Snapshot ID") },
    ["root", "topic_id"],
  ),
  "topic.history": object({ ...root, topic_id: string("Topic ID") }, ["root", "topic_id"]),
  "topic.diff": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      from: string("Parent Build ID"),
      to: string("Target Build ID or latest"),
    },
    ["root", "topic_id", "from"],
  ),
  "topic.open": object({ ...root, topic_id: string("Topic ID") }, ["root", "topic_id"]),
  "topic.export": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      format: { type: "string", enum: ["html", "markdown", "json"] },
      output: string("Explicit output path"),
      single_file: boolean("Inline all HTML assets"),
    },
    ["root", "topic_id", "format"],
  ),
  "topic.delete": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      plan: { const: true },
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "topic_id", "plan"],
  ),
  "topic.restore": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      if_version: string("Expected deleted Topic version"),
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "topic_id"],
  ),
};

export const TOPIC_COMMAND_SPECS: CommandSpec[] = [
  {
    id: "topic.create",
    summary: "Define a long-lived Topic scope",
    root: "required",
    execution: "write",
  },
  { id: "topic.list", summary: "List Topics", root: "required", execution: "read" },
  {
    id: "topic.show",
    summary: "Show Topic state and latest snapshot",
    root: "required",
    execution: "read",
  },
  {
    id: "topic.update",
    summary: "Version Topic scope or aliases",
    root: "required",
    execution: "write",
  },
  {
    id: "topic.build",
    summary: "Create an immutable trusted synthesis snapshot",
    root: "required",
    execution: "write",
  },
  {
    id: "topic.report",
    summary: "Read an existing structured Topic report",
    root: "required",
    execution: "read",
  },
  {
    id: "topic.refresh",
    summary: "Incrementally refresh a Topic and its Artifact",
    root: "required",
    execution: "write",
  },
  {
    id: "topic.history",
    summary: "List immutable Topic Artifact Builds",
    root: "required",
    execution: "read",
  },
  {
    id: "topic.diff",
    summary: "Compare two Topic Artifact Builds",
    root: "required",
    execution: "read",
  },
  {
    id: "topic.open",
    summary: "Open the latest offline Topic HTML",
    root: "required",
    execution: "read",
  },
  {
    id: "topic.export",
    summary: "Export the latest Topic Build",
    root: "required",
    execution: "write",
  },
  { id: "topic.delete", summary: "Plan Topic soft deletion", root: "required", execution: "plan" },
  { id: "topic.restore", summary: "Restore a deleted Topic", root: "required", execution: "write" },
];

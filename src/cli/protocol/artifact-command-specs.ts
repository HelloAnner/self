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

export const ARTIFACT_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "artifact.list": object({ ...root, status: string("Optional Artifact status") }, ["root"]),
  "artifact.show": object({ ...root, artifact_id: string("Artifact ID") }, ["root", "artifact_id"]),
  "artifact.open": object({ ...root, artifact_id: string("Artifact ID") }, ["root", "artifact_id"]),
  "artifact.history": object({ ...root, artifact_id: string("Artifact ID") }, [
    "root",
    "artifact_id",
  ]),
  "artifact.diff": object(
    { ...root, from_build: string("Parent Build ID"), to_build: string("Target Build ID") },
    ["root", "from_build", "to_build"],
  ),
  "artifact.render": object(
    {
      ...root,
      topic_id: string("Topic ID"),
      template: string("Template ID"),
      theme: string("Theme ID"),
    },
    ["root", "topic_id"],
  ),
  "artifact.export": object(
    {
      ...root,
      artifact_id: string("Artifact ID"),
      format: { type: "string", enum: ["html", "markdown", "json"] },
      output: string("Explicit output path"),
      single_file: boolean("Inline all HTML assets"),
    },
    ["root", "artifact_id", "format"],
  ),
  "artifact.delete": object(
    {
      ...root,
      artifact_id: string("Artifact ID"),
      plan: { const: true },
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "artifact_id", "plan"],
  ),
  "artifact.restore": object(
    {
      ...root,
      artifact_id: string("Artifact ID"),
      if_version: string("Expected deleted Artifact version"),
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "artifact_id"],
  ),
  "template.list": object(root, ["root"]),
};

export const ARTIFACT_COMMAND_SPECS: CommandSpec[] = [
  {
    id: "artifact.list",
    summary: "List long-lived Artifacts",
    root: "required",
    execution: "read",
  },
  {
    id: "artifact.show",
    summary: "Show an Artifact and latest Build",
    root: "required",
    execution: "read",
  },
  { id: "artifact.open", summary: "Open an Artifact offline", root: "required", execution: "read" },
  {
    id: "artifact.history",
    summary: "List immutable Artifact Builds",
    root: "required",
    execution: "read",
  },
  {
    id: "artifact.diff",
    summary: "Compare two Artifact Builds",
    root: "required",
    execution: "read",
  },
  {
    id: "artifact.render",
    summary: "Render an existing Page IR without synthesis",
    root: "required",
    execution: "write",
  },
  {
    id: "artifact.export",
    summary: "Export an existing Artifact Build",
    root: "required",
    execution: "write",
  },
  {
    id: "artifact.delete",
    summary: "Plan Artifact soft deletion",
    root: "required",
    execution: "plan",
  },
  {
    id: "artifact.restore",
    summary: "Restore a deleted Artifact",
    root: "required",
    execution: "write",
  },
  {
    id: "template.list",
    summary: "List registered templates and themes",
    root: "required",
    execution: "read",
  },
];

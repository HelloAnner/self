import { CONNECTION_COMMAND_SPECS, CONNECTION_INPUT_SCHEMAS } from "./connection-command-specs.ts";
import { KNOWLEDGE_COMMAND_SPECS, KNOWLEDGE_INPUT_SCHEMAS } from "./knowledge-command-specs.ts";

export type CommandSpec = {
  id: string;
  summary: string;
  root: "none" | "optional" | "required";
  execution: "read" | "write" | "plan" | "maintenance";
};

type JsonSchema = Record<string, unknown>;

const string = (description: string): JsonSchema => ({ type: "string", description });
const boolean = (description: string): JsonSchema => ({ type: "boolean", description });
const object = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const INPUT_SCHEMAS: Record<string, JsonSchema> = {
  version: object({ json: boolean("Emit a JSON envelope") }),
  commands: object({ json: boolean("Emit a JSON envelope") }),
  "schema.command": object(
    { id: string("Stable command ID"), json: boolean("Emit a JSON envelope") },
    ["id"],
  ),
  completion: object({ shell: { type: "string", enum: ["bash", "fish", "zsh"] } }, ["shell"]),
  init: object(
    {
      directory: string("Target Workspace directory"),
      offline: boolean("Skip hosted model configuration"),
      plan: boolean("Create a Plan when the target is non-empty"),
      json: boolean("Emit a JSON envelope"),
    },
    ["directory"],
  ),
  "init.resume": object(
    { directory: string("Workspace initialization target"), json: boolean("Emit JSON") },
    ["directory"],
  ),
  "init.rollback": object(
    {
      directory: string("Workspace initialization target"),
      plan: { const: true, description: "Required safety acknowledgement" },
      json: boolean("Emit JSON"),
    },
    ["directory", "plan"],
  ),
  apply: object(
    {
      plan_id: string("Plan public ID"),
      root: string("Workspace Root containing the Plan"),
      json: boolean("Emit JSON"),
    },
    ["plan_id", "root"],
  ),
  "migration.plan": object(
    { root: string("Workspace Root requiring migration"), json: boolean("Emit JSON") },
    ["root"],
  ),
  "setup.interactive": object({
    root: string("Existing or new Workspace Root"),
    offline: boolean("Skip hosted model configuration"),
    resume: boolean("Resume the latest SetupSession"),
    json: boolean("Emit JSON; interactive input is unavailable when not attached to a TTY"),
  }),
  "setup.status": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "setup.resume": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "setup.plan": object({ spec: string("Setup Spec TOML file"), json: boolean("Emit JSON") }, [
    "spec",
  ]),
  status: object(
    {
      root: string("Workspace Root or a descendant path"),
      verbose: boolean("Include detailed state"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "system.info": object({ json: boolean("Emit JSON") }),
  "doctor.system": object({ system: { const: true }, json: boolean("Emit JSON") }, ["system"]),
  "doctor.workspace": object(
    {
      root: string("Workspace Root or a descendant path"),
      workspace: boolean("Check Workspace state"),
      components: boolean("Check runtime components"),
      all: boolean("Run every implemented check"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "component.list": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, [
    "root",
  ]),
  "component.show": object(
    { root: string("Workspace Root"), name: string("Component name"), json: boolean("Emit JSON") },
    ["root", "name"],
  ),
  "component.verify": object(
    {
      root: string("Workspace Root"),
      name: string("Optional component name"),
      all: boolean("Verify all components"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "capability.list": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, [
    "root",
  ]),
  "capability.show": object(
    { root: string("Workspace Root"), name: string("Capability name"), json: boolean("Emit JSON") },
    ["root", "name"],
  ),
  "diagnostics.collect": object(
    {
      root: string("Workspace Root"),
      redact: { const: true, description: "Required redaction acknowledgement" },
      json: boolean("Emit JSON"),
    },
    ["root", "redact"],
  ),
  "diagnostics.show": object(
    {
      root: string("Workspace Root"),
      id: string("Diagnostics bundle ID"),
      json: boolean("Emit JSON"),
    },
    ["root", "id"],
  ),
  "diagnostics.verify": object(
    {
      root: string("Workspace Root"),
      id: string("Diagnostics bundle ID"),
      json: boolean("Emit JSON"),
    },
    ["root", "id"],
  ),
  "config.list": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "config.get": object(
    {
      root: string("Workspace Root"),
      path: string("Dotted configuration path"),
      json: boolean("Emit JSON"),
    },
    ["root", "path"],
  ),
  "config.set": object(
    {
      root: string("Workspace Root"),
      path: string("Dotted configuration path"),
      value: string("TOML-compatible scalar value"),
      json: boolean("Emit JSON"),
    },
    ["root", "path", "value"],
  ),
  "config.unset": object(
    {
      root: string("Workspace Root"),
      path: string("Dotted configuration path"),
      json: boolean("Emit JSON"),
    },
    ["root", "path"],
  ),
  "config.validate": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, [
    "root",
  ]),
  "source.add": object(
    {
      root: string("Workspace Root"),
      input: string("File, directory, URL, or - for stdin"),
      kind: {
        type: "string",
        enum: ["auto", "file", "markdown", "directory", "obsidian", "web", "text", "jsonl"],
      },
      mode: { type: "string", enum: ["import", "snapshot", "mirror"] },
      name: string("Human-readable Source name"),
      recursive: boolean("Recursively enumerate directories"),
      include: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      watch: boolean("Create a continuous Connection for the Source"),
      interval: string("Reconciliation interval"),
      settle: string("Write settle duration"),
      delete_grace: string("Deletion grace duration"),
      no_daemon: boolean("Do not start the Root-local daemon"),
      no_build: {
        const: true,
        description: "Archive only; skip default Ingestion/Knowledge build",
      },
      json: boolean("Emit JSON"),
    },
    ["root", "input"],
  ),
  "source.list": object(
    {
      root: string("Workspace Root"),
      status: { type: "string", enum: ["active", "failed", "deleted"] },
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "source.show": sourceIdSchema(),
  "source.status": sourceIdSchema(),
  "source.files": object(
    {
      root: string("Workspace Root"),
      source_id: string("Source public ID"),
      snapshot: string("Optional Snapshot public ID"),
      json: boolean("Emit JSON"),
    },
    ["root", "source_id"],
  ),
  "source.sync": object(
    {
      root: string("Workspace Root"),
      source_id: string("Optional Source public ID"),
      all: boolean("Sync every active Source"),
      changed_only: boolean("Return only changed results"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "source.retry": sourceIdSchema(),
  "source.delete": object(
    {
      root: string("Workspace Root"),
      source_id: string("Source public ID"),
      plan: { const: true, description: "Required safety acknowledgement" },
      json: boolean("Emit JSON"),
    },
    ["root", "source_id", "plan"],
  ),
  "source.restore": sourceIdSchema(),
};

export const COMMAND_SPECS: CommandSpec[] = [
  { id: "version", summary: "Show CLI and format versions", root: "none", execution: "read" },
  {
    id: "commands",
    summary: "List machine-readable command contracts",
    root: "none",
    execution: "read",
  },
  { id: "schema.command", summary: "Show a command JSON Schema", root: "none", execution: "read" },
  { id: "completion", summary: "Generate shell completion", root: "none", execution: "read" },
  { id: "init", summary: "Initialize a Self Workspace", root: "optional", execution: "write" },
  {
    id: "init.resume",
    summary: "Resume an interrupted initialization",
    root: "optional",
    execution: "write",
  },
  {
    id: "init.rollback",
    summary: "Plan rollback of an incomplete initialization",
    root: "optional",
    execution: "plan",
  },
  { id: "apply", summary: "Apply an approved Plan", root: "required", execution: "maintenance" },
  {
    id: "migration.plan",
    summary: "Plan an explicit database migration",
    root: "required",
    execution: "plan",
  },
  { id: "setup.interactive", summary: "Run guided setup", root: "optional", execution: "write" },
  {
    id: "setup.status",
    summary: "Show the latest setup session",
    root: "required",
    execution: "read",
  },
  {
    id: "setup.resume",
    summary: "Resume the latest setup session",
    root: "required",
    execution: "write",
  },
  {
    id: "setup.plan",
    summary: "Create a Setup Plan from a TOML spec",
    root: "none",
    execution: "plan",
  },
  { id: "status", summary: "Show Workspace status", root: "required", execution: "read" },
  {
    id: "system.info",
    summary: "Show binary and platform information",
    root: "none",
    execution: "read",
  },
  { id: "doctor.system", summary: "Verify system components", root: "none", execution: "read" },
  {
    id: "doctor.workspace",
    summary: "Verify Workspace integrity",
    root: "required",
    execution: "read",
  },
  { id: "component.list", summary: "List components", root: "required", execution: "read" },
  { id: "component.show", summary: "Show one component", root: "required", execution: "read" },
  { id: "component.verify", summary: "Verify components", root: "required", execution: "read" },
  { id: "capability.list", summary: "List capabilities", root: "required", execution: "read" },
  { id: "capability.show", summary: "Show one capability", root: "required", execution: "read" },
  {
    id: "diagnostics.collect",
    summary: "Collect redacted diagnostics",
    root: "required",
    execution: "write",
  },
  {
    id: "diagnostics.show",
    summary: "Show a diagnostics bundle",
    root: "required",
    execution: "read",
  },
  {
    id: "diagnostics.verify",
    summary: "Verify a diagnostics bundle",
    root: "required",
    execution: "read",
  },
  {
    id: "config.list",
    summary: "List validated configuration",
    root: "required",
    execution: "read",
  },
  {
    id: "config.get",
    summary: "Read one configuration value",
    root: "required",
    execution: "read",
  },
  {
    id: "config.set",
    summary: "Atomically update configuration",
    root: "required",
    execution: "write",
  },
  {
    id: "config.unset",
    summary: "Atomically remove configuration",
    root: "required",
    execution: "write",
  },
  { id: "config.validate", summary: "Validate self.toml", root: "required", execution: "read" },
  { id: "source.add", summary: "Archive a Source", root: "required", execution: "write" },
  { id: "source.list", summary: "List Sources", root: "required", execution: "read" },
  { id: "source.show", summary: "Show a Source", root: "required", execution: "read" },
  {
    id: "source.status",
    summary: "Show Source archive status",
    root: "required",
    execution: "read",
  },
  {
    id: "source.files",
    summary: "List Snapshot evidence files",
    root: "required",
    execution: "read",
  },
  {
    id: "source.sync",
    summary: "Archive the current Source state",
    root: "required",
    execution: "write",
  },
  { id: "source.retry", summary: "Retry a failed Source", root: "required", execution: "write" },
  {
    id: "source.delete",
    summary: "Plan Source soft deletion",
    root: "required",
    execution: "plan",
  },
  {
    id: "source.restore",
    summary: "Restore a deleted Source",
    root: "required",
    execution: "write",
  },
  ...CONNECTION_COMMAND_SPECS,
  ...KNOWLEDGE_COMMAND_SPECS,
];

export function commandSchema(id: string): Record<string, unknown> | undefined {
  const spec = COMMAND_SPECS.find((candidate) => candidate.id === id);
  if (!spec) return undefined;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: id,
    description: spec.summary,
    "x-self-root": spec.root,
    "x-self-execution": spec.execution,
    ...(INPUT_SCHEMAS[id] ??
      CONNECTION_INPUT_SCHEMAS[id] ??
      KNOWLEDGE_INPUT_SCHEMAS[id] ??
      object()),
  };
}

function sourceIdSchema(): JsonSchema {
  return object(
    {
      root: string("Workspace Root"),
      source_id: string("Source public ID"),
      json: boolean("Emit JSON"),
    },
    ["root", "source_id"],
  );
}

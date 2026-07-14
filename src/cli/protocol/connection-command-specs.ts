import type { CommandSpec } from "./command-specs.ts";

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

const idInput = object(
  {
    root: string("Workspace Root"),
    connection_id: string("Connection public ID"),
    json: boolean("Emit JSON"),
  },
  ["root", "connection_id"],
);

export const CONNECTION_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "connection.add": object(
    {
      root: string("Workspace Root"),
      path: string("Connection target path"),
      kind: { type: "string", enum: ["file", "directory", "obsidian", "project"] },
      scope: { type: "string", enum: ["external", "managed-content"] },
      name: string("Human-readable Connection name"),
      preset: { type: "string", enum: ["docs", "obsidian", "project", "custom"] },
      mode: { type: "string", enum: ["poll", "native", "watch-and-reconcile"] },
      recursive: boolean("Recursively enumerate directories"),
      include: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      interval: string("Reconciliation interval"),
      settle: string("Write settle duration"),
      delete_grace: string("Deletion grace duration"),
      paused: boolean("Create the Connection paused"),
      no_initial_scan: boolean("Skip the initial authoritative scan"),
      no_daemon: boolean("Do not start the Root-local daemon"),
      json: boolean("Emit JSON"),
    },
    ["root", "path", "kind"],
  ),
  "connection.list": object(
    {
      root: string("Workspace Root"),
      state: string("Optional Connection state"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "connection.show": idInput,
  "connection.status": idInput,
  "connection.events": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Optional Connection public ID"),
      all: boolean("Read every Connection"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "connection.changes": idInput,
  "connection.watch": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Optional Connection public ID"),
      all: boolean("Watch every Connection"),
      once: boolean("Return current events and exit"),
      jsonl: boolean("Emit a JSON Lines event stream"),
    },
    ["root"],
  ),
  "connection.scan": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Optional Connection public ID"),
      all: boolean("Scan every active Connection"),
      due: boolean("Scan due Connections"),
      full_hash: boolean("Hash every accepted file"),
      dry_run: boolean("Classify without committing changes"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "connection.pause": idInput,
  "connection.resume": idInput,
  "connection.retry": idInput,
  "connection.rebind": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Connection public ID"),
      path: string("New Connection target path"),
      plan: { const: true, description: "Required safety acknowledgement" },
      json: boolean("Emit JSON"),
    },
    ["root", "connection_id", "path", "plan"],
  ),
  "connection.detach": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Connection public ID"),
      plan: { const: true },
      idempotency_key: string("Retry-stable idempotency key"),
      json: boolean("Emit JSON"),
    },
    ["root", "connection_id", "plan"],
  ),
  "connection.restore": object(
    {
      root: string("Workspace Root"),
      connection_id: string("Connection public ID"),
      if_version: string("Expected detached Connection revision"),
      idempotency_key: string("Retry-stable idempotency key"),
      json: boolean("Emit JSON"),
    },
    ["root", "connection_id"],
  ),
  "daemon.run": object(
    {
      root: string("Workspace Root"),
      connections_only: boolean("Run only Connection scheduling"),
      once: boolean("Reconcile due work once and exit"),
      json: boolean("Emit JSON"),
    },
    ["root"],
  ),
  "daemon.start": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "daemon.status": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "daemon.stop": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
  "daemon.restart": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, [
    "root",
  ]),
  "daemon.logs": object({ root: string("Workspace Root"), json: boolean("Emit JSON") }, ["root"]),
};

export const CONNECTION_COMMAND_SPECS: CommandSpec[] = [
  {
    id: "connection.add",
    summary: "Create and initially reconcile a Connection",
    root: "required",
    execution: "write",
  },
  { id: "connection.list", summary: "List Connections", root: "required", execution: "read" },
  {
    id: "connection.show",
    summary: "Show Connection configuration",
    root: "required",
    execution: "read",
  },
  {
    id: "connection.status",
    summary: "Show Connection health and lag",
    root: "required",
    execution: "read",
  },
  {
    id: "connection.events",
    summary: "List durable Connection changes",
    root: "required",
    execution: "read",
  },
  {
    id: "connection.changes",
    summary: "List Connection changes",
    root: "required",
    execution: "read",
  },
  {
    id: "connection.watch",
    summary: "Follow durable Connection events",
    root: "required",
    execution: "read",
  },
  {
    id: "connection.scan",
    summary: "Run authoritative reconciliation",
    root: "required",
    execution: "write",
  },
  {
    id: "connection.pause",
    summary: "Pause Connection scheduling",
    root: "required",
    execution: "write",
  },
  {
    id: "connection.resume",
    summary: "Resume Connection scheduling",
    root: "required",
    execution: "write",
  },
  {
    id: "connection.retry",
    summary: "Retry a degraded Connection",
    root: "required",
    execution: "write",
  },
  {
    id: "connection.rebind",
    summary: "Plan an atomic Connection target rebind",
    root: "required",
    execution: "plan",
  },
  {
    id: "connection.detach",
    summary: "Plan Connection detachment while retaining its Source",
    root: "required",
    execution: "plan",
  },
  {
    id: "connection.restore",
    summary: "Restore a detached Connection",
    root: "required",
    execution: "write",
  },
  {
    id: "daemon.run",
    summary: "Run the Root-local Connection daemon",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "daemon.start",
    summary: "Start the Root-local Connection daemon",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "daemon.status",
    summary: "Show Root-local daemon state",
    root: "required",
    execution: "read",
  },
  {
    id: "daemon.stop",
    summary: "Stop the Root-local Connection daemon",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "daemon.restart",
    summary: "Restart the Root-local Connection daemon",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "daemon.logs",
    summary: "Read Root-local daemon logs",
    root: "required",
    execution: "read",
  },
];

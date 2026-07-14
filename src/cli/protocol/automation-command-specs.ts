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

export const AUTOMATION_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  "job.list": object(
    { ...root, state: string("Optional Job state"), limit: string("Result limit") },
    ["root"],
  ),
  "job.show": object({ ...root, job_id: string("Job ID") }, ["root", "job_id"]),
  "job.logs": object({ ...root, job_id: string("Job ID"), after: string("Event sequence") }, [
    "root",
    "job_id",
  ]),
  "job.watch": object(
    {
      ...root,
      job_id: string("Job ID"),
      timeout: string("Timeout seconds"),
      jsonl: boolean("Emit JSON Lines"),
    },
    ["root", "job_id"],
  ),
  "job.cancel": object({ ...root, job_id: string("Job ID") }, ["root", "job_id"]),
  "job.retry": object({ ...root, job_id: string("Job ID"), wait: boolean("Wait for completion") }, [
    "root",
    "job_id",
  ]),
  "backup.create": object(
    {
      ...root,
      include_models: boolean("Include Root-local model files"),
      wait: boolean("Wait for completion"),
      detach: boolean("Run in a detached worker"),
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root"],
  ),
  "backup.list": object({ ...root, limit: string("Result limit") }, ["root"]),
  "backup.show": object({ ...root, backup_id: string("Backup ID") }, ["root", "backup_id"]),
  "backup.verify": object({ ...root, backup_id: string("Backup ID") }, ["root", "backup_id"]),
  "backup.restore": object(
    {
      ...root,
      backup_id: string("Backup ID"),
      to: string("New destination Root"),
      plan: { const: true },
    },
    ["root", "backup_id", "to", "plan"],
  ),
  verify: object(
    {
      ...root,
      deep: boolean("Verify Blobs, indexes, vectors, evidence, and Artifacts"),
      wait: boolean("Wait for completion"),
      detach: boolean("Run in a detached worker"),
    },
    ["root"],
  ),
  gc: object({ ...root, plan: { const: true }, older_than: string("Minimum temporary-file age") }, [
    "root",
    "plan",
  ]),
  "maintenance.status": object(root, ["root"]),
  "maintenance.checkpoint": object(root, ["root"]),
  "plan.list": object(
    { ...root, state: string("Optional Plan state"), limit: string("Result limit") },
    ["root"],
  ),
  "plan.show": object({ ...root, plan_id: string("Plan ID") }, ["root", "plan_id"]),
  "plan.diff": object({ ...root, plan_id: string("Plan ID") }, ["root", "plan_id"]),
  "plan.cancel": object({ ...root, plan_id: string("Plan ID") }, ["root", "plan_id"]),
  "operation.list": object(
    { ...root, resource: string("Optional affected resource ID"), limit: string("Result limit") },
    ["root"],
  ),
  "operation.show": object({ ...root, operation_id: string("Operation ID") }, [
    "root",
    "operation_id",
  ]),
  "operation.undo": object(
    {
      ...root,
      operation_id: string("Operation ID"),
      plan: { const: true },
      idempotency_key: string("Retry-stable idempotency key"),
    },
    ["root", "operation_id", "plan"],
  ),
  "history.list": object(
    { ...root, resource: string("Optional affected resource ID"), limit: string("Result limit") },
    ["root"],
  ),
  "history.show": object({ ...root, operation_id: string("Operation ID") }, [
    "root",
    "operation_id",
  ]),
  "history.diff": object({ ...root, operation_id: string("Operation ID") }, [
    "root",
    "operation_id",
  ]),
};

export const AUTOMATION_COMMAND_SPECS: CommandSpec[] = [
  read("job.list", "List durable Jobs"),
  read("job.show", "Show durable Job state and checkpoint"),
  read("job.logs", "Show immutable Job events"),
  read("job.watch", "Wait for a durable Job terminal state"),
  { id: "job.cancel", summary: "Request Job cancellation", root: "required", execution: "write" },
  {
    id: "job.retry",
    summary: "Retry a failed or cancelled Job",
    root: "required",
    execution: "write",
  },
  {
    id: "backup.create",
    summary: "Create a consistent Workspace Backup",
    root: "required",
    execution: "maintenance",
  },
  read("backup.list", "List Workspace Backups"),
  read("backup.show", "Show a Workspace Backup manifest"),
  {
    id: "backup.verify",
    summary: "Verify Backup checksums and database integrity",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "backup.restore",
    summary: "Plan a non-overwriting Workspace restore",
    root: "required",
    execution: "plan",
  },
  {
    id: "verify",
    summary: "Verify Workspace integrity and evidence chains",
    root: "required",
    execution: "maintenance",
  },
  {
    id: "gc",
    summary: "Plan reference-proven garbage collection",
    root: "required",
    execution: "plan",
  },
  read("maintenance.status", "Show maintenance lock and WAL state"),
  {
    id: "maintenance.checkpoint",
    summary: "Checkpoint and truncate the Workspace WAL",
    root: "required",
    execution: "maintenance",
  },
  read("plan.list", "List immutable Plans"),
  read("plan.show", "Show an immutable Plan"),
  read("plan.diff", "Show exact planned changes"),
  { id: "plan.cancel", summary: "Cancel a ready Plan", root: "required", execution: "write" },
  read("operation.list", "List audited Operations"),
  read("operation.show", "Show an Operation and item results"),
  {
    id: "operation.undo",
    summary: "Plan an exact Operation undo",
    root: "required",
    execution: "plan",
  },
  read("history.list", "List immutable AuditEvents"),
  read("history.show", "Show audited Operation history"),
  read("history.diff", "Show before and after values for an Operation"),
];

function read(id: string, summary: string): CommandSpec {
  return { id, summary, root: "required", execution: "read" };
}

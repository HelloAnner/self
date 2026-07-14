import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerOperationsCommands(program: Command): void {
  registerPlan(program);
  registerOperation(program);
  registerHistory(program);
  registerJob(program);
  registerBackup(program);
  registerVerify(program);
  registerGc(program);
  registerMaintenance(program);
  const migration = program
    .command("migration")
    .description("inspect or apply database migrations");
  const plan = migration.command("plan").option("--json");
  plan.action(() =>
    runCliAction({
      command: plan,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { createDatabaseMigrationPlan } = await import(
          "../../application/operations/database-migration.ts"
        );
        return createDatabaseMigrationPlan(root ?? "", requestId);
      },
      present: presentKeyValues,
    }),
  );
}

function registerJob(program: Command): void {
  const job = program.command("job").description("inspect and control durable background Jobs");
  const list = job.command("list").option("--state <state>").option("--limit <n>").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const options = list.opts<{ state?: string; limit?: string }>();
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.showJobs(root ?? "", options.state, limit(options.limit));
      },
      present: presentList,
    }),
  );
  const show = job.command("show <job-id>").option("--json");
  show.action((jobId: string) =>
    runCliAction({
      command: show,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.showJob(root ?? "", jobId);
      },
      present: presentKeyValues,
    }),
  );
  const logs = job.command("logs <job-id>").option("--after <sequence>").option("--json");
  logs.action((jobId: string) =>
    runCliAction({
      command: logs,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.showJobEvents(
          root ?? "",
          jobId,
          logs.opts<{ after?: string }>().after ? number(logs.opts<{ after: string }>().after) : 0,
        );
      },
      present: presentList,
    }),
  );
  const watch = job
    .command("watch <job-id>")
    .option("--timeout <seconds>", "watch timeout", "300")
    .option("--jsonl")
    .option("--json");
  watch.action((jobId: string) =>
    runCliAction({
      command: watch,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.watchJob(
          root ?? "",
          jobId,
          number(watch.opts<{ timeout: string }>().timeout) * 1_000,
        );
      },
      present: (rows) =>
        watch.opts<{ jsonl?: boolean }>().jsonl
          ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
          : presentList(rows as Record<string, unknown>[]),
    }),
  );
  const cancel = job.command("cancel <job-id>").option("--json");
  cancel.action((jobId: string) =>
    runCliAction({
      command: cancel,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.cancelJob(root ?? "", jobId);
      },
      present: presentKeyValues,
    }),
  );
  const retry = job.command("retry <job-id>").option("--wait").option("--json");
  retry.action((jobId: string) =>
    runCliAction({
      command: retry,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.retryExistingJob(
          root ?? "",
          jobId,
          retry.opts<{ wait?: boolean }>().wait === true,
        );
      },
      present: presentKeyValues,
    }),
  );
  const execute = job.command("execute <job-id>", { hidden: true });
  execute.action((jobId: string) =>
    runCliAction({
      command: execute,
      root: "required",
      handler: async ({ root }) => {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.executeJob(root ?? "", jobId);
      },
      present: presentKeyValues,
    }),
  );
}

function registerBackup(program: Command): void {
  const backup = program
    .command("backup")
    .description("create, verify, and restore Workspace Backups");
  const create = backup
    .command("create")
    .option("--include-models")
    .option("--wait")
    .option("--detach")
    .option("--idempotency-key <key>")
    .option("--json");
  create.action(() =>
    runCliAction({
      command: create,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = create.opts<{
          includeModels?: boolean;
          wait?: boolean;
          detach?: boolean;
          idempotencyKey?: string;
        }>();
        if (options.wait && options.detach)
          throw failure("job_mode_invalid", "Use either --wait or --detach", "usage");
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.enqueueJob(root ?? "", {
          kind: "backup.create",
          values: { include_models: options.includeModels === true },
          requestId,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          wait: options.wait === true,
        });
      },
      present: presentKeyValues,
    }),
  );
  const list = backup.command("list").option("--limit <n>").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const backups = await import("../../application/operations/backup.ts");
        return backups.listWorkspaceBackups(
          root ?? "",
          limit(list.opts<{ limit?: string }>().limit),
        );
      },
      present: presentList,
    }),
  );
  const show = backup.command("show <backup-id>").option("--json");
  show.action((backupId: string) =>
    runCliAction({
      command: show,
      root: "required",
      handler: async ({ root }) => {
        const backups = await import("../../application/operations/backup.ts");
        return backups.showWorkspaceBackup(root ?? "", backupId);
      },
      present: presentKeyValues,
    }),
  );
  const verify = backup.command("verify <backup-id>").option("--json");
  verify.action((backupId: string) =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root }) => {
        const backups = await import("../../application/operations/backup-restore.ts");
        return backups.verifyWorkspaceBackup(root ?? "", backupId);
      },
      present: presentKeyValues,
    }),
  );
  const restore = backup
    .command("restore <backup-id>")
    .requiredOption("--to <directory>")
    .requiredOption("--plan")
    .option("--json");
  restore.action((backupId: string) =>
    runCliAction({
      command: restore,
      root: "required",
      handler: async ({ root, requestId }) => {
        const backups = await import("../../application/operations/backup-restore.ts");
        return backups.createBackupRestorePlan(
          root ?? "",
          backupId,
          restore.opts<{ to: string }>().to,
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerVerify(program: Command): void {
  const verify = program
    .command("verify")
    .description("verify database, evidence, indexes, vectors, Blobs, and Artifacts")
    .option("--deep")
    .option("--wait")
    .option("--detach")
    .option("--json");
  verify.action(() =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = verify.opts<{ deep?: boolean; wait?: boolean; detach?: boolean }>();
        if (!options.deep) {
          const operations = await import("../../application/operations/verify.ts");
          return operations.verifyWorkspaceShallow(root ?? "");
        }
        if (options.wait && options.detach)
          throw failure("job_mode_invalid", "Use either --wait or --detach", "usage");
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.enqueueJob(root ?? "", {
          kind: "verify.deep",
          values: {},
          requestId,
          wait: options.wait === true,
        });
      },
      present: presentKeyValues,
    }),
  );
}

function registerGc(program: Command): void {
  const gc = program
    .command("gc")
    .description("plan reference-proven reclamation")
    .requiredOption("--plan")
    .option("--older-than <duration>", "temporary file age", "24h")
    .option("--json");
  gc.action(() =>
    runCliAction({
      command: gc,
      root: "required",
      handler: async ({ root, requestId }) => {
        const operations = await import("../../application/operations/gc.ts");
        return operations.createGcPlan(
          root ?? "",
          duration(gc.opts<{ olderThan: string }>().olderThan),
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerMaintenance(program: Command): void {
  const maintenance = program.command("maintenance").description("inspect locks and WAL recovery");
  const status = maintenance.command("status").option("--json");
  status.action(() =>
    runCliAction({
      command: status,
      root: "required",
      handler: async ({ root }) => {
        const operations = await import("../../application/operations/maintenance.ts");
        return operations.showMaintenanceStatus(root ?? "");
      },
      present: presentKeyValues,
    }),
  );
  const checkpoint = maintenance.command("checkpoint").option("--json");
  checkpoint.action(() =>
    runCliAction({
      command: checkpoint,
      root: "required",
      handler: async ({ root }) => {
        const operations = await import("../../application/operations/maintenance.ts");
        return operations.checkpointWorkspace(root ?? "");
      },
      present: presentKeyValues,
    }),
  );
}

function registerPlan(program: Command): void {
  const plan = program.command("plan").description("inspect and cancel immutable Plans");
  const list = plan
    .command("list")
    .option("--state <state>")
    .option("--limit <n>")
    .option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const options = list.opts<{ state?: string; limit?: string }>();
        const { listPlans } = await import("../../application/automation/plan-workflows.ts");
        return listPlans(root ?? "", options.state, limit(options.limit));
      },
      present: presentList,
    }),
  );
  const show = plan.command("show <plan-id>").option("--json");
  show.action((planId: string) => planRead(show, "show", planId));
  const diff = plan.command("diff <plan-id>").option("--json");
  diff.action((planId: string) => planRead(diff, "diff", planId));
  const cancel = plan.command("cancel <plan-id>").option("--json");
  cancel.action((planId: string) =>
    runCliAction({
      command: cancel,
      root: "required",
      handler: async ({ root }) => {
        const workflows = await import("../../application/automation/plan-workflows.ts");
        return workflows.cancelPlan(root ?? "", planId);
      },
      present: presentKeyValues,
    }),
  );
}

function registerOperation(program: Command): void {
  const operation = program.command("operation").description("inspect and undo audited Operations");
  const list = operation
    .command("list")
    .option("--resource <id>")
    .option("--limit <n>")
    .option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const options = list.opts<{ resource?: string; limit?: string }>();
        const { showOperations } = await import(
          "../../application/automation/operation-workflows.ts"
        );
        return showOperations(root ?? "", options.resource, limit(options.limit));
      },
      present: presentList,
    }),
  );
  const show = operation.command("show <operation-id>").option("--json");
  show.action((operationId: string) => operationRead(show, "show", operationId));
  const undo = operation
    .command("undo <operation-id>")
    .requiredOption("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  undo.action((operationId: string) =>
    runCliAction({
      command: undo,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = undo.opts<{ idempotencyKey?: string }>();
        const { createSafetyPlan } = await import("../../application/automation/plan-workflows.ts");
        return createSafetyPlan(
          root ?? "",
          {
            action: "operation_undo",
            resourceId: operationId,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          },
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerHistory(program: Command): void {
  const history = program.command("history").description("inspect immutable audit history");
  const list = history
    .command("list")
    .option("--resource <id>")
    .option("--limit <n>")
    .option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const options = list.opts<{ resource?: string; limit?: string }>();
        const { showHistory } = await import("../../application/automation/operation-workflows.ts");
        return showHistory(root ?? "", options.resource, limit(options.limit));
      },
      present: presentList,
    }),
  );
  const show = history.command("show <operation-id>").option("--json");
  show.action((operationId: string) => operationRead(show, "show", operationId));
  const diff = history.command("diff <operation-id>").option("--json");
  diff.action((operationId: string) => operationRead(diff, "diff", operationId));
}

function planRead(command: Command, action: "show" | "diff", planId: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const workflows = await import("../../application/automation/plan-workflows.ts");
      return action === "show"
        ? workflows.showPlan(root ?? "", planId)
        : workflows.diffPlan(root ?? "", planId);
    },
    present: presentKeyValues,
  });
}

function operationRead(command: Command, action: "show" | "diff", operationId: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const workflows = await import("../../application/automation/operation-workflows.ts");
      return action === "show"
        ? workflows.showOperation(root ?? "", operationId)
        : workflows.showOperationDiff(root ?? "", operationId);
    },
    present: presentKeyValues,
  });
}

function limit(value?: string): number {
  if (value === undefined) return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw failure("limit_invalid", "--limit must be an integer from 1 to 1000", "usage");
  }
  return parsed;
}

function number(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw failure("number_invalid", "Expected a non-negative integer", "usage");
  return parsed;
}

function duration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value.trim());
  if (!match) throw failure("duration_invalid", "Duration must look like 30m, 24h, or 7d", "usage");
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "ms" | "s" | "m" | "h" | "d"
  ];
  return amount * multiplier;
}

import type { Command } from "commander";
import { parseDuration } from "../../domains/connection/index.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerConnectionCommands(program: Command): void {
  const connection = program
    .command("connection")
    .description("monitor external files and directories");
  registerAdd(connection);
  registerRead(connection);
  registerScan(connection);
  registerLifecycle(connection);
  registerDaemon(program);
}

function registerAdd(connection: Command): void {
  const add = connection
    .command("add <path>")
    .requiredOption("--kind <kind>")
    .option("--scope <scope>", "external or managed-content", "external")
    .option("--name <name>")
    .option("--preset <preset>", "docs, obsidian, project, or custom", "docs")
    .option("--mode <mode>", "poll, native, or watch-and-reconcile", "watch-and-reconcile")
    .option("--recursive")
    .option("--include <glob>", "include Glob", collect, [])
    .option("--exclude <glob>", "exclude Glob", collect, [])
    .option("--interval <duration>")
    .option("--settle <duration>")
    .option("--delete-grace <duration>")
    .option("--paused")
    .option("--no-initial-scan")
    .option("--no-daemon")
    .option("--json");
  add.action((path: string) =>
    runCliAction({
      command: add,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = add.opts<{
          kind: string;
          scope: string;
          name?: string;
          preset: string;
          mode: string;
          recursive?: boolean;
          include: string[];
          exclude: string[];
          interval?: string;
          settle?: string;
          deleteGrace?: string;
          paused?: boolean;
          initialScan: boolean;
          daemon: boolean;
        }>();
        const { addConnection } = await import("../../application/connection/connection-add.ts");
        return addConnection(
          root ?? "",
          {
            input: path,
            kind: options.kind,
            scope: options.scope.replace("-", "_"),
            ...(options.name ? { name: options.name } : {}),
            preset: options.preset,
            watchMode: options.mode.replaceAll("-", "_"),
            recursive: options.recursive ?? false,
            include: options.include,
            exclude: options.exclude,
            ...(options.interval ? { intervalMs: duration(options.interval) } : {}),
            ...(options.settle ? { settleMs: duration(options.settle) } : {}),
            ...(options.deleteGrace ? { deleteGraceMs: duration(options.deleteGrace) } : {}),
            paused: options.paused ?? false,
            initialScan: options.initialScan,
            noDaemon: !options.daemon,
          },
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerRead(connection: Command): void {
  const list = connection.command("list").option("--state <state>").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const { connectionList } = await import("../../application/connection/connection-view.ts");
        return connectionList(root ?? "", list.opts<{ state?: string }>().state);
      },
      present: presentList,
    }),
  );
  for (const action of ["show", "status"] as const) {
    const command = connection.command(`${action} <connection-id>`).option("--json");
    command.action((connectionId: string) =>
      runCliAction({
        command,
        root: "required",
        handler: async ({ root }) => {
          const { connectionShow } = await import(
            "../../application/connection/connection-view.ts"
          );
          return connectionShow(root ?? "", connectionId);
        },
        present: presentKeyValues,
      }),
    );
  }
  const events = connection.command("events [connection-id]").option("--all").option("--json");
  events.action((connectionId: string | undefined) =>
    runCliAction({
      command: events,
      root: "required",
      handler: async ({ root }) => {
        if (!connectionId && !events.opts<{ all?: boolean }>().all) {
          throw failure(
            "connection_input_invalid",
            "connection events requires an ID or --all",
            "usage",
          );
        }
        const { connectionEvents } = await import(
          "../../application/connection/connection-view.ts"
        );
        return connectionEvents(root ?? "", connectionId);
      },
      present: presentList,
    }),
  );
  const changes = connection.command("changes <connection-id>").option("--json");
  changes.action((connectionId: string) =>
    runCliAction({
      command: changes,
      root: "required",
      handler: async ({ root }) => {
        const { connectionEvents } = await import(
          "../../application/connection/connection-view.ts"
        );
        return connectionEvents(root ?? "", connectionId);
      },
      present: presentList,
    }),
  );
  const watch = connection
    .command("watch [connection-id]")
    .option("--all")
    .option("--once")
    .option("--jsonl");
  watch.action((connectionId: string | undefined) =>
    runCliAction({
      command: watch,
      root: "required",
      handler: async ({ root }) => {
        if (!connectionId && !watch.opts<{ all?: boolean }>().all) {
          throw failure(
            "connection_input_invalid",
            "connection watch requires an ID or --all",
            "usage",
          );
        }
        const view = await import("../../application/connection/connection-view.ts");
        if (watch.opts<{ once?: boolean }>().once) {
          return view.connectionEvents(root ?? "", connectionId);
        }
        await view.followConnectionEvents(root ?? "", connectionId, (event) => {
          process.stdout.write(
            watch.opts<{ jsonl?: boolean }>().jsonl
              ? `${JSON.stringify(event)}\n`
              : `${event.change_kind}\t${event.relative_path}\t${event.state}\n`,
          );
        });
        return [];
      },
      present: (data) => {
        if (!watch.opts<{ once?: boolean }>().once) return "";
        return watch.opts<{ jsonl?: boolean }>().jsonl
          ? `${data.map((event) => JSON.stringify(event)).join("\n")}${data.length > 0 ? "\n" : ""}`
          : presentList(data);
      },
    }),
  );
}

function registerScan(connection: Command): void {
  const scan = connection
    .command("scan [connection-id]")
    .option("--all")
    .option("--due")
    .option("--full-hash")
    .option("--dry-run")
    .option("--json");
  scan.action((connectionId: string | undefined) =>
    runCliAction({
      command: scan,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { scanConnection } = await import("../../application/connection/connection-scan.ts");
        if (connectionId) {
          return scanConnection(
            root ?? "",
            connectionId,
            {
              trigger: "manual",
              ...(scan.opts<{ fullHash?: boolean }>().fullHash ? { fullHash: true } : {}),
              ...(scan.opts<{ dryRun?: boolean }>().dryRun ? { dryRun: true } : {}),
            },
            requestId,
          );
        }
        if (!scan.opts<{ all?: boolean; due?: boolean }>().all && !scan.opts().due) {
          throw failure(
            "connection_input_invalid",
            "connection scan requires an ID, --all, or --due",
            "usage",
          );
        }
        const selected = scan.opts<{
          all?: boolean;
          due?: boolean;
          fullHash?: boolean;
          dryRun?: boolean;
        }>();
        let connectionIds: string[];
        if (selected.due) {
          const { listDueConnectionIds } = await import(
            "../../infrastructure/connection/connection-query-repository.ts"
          );
          connectionIds = await listDueConnectionIds(root ?? "", new Date().toISOString());
        } else {
          const { connectionList } = await import(
            "../../application/connection/connection-view.ts"
          );
          connectionIds = (await connectionList(root ?? ""))
            .filter((item) => ["active", "degraded"].includes(item.state))
            .map((item) => item.connection_id);
        }
        const results = [];
        const failures = [];
        for (const selectedId of connectionIds) {
          try {
            results.push(
              await scanConnection(
                root ?? "",
                selectedId,
                {
                  trigger: "manual",
                  ...(selected.fullHash ? { fullHash: true } : {}),
                  ...(selected.dryRun ? { dryRun: true } : {}),
                },
                requestId,
              ),
            );
          } catch (cause) {
            failures.push({
              connection_id: selectedId,
              code: cause instanceof SelfFailure ? cause.selfError.code : "connection_scan_failed",
            });
          }
        }
        if (failures.length > 0) {
          throw failure(
            "connection_scan_partial",
            "Some Connections could not be reconciled",
            "state",
            { exitCode: 7, details: { results, failures } },
          );
        }
        return results;
      },
      present: (data) => (Array.isArray(data) ? presentList(data) : presentKeyValues(data)),
    }),
  );
}

function registerLifecycle(connection: Command): void {
  for (const action of ["pause", "resume", "retry"] as const) {
    const command = connection.command(`${action} <connection-id>`).option("--json");
    command.action((connectionId: string) =>
      runCliAction({
        command,
        root: "required",
        handler: async ({ root, requestId }) => {
          const view = await import("../../application/connection/connection-view.ts");
          if (action === "pause") return view.pauseConnection(root ?? "", connectionId, requestId);
          if (action === "resume")
            return view.resumeConnection(root ?? "", connectionId, requestId);
          return view.retryConnection(root ?? "", connectionId, requestId);
        },
        present: presentKeyValues,
      }),
    );
  }
  const rebind = connection
    .command("rebind <connection-id> <path>")
    .option("--plan")
    .option("--json");
  rebind.action((connectionId: string, path: string) =>
    runCliAction({
      command: rebind,
      root: "required",
      handler: async ({ root, requestId }) => {
        if (!rebind.opts<{ plan?: boolean }>().plan) {
          throw failure("plan_required", "Connection rebind requires --plan", "state", {
            exitCode: 10,
          });
        }
        const { createConnectionRebindPlan } = await import(
          "../../application/connection/connection-rebind.ts"
        );
        return createConnectionRebindPlan(root ?? "", connectionId, path, requestId);
      },
      present: presentKeyValues,
    }),
  );
  const detach = connection
    .command("detach <connection-id>")
    .requiredOption("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  detach.action((connectionId: string) =>
    runCliAction({
      command: detach,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { createResourceMutationPlan } = await import(
          "../../application/automation/resource-lifecycle.ts"
        );
        return createResourceMutationPlan(
          root ?? "",
          "connection_detach",
          connectionId,
          requestId,
          {
            ...(detach.opts<{ idempotencyKey?: string }>().idempotencyKey
              ? { idempotencyKey: detach.opts<{ idempotencyKey: string }>().idempotencyKey }
              : {}),
          },
        );
      },
      present: presentKeyValues,
    }),
  );
  const restore = connection
    .command("restore <connection-id>")
    .option("--if-version <version>")
    .option("--idempotency-key <key>")
    .option("--json");
  restore.action((connectionId: string) =>
    runCliAction({
      command: restore,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = restore.opts<{ ifVersion?: string; idempotencyKey?: string }>();
        const ifVersion = version(options.ifVersion);
        const { restoreDeletedResource } = await import(
          "../../application/automation/resource-lifecycle.ts"
        );
        return restoreDeletedResource(root ?? "", "connection", connectionId, requestId, {
          ...(ifVersion !== undefined ? { ifVersion } : {}),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
}

function version(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw failure("connection_version_invalid", "--if-version must be a positive integer", "usage");
  }
  return parsed;
}

function registerDaemon(program: Command): void {
  const daemon = program.command("daemon").description("run the Root-local Connection daemon");
  const run = daemon.command("run").option("--connections-only").option("--once").option("--json");
  run.action(() => daemonAction(run, "run"));
  for (const action of ["start", "status", "stop", "restart", "logs"] as const) {
    const command = daemon.command(action).option("--json");
    command.action(() => daemonAction(command, action));
  }
}

function daemonAction(
  command: Command,
  action: "run" | "start" | "status" | "stop" | "restart" | "logs",
) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const daemon = await import("../../application/connection/connection-daemon.ts");
      if (action === "run") {
        return daemon.runConnectionDaemon(root ?? "", {
          ...(command.opts<{ once?: boolean }>().once ? { once: true } : {}),
        });
      }
      if (action === "start") return daemon.startConnectionDaemon(root ?? "");
      if (action === "status") return daemon.daemonStatus(root ?? "");
      if (action === "stop") return daemon.stopConnectionDaemon(root ?? "");
      if (action === "restart") {
        await daemon.stopConnectionDaemon(root ?? "");
        return daemon.startConnectionDaemon(root ?? "");
      }
      return { content: await daemon.daemonLogs(root ?? "") };
    },
    present: presentKeyValues,
  });
}

function duration(value: string): number {
  try {
    return parseDuration(value);
  } catch {
    throw failure("connection_input_invalid", `Invalid duration: ${value}`, "usage");
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

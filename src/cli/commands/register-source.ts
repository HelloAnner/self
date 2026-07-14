import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerSourceCommands(program: Command): void {
  const source = program.command("source").description("archive and inspect evidence Sources");
  registerAdd(source);
  registerRead(source);
  registerSync(source);
  registerLifecycle(source);
}

function registerAdd(source: Command): void {
  const add = source
    .command("add <input>")
    .option("--kind <kind>", "Source kind", "auto")
    .option("--name <name>")
    .option("--mode <mode>", "Source mode", "snapshot")
    .option("--recursive")
    .option("--include <glob>", "include matching logical paths", collect, [])
    .option("--exclude <glob>", "exclude matching logical paths", collect, [])
    .option("--watch", "create a continuous Connection for this Source")
    .option("--interval <duration>")
    .option("--settle <duration>")
    .option("--delete-grace <duration>")
    .option("--no-daemon")
    .option("--no-build")
    .option("--json");
  add.action((input: string) =>
    runCliAction({
      command: add,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = add.opts<{
          kind: string;
          name?: string;
          mode: string;
          recursive?: boolean;
          include: string[];
          exclude: string[];
          watch?: boolean;
          interval?: string;
          settle?: string;
          deleteGrace?: string;
          daemon: boolean;
          build: boolean;
        }>();
        if (options.watch) {
          if (input === "-") {
            throw failure(
              "connection_input_invalid",
              "A watched Source requires a file or directory path",
              "usage",
            );
          }
          const { parseDuration } = await import("../../domains/connection/index.ts");
          const { addConnection } = await import("../../application/connection/connection-add.ts");
          return addConnection(
            root ?? "",
            {
              input,
              kind: await inferConnectionKind(input, options.kind),
              scope: "external",
              ...(options.name ? { name: options.name } : {}),
              preset: options.kind === "obsidian" ? "obsidian" : "docs",
              watchMode: "watch_and_reconcile",
              recursive: options.recursive ?? false,
              include: options.include,
              exclude: options.exclude,
              ...(options.interval ? { intervalMs: parseDuration(options.interval) } : {}),
              ...(options.settle ? { settleMs: parseDuration(options.settle) } : {}),
              ...(options.deleteGrace ? { deleteGraceMs: parseDuration(options.deleteGrace) } : {}),
              initialScan: true,
              noDaemon: !options.daemon,
            },
            requestId,
          );
        }
        const stdinBytes = input === "-" ? await Bun.stdin.bytes() : undefined;
        const { addSource } = await import("../../application/source/source-archive.ts");
        return addSource(
          root ?? "",
          {
            input,
            kind: options.kind,
            mode: options.mode,
            ...(options.name ? { name: options.name } : {}),
            recursive: options.recursive ?? false,
            include: options.include,
            exclude: options.exclude,
            noBuild: options.build === false,
            ...(stdinBytes ? { stdinBytes } : {}),
          },
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerRead(source: Command): void {
  const list = source.command("list").option("--status <state>").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const state = list.opts<{ status?: string }>().status;
        if (state && !["active", "failed", "deleted"].includes(state)) {
          throw failure("source_input_invalid", `Unknown Source state: ${state}`, "usage");
        }
        const { sourceList } = await import("../../application/source/source-lifecycle.ts");
        return sourceList(root ?? "", state);
      },
      present: presentList,
    }),
  );
  const show = source.command("show <source-id>").option("--json");
  show.action((sourceId: string) =>
    runCliAction({
      command: show,
      root: "required",
      handler: async ({ root }) => {
        const { sourceShow } = await import("../../application/source/source-lifecycle.ts");
        return sourceShow(root ?? "", sourceId);
      },
      present: presentKeyValues,
    }),
  );
  const status = source.command("status <source-id>").option("--json");
  status.action((sourceId: string) =>
    runCliAction({
      command: status,
      root: "required",
      handler: async ({ root }) => {
        const { sourceShow } = await import("../../application/source/source-lifecycle.ts");
        return sourceShow(root ?? "", sourceId);
      },
      present: presentKeyValues,
    }),
  );
  const files = source
    .command("files <source-id>")
    .option("--snapshot <snapshot-id>")
    .option("--json");
  files.action((sourceId: string) =>
    runCliAction({
      command: files,
      root: "required",
      handler: async ({ root }) => {
        const { sourceFiles } = await import("../../application/source/source-lifecycle.ts");
        return sourceFiles(root ?? "", sourceId, files.opts<{ snapshot?: string }>().snapshot);
      },
      present: presentList,
    }),
  );
}

function registerSync(source: Command): void {
  const sync = source
    .command("sync [source-id]")
    .option("--all")
    .option("--changed-only")
    .option("--json");
  sync.action((sourceId: string | undefined) =>
    runCliAction({
      command: sync,
      root: "required",
      handler: async ({ root, requestId }) => {
        if (sourceId) {
          const { getConnectionBySourceId } = await import(
            "../../infrastructure/connection/connection-repository.ts"
          );
          const connection = await getConnectionBySourceId(root ?? "", sourceId);
          if (connection) {
            const { scanConnection } = await import(
              "../../application/connection/connection-scan.ts"
            );
            return scanConnection(
              root ?? "",
              connection.connection_id,
              { trigger: "manual" },
              requestId,
            );
          }
        }
        const { syncSource } = await import("../../application/source/source-archive.ts");
        if (sourceId) return syncSource(root ?? "", sourceId, requestId);
        if (!sync.opts<{ all?: boolean }>().all) {
          throw failure("source_input_invalid", "source sync requires an ID or --all", "usage");
        }
        const { sourceList } = await import("../../application/source/source-lifecycle.ts");
        const results = [];
        const failures = [];
        for (const item of await sourceList(root ?? "", "active")) {
          try {
            const result = await syncSource(root ?? "", item.source_id, requestId);
            if (!sync.opts<{ changedOnly?: boolean }>().changedOnly || !result.reused_snapshot) {
              results.push(result);
            }
          } catch (cause) {
            failures.push({
              source_id: item.source_id,
              code: cause instanceof SelfFailure ? cause.selfError.code : "source_archive_failed",
            });
          }
        }
        if (failures.length > 0) {
          throw failure("source_sync_partial", "Some Sources could not be synchronized", "state", {
            exitCode: 7,
            details: { results, failures },
          });
        }
        return results;
      },
      present: (data) => (Array.isArray(data) ? presentList(data) : presentKeyValues(data)),
    }),
  );
  const retry = source.command("retry <source-id>").option("--json");
  retry.action((sourceId: string) =>
    runCliAction({
      command: retry,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { retrySource } = await import("../../application/source/source-archive.ts");
        return retrySource(root ?? "", sourceId, requestId);
      },
      present: presentKeyValues,
    }),
  );
}

function registerLifecycle(source: Command): void {
  const remove = source
    .command("delete <source-id>")
    .option("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  remove.action((sourceId: string) =>
    runCliAction({
      command: remove,
      root: "required",
      handler: async ({ root, requestId }) => {
        if (!remove.opts<{ plan?: boolean }>().plan) {
          throw failure("source_plan_required", "Source delete requires --plan", "state", {
            exitCode: 10,
          });
        }
        const { createSourceDeletePlan } = await import(
          "../../application/source/source-lifecycle.ts"
        );
        return createSourceDeletePlan(
          root ?? "",
          sourceId,
          requestId,
          remove.opts<{ idempotencyKey?: string }>().idempotencyKey,
        );
      },
      present: presentKeyValues,
    }),
  );
  const purge = source
    .command("purge <source-id>")
    .option("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  purge.action((sourceId: string) =>
    runCliAction({
      command: purge,
      root: "required",
      handler: async ({ root, requestId }) => {
        if (!purge.opts<{ plan?: boolean }>().plan) {
          throw failure("source_plan_required", "Source purge requires --plan", "state", {
            exitCode: 10,
          });
        }
        const { createSourcePurgePlan } = await import(
          "../../application/source/source-lifecycle.ts"
        );
        return createSourcePurgePlan(
          root ?? "",
          sourceId,
          requestId,
          purge.opts<{ idempotencyKey?: string }>().idempotencyKey,
        );
      },
      present: presentKeyValues,
    }),
  );
  const restore = source
    .command("restore <source-id>")
    .option("--if-version <version>")
    .option("--idempotency-key <key>")
    .option("--json");
  restore.action((sourceId: string) =>
    runCliAction({
      command: restore,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { restoreDeletedSource } = await import(
          "../../application/source/source-lifecycle.ts"
        );
        const options = restore.opts<{ ifVersion?: string; idempotencyKey?: string }>();
        const ifVersion = optionalVersion(options.ifVersion, "source_input_invalid");
        return restoreDeletedSource(root ?? "", sourceId, requestId, {
          ...(ifVersion !== undefined ? { ifVersion } : {}),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
}

function optionalVersion(value: string | undefined, code: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw failure(code, "--if-version must be a positive integer", "usage");
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function inferConnectionKind(
  input: string,
  requested: string,
): Promise<"file" | "directory" | "project" | "obsidian"> {
  if (["directory", "project", "obsidian"].includes(requested)) {
    return requested as "directory" | "project" | "obsidian";
  }
  const expanded = input.startsWith("~/") ? join(process.env.HOME ?? "~", input.slice(2)) : input;
  const metadata = await lstat(resolve(expanded)).catch(() => null);
  if (!metadata) {
    throw failure("connection_target_unavailable", "Connection Target is unavailable", "external", {
      retryable: true,
    });
  }
  return metadata.isDirectory() ? "directory" : "file";
}

import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerTopicCommands(program: Command): void {
  const topic = program.command("topic").description("manage evidence-backed synthesis Topics");
  const create = topic
    .command("create <name>")
    .option("--scope <text>")
    .option("--exclude <text>")
    .option("--description <text>")
    .option("--alias <alias...>")
    .option("--json");
  create.action((name: string) =>
    runCliAction({
      command: create,
      root: "required",
      handler: async ({ root }) => {
        const options = create.opts<{
          scope?: string;
          exclude?: string;
          description?: string;
          alias?: string[];
        }>();
        const { createTopicDefinition } = await import(
          "../../application/topic/topic-lifecycle.ts"
        );
        return createTopicDefinition(root ?? "", {
          name,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.exclude ? { exclude: options.exclude } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.alias ? { aliases: options.alias } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
  const list = topic
    .command("list")
    .option("--status <status>")
    .option("--limit <n>")
    .option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const options = list.opts<{ status?: string; limit?: string }>();
        const limit = options.limit ? number(options.limit, "topic_limit_invalid") : undefined;
        const { showTopics } = await import("../../application/topic/topic-lifecycle.ts");
        return showTopics(root ?? "", options.status, limit);
      },
      present: presentList,
    }),
  );
  const show = topic.command("show <topic-id>").option("--json");
  show.action((topicId: string) => lifecycle(show, "showTopic", topicId));
  const update = topic
    .command("update <topic-id>")
    .option("--scope <text>")
    .option("--exclude <text>")
    .option("--add-alias <alias>")
    .option("--if-version <n>")
    .option("--json");
  update.action((topicId: string) =>
    runCliAction({
      command: update,
      root: "required",
      handler: async ({ root }) => {
        const options = update.opts<{
          scope?: string;
          exclude?: string;
          addAlias?: string;
          ifVersion?: string;
        }>();
        const { updateTopicDefinition } = await import(
          "../../application/topic/topic-lifecycle.ts"
        );
        return updateTopicDefinition(root ?? "", topicId, {
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
          ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
          ...(options.addAlias !== undefined ? { addAlias: options.addAlias } : {}),
          ...(options.ifVersion !== undefined
            ? { ifVersion: number(options.ifVersion, "topic_version_invalid") }
            : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
  const build = topic
    .command("build <topic-id>")
    .option("--mode <mode>", "text, vector, or hybrid", "text")
    .option("--limit <n>", "candidate limit", "50")
    .option("--tokens <n>", "evidence token budget", "24000")
    .option("--template <id>", "Artifact template", "knowledge-atlas")
    .option("--wait")
    .option("--detach")
    .option("--json");
  build.action((topicId: string) =>
    runCliAction({
      command: build,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = build.opts<{
          mode: string;
          limit: string;
          tokens: string;
          template: string;
          wait?: boolean;
          detach?: boolean;
        }>();
        if (!(["text", "vector", "hybrid"] as string[]).includes(options.mode))
          throw failure("search_mode_invalid", "Topic build mode is invalid", "usage");
        const input = {
          mode: options.mode as "text" | "vector" | "hybrid",
          limit: number(options.limit, "topic_limit_invalid"),
          tokenBudget: number(options.tokens, "topic_context_budget_invalid"),
          templateId: options.template,
        };
        if (options.wait || options.detach) {
          const jobs = await import("../../application/automation/job-workflows.ts");
          return jobs.enqueueJob(root ?? "", {
            kind: "topic.build",
            values: {
              topic_id: topicId,
              mode: input.mode,
              limit: input.limit,
              token_budget: input.tokenBudget,
              template_id: input.templateId,
            },
            requestId,
            wait: options.wait === true,
          });
        }
        const { buildTopic } = await import("../../application/topic/topic-build.ts");
        return buildTopic(root ?? "", topicId, input);
      },
      present: presentKeyValues,
    }),
  );
  const refresh = topic
    .command("refresh <topic-id>")
    .option("--mode <mode>", "text, vector, or hybrid", "text")
    .option("--limit <n>", "candidate limit", "50")
    .option("--tokens <n>", "evidence token budget", "24000")
    .option("--template <id>", "Artifact template", "knowledge-atlas")
    .option("--since-last-build")
    .option("--explain-changes")
    .option("--wait")
    .option("--detach")
    .option("--json");
  refresh.action((topicId: string) =>
    runCliAction({
      command: refresh,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = refresh.opts<{
          mode: string;
          limit: string;
          tokens: string;
          template: string;
          wait?: boolean;
          detach?: boolean;
        }>();
        if (!(["text", "vector", "hybrid"] as string[]).includes(options.mode))
          throw failure("search_mode_invalid", "Topic refresh mode is invalid", "usage");
        const input = {
          mode: options.mode as "text" | "vector" | "hybrid",
          limit: number(options.limit, "topic_limit_invalid"),
          tokenBudget: number(options.tokens, "topic_context_budget_invalid"),
          templateId: options.template,
        };
        if (options.wait || options.detach) {
          const jobs = await import("../../application/automation/job-workflows.ts");
          return jobs.enqueueJob(root ?? "", {
            kind: "topic.refresh",
            values: {
              topic_id: topicId,
              mode: input.mode,
              limit: input.limit,
              token_budget: input.tokenBudget,
              template_id: input.templateId,
            },
            requestId,
            wait: options.wait === true,
          });
        }
        const { refreshTopic } = await import("../../application/topic/topic-build.ts");
        return refreshTopic(root ?? "", topicId, input);
      },
      present: presentKeyValues,
    }),
  );
  const report = topic
    .command("report <topic-id>")
    .option("--snapshot <topic-snapshot-id>")
    .option("--show-confidence")
    .option("--show-conflicts")
    .option("--show-unknowns")
    .option("--json");
  report.action((topicId: string) =>
    runCliAction({
      command: report,
      root: "required",
      handler: async ({ root }) => {
        const { readTopicReport } = await import("../../application/topic/topic-queries.ts");
        return readTopicReport(root ?? "", topicId, report.opts<{ snapshot?: string }>().snapshot);
      },
      present: presentKeyValues,
    }),
  );
  const history = topic.command("history <topic-id>").option("--json");
  history.action((topicId: string) =>
    runCliAction({
      command: history,
      root: "required",
      handler: async ({ root }) => {
        const { readTopicArtifactHistory } = await import(
          "../../application/artifact/artifact-queries.ts"
        );
        return readTopicArtifactHistory(root ?? "", topicId);
      },
      present: presentList,
    }),
  );
  const diff = topic
    .command("diff <topic-id>")
    .requiredOption("--from <build-id>")
    .option("--to <build-id>", "target Build", "latest")
    .option("--json");
  diff.action((topicId: string) =>
    runCliAction({
      command: diff,
      root: "required",
      handler: async ({ root }) => {
        const options = diff.opts<{ from: string; to: string }>();
        const { readTopicArtifactDiff } = await import(
          "../../application/artifact/artifact-queries.ts"
        );
        return readTopicArtifactDiff(root ?? "", topicId, options.from, options.to);
      },
      present: presentKeyValues,
    }),
  );
  const open = topic.command("open <topic-id>").option("--json");
  open.action((topicId: string) =>
    runCliAction({
      command: open,
      root: "required",
      handler: async ({ root }) => {
        const { openArtifact } = await import("../../application/artifact/artifact-queries.ts");
        return openArtifact(root ?? "", topicId, "topic");
      },
      present: presentKeyValues,
    }),
  );
  const exportCommand = topic
    .command("export <topic-id>")
    .requiredOption("--format <format>", "html, markdown, or json")
    .option("--output <path>")
    .option("--single-file")
    .option("--json");
  exportCommand.action((topicId: string) =>
    runCliAction({
      command: exportCommand,
      root: "required",
      handler: async ({ root }) => {
        const options = exportCommand.opts<{
          format: string;
          output?: string;
          singleFile?: boolean;
        }>();
        if (!(["html", "markdown", "json"] as string[]).includes(options.format))
          throw failure("artifact_export_format_invalid", "Export format is invalid", "usage");
        if (options.singleFile && options.format !== "html")
          throw failure(
            "artifact_export_option_invalid",
            "--single-file only applies to HTML",
            "usage",
          );
        const { exportArtifact } = await import("../../application/artifact/artifact-export.ts");
        return exportArtifact(root ?? "", topicId, {
          resourceKind: "topic",
          format: options.format as "html" | "markdown" | "json",
          ...(options.output ? { output: options.output } : {}),
          ...(options.singleFile ? { singleFile: true } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
  const remove = topic
    .command("delete <topic-id>")
    .requiredOption("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  remove.action((topicId: string) => resourceDelete(remove, "topic_delete", topicId));
  const restore = topic
    .command("restore <topic-id>")
    .option("--if-version <version>")
    .option("--idempotency-key <key>")
    .option("--json");
  restore.action((topicId: string) => resourceRestore(restore, "topic", topicId));
}

function resourceDelete(command: Command, action: "topic_delete", id: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const idempotencyKey = command.opts<{ idempotencyKey?: string }>().idempotencyKey;
      const { createResourceMutationPlan } = await import(
        "../../application/automation/resource-lifecycle.ts"
      );
      return createResourceMutationPlan(root ?? "", action, id, requestId, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    },
    present: presentKeyValues,
  });
}

function resourceRestore(command: Command, kind: "topic", id: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<{ ifVersion?: string; idempotencyKey?: string }>();
      const ifVersion = options.ifVersion
        ? number(options.ifVersion, "topic_version_invalid")
        : undefined;
      const { restoreDeletedResource } = await import(
        "../../application/automation/resource-lifecycle.ts"
      );
      return restoreDeletedResource(root ?? "", kind, id, requestId, {
        ...(ifVersion !== undefined ? { ifVersion } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    },
    present: presentKeyValues,
  });
}

function lifecycle(command: Command, method: "showTopic", topicId: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const module = await import("../../application/topic/topic-lifecycle.ts");
      return module[method](root ?? "", topicId);
    },
    present: presentKeyValues,
  });
}

function number(value: string, code: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw failure(code, "Expected a positive integer", "usage");
  return parsed;
}

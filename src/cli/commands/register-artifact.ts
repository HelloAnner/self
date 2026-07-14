import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerArtifactCommands(program: Command): void {
  const artifact = program
    .command("artifact")
    .description("inspect and render immutable Artifacts");
  const list = artifact.command("list").option("--status <status>").option("--json");
  list.action(() =>
    action(
      list,
      async (root) => {
        const { readArtifacts } = await import("../../application/artifact/artifact-queries.ts");
        return readArtifacts(root, list.opts<{ status?: string }>().status);
      },
      presentList,
    ),
  );
  const show = artifact.command("show <artifact-id>").option("--json");
  show.action((id: string) =>
    action(show, async (root) => {
      const { readArtifact } = await import("../../application/artifact/artifact-queries.ts");
      return readArtifact(root, id);
    }),
  );
  const open = artifact.command("open <artifact-id>").option("--json");
  open.action((id: string) =>
    action(open, async (root) => {
      const { openArtifact } = await import("../../application/artifact/artifact-queries.ts");
      return openArtifact(root, id, "artifact");
    }),
  );
  const history = artifact.command("history <artifact-id>").option("--json");
  history.action((id: string) =>
    action(
      history,
      async (root) => {
        const { readArtifactHistory } = await import(
          "../../application/artifact/artifact-queries.ts"
        );
        return readArtifactHistory(root, id);
      },
      presentList,
    ),
  );
  const diff = artifact.command("diff <from-build> <to-build>").option("--json");
  diff.action((from: string, to: string) =>
    action(diff, async (root) => {
      const { readArtifactDiff } = await import("../../application/artifact/artifact-queries.ts");
      return readArtifactDiff(root, from, to);
    }),
  );
  const render = artifact
    .command("render <topic-id>")
    .option("--template <id>", "Artifact template", "knowledge-atlas")
    .option("--theme <id>", "Artifact theme", "self-light")
    .option("--json");
  render.action((topicId: string) =>
    action(render, async (root) => {
      const options = render.opts<{ template: string; theme: string }>();
      const { renderExistingArtifact } = await import(
        "../../application/artifact/artifact-build.ts"
      );
      return renderExistingArtifact(root, topicId, {
        templateId: options.template,
        themeId: options.theme,
      });
    }),
  );
  const exportCommand = artifact
    .command("export <artifact-id>")
    .requiredOption("--format <format>")
    .option("--output <path>")
    .option("--single-file")
    .option("--json");
  exportCommand.action((id: string) =>
    action(exportCommand, async (root) => {
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
      return exportArtifact(root, id, {
        resourceKind: "artifact",
        format: options.format as "html" | "markdown" | "json",
        ...(options.output ? { output: options.output } : {}),
        ...(options.singleFile ? { singleFile: true } : {}),
      });
    }),
  );
  const remove = artifact
    .command("delete <artifact-id>")
    .requiredOption("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  remove.action((id: string) => lifecycle(remove, "delete", id));
  const restore = artifact
    .command("restore <artifact-id>")
    .option("--if-version <version>")
    .option("--idempotency-key <key>")
    .option("--json");
  restore.action((id: string) => lifecycle(restore, "restore", id));

  const template = program.command("template").description("inspect registered Page IR templates");
  const templateList = template.command("list").option("--json");
  templateList.action(() =>
    action(templateList, async (root) => {
      const { readTemplates } = await import("../../application/artifact/artifact-queries.ts");
      return readTemplates(root);
    }),
  );
}

function lifecycle(command: Command, action: "delete" | "restore", artifactId: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<{ ifVersion?: string; idempotencyKey?: string }>();
      if (action === "delete") {
        const { createResourceMutationPlan } = await import(
          "../../application/automation/resource-lifecycle.ts"
        );
        return createResourceMutationPlan(root ?? "", "artifact_delete", artifactId, requestId, {
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        });
      }
      const ifVersion = options.ifVersion ? positiveVersion(options.ifVersion) : undefined;
      const { restoreDeletedResource } = await import(
        "../../application/automation/resource-lifecycle.ts"
      );
      return restoreDeletedResource(root ?? "", "artifact", artifactId, requestId, {
        ...(ifVersion !== undefined ? { ifVersion } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    },
    present: presentKeyValues,
  });
}

function positiveVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw failure("artifact_version_invalid", "--if-version must be a positive integer", "usage");
  }
  return parsed;
}

function action<T>(
  command: Command,
  handler: (root: string) => Promise<T>,
  present?: (data: T) => string,
) {
  return runCliAction({
    command,
    root: "required",
    handler: ({ root }) => handler(root ?? ""),
    present: present ?? ((data) => presentKeyValues(data as unknown as Record<string, unknown>)),
  });
}

import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues } from "../protocol/presenter.ts";
import { requireArgument, runCliAction } from "../runtime.ts";

export function registerInitCommands(program: Command): void {
  const init = program
    .command("init")
    .description("initialize a Self Workspace")
    .argument("[directory]");
  init.option("--offline").option("--plan").option("--json");
  init.action((directory: string | undefined) =>
    runCliAction({
      command: init,
      root: "none",
      handler: async ({ requestId, options }) => {
        const { initWorkspace } = await import("../../application/workspace/init-workspace.ts");
        return initWorkspace({
          target: requireArgument(directory, "directory"),
          requestId,
          offline: options.offline ?? true,
          planOnly: options.plan ?? false,
        });
      },
      present: presentKeyValues,
    }),
  );

  const resume = init.command("resume <directory>").option("--json");
  resume.action((directory: string) =>
    runCliAction({
      command: resume,
      root: "none",
      handler: async ({ requestId }) => {
        const { initWorkspace } = await import("../../application/workspace/init-workspace.ts");
        return initWorkspace({ target: directory, requestId, resume: true });
      },
      present: presentKeyValues,
    }),
  );

  const rollback = init.command("rollback <directory>").option("--plan").option("--json");
  rollback.action((directory: string) =>
    runCliAction({
      command: rollback,
      root: "none",
      handler: async () => {
        if (!rollback.optsWithGlobals<{ plan?: boolean }>().plan) {
          throw failure("plan_required", "Init rollback requires --plan", "state", {
            exitCode: 10,
          });
        }
        const { createInitRollbackPlan } = await import(
          "../../application/workspace/init-rollback.ts"
        );
        return createInitRollbackPlan(directory);
      },
      present: presentKeyValues,
    }),
  );

  const apply = program
    .command("apply <plan-id>")
    .description("apply an approved Plan")
    .option("--json");
  apply.action((planId: string) =>
    runCliAction({
      command: apply,
      root: "none",
      handler: async ({ options }) => {
        if (!options.root)
          throw failure(
            "workspace_root_required",
            "--root is required to apply this Plan",
            "usage",
          );
        const { applyWorkspacePlan } = await import("../../application/workspace/apply-plan.ts");
        return applyWorkspacePlan(options.root, planId);
      },
      present: presentKeyValues,
    }),
  );
}

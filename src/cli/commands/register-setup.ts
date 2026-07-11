import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerSetupCommands(program: Command): void {
  const setup = program
    .command("setup")
    .description("guided or spec-driven setup")
    .option("--interactive");
  setup.action(() =>
    runCliAction({
      command: setup,
      root: "optional",
      handler: async ({ root, options }) => {
        if (!setup.opts().interactive) {
          throw failure(
            "invalid_arguments",
            "Use `setup --interactive` or a setup subcommand",
            "usage",
          );
        }
        const { runInteractiveSetup } = await import(
          "../../application/workspace/setup-workspace.ts"
        );
        return runInteractiveSetup({
          ...(root ? { root } : {}),
          ...(options.offline !== undefined ? { offline: options.offline } : {}),
          ...(options.json !== undefined ? { json: options.json } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );

  const status = setup.command("status").option("--json");
  status.action(() =>
    runCliAction({
      command: status,
      root: "required",
      handler: async ({ root }) => {
        const { loadLatestSetupSession } = await import("../../domains/workspace/setup/session.ts");
        return loadLatestSetupSession(root ?? "");
      },
      present: presentKeyValues,
    }),
  );

  const resume = setup.command("resume").option("--json");
  resume.action(() =>
    runCliAction({
      command: resume,
      root: "required",
      handler: async ({ root, options }) => {
        const { runInteractiveSetup } = await import(
          "../../application/workspace/setup-workspace.ts"
        );
        return runInteractiveSetup({
          root: root ?? "",
          resume: true,
          ...(options.json !== undefined ? { json: options.json } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );

  const plan = setup.command("plan").requiredOption("--spec <file>").option("--json");
  plan.action(() =>
    runCliAction({
      command: plan,
      root: "none",
      handler: async () => {
        const { createSetupPlanFromSpec } = await import(
          "../../application/workspace/setup-workspace.ts"
        );
        return createSetupPlanFromSpec(await Bun.file(plan.opts().spec).text());
      },
      present: presentKeyValues,
    }),
  );
}

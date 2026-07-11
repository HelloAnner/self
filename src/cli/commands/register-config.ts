import type { Command } from "commander";
import { presentKeyValues } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("inspect or update self.toml");
  registerReadCommands(config);
  registerWriteCommands(config);
}

function registerReadCommands(config: Command): void {
  const list = config.command("list").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const { listConfig } = await import("../../application/workspace/workspace-config.ts");
        return listConfig(root ?? "");
      },
      present: presentKeyValues,
    }),
  );
  const get = config.command("get <path>").option("--json");
  get.action((path: string) =>
    runCliAction({
      command: get,
      root: "required",
      handler: async ({ root }) => {
        const { getConfigValue } = await import("../../application/workspace/workspace-config.ts");
        return { path, value: await getConfigValue(root ?? "", path) };
      },
      present: presentKeyValues,
    }),
  );
  const validate = config.command("validate").option("--json");
  validate.action(() =>
    runCliAction({
      command: validate,
      root: "required",
      handler: async ({ root }) => {
        const { listConfig } = await import("../../application/workspace/workspace-config.ts");
        const result = await listConfig(root ?? "");
        return { valid: true, format_version: result.format_version };
      },
      present: presentKeyValues,
    }),
  );
}

function registerWriteCommands(config: Command): void {
  const set = config.command("set <path> <value>").option("--json");
  set.action((path: string, value: string) =>
    runCliAction({
      command: set,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { mutateConfig, parseConfigCliValue } = await import(
          "../../application/workspace/workspace-config.ts"
        );
        return mutateConfig({
          root: root ?? "",
          path,
          value: parseConfigCliValue(value),
          requestId,
        });
      },
      present: presentKeyValues,
    }),
  );
  const unset = config.command("unset <path>").option("--json");
  unset.action((path: string) =>
    runCliAction({
      command: unset,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { mutateConfig } = await import("../../application/workspace/workspace-config.ts");
        return mutateConfig({ root: root ?? "", path, unset: true, requestId });
      },
      present: presentKeyValues,
    }),
  );
}

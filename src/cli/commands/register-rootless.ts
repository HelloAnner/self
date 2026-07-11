import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { VERSION } from "../../shared/version.ts";
import { COMMAND_SPECS, commandSchema } from "../protocol/command-specs.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";
import { getVersionInfo } from "./version/handler.ts";
import { presentVersion } from "./version/presenter.ts";

export function registerRootlessCommands(program: Command): void {
  registerVersion(program);
  registerDiscovery(program);
  registerSystem(program);
}

function registerVersion(program: Command): void {
  const command = program
    .command("version")
    .description("show CLI and data format versions")
    .option("--json");
  command.action(() =>
    runCliAction({
      command,
      root: "none",
      handler: getVersionInfo,
      present: presentVersion,
    }),
  );
}

function registerDiscovery(program: Command): void {
  const commands = program
    .command("commands")
    .description("list command contracts")
    .option("--json");
  commands.action(() =>
    runCliAction({
      command: commands,
      root: "none",
      handler: () => COMMAND_SPECS,
      present: presentList,
    }),
  );

  const schema = program.command("schema").description("show a JSON schema");
  const commandSchemaCommand = schema.command("command <id>").option("--json");
  commandSchemaCommand.action((id: string) =>
    runCliAction({
      command: commandSchemaCommand,
      root: "none",
      handler: () => {
        const result = commandSchema(id);
        if (!result) throw failure("command_not_found", `Unknown command: ${id}`, "not_found");
        return result;
      },
      present: (data) => `${JSON.stringify(data, null, 2)}\n`,
    }),
  );

  const completion = program.command("completion <shell>").description("generate shell completion");
  completion.action((shell: string) =>
    runCliAction({
      command: completion,
      root: "none",
      handler: () => completionScript(shell),
      present: (data) => data,
    }),
  );
}

function registerSystem(program: Command): void {
  const system = program.command("system").description("show system information");
  const info = system.command("info").option("--json");
  info.action(() =>
    runCliAction({
      command: info,
      root: "none",
      handler: () => ({
        cli_version: VERSION.cli,
        bun_version: Bun.version,
        platform: process.platform,
        arch: process.arch,
      }),
      present: presentKeyValues,
    }),
  );
}

export function presentDoctor(result: {
  status: string;
  checks: { status: string; name: string; message: string }[];
}): string {
  const rows = result.checks.map((check) => ({
    status: check.status,
    name: check.name,
    message: check.message,
  }));
  return `Doctor: ${result.status}\n${presentList(rows)}`;
}

function completionScript(shell: string): string {
  if (shell === "zsh") return "#compdef self\n_arguments '*: :->args'\n";
  if (shell === "bash")
    return "complete -W 'version init status doctor config system component capability commands migration source connection daemon knowledge ingestion note' self\n";
  if (shell === "fish")
    return "complete -c self -f -a 'version init status doctor config system component capability commands migration source connection daemon knowledge ingestion note'\n";
  throw failure("unsupported_shell", `Unsupported shell: ${shell}`, "usage");
}

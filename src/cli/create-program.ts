import { Command } from "commander";
import { VERSION } from "../shared/version.ts";
import { registerArtifactCommands } from "./commands/register-artifact.ts";
import { registerConfigCommands } from "./commands/register-config.ts";
import { registerConnectionCommands } from "./commands/register-connection.ts";
import { registerGraphCommands } from "./commands/register-graph.ts";
import { registerInitCommands } from "./commands/register-init.ts";
import { registerKnowledgeCommands } from "./commands/register-knowledge.ts";
import { registerNoteCommands } from "./commands/register-note.ts";
import { registerOperationsCommands } from "./commands/register-operations.ts";
import { registerRetrievalCommands } from "./commands/register-retrieval.ts";
import { registerRootlessCommands } from "./commands/register-rootless.ts";
import { registerSearchModelCommands } from "./commands/register-search-model.ts";
import { registerSetupCommands } from "./commands/register-setup.ts";
import { registerSourceCommands } from "./commands/register-source.ts";
import { registerTopicCommands } from "./commands/register-topic.ts";
import { registerWorkspaceCommands } from "./commands/register-workspace.ts";
import { runCliAction } from "./runtime.ts";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("self")
    .description("Local-first personal knowledge operating system")
    .version(VERSION.cli)
    .option("--root <directory>", "select a Self Workspace")
    .option("--json", "emit a stable JSON envelope")
    .option("--init", "run guided setup")
    .option("--offline", "disable model and network setup")
    .option("--resume", "resume the latest setup session")
    .option("--no-color", "disable terminal colors")
    .showHelpAfterError();

  registerRootlessCommands(program);
  registerInitCommands(program);
  registerOperationsCommands(program);
  registerWorkspaceCommands(program);
  registerConfigCommands(program);
  registerArtifactCommands(program);
  registerConnectionCommands(program);
  registerGraphCommands(program);
  registerKnowledgeCommands(program);
  registerSearchModelCommands(program);
  registerRetrievalCommands(program);
  registerTopicCommands(program);
  registerNoteCommands(program);
  registerSetupCommands(program);
  registerSourceCommands(program);

  program.action(() =>
    runCliAction<string | { workspace_id: string; root: string; state: string; profile: string }>({
      command: program,
      root: "none",
      handler: async () => {
        const options = program.opts<{
          init?: boolean;
          root?: string;
          offline?: boolean;
          resume?: boolean;
          json?: boolean;
        }>();
        if (options.init) {
          const { runInteractiveSetup } = await import(
            "../application/workspace/setup-workspace.ts"
          );
          return runInteractiveSetup({
            ...(options.root ? { root: options.root } : {}),
            ...(options.offline !== undefined ? { offline: options.offline } : {}),
            ...(options.resume !== undefined ? { resume: options.resume } : {}),
            ...(options.json !== undefined ? { json: options.json } : {}),
          });
        }
        program.outputHelp();
        return "";
      },
      present: (data) => (typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`),
    }),
  );
  return program;
}

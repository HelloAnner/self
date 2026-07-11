import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";
import { presentDoctor } from "./register-rootless.ts";

export function registerWorkspaceCommands(program: Command): void {
  const status = program
    .command("status")
    .description("show Workspace status")
    .option("--verbose")
    .option("--json");
  status.action(() =>
    runCliAction({
      command: status,
      root: "required",
      handler: async ({ root }) => {
        const { getWorkspaceStatus } = await import(
          "../../application/workspace/workspace-status.ts"
        );
        return getWorkspaceStatus(root ?? "");
      },
      present: presentKeyValues,
    }),
  );

  const doctor = program.command("doctor").description("verify Workspace health");
  doctor
    .option("--system")
    .option("--workspace")
    .option("--components")
    .option("--all")
    .option("--json");
  doctor.action(() =>
    runCliAction({
      command: doctor,
      root: "optional",
      handler: async ({ root, options }) => {
        const { doctorSystem, doctorWorkspace } = await import(
          "../../application/workspace/workspace-doctor.ts"
        );
        if (options.system) return doctorSystem();
        if (!root)
          throw failure("workspace_not_found", "Workspace doctor requires a Root", "not_found");
        return doctorWorkspace(root);
      },
      present: presentDoctor,
    }),
  );

  const component = program.command("component").description("inspect components");
  const componentList = component.command("list").option("--json");
  componentList.action(() =>
    runCliAction({
      command: componentList,
      root: "required",
      handler: async ({ root }) => {
        const { getWorkspaceStatus } = await import(
          "../../application/workspace/workspace-status.ts"
        );
        return (await getWorkspaceStatus(root ?? "")).capabilities;
      },
      present: presentList,
    }),
  );
  const componentShow = component.command("show <name>").option("--json");
  componentShow.action((name: string) =>
    runCliAction({
      command: componentShow,
      root: "required",
      handler: async ({ root }) => {
        const { getWorkspaceStatus } = await import(
          "../../application/workspace/workspace-status.ts"
        );
        const item = (await getWorkspaceStatus(root ?? "")).capabilities.find(
          (candidate) => candidate.name === name,
        );
        if (!item) throw failure("component_missing", `Unknown component: ${name}`, "not_found");
        return item;
      },
      present: presentKeyValues,
    }),
  );
  const componentVerify = component.command("verify [name]").option("--all").option("--json");
  componentVerify.action(() =>
    runCliAction({
      command: componentVerify,
      root: "required",
      handler: async ({ root }) => {
        const { doctorWorkspace } = await import("../../application/workspace/workspace-doctor.ts");
        return doctorWorkspace(root ?? "");
      },
      present: presentDoctor,
    }),
  );

  const capability = program.command("capability").description("inspect capabilities");
  const capabilityList = capability.command("list").option("--json");
  capabilityList.action(() =>
    runCliAction({
      command: capabilityList,
      root: "required",
      handler: async ({ root }) => {
        const { getWorkspaceStatus } = await import(
          "../../application/workspace/workspace-status.ts"
        );
        return (await getWorkspaceStatus(root ?? "")).capabilities;
      },
      present: presentList,
    }),
  );
  const capabilityShow = capability.command("show <name>").option("--json");
  capabilityShow.action((name: string) =>
    runCliAction({
      command: capabilityShow,
      root: "required",
      handler: async ({ root }) => {
        const { getWorkspaceStatus } = await import(
          "../../application/workspace/workspace-status.ts"
        );
        const item = (await getWorkspaceStatus(root ?? "")).capabilities.find(
          (candidate) => candidate.name === name,
        );
        if (!item)
          throw failure("capability_unavailable", `Unknown capability: ${name}`, "not_found");
        return item;
      },
      present: presentKeyValues,
    }),
  );
  registerDiagnostics(program);
}

function registerDiagnostics(program: Command): void {
  const diagnostics = program.command("diagnostics").description("collect redacted diagnostics");
  const collect = diagnostics.command("collect").requiredOption("--redact").option("--json");
  collect.action(() =>
    runCliAction({
      command: collect,
      root: "required",
      handler: async ({ root }) => {
        const { collectDiagnostics } = await import(
          "../../application/workspace/workspace-diagnostics.ts"
        );
        return collectDiagnostics(root ?? "");
      },
      present: presentKeyValues,
    }),
  );
  const show = diagnostics.command("show <id>").option("--json");
  show.action((id: string) =>
    runCliAction({
      command: show,
      root: "required",
      handler: async ({ root }) => {
        const { showDiagnostics } = await import(
          "../../application/workspace/workspace-diagnostics.ts"
        );
        return showDiagnostics(root ?? "", id);
      },
      present: (data) => `${JSON.stringify(data, null, 2)}\n`,
    }),
  );
  const verify = diagnostics.command("verify <id>").option("--json");
  verify.action((id: string) =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root }) => {
        const { verifyDiagnostics } = await import(
          "../../application/workspace/workspace-diagnostics.ts"
        );
        return verifyDiagnostics(root ?? "", id);
      },
      present: presentKeyValues,
    }),
  );
}

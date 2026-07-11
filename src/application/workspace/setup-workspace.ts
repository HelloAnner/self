import { Writable } from "node:stream";
import * as prompts from "@clack/prompts";
import { parse } from "smol-toml";
import { canonicalizePotentialPath } from "../../domains/workspace/root/discovery.ts";
import {
  loadLatestSetupSession,
  type SetupSession,
  saveSetupSession,
} from "../../domains/workspace/setup/session.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createRequestId, createResourceId } from "../../shared/ids/id.ts";
import { initWorkspace } from "./init-workspace.ts";
import { mutateConfig } from "./workspace-config.ts";
import { doctorSystem, doctorWorkspace } from "./workspace-doctor.ts";

const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
// biome-ignore lint/suspicious/noControlCharactersInRegex: this deliberately matches ANSI SGR styling.
const ANSI_STYLE = /\x1b\[[0-9;]*m/g;
const PROMPT_OUTPUT = createPromptOutput();

export type InteractiveSetupOptions = {
  root?: string;
  offline?: boolean;
  resume?: boolean;
  json?: boolean;
};

export async function runInteractiveSetup(
  options: InteractiveSetupOptions,
): Promise<{ workspace_id: string; root: string; state: string; profile: string }> {
  assertInteractive(options);
  prompts.intro("Self guided setup", { output: PROMPT_OUTPUT });
  const preflight = await doctorSystem();
  if (preflight.status === "blocking") {
    throw failure("component_missing", "System preflight has blocking failures", "external");
  }

  if (options.resume) return resumeSetup(options);
  const selectedRoot = options.root ?? (await promptText("Choose a Self Root", "./data"));
  const profile = options.offline ? "offline" : await promptProfile();
  const confirmed = await prompts.confirm({
    message: `Create Self Workspace at ${selectedRoot}? Network calls during init: none`,
    initialValue: false,
    output: PROMPT_OUTPUT,
  });
  if (prompts.isCancel(confirmed) || !confirmed) throw setupCancelled();

  const requestId = createRequestId();
  const initialized = await initWorkspace({
    target: selectedRoot,
    requestId,
    offline: profile === "offline",
  });
  if (!("state" in initialized)) throw new Error("Interactive init unexpectedly returned a Plan");
  const now = new Date().toISOString();
  const session: SetupSession = {
    session_id: createResourceId("setup"),
    workspace_id: initialized.workspace_id,
    state: "workspace_ready",
    current_step: "workspace",
    profile,
    answers: {},
    created_resource_ids: [initialized.workspace_id, initialized.operation_id],
    warnings: [],
    started_at: now,
    updated_at: now,
  };
  await saveSetupSession(initialized.root, session);
  return continueSetupSession(initialized.root, session, requestId);
}

export async function createSetupPlanFromSpec(content: string) {
  const spec = parse(content);
  if (!spec || typeof spec !== "object" || !("root" in spec) || typeof spec.root !== "string") {
    throw failure("invalid_setup_spec", "Setup Spec requires a root string", "usage");
  }
  const profile = "profile" in spec && spec.profile === "hosted" ? "hosted" : "offline";
  const plan = await initWorkspace({
    target: spec.root,
    requestId: createRequestId(),
    offline: profile === "offline",
    planOnly: true,
  });
  return {
    ...plan,
    profile,
    spec_format_version: "format_version" in spec ? spec.format_version : null,
  };
}

export async function continueSetupSession(root: string, session: SetupSession, requestId: string) {
  try {
    if (session.profile === "hosted") await configureHosted(root, session, requestId);
    session.state = "verifying";
    session.current_step = "doctor";
    await saveSetupSession(root, session);
    const doctor = await doctorWorkspace(root);
    if (doctor.status === "blocking")
      throw failure("setup_step_failed", "Final Workspace doctor failed", "state");
    session.state = "completed";
    session.current_step = "completed";
    session.completed_at = new Date().toISOString();
    await saveSetupSession(root, session);
    prompts.outro(`Workspace ready: ${root}`, { output: PROMPT_OUTPUT });
    return {
      workspace_id: session.workspace_id,
      root,
      state: session.state,
      profile: session.profile,
    };
  } catch (cause) {
    session.state =
      cause instanceof SelfFailure && cause.selfError.code === "setup_secret_unavailable"
        ? "waiting_for_user"
        : cause instanceof SelfFailure && cause.selfError.code === "setup_cancelled"
          ? "cancelled"
          : "failed";
    session.warnings.push(cause instanceof Error ? cause.message : String(cause));
    await saveSetupSession(root, session);
    throw cause;
  }
}

async function configureHosted(
  root: string,
  session: SetupSession,
  requestId: string,
): Promise<void> {
  const baseUrl =
    (session.answers.base_url as string | undefined) ??
    (await promptText("OpenAI-compatible Base URL", DASHSCOPE_BASE_URL));
  const apiKeyEnv =
    (session.answers.api_key_env as string | undefined) ??
    (await promptText("API Key environment variable", "SELF_DASHSCOPE_API_KEY"));
  session.answers = { ...session.answers, base_url: baseUrl, api_key_env: apiKeyEnv };
  session.current_step = "model_probe";
  await saveSetupSession(root, session);
  const models = await probeProvider(baseUrl, apiKeyEnv);
  session.answers = { ...session.answers, discovered_model_ids: models };
  await mutateConfig({
    root,
    path: "models.providers.dashscope",
    value: { protocol: "openai-compatible", base_url: baseUrl, api_key_env: apiKeyEnv },
    requestId,
  });
  session.state = "models_configured";
  session.current_step = "models";
  await saveSetupSession(root, session);
}

async function probeProvider(baseUrl: string, apiKeyEnv: string): Promise<string[]> {
  const secret = process.env[apiKeyEnv];
  if (!secret) {
    throw failure(
      "setup_secret_unavailable",
      `Environment variable ${apiKeyEnv} is not set`,
      "external",
      {
        suggestedActions: [`Set ${apiKeyEnv} and run \`self --init --resume --root <DIR>\`.`],
      },
    );
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw failure(
      "setup_model_unverified",
      `Provider model discovery failed with HTTP ${response.status}`,
      "external",
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
    return [];
  return body.data
    .map((item) => (item && typeof item === "object" && "id" in item ? item.id : undefined))
    .filter((id): id is string => typeof id === "string")
    .sort();
}

async function resumeSetup(options: InteractiveSetupOptions) {
  if (!options.root)
    throw failure("workspace_root_required", "--root is required with --resume", "usage");
  const root = await canonicalizePotentialPath(options.root);
  const session = await loadLatestSetupSession(root);
  if (session.state === "completed") {
    return {
      workspace_id: session.workspace_id,
      root,
      state: session.state,
      profile: session.profile,
    };
  }
  return continueSetupSession(root, session, createRequestId());
}

async function promptText(message: string, placeholder: string): Promise<string> {
  const result = await prompts.text({
    message,
    placeholder,
    defaultValue: placeholder,
    output: PROMPT_OUTPUT,
  });
  if (prompts.isCancel(result)) throw setupCancelled();
  return result;
}

async function promptProfile(): Promise<"offline" | "hosted"> {
  const result = await prompts.select<"offline" | "hosted">({
    message: "Model profile",
    options: [
      { value: "offline", label: "Offline", hint: "No model or network calls" },
      { value: "hosted", label: "Hosted", hint: "Probe an OpenAI-compatible provider after init" },
    ],
    initialValue: "offline",
    output: PROMPT_OUTPUT,
  });
  if (prompts.isCancel(result)) throw setupCancelled();
  return result;
}

function assertInteractive(options: InteractiveSetupOptions): void {
  if (options.json)
    throw failure(
      "interactive_json_conflict",
      "Interactive setup cannot emit one JSON envelope",
      "usage",
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw failure("interactive_tty_required", "Interactive setup requires a TTY", "usage", {
      suggestedActions: ["Use `self setup plan --spec <FILE> --json` for automation."],
    });
  }
}

function setupCancelled() {
  prompts.cancel("Setup cancelled safely.", { output: PROMPT_OUTPUT });
  return failure("setup_cancelled", "Setup was cancelled", "state");
}

function createPromptOutput(): NodeJS.WriteStream | Writable {
  if (!process.env.NO_COLOR) return process.stdout;
  return new Writable({
    write(chunk, _encoding, callback) {
      process.stdout.write(String(chunk).replaceAll(ANSI_STYLE, ""));
      callback();
    },
  });
}

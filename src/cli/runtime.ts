import type { Command } from "commander";
import { failure, SelfFailure } from "../shared/errors/self-error.ts";
import { createRequestId } from "../shared/ids/id.ts";
import { failureEnvelope, successEnvelope } from "./protocol/envelope.ts";

export type CliOptions = {
  json?: boolean;
  root?: string;
  offline?: boolean;
  plan?: boolean;
  verbose?: boolean;
  system?: boolean;
  components?: boolean;
  all?: boolean;
};

export type ActionContext = {
  root?: string;
  requestId: string;
  options: CliOptions;
};

export async function runCliAction<T>(options: {
  command: Command;
  root: "none" | "optional" | "required";
  handler: (context: ActionContext) => Promise<T> | T;
  present: (data: T) => string;
}): Promise<void> {
  const cliOptions = options.command.optsWithGlobals<CliOptions>();
  const requestId = createRequestId();
  let root: string | undefined;
  try {
    if (options.root !== "none") {
      try {
        const { discoverWorkspaceRoot } = await import("../domains/workspace/root/discovery.ts");
        root = await discoverWorkspaceRoot({
          ...(cliOptions.root ? { explicit: cliOptions.root } : {}),
          ...(process.env.SELF_ROOT ? { environment: process.env.SELF_ROOT } : {}),
          cwd: process.cwd(),
        });
      } catch (cause) {
        if (options.root === "required") throw cause;
        if (!(cause instanceof SelfFailure) || cause.selfError.code !== "workspace_not_found")
          throw cause;
      }
    }
    const data = await options.handler({
      ...(root ? { root } : {}),
      requestId,
      options: cliOptions,
    });
    const operationId = extractOperationId(data);
    const resultRoot = root ?? extractRoot(data);
    if (cliOptions.json) {
      process.stdout.write(
        `${JSON.stringify(
          successEnvelope(data, requestId, {
            ...(resultRoot ? { root: resultRoot } : {}),
            ...(operationId ? { operationId } : {}),
            ...extractWarnings(data),
          }),
        )}\n`,
      );
    } else {
      process.stdout.write(options.present(data));
    }
  } catch (cause) {
    const error =
      cause instanceof SelfFailure
        ? cause
        : failure("internal_error", "Self encountered an unexpected error", "internal", {
            details: { reason: cause instanceof Error ? cause.message : String(cause) },
          });
    process.exitCode = error.exitCode;
    if (cliOptions.json) {
      process.stdout.write(
        `${JSON.stringify(failureEnvelope(error.selfError, requestId, root ?? null))}\n`,
      );
    } else {
      process.stderr.write(`${error.selfError.code}: ${error.selfError.message}\n`);
      for (const action of error.selfError.suggestedActions ?? [])
        process.stderr.write(`${action}\n`);
    }
  }
}

export function requireArgument(value: string | undefined, name: string): string {
  if (!value) throw failure("invalid_arguments", `${name} is required`, "usage");
  return value;
}

function extractOperationId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("operation_id" in data)) return undefined;
  const value = data.operation_id;
  return typeof value === "string" ? value : undefined;
}

function extractRoot(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = "root" in data ? data.root : "target_root" in data ? data.target_root : undefined;
  return typeof value === "string" ? value : undefined;
}

function extractWarnings(data: unknown): { warnings?: string[] } {
  if (!data || typeof data !== "object" || !("warnings" in data)) return {};
  const warnings = data.warnings;
  return Array.isArray(warnings) && warnings.every((item) => typeof item === "string")
    ? { warnings }
    : {};
}

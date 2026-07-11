import { parse, stringify } from "smol-toml";
import { failure } from "../../../shared/errors/self-error.ts";
import { type SelfConfig, selfConfigSchema } from "./schema.ts";

export function parseSelfConfig(content: string): SelfConfig {
  try {
    return selfConfigSchema.parse(parse(content));
  } catch (cause) {
    const details = cause instanceof Error ? { reason: cause.message } : undefined;
    throw failure("config_invalid", "self.toml is invalid", "state", {
      ...(details ? { details } : {}),
      suggestedActions: ["Run `self config validate` after correcting self.toml."],
    });
  }
}

export function stringifySelfConfig(config: SelfConfig): string {
  return `${stringify(selfConfigSchema.parse(config))}\n`;
}

export async function loadSelfConfig(root: string): Promise<SelfConfig> {
  const file = Bun.file(`${root}/self.toml`);
  if (!(await file.exists())) {
    throw failure("workspace_not_found", "No self.toml exists at the selected root", "not_found", {
      suggestedActions: ["Run `self init <DIR>` to create a Workspace."],
    });
  }
  return parseSelfConfig(await file.text());
}

import type { getVersionInfo } from "./handler.ts";

export function presentVersion(data: ReturnType<typeof getVersionInfo>): string {
  return `Self ${data.cli_version}\nDatabase schema ${data.database_schema_version}\nCLI protocol ${data.cli_protocol_version}\nPage IR ${data.page_ir_version}\n`;
}

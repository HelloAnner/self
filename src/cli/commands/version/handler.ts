import { VERSION } from "../../../shared/version.ts";

export function getVersionInfo() {
  return {
    cli_version: VERSION.cli,
    config_format_version: VERSION.configFormat,
    database_schema_version: VERSION.databaseSchema,
    cli_protocol_version: VERSION.cliProtocol,
    page_ir_version: VERSION.pageIr,
  } as const;
}

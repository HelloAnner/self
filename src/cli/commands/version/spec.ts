import { z } from "zod";

export const versionOutputSchema = z.object({
  cli_version: z.string(),
  config_format_version: z.number().int().nonnegative(),
  database_schema_version: z.number().int().nonnegative(),
  cli_protocol_version: z.number().int().nonnegative(),
  page_ir_version: z.number().int().nonnegative(),
});

export const versionCommandSpec = {
  id: "version",
  summary: "Show CLI and format versions",
  output: versionOutputSchema,
} as const;

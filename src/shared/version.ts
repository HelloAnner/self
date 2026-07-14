export const VERSION = {
  cli: "1.0.0",
  configFormat: 1,
  databaseSchema: 11,
  cliProtocol: 1,
  pageIr: 1,
} as const;

export type VersionInfo = typeof VERSION;

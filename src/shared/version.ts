export const VERSION = {
  cli: "0.1.0",
  configFormat: 1,
  databaseSchema: 4,
  cliProtocol: 1,
  pageIr: 1,
} as const;

export type VersionInfo = typeof VERSION;

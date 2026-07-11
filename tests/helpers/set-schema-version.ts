import { openWorkspaceDatabase } from "../../src/infrastructure/db/workspace-database.ts";

const [root, versionText] = process.argv.slice(2);
if (!root?.includes("/data/test-runs/"))
  throw new Error("Schema helper only accepts data/test-runs paths");
const version = Number.parseInt(versionText ?? "", 10);
if (!Number.isInteger(version) || version < 0)
  throw new Error("A non-negative schema version is required");

const opened = await openWorkspaceDatabase(root, "read_write");
try {
  opened.database.exec(`PRAGMA user_version = ${version}`);
} finally {
  opened.database.close();
}

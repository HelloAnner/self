import { resolve } from "node:path";
import { scanConnection } from "../../src/application/connection/connection-scan.ts";
import { createRequestId } from "../../src/shared/ids/id.ts";

const root = resolve(process.argv[2] ?? "");
const connectionId = process.argv[3];
if (!root || !connectionId) {
  throw new Error("Usage: crash-connection-after-batch.ts <root> <connection-id>");
}

await scanConnection(
  root,
  connectionId,
  {
    trigger: "manual",
    afterCheckpoint: () => process.exit(99),
  },
  createRequestId(),
);

throw new Error("Crash checkpoint was not reached");

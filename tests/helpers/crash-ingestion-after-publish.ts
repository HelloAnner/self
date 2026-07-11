import { resolve } from "node:path";
import { ingestSnapshot } from "../../src/application/ingestion/ingest-snapshot.ts";
import { createRequestId } from "../../src/shared/ids/id.ts";

const root = resolve(process.argv[2] ?? "");
const sourceId = process.argv[3];
const snapshotId = process.argv[4];
if (!root || !sourceId || !snapshotId) {
  throw new Error("Usage: crash-ingestion-after-publish.ts <root> <source-id> <snapshot-id>");
}

await ingestSnapshot(
  root,
  {
    sourceId,
    snapshotId,
    trigger: "manual",
    afterCheckpoint: () => process.exit(99),
  },
  createRequestId(),
);

throw new Error("Ingestion crash checkpoint was not reached");

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  acceptSourceChangeBatch,
  addSource,
} from "../../../src/application/source/source-archive.ts";
import { initWorkspace } from "../../../src/application/workspace/init-workspace.ts";
import { openWorkspaceDatabase } from "../../../src/infrastructure/db/workspace-database.ts";
import { createRequestId } from "../../../src/shared/ids/id.ts";

const runRoot = resolve("data/test-runs/integration-source-change-batch");
const instance = resolve(runRoot, "instance");
const input = resolve(runRoot, "input/note.md");
let sourceId = "";

describe("Source ChangeBatch receipt", () => {
  beforeAll(async () => {
    await rm(runRoot, { recursive: true, force: true });
    await mkdir(resolve(runRoot, "input"), { recursive: true });
    await Bun.write(input, "version one\n");
    await initWorkspace({ target: instance, requestId: createRequestId(), offline: true });
    const added = await addSource(
      instance,
      {
        input,
        kind: "markdown",
        mode: "mirror",
        recursive: false,
        include: [],
        exclude: [],
        noBuild: true,
      },
      createRequestId(),
    );
    sourceId = added.source_id;
  });

  afterAll(async () => rm(runRoot, { recursive: true, force: true }));

  test("returns the same Snapshot when a ChangeBatch is retried", async () => {
    await Bun.write(input, "version two\n");
    const batchId = "change-batch:cb_019f5075-0000-7000-8000-000000000001";
    const first = await acceptSourceChangeBatch(instance, sourceId, batchId, createRequestId());
    const retried = await acceptSourceChangeBatch(instance, sourceId, batchId, createRequestId());
    expect(retried.source_id).toBe(sourceId);
    expect(retried.snapshot_id).toBe(first.snapshot_id);
    expect(retried.reused_batch).toBe(true);
    expect(retried.ingestion_status).toBe("ready");
    const opened = await openWorkspaceDatabase(instance, "read_only");
    try {
      expect(
        opened.database
          .query<{ count: number }, []>("SELECT COUNT(*) count FROM source_batch_receipts")
          .get()?.count,
      ).toBe(1);
    } finally {
      opened.database.close();
    }
  });
});

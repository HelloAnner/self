import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  applyInitRollback,
  createInitRollbackPlan,
} from "../../../src/application/workspace/init-rollback.ts";
import { initWorkspace } from "../../../src/application/workspace/init-workspace.ts";
import { migrateDatabase } from "../../../src/infrastructure/db/migrations/runner.ts";
import { openWorkspaceDatabase } from "../../../src/infrastructure/db/workspace-database.ts";
import { createRequestId } from "../../../src/shared/ids/id.ts";
import { VERSION } from "../../../src/shared/version.ts";

const root = resolve("data/test-runs/integration-init-recovery");
const rollbackRoot = resolve("data/test-runs/integration-init-rollback");

describe("Workspace Init recovery", () => {
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(rollbackRoot, { recursive: true, force: true });
  });

  test("resumes from a durable checkpoint", async () => {
    await rm(root, { recursive: true, force: true });
    await expect(
      initWorkspace({
        target: root,
        requestId: createRequestId(),
        afterCheckpoint(step) {
          if (step === "runtime_assets") throw new Error("interrupt");
        },
      }),
    ).rejects.toThrow("can be resumed");
    expect(await Bun.file(join(root, "self.toml")).exists()).toBe(false);

    const resumed = await initWorkspace({
      target: root,
      requestId: createRequestId(),
      resume: true,
    });
    expect("state" in resumed && resumed.state).toBe("active");
    expect("resumed" in resumed && resumed.resumed).toBe(true);
    const opened = await openWorkspaceDatabase(root, "read_write");
    try {
      const repeatedMigration = await migrateDatabase(opened.database);
      expect(repeatedMigration.applied).toEqual([]);
      expect(repeatedMigration.schemaVersion).toBe(VERSION.databaseSchema);
    } finally {
      opened.database.close();
    }
  });

  test("rollback preserves unknown user files", async () => {
    await rm(rollbackRoot, { recursive: true, force: true });
    await expect(
      initWorkspace({
        target: rollbackRoot,
        requestId: createRequestId(),
        afterCheckpoint(step) {
          if (step === "directories") throw new Error("interrupt");
        },
      }),
    ).rejects.toThrow("can be resumed");
    await mkdir(rollbackRoot, { recursive: true });
    await Bun.write(join(rollbackRoot, "user-file.txt"), "keep me");
    const plan = await createInitRollbackPlan(rollbackRoot);
    const result = await applyInitRollback(rollbackRoot, plan.plan_id);
    expect(await Bun.file(join(rollbackRoot, "user-file.txt")).text()).toBe("keep me");
    expect(result.retained).toContain(".");
  });
});

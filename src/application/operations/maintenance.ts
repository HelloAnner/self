import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  acquireMaintenanceLock,
  maintenanceLockStatus,
} from "../../infrastructure/operations/maintenance-lock.ts";
import { recoverGcStaging } from "./gc.ts";

export async function showMaintenanceStatus(root: string) {
  const lock = await maintenanceLockStatus(root);
  const database = await writableAutomationDatabase(root);
  try {
    const journalMode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    const checkpoint = database
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        "PRAGMA wal_checkpoint(PASSIVE)",
      )
      .get();
    const jobs = database
      .query<{ state: string; count: number }, []>(
        "SELECT state, COUNT(*) count FROM automation_jobs GROUP BY state ORDER BY state",
      )
      .all();
    const failedBackups = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM operation_backups WHERE state = 'failed'",
      )
      .get()?.count;
    return {
      lock,
      journal_mode: journalMode?.journal_mode ?? "unknown",
      wal: checkpoint ?? { busy: 0, log: 0, checkpointed: 0 },
      jobs: Object.fromEntries(jobs.map((row) => [row.state, row.count])),
      failed_backups: failedBackups ?? 0,
    };
  } finally {
    database.close();
  }
}

export async function checkpointWorkspace(root: string) {
  const lock = await acquireMaintenanceLock(root, "wal.checkpoint", 60_000);
  try {
    const recoveredGcStaging = await recoverGcStaging(root);
    const database = await writableAutomationDatabase(root);
    try {
      const before = database
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          "PRAGMA wal_checkpoint(PASSIVE)",
        )
        .get();
      const result = database
        .query<{ busy: number; log: number; checkpointed: number }, []>(
          "PRAGMA wal_checkpoint(TRUNCATE)",
        )
        .get();
      return {
        status: result?.busy ? "busy" : "succeeded",
        before: before ?? { busy: 0, log: 0, checkpointed: 0 },
        after: result ?? { busy: 0, log: 0, checkpointed: 0 },
        recovered_gc_staging: recoveredGcStaging,
      };
    } finally {
      database.close();
    }
  } finally {
    await lock.release();
  }
}

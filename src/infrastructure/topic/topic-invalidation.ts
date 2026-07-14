import type { Database } from "bun:sqlite";
import { writableModelDatabase } from "../model/model-db.ts";

export async function invalidateActiveTopics(root: string, reason: string) {
  const database = await writableModelDatabase(root);
  try {
    return invalidateTopics(database, { reason });
  } finally {
    database.close();
  }
}

export function invalidateTopics(
  database: Database,
  input: { reason: string; claimId?: string; review?: boolean },
) {
  const now = new Date().toISOString();
  const status = input.review ? "needs_review" : "stale";
  if (input.claimId)
    return database
      .prepare(
        `UPDATE topics SET status = ?, stale_reason = ?, stale_at = ?, updated_at = ?
         WHERE status <> 'deleted' AND latest_snapshot_id IN
         (SELECT topic_snapshot_id FROM topic_snapshot_claims WHERE claim_id = ?)`,
      )
      .run(status, input.reason, now, now, input.claimId).changes;
  return database
    .prepare(
      `UPDATE topics SET status = ?, stale_reason = ?, stale_at = ?, updated_at = ?
       WHERE status = 'active' AND latest_snapshot_id IS NOT NULL`,
    )
    .run(status, input.reason, now, now).changes;
}

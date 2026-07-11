import { isAbsolute, relative } from "node:path";
import type { ConnectionChange } from "../../domains/connection/index.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { writableConnectionDatabase } from "./connection-db.ts";

export async function recordManagedWriteReceipt(
  root: string,
  input: { absolutePath: string; expectedHash: string; operationId: string },
): Promise<void> {
  const database = await writableConnectionDatabase(root);
  try {
    const targets = database
      .query<{ target_id: string; connection_id: string; canonical_path: string }, []>(
        `SELECT t.target_id, t.connection_id, t.canonical_path FROM connection_targets t
         JOIN data_connections c ON c.connection_id = t.connection_id
         WHERE t.location_scope = 'managed_content' AND t.status = 'active'
         AND c.state IN ('active', 'paused', 'degraded')`,
      )
      .all();
    const target = targets.find((candidate) =>
      inside(candidate.canonical_path, input.absolutePath),
    );
    if (!target) return;
    const path = relative(target.canonical_path, input.absolutePath).split("\\").join("/");
    const now = new Date();
    database
      .prepare(
        `INSERT INTO connection_write_receipts(write_receipt_id, connection_id, target_id,
         relative_path, normalized_path_key, expected_hash, operation_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createResourceId("write-receipt"),
        target.connection_id,
        target.target_id,
        path,
        path.normalize("NFC"),
        input.expectedHash,
        input.operationId,
        new Date(now.getTime() + 30_000).toISOString(),
        now.toISOString(),
      );
  } finally {
    database.close();
  }
}

export async function consumeManagedWriteReceipts(
  root: string,
  targetId: string,
  changes: ConnectionChange[],
): Promise<ConnectionChange[]> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  try {
    return database.transaction(() => {
      const output: ConnectionChange[] = [];
      for (const change of changes) {
        if (!change.current_hash) {
          output.push(change);
          continue;
        }
        const receipt = database
          .query<{ write_receipt_id: string }, [string, string, string, string]>(
            `SELECT write_receipt_id FROM connection_write_receipts WHERE target_id = ?
             AND normalized_path_key = ? AND expected_hash = ? AND consumed_at IS NULL
             AND expires_at > ? LIMIT 1`,
          )
          .get(targetId, change.relative_path.normalize("NFC"), change.current_hash, now);
        if (!receipt) output.push(change);
        else
          database
            .prepare(
              "UPDATE connection_write_receipts SET consumed_at = ? WHERE write_receipt_id = ?",
            )
            .run(now, receipt.write_receipt_id);
      }
      return output;
    })();
  } finally {
    database.close();
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path === "." || (!path.startsWith("..") && !isAbsolute(path));
}

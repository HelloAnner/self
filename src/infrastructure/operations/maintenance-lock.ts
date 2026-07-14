import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { failure } from "../../shared/errors/self-error.ts";
import { writableAutomationDatabase } from "../automation/automation-db.ts";
import { sha256Text } from "../filesystem/hash.ts";

export type MaintenanceLock = {
  owner: string;
  purpose: string;
  acquiredAt: string;
  expiresAt: string;
  release(): Promise<void>;
};

export async function acquireMaintenanceLock(
  root: string,
  purpose: string,
  ttlMs = 30 * 60_000,
): Promise<MaintenanceLock> {
  const path = join(root, "runtime/locks/maintenance.lock");
  await mkdir(join(root, "runtime/locks"), { recursive: true });
  const token = crypto.randomUUID();
  const owner = `maintenance:${process.pid}`;
  const acquiredAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    const current = await maintenanceLockStatus(root);
    if (current.exists && !current.stale)
      throw failure(
        "maintenance_locked",
        "Another maintenance operation holds the lock",
        "conflict",
        {
          retryable: true,
          exitCode: 8,
          details: {
            owner: current.owner,
            purpose: current.purpose,
            expires_at: current.expires_at,
          },
        },
      );
    await rm(path, { force: true });
    handle = await open(path, "wx", 0o600);
  }
  await handle.writeFile(
    `${JSON.stringify({ owner, purpose, pid: process.pid, token, acquired_at: acquiredAt, expires_at: expiresAt })}\n`,
  );
  const database = await writableAutomationDatabase(root);
  try {
    database
      .prepare(
        `INSERT INTO operation_maintenance_lease(singleton_key, owner, token_hash, purpose,
         pid, acquired_at, expires_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_key) DO UPDATE SET owner = excluded.owner,
         token_hash = excluded.token_hash, purpose = excluded.purpose, pid = excluded.pid,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      )
      .run(owner, sha256Text(token), purpose, process.pid, acquiredAt, expiresAt, acquiredAt);
  } finally {
    database.close();
  }
  let released = false;
  return {
    owner,
    purpose,
    acquiredAt,
    expiresAt,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      const current = await readLockFile(path);
      if (current?.token === token) await rm(path, { force: true });
      const db = await writableAutomationDatabase(root);
      try {
        db.prepare(
          "DELETE FROM operation_maintenance_lease WHERE singleton_key = 1 AND token_hash = ?",
        ).run(sha256Text(token));
      } finally {
        db.close();
      }
    },
  };
}

export async function maintenanceLockStatus(root: string) {
  const path = join(root, "runtime/locks/maintenance.lock");
  const current = await readLockFile(path);
  if (!current)
    return { exists: false, stale: false, owner: null, purpose: null, expires_at: null, pid: null };
  const expired = Date.parse(current.expires_at) <= Date.now();
  const alive = pidAlive(current.pid);
  return {
    exists: true,
    stale: expired || !alive,
    owner: current.owner,
    purpose: current.purpose,
    expires_at: current.expires_at,
    pid: current.pid,
  };
}

async function readLockFile(path: string): Promise<{
  owner: string;
  purpose: string;
  pid: number;
  token: string;
  expires_at: string;
} | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      "owner" in value &&
      "purpose" in value &&
      "pid" in value &&
      "token" in value &&
      "expires_at" in value &&
      typeof value.owner === "string" &&
      typeof value.purpose === "string" &&
      typeof value.pid === "number" &&
      typeof value.token === "string" &&
      typeof value.expires_at === "string"
    )
      return value as {
        owner: string;
        purpose: string;
        pid: number;
        token: string;
        expires_at: string;
      };
  } catch {
    return null;
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

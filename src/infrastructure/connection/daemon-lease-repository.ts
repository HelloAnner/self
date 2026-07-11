import { failure } from "../../shared/errors/self-error.ts";
import { readableConnectionDatabase, writableConnectionDatabase } from "./connection-db.ts";

export type DaemonLease = {
  workspace_id: string;
  instance_id: string;
  pid: number;
  host_id: string;
  cli_version: string;
  protocol_version: number;
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  version: number;
};

export async function acquireDaemonLease(
  root: string,
  input: Omit<DaemonLease, "workspace_id" | "version">,
): Promise<DaemonLease> {
  const database = await writableConnectionDatabase(root);
  try {
    const workspace = database
      .query<{ workspace_id: string }, []>("SELECT workspace_id FROM workspace")
      .get();
    if (!workspace) throw new Error("Workspace row is missing");
    return database.transaction(() => {
      const existing = database
        .query<DaemonLease, [string]>(
          "SELECT * FROM connection_daemon_leases WHERE workspace_id = ?",
        )
        .get(workspace.workspace_id);
      if (
        existing &&
        existing.instance_id !== input.instance_id &&
        Date.parse(existing.lease_expires_at) > Date.now()
      ) {
        throw failure(
          "connection_daemon_conflict",
          "Another Daemon holds the active Lease",
          "conflict",
        );
      }
      database
        .prepare(
          `INSERT INTO connection_daemon_leases(workspace_id, instance_id, pid, host_id, cli_version,
           protocol_version, started_at, heartbeat_at, lease_expires_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(workspace_id) DO UPDATE SET instance_id = excluded.instance_id, pid = excluded.pid,
           host_id = excluded.host_id, cli_version = excluded.cli_version,
           protocol_version = excluded.protocol_version, started_at = excluded.started_at,
           heartbeat_at = excluded.heartbeat_at, lease_expires_at = excluded.lease_expires_at,
           version = connection_daemon_leases.version + 1`,
        )
        .run(
          workspace.workspace_id,
          input.instance_id,
          input.pid,
          input.host_id,
          input.cli_version,
          input.protocol_version,
          input.started_at,
          input.heartbeat_at,
          input.lease_expires_at,
        );
      const lease = database
        .query<DaemonLease, [string]>(
          "SELECT * FROM connection_daemon_leases WHERE workspace_id = ?",
        )
        .get(workspace.workspace_id);
      if (!lease) throw new Error("Daemon Lease was not persisted");
      return lease;
    })();
  } finally {
    database.close();
  }
}

export async function heartbeatDaemonLease(
  root: string,
  lease: DaemonLease,
  expiresAt: string,
): Promise<DaemonLease> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  try {
    const result = database
      .prepare(
        `UPDATE connection_daemon_leases SET heartbeat_at = ?, lease_expires_at = ?, version = version + 1
         WHERE workspace_id = ? AND instance_id = ? AND version = ?`,
      )
      .run(now, expiresAt, lease.workspace_id, lease.instance_id, lease.version);
    if (result.changes !== 1) {
      throw failure("connection_daemon_conflict", "Daemon lost its Lease", "conflict");
    }
    const updated = database
      .query<DaemonLease, [string]>("SELECT * FROM connection_daemon_leases WHERE workspace_id = ?")
      .get(lease.workspace_id);
    if (!updated) throw new Error("Heartbeat Lease disappeared");
    return updated;
  } finally {
    database.close();
  }
}

export async function releaseDaemonLease(root: string, instanceId: string): Promise<void> {
  const database = await writableConnectionDatabase(root);
  try {
    database.prepare("DELETE FROM connection_daemon_leases WHERE instance_id = ?").run(instanceId);
  } finally {
    database.close();
  }
}

export async function getDaemonLease(root: string): Promise<DaemonLease | null> {
  const database = await readableConnectionDatabase(root);
  try {
    return (
      database.query<DaemonLease, []>("SELECT * FROM connection_daemon_leases LIMIT 1").get() ??
      null
    );
  } finally {
    database.close();
  }
}

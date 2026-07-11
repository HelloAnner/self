import { type FSWatcher, watch } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  listDueConnectionIds,
  markEventHintsProcessed,
  recordEventHint,
  recoverInterruptedConnections,
} from "../../infrastructure/connection/connection-query-repository.ts";
import {
  getConnectionTarget,
  listConnections,
} from "../../infrastructure/connection/connection-repository.ts";
import {
  acquireDaemonLease,
  type DaemonLease,
  getDaemonLease,
  heartbeatDaemonLease,
  releaseDaemonLease,
} from "../../infrastructure/connection/daemon-lease-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createRequestId, createResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";
import { scanConnection } from "./connection-scan.ts";

const HEARTBEAT_MS = 5_000;
const LEASE_MS = 15_000;

export async function runConnectionDaemon(root: string, options: { once?: boolean } = {}) {
  const lock = await acquireFileLock(root);
  const instanceId = createResourceId("event");
  let lease: DaemonLease | null = null;
  const watchers: FSWatcher[] = [];
  try {
    const now = new Date();
    lease = await acquireDaemonLease(root, {
      instance_id: instanceId,
      pid: process.pid,
      host_id: process.env.HOSTNAME ?? "local",
      cli_version: VERSION.cli,
      protocol_version: VERSION.cliProtocol,
      started_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
    });
    await recoverInterruptedConnections(root);
    if (options.once) {
      await scanDue(root);
      return { instance_id: instanceId, pid: process.pid, state: "stopped" as const, once: true };
    }
    watchers.push(...(await startWatchers(root)));
    const stop = createStopSignal();
    let lastHeartbeat = 0;
    while (!stop.stopped()) {
      const timestamp = Date.now();
      if (timestamp - lastHeartbeat >= HEARTBEAT_MS) {
        lease = await heartbeatDaemonLease(
          root,
          lease,
          new Date(timestamp + LEASE_MS).toISOString(),
        );
        lastHeartbeat = timestamp;
      }
      await scanDue(root);
      await Promise.race([Bun.sleep(250), stop.promise]);
    }
    stop.dispose();
    return { instance_id: instanceId, pid: process.pid, state: "stopped" as const, once: false };
  } finally {
    for (const watcher of watchers) watcher.close();
    if (lease) await releaseDaemonLease(root, lease.instance_id).catch(() => undefined);
    await lock.close();
    await rm(lockPath(root), { force: true });
  }
}

export async function startConnectionDaemon(root: string) {
  const current = await daemonStatus(root);
  if (current.state === "running") return { ...current, reused: true };
  const directory = join(root, "runtime/daemon");
  await mkdir(directory, { recursive: true });
  const log = await open(join(root, "runtime/logs/connection-daemon.log"), "a", 0o600);
  const child = Bun.spawn(
    [process.execPath, "--root", root, "daemon", "run", "--connections-only"],
    { cwd: root, stdin: "ignore", stdout: log.fd, stderr: log.fd, detached: true },
  );
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(50);
    const status = await daemonStatus(root);
    if (status.state === "running") return { ...status, reused: false };
  }
  throw failure("connection_daemon_not_running", "Daemon did not acquire Leadership", "external");
}

export async function stopConnectionDaemon(root: string) {
  const status = await daemonStatus(root);
  if (status.state !== "running" || !status.pid) return { state: "stopped" as const, reused: true };
  process.kill(status.pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await Bun.sleep(50);
    const next = await daemonStatus(root);
    if (next.state === "stopped") return { state: "stopped" as const, reused: false };
  }
  throw failure("connection_daemon_stop_timeout", "Daemon did not stop in time", "external");
}

export async function daemonStatus(root: string) {
  const lease = await getDaemonLease(root);
  if (!lease || Date.parse(lease.lease_expires_at) <= Date.now() || !pidAlive(lease.pid)) {
    return { state: "stopped" as const, pid: null, instance_id: null };
  }
  return {
    state: "running" as const,
    pid: lease.pid,
    instance_id: lease.instance_id,
    cli_version: lease.cli_version,
    protocol_version: lease.protocol_version,
    heartbeat_at: lease.heartbeat_at,
    lease_expires_at: lease.lease_expires_at,
  };
}

export async function daemonLogs(root: string): Promise<string> {
  try {
    return await readFile(join(root, "runtime/logs/connection-daemon.log"), "utf8");
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return "";
    throw cause;
  }
}

async function scanDue(root: string): Promise<void> {
  for (const connectionId of await listDueConnectionIds(root, new Date().toISOString())) {
    try {
      await scanConnection(root, connectionId, { trigger: "schedule" }, createRequestId());
      await markEventHintsProcessed(root, connectionId);
    } catch {
      // Scan and Connection state already retain the redacted failure.
    }
  }
}

async function startWatchers(root: string): Promise<FSWatcher[]> {
  const output: FSWatcher[] = [];
  for (const connection of await listConnections(root, "active")) {
    if (connection.watch_mode === "poll") continue;
    const target = await getConnectionTarget(root, connection.connection_id);
    try {
      const watcher = watch(
        target.canonical_path,
        { recursive: target.recursive && ["darwin", "win32"].includes(process.platform) },
        (eventType, filename) => {
          const path = filename ? String(filename).split("\\").join("/") : null;
          void recordEventHint(root, connection.connection_id, target.target_id, eventType, path);
        },
      );
      output.push(watcher);
    } catch {
      // Polling reconciliation remains authoritative when native watch is unavailable.
    }
  }
  return output;
}

async function acquireFileLock(root: string) {
  const path = lockPath(root);
  await mkdir(join(root, "runtime/locks"), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
    );
    return handle;
  } catch {
    const owner = await lockOwner(path);
    if (owner && pidAlive(owner.pid)) {
      throw failure("connection_daemon_conflict", "Another Daemon holds the file lock", "conflict");
    }
    await rm(path, { force: true });
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
    );
    return handle;
  }
}

async function lockOwner(path: string): Promise<{ pid: number } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && "pid" in value && typeof value.pid === "number"
      ? { pid: value.pid }
      : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockPath(root: string): string {
  return join(root, "runtime/locks/connection-daemon.lock");
}

function createStopSignal() {
  let stopped = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const handler = () => {
    stopped = true;
    resolvePromise();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return {
    promise,
    stopped: () => stopped,
    dispose() {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

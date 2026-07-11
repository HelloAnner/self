import { setConnectionState } from "../../infrastructure/connection/connection-lifecycle-repository.ts";
import {
  getConnectionMetrics,
  listConnectionEvents,
} from "../../infrastructure/connection/connection-query-repository.ts";
import {
  getConnection,
  getConnectionTarget,
  listConnections,
} from "../../infrastructure/connection/connection-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { scanConnection } from "./connection-scan.ts";

export async function connectionList(root: string, state?: string) {
  return Promise.all(
    (await listConnections(root, state)).map(async (item) => connectionSummary(root, item)),
  );
}

export async function connectionShow(root: string, connectionId: string) {
  const connection = await getConnection(root, connectionId);
  const target = await getConnectionTarget(root, connectionId);
  const metrics = await getConnectionMetrics(root, connectionId);
  return {
    ...connection,
    target,
    health: health(connection.state, metrics.failed_changes, connection.reconcile_required),
    metrics,
  };
}

export async function connectionEvents(root: string, connectionId?: string) {
  if (connectionId) await getConnection(root, connectionId);
  return listConnectionEvents(root, { ...(connectionId ? { connectionId } : {}) });
}

export async function followConnectionEvents(
  root: string,
  connectionId: string | undefined,
  emit: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (connectionId) await getConnection(root, connectionId);
  const seen = new Set(
    (await listConnectionEvents(root, { ...(connectionId ? { connectionId } : {}) })).map(
      (event) => event.change_item_id,
    ),
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      const events = await listConnectionEvents(root, {
        ...(connectionId ? { connectionId } : {}),
      });
      for (const event of events.reverse()) {
        if (seen.has(event.change_item_id)) continue;
        seen.add(event.change_item_id);
        emit(event);
      }
      await Bun.sleep(200);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function pauseConnection(root: string, connectionId: string, requestId: string) {
  await getConnection(root, connectionId);
  await setConnectionState(root, connectionId, "paused", requestId);
  return { connection_id: connectionId, state: "paused" as const };
}

export async function resumeConnection(root: string, connectionId: string, requestId: string) {
  await getConnection(root, connectionId);
  await setConnectionState(root, connectionId, "active", requestId);
  const scan = await scanConnection(
    root,
    connectionId,
    { trigger: "manual", fullHash: true },
    requestId,
  );
  return { connection_id: connectionId, state: "active" as const, scan };
}

export async function retryConnection(root: string, connectionId: string, requestId: string) {
  const connection = await getConnection(root, connectionId);
  if (!["degraded", "error"].includes(connection.state)) {
    throw failure(
      "connection_retry_invalid",
      "Only degraded or error Connections can retry",
      "state",
    );
  }
  await setConnectionState(root, connectionId, "active", requestId);
  return scanConnection(root, connectionId, { trigger: "recovery", fullHash: true }, requestId);
}

async function connectionSummary(
  root: string,
  connection: Awaited<ReturnType<typeof getConnection>>,
) {
  const metrics = await getConnectionMetrics(root, connection.connection_id);
  return {
    connection_id: connection.connection_id,
    source_id: connection.source_id,
    name: connection.name,
    kind: connection.kind,
    state: connection.state,
    health: health(connection.state, metrics.failed_changes, connection.reconcile_required),
    last_scan_at: connection.last_scan_at,
    next_scan_at: connection.next_scan_at,
    known_files: metrics.known_files,
    pending_changes: metrics.pending_changes,
  };
}

function health(state: string, failures: number, reconcileRequired: boolean) {
  const level =
    state === "degraded"
      ? "degraded"
      : state === "error" || failures > 0
        ? "error"
        : reconcileRequired
          ? "stale"
          : "healthy";
  return {
    level,
    reasons: level === "healthy" ? [] : [state === "active" ? "reconciliation_required" : state],
  };
}

import type { Database } from "bun:sqlite";
import { automationInputHash } from "../../domains/automation/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { type PlannedMutationChange, plannedChange } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export function one(database: Database, sql: string, id: string, code: string): Row {
  const row = database.query<Row, [string]>(sql).get(id);
  if (!row) throw failure(code, "Resource does not exist", "not_found");
  return row;
}

export function stateChange(
  kind: string,
  id: string,
  selector: Record<string, string>,
  row: Row,
  field: string,
  value: string,
  changeKind: string,
  extraAfter: Record<string, unknown> = {},
): PlannedMutationChange | null {
  if (
    row[field] === value &&
    Object.entries(extraAfter).every(([key, next]) =>
      next === "$now" ? typeof row[key] === "string" : row[key] === next,
    )
  ) {
    return null;
  }
  const before: Record<string, unknown> = { [field]: row[field] };
  const after: Record<string, unknown> = { [field]: value, ...extraAfter };
  for (const key of Object.keys(extraAfter)) before[key] = row[key] ?? null;
  if (typeof row.version === "number") {
    before.version = row.version;
    after.version = row.version + 1;
  }
  if (typeof row.revision === "number") {
    before.revision = row.revision;
    after.revision = row.revision + 1;
  }
  if (typeof row.config_version === "number") {
    before.config_version = row.config_version;
    after.config_version = row.config_version + 1;
  }
  return plannedChange(kind, id, selector, before, after, changeKind);
}

export function append(changeList: PlannedMutationChange[], change: PlannedMutationChange | null) {
  if (change) changeList.push(change);
}

export function impactDigest(changes: PlannedMutationChange[]): string {
  return automationInputHash(
    changes.map((change) => ({
      resource_id: change.resource_id,
      resource_kind: change.resource_kind,
      selector: change.selector,
      before: change.before,
      after: change.after,
    })),
  );
}

export function uniqueIds(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))].sort();
}

export function topicAndArtifactChanges(
  database: Database,
  topicIds: string[],
  reason: string,
  review: boolean,
) {
  const changes: PlannedMutationChange[] = [];
  const artifactIds: string[] = [];
  for (const topicId of uniqueIds(topicIds)) {
    const topic = database
      .query<Row, [string]>(
        "SELECT topic_id, status, version, stale_at, stale_reason FROM topics WHERE topic_id = ?",
      )
      .get(topicId);
    if (!topic || topic.status === "deleted") continue;
    const desired = review ? "needs_review" : "stale";
    append(
      changes,
      stateChange(
        "topic",
        topicId,
        { topic_id: topicId },
        topic,
        "status",
        desired,
        "invalidated",
        { stale_at: "$now", stale_reason: reason },
      ),
    );
    const artifacts = database
      .query<Row, [string]>(
        `SELECT artifact_id, status, version, stale_reason FROM artifacts
         WHERE topic_id = ? AND status <> 'deleted'`,
      )
      .all(topicId);
    for (const artifact of artifacts) {
      const artifactId = String(artifact.artifact_id);
      artifactIds.push(artifactId);
      append(
        changes,
        stateChange(
          "artifact",
          artifactId,
          { artifact_id: artifactId },
          artifact,
          "status",
          "stale",
          "invalidated",
          { stale_reason: reason },
        ),
      );
    }
  }
  return { changes, artifactIds: uniqueIds(artifactIds) };
}

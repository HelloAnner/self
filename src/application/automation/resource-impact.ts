import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import {
  append,
  impactDigest,
  stateChange,
  topicAndArtifactChanges,
  uniqueIds,
} from "./impact-helpers.ts";
import type { MutationDescription, PlannedMutationChange } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export function describeConnectionDetach(
  database: Database,
  connectionId: string,
): MutationDescription {
  const row = database
    .query<Row, [string]>(
      "SELECT connection_id, source_id, state, revision FROM data_connections WHERE connection_id = ?",
    )
    .get(connectionId);
  if (!row) throw failure("connection_not_found", "Connection does not exist", "not_found");
  if (row.state === "detached")
    throw failure("connection_state_invalid", "Connection is already detached", "state");
  if (row.state === "deleted")
    throw failure("connection_state_invalid", "Deleted Connection cannot detach", "state");
  const change = stateChange(
    "connection",
    connectionId,
    { connection_id: connectionId },
    row,
    "state",
    "detached",
    "detached",
  );
  const changes = change ? [change] : [];
  return description(row, connectionId, "connection", changes, {
    source_id: row.source_id,
    monitoring_stopped: true,
    source_retained: true,
  });
}

export function describeEntityDelete(database: Database, entityId: string): MutationDescription {
  const entity = database
    .query<Row, [string]>(
      "SELECT entity_id, node_id, status, version FROM graph_entities WHERE entity_id = ?",
    )
    .get(entityId);
  if (!entity) throw failure("entity_not_found", "Entity does not exist", "not_found");
  if (["deleted", "redirected"].includes(String(entity.status)))
    throw failure("entity_state_invalid", "Entity cannot be deleted in its current state", "state");
  const nodeId = String(entity.node_id);
  const changes: PlannedMutationChange[] = [];
  append(
    changes,
    stateChange(
      "entity",
      entityId,
      { entity_id: entityId },
      entity,
      "status",
      "deleted",
      "deleted",
    ),
  );
  const node = database
    .query<Row, [string]>("SELECT node_id, status, version FROM graph_nodes WHERE node_id = ?")
    .get(nodeId);
  if (node)
    append(
      changes,
      stateChange("graph_node", nodeId, { node_id: nodeId }, node, "status", "deleted", "deleted", {
        deleted_at: "$now",
      }),
    );
  const relations = database
    .query<Row, [string, string]>(
      `SELECT relation_id, status, version FROM graph_relations
       WHERE subject_node_id = ? OR object_node_id = ?`,
    )
    .all(nodeId, nodeId);
  for (const relation of relations) {
    if (["deleted", "rejected", "deprecated"].includes(String(relation.status))) continue;
    const id = String(relation.relation_id);
    append(
      changes,
      stateChange("relation", id, { relation_id: id }, relation, "status", "stale", "invalidated"),
    );
  }
  const claims = database
    .query<Row, [string, string]>(
      `SELECT claim_id, status, version FROM graph_claims
       WHERE subject_node_id = ? OR object_node_id = ?`,
    )
    .all(nodeId, nodeId);
  for (const claim of claims) {
    if (["deleted", "rejected", "superseded"].includes(String(claim.status))) continue;
    const id = String(claim.claim_id);
    append(
      changes,
      stateChange("claim", id, { claim_id: id }, claim, "status", "stale", "invalidated"),
    );
  }
  const claimIds = uniqueIds(claims.map((row) => row.claim_id));
  const topicIds = topicsForClaims(database, claimIds);
  const downstream = topicAndArtifactChanges(
    database,
    topicIds,
    `entity_deleted:${entityId}`,
    true,
  );
  changes.push(...downstream.changes);
  return description(entity, entityId, "entity", changes, {
    node_id: nodeId,
    relations: relations.map((row) => row.relation_id),
    claims: claimIds,
    topics: topicIds,
    artifacts: downstream.artifactIds,
  });
}

export function describeClaimDelete(database: Database, claimId: string): MutationDescription {
  const claim = database
    .query<Row, [string]>(
      "SELECT claim_id, node_id, status, version FROM graph_claims WHERE claim_id = ?",
    )
    .get(claimId);
  if (!claim) throw failure("claim_not_found", "Claim does not exist", "not_found");
  if (claim.status === "deleted")
    throw failure("claim_state_invalid", "Claim is already deleted", "state");
  const nodeId = String(claim.node_id);
  const changes: PlannedMutationChange[] = [];
  append(
    changes,
    stateChange("claim", claimId, { claim_id: claimId }, claim, "status", "deleted", "deleted", {
      deleted_at: "$now",
    }),
  );
  const node = database
    .query<Row, [string]>("SELECT node_id, status, version FROM graph_nodes WHERE node_id = ?")
    .get(nodeId);
  if (node)
    append(
      changes,
      stateChange("graph_node", nodeId, { node_id: nodeId }, node, "status", "deleted", "deleted", {
        deleted_at: "$now",
      }),
    );
  const topicIds = topicsForClaims(database, [claimId]);
  const downstream = topicAndArtifactChanges(database, topicIds, `claim_deleted:${claimId}`, true);
  changes.push(...downstream.changes);
  return description(claim, claimId, "claim", changes, {
    node_id: nodeId,
    topics: topicIds,
    artifacts: downstream.artifactIds,
  });
}

export function describeRelationDelete(
  database: Database,
  relationId: string,
): MutationDescription {
  const relation = database
    .query<Row, [string]>(
      "SELECT relation_id, status, version FROM graph_relations WHERE relation_id = ?",
    )
    .get(relationId);
  if (!relation) throw failure("relation_not_found", "Relation does not exist", "not_found");
  if (relation.status === "deleted")
    throw failure("relation_state_invalid", "Relation is already deleted", "state");
  const changes: PlannedMutationChange[] = [];
  append(
    changes,
    stateChange(
      "relation",
      relationId,
      { relation_id: relationId },
      relation,
      "status",
      "deleted",
      "deleted",
      { deleted_at: "$now" },
    ),
  );
  const topicIds = database
    .query<{ topic_id: string }, [string]>(
      `SELECT DISTINCT t.topic_id FROM topics t JOIN topic_snapshot_relations r
       ON r.topic_snapshot_id = t.latest_snapshot_id WHERE r.relation_id = ?`,
    )
    .all(relationId)
    .map((row) => row.topic_id);
  const downstream = topicAndArtifactChanges(
    database,
    topicIds,
    `relation_deleted:${relationId}`,
    false,
  );
  changes.push(...downstream.changes);
  return description(relation, relationId, "relation", changes, {
    topics: topicIds,
    artifacts: downstream.artifactIds,
  });
}

export function describeTopicDelete(database: Database, topicId: string): MutationDescription {
  const topic = database
    .query<Row, [string]>("SELECT topic_id, status, version FROM topics WHERE topic_id = ?")
    .get(topicId);
  if (!topic) throw failure("topic_not_found", "Topic does not exist", "not_found");
  if (topic.status === "deleted")
    throw failure("topic_deleted", "Topic is already deleted", "state");
  const changes: PlannedMutationChange[] = [];
  append(
    changes,
    stateChange("topic", topicId, { topic_id: topicId }, topic, "status", "deleted", "deleted", {
      deleted_at: "$now",
    }),
  );
  const artifacts = database
    .query<Row, [string]>("SELECT artifact_id, status, version FROM artifacts WHERE topic_id = ?")
    .all(topicId);
  for (const artifact of artifacts) {
    if (artifact.status === "deleted") continue;
    const id = String(artifact.artifact_id);
    append(
      changes,
      stateChange("artifact", id, { artifact_id: id }, artifact, "status", "deleted", "deleted", {
        deleted_at: "$now",
      }),
    );
  }
  return description(topic, topicId, "topic", changes, {
    artifacts: artifacts.map((row) => row.artifact_id),
  });
}

export function describeArtifactDelete(
  database: Database,
  artifactId: string,
): MutationDescription {
  const artifact = database
    .query<Row, [string]>(
      "SELECT artifact_id, topic_id, status, version FROM artifacts WHERE artifact_id = ?",
    )
    .get(artifactId);
  if (!artifact) throw failure("artifact_not_found", "Artifact does not exist", "not_found");
  if (artifact.status === "deleted")
    throw failure("artifact_state_invalid", "Artifact is already deleted", "state");
  const change = stateChange(
    "artifact",
    artifactId,
    { artifact_id: artifactId },
    artifact,
    "status",
    "deleted",
    "deleted",
    { deleted_at: "$now" },
  );
  return description(artifact, artifactId, "artifact", change ? [change] : [], {
    topic_id: artifact.topic_id,
    builds_retained: true,
  });
}

function description(
  primary: Row,
  resourceId: string,
  resourceKind: string,
  changes: PlannedMutationChange[],
  impact: Record<string, unknown>,
): MutationDescription {
  const version =
    typeof primary.version === "number"
      ? primary.version
      : typeof primary.revision === "number"
        ? primary.revision
        : null;
  const state = String(primary.status ?? primary.state ?? "unknown");
  const digest = impactDigest(changes);
  return {
    preconditions: { resource_version: version, resource_state: state, impact_hash: digest },
    impact: { ...impact, change_count: changes.length, impact_hash: digest },
    changes,
    inverse: { action: `${resourceKind}_restore`, resource_id: resourceId },
    reversible: true,
    targets: [
      {
        resourceId,
        resourceKind,
        role: "primary",
        expectedVersion: version,
        expectedState: state,
      },
      ...changes
        .filter((change) => change.resource_id !== resourceId)
        .map((change) => ({
          resourceId: change.resource_id,
          resourceKind: change.resource_kind,
          role: "affected" as const,
        })),
    ],
  };
}

function topicsForClaims(database: Database, claimIds: string[]): string[] {
  return uniqueIds(
    claimIds.flatMap((claimId) =>
      database
        .query<{ topic_id: string }, [string]>(
          `SELECT DISTINCT t.topic_id FROM topics t JOIN topic_snapshot_claims c
           ON c.topic_snapshot_id = t.latest_snapshot_id WHERE c.claim_id = ?`,
        )
        .all(claimId)
        .map((row) => row.topic_id),
    ),
  );
}

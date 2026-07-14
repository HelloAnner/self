import { automationInputHash } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  completeAutomationOperation,
  findIdempotency,
} from "../../infrastructure/automation/automation-repository.ts";
import { recalculateClaimConfidence } from "../../infrastructure/graph/graph-claim-alignment.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import {
  append,
  stateChange,
  topicAndArtifactChanges,
  uniqueIds,
} from "../automation/impact-helpers.ts";
import { applyMutationChanges, verifyMutationChanges } from "../automation/mutation-store.ts";
import type { PlannedMutationChange } from "../automation/mutation-types.ts";

type Row = Record<string, unknown>;

export async function moderateGraphObject(
  root: string,
  input: {
    kind: "entity" | "relation" | "claim";
    id: string;
    action: "confirm" | "reject";
    reason?: string;
    requestId: string;
    ifVersion?: number;
    idempotencyKey?: string;
  },
) {
  validateIdempotencyKey(input.idempotencyKey);
  const commandKind = `${input.kind}.${input.action}`;
  const inputHash = automationInputHash({
    kind: input.kind,
    id: input.id,
    action: input.action,
    reason: input.reason ?? null,
    if_version: input.ifVersion ?? null,
  });
  const database = await writableAutomationDatabase(root);
  try {
    const prior = findIdempotency(database, input.idempotencyKey, commandKind, inputHash);
    if (prior?.result_json && typeof prior.result_json === "object") {
      return { ...(prior.result_json as Row), reused: true };
    }
    const table =
      input.kind === "entity"
        ? "graph_entities"
        : input.kind === "relation"
          ? "graph_relations"
          : "graph_claims";
    const key = `${input.kind}_id`;
    const selected =
      input.kind === "entity" ? "status, version, user_confirmed" : "status, version";
    const row = database
      .query<Row, [string]>(`SELECT ${selected} FROM ${table} WHERE ${key} = ?`)
      .get(input.id);
    if (!row) throw failure(`${input.kind}_not_found`, `${input.kind} does not exist`, "not_found");
    if (input.ifVersion !== undefined && row.version !== input.ifVersion) {
      throw failure(
        `${input.kind}_version_conflict`,
        "Version precondition did not match",
        "conflict",
        {
          details: { expected: input.ifVersion, actual: row.version },
        },
      );
    }
    const status =
      input.action === "reject"
        ? "rejected"
        : input.kind === "entity"
          ? "active"
          : input.kind === "relation"
            ? "accepted"
            : "user_confirmed";
    const changes: PlannedMutationChange[] = [];
    append(
      changes,
      stateChange(
        input.kind,
        input.id,
        { [key]: input.id },
        row,
        "status",
        status,
        "moderated",
        input.kind === "entity" ? { user_confirmed: input.action === "confirm" ? 1 : 0 } : {},
      ),
    );
    const topicIds = affectedTopicIds(database, input.kind, input.id);
    const downstream = topicAndArtifactChanges(
      database,
      topicIds,
      `${input.kind}_moderated:${input.id}`,
      input.kind === "claim",
    );
    changes.push(...downstream.changes);
    const answers = database
      .query<Row, []>(
        "SELECT answer_id, cache_state, stale_at, stale_reason FROM answer_runs WHERE cache_state = 'active'",
      )
      .all();
    for (const answer of answers) {
      const answerId = String(answer.answer_id);
      append(
        changes,
        stateChange(
          "answer",
          answerId,
          { answer_id: answerId },
          answer,
          "cache_state",
          "stale",
          "invalidated",
          { stale_at: "$now", stale_reason: `${input.kind}_moderated:${input.id}` },
        ),
      );
    }
    verifyMutationChanges(database, changes);
    const now = new Date().toISOString();
    const operationId = createResourceId("operation");
    return database.transaction(() => {
      const applied = applyMutationChanges(database, changes, now);
      if (input.kind === "claim") recalculateClaimConfidence(database, input.id);
      const result = {
        operation_id: operationId,
        [`${input.kind}_id`]: input.id,
        status,
        version: Number(row.version) + 1,
        reason: input.reason ?? null,
        affected_topics: topicIds,
        affected_artifacts: downstream.artifactIds,
        invalidated_answers: answers.length,
      };
      completeAutomationOperation(database, {
        plan: null,
        operationId,
        requestId: input.requestId,
        kind: commandKind,
        targetId: input.id,
        inputHash,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        result,
        changes: applied,
        reversible: false,
        atomicity: "atomic",
        createdAt: now,
        completedAt: now,
      });
      return result;
    })();
  } finally {
    database.close();
  }
}

function affectedTopicIds(
  database: Awaited<ReturnType<typeof writableAutomationDatabase>>,
  kind: "entity" | "relation" | "claim",
  id: string,
): string[] {
  if (kind === "claim") return topicsForClaims(database, [id]);
  if (kind === "relation") {
    return database
      .query<{ topic_id: string }, [string]>(
        `SELECT DISTINCT t.topic_id FROM topics t JOIN topic_snapshot_relations r
         ON r.topic_snapshot_id = t.latest_snapshot_id WHERE r.relation_id = ?`,
      )
      .all(id)
      .map((row) => row.topic_id);
  }
  const node = database
    .query<{ node_id: string }, [string]>("SELECT node_id FROM graph_entities WHERE entity_id = ?")
    .get(id);
  if (!node) return [];
  const claimIds = database
    .query<{ claim_id: string }, [string, string]>(
      `SELECT claim_id FROM graph_claims WHERE subject_node_id = ? OR object_node_id = ?`,
    )
    .all(node.node_id, node.node_id)
    .map((row) => row.claim_id);
  return topicsForClaims(database, claimIds);
}

function topicsForClaims(
  database: Awaited<ReturnType<typeof writableAutomationDatabase>>,
  claimIds: string[],
): string[] {
  const ids: string[] = [];
  const query = database.query<{ topic_id: string }, [string]>(
    `SELECT DISTINCT t.topic_id FROM topics t JOIN topic_snapshot_claims c
     ON c.topic_snapshot_id = t.latest_snapshot_id WHERE c.claim_id = ?`,
  );
  for (const claimId of claimIds) ids.push(...query.all(claimId).map((row) => row.topic_id));
  return uniqueIds(ids);
}

function validateIdempotencyKey(value?: string) {
  if (value !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw failure("idempotency_key_invalid", "Idempotency key is invalid", "usage");
  }
}

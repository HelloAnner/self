import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";

export type TopicRow = {
  topic_id: string;
  name: string;
  normalized_name: string;
  description: string | null;
  scope_text: string;
  exclude_text: string;
  status: "active" | "stale" | "needs_review" | "deleted";
  version: number;
  latest_snapshot_id: string | null;
  stale_reason: string | null;
  stale_at: string | null;
  created_at: string;
  updated_at: string;
};

export function createTopic(
  database: Database,
  input: {
    name: string;
    scope?: string;
    exclude?: string;
    description?: string;
    aliases?: string[];
  },
) {
  const name = requiredText(input.name, "topic_name_invalid", "Topic name");
  const scope = clean(input.scope ?? name);
  if (!scope) throw failure("topic_scope_invalid", "Topic scope must not be empty", "usage");
  const normalized = normalize(name);
  const exists = database
    .query<{ topic_id: string }, [string]>(
      "SELECT topic_id FROM topics WHERE normalized_name = ? AND status <> 'deleted'",
    )
    .get(normalized);
  if (exists)
    throw failure("topic_name_conflict", "An active Topic already uses this name", "conflict");
  const topicId = createResourceId("topic");
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO topics(topic_id, name, normalized_name, description, scope_text,
         exclude_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        topicId,
        name,
        normalized,
        clean(input.description ?? "") || null,
        scope,
        clean(input.exclude ?? ""),
        now,
        now,
      );
    for (const alias of uniqueAliases(input.aliases ?? [], normalized))
      insertAlias(database, topicId, alias, now);
  })();
  return topicView(database, topicId);
}

export function updateTopic(
  database: Database,
  topicId: string,
  input: { scope?: string; exclude?: string; addAlias?: string; ifVersion?: number },
) {
  const topic = requireTopic(database, topicId);
  if (topic.status === "deleted")
    throw failure("topic_deleted", "Deleted Topic cannot be updated", "state");
  if (input.ifVersion !== undefined && input.ifVersion !== topic.version)
    throw failure("topic_version_conflict", "Topic version changed", "conflict", {
      details: { expected: input.ifVersion, actual: topic.version },
    });
  if (input.scope === undefined && input.exclude === undefined && input.addAlias === undefined)
    throw failure("topic_update_empty", "Topic update has no changes", "usage");
  const now = new Date().toISOString();
  database.transaction(() => {
    if (input.addAlias !== undefined) {
      const alias = requiredText(input.addAlias, "topic_alias_invalid", "Topic alias");
      if (normalize(alias) !== topic.normalized_name) insertAlias(database, topicId, alias, now);
    }
    const scope = input.scope === undefined ? topic.scope_text : clean(input.scope);
    if (!scope) throw failure("topic_scope_invalid", "Topic scope must not be empty", "usage");
    const exclude = input.exclude === undefined ? topic.exclude_text : clean(input.exclude);
    database
      .prepare(
        `UPDATE topics SET scope_text = ?, exclude_text = ?, status = CASE
         WHEN latest_snapshot_id IS NULL THEN 'active' ELSE 'stale' END,
         stale_reason = CASE WHEN latest_snapshot_id IS NULL THEN NULL ELSE 'topic_scope_changed' END,
         stale_at = CASE WHEN latest_snapshot_id IS NULL THEN NULL ELSE ? END,
         version = version + 1, updated_at = ? WHERE topic_id = ?`,
      )
      .run(scope, exclude, now, now, topicId);
  })();
  return topicView(database, topicId);
}

export function requireTopic(database: Database, topicId: string): TopicRow {
  const row = database
    .query<TopicRow, [string]>("SELECT * FROM topics WHERE topic_id = ?")
    .get(topicId);
  if (!row) throw failure("topic_not_found", "Topic does not exist", "not_found");
  return row;
}

export function topicView(database: Database, topicId: string) {
  const topic = requireTopic(database, topicId);
  const aliases = database
    .query<{ alias: string }, [string]>(
      "SELECT alias FROM topic_aliases WHERE topic_id = ? ORDER BY normalized_alias",
    )
    .all(topicId)
    .map((row) => row.alias);
  const latest = topic.latest_snapshot_id
    ? database
        .query<Record<string, unknown>, [string]>(
          `SELECT topic_snapshot_id, sequence, health_status, confidence_level, coverage_json,
           change_summary_json, created_at FROM topic_snapshots WHERE topic_snapshot_id = ?`,
        )
        .get(topic.latest_snapshot_id)
    : null;
  return { ...topic, aliases, latest_snapshot: latest ? parseJson(latest) : null };
}

export function listTopics(database: Database, status?: string, limit = 100) {
  const rows = status
    ? database
        .query<TopicRow, [string, number]>(
          "SELECT * FROM topics WHERE status = ? ORDER BY updated_at DESC, topic_id LIMIT ?",
        )
        .all(status, limit)
    : database
        .query<TopicRow, [number]>(
          "SELECT * FROM topics WHERE status <> 'deleted' ORDER BY updated_at DESC, topic_id LIMIT ?",
        )
        .all(limit);
  return rows.map((row) => ({
    ...row,
    aliases: database
      .query<{ alias: string }, [string]>(
        "SELECT alias FROM topic_aliases WHERE topic_id = ? ORDER BY normalized_alias",
      )
      .all(row.topic_id)
      .map((item) => item.alias),
  }));
}

function insertAlias(database: Database, topicId: string, alias: string, now: string) {
  database
    .prepare(
      "INSERT OR IGNORE INTO topic_aliases(topic_id, alias, normalized_alias, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(topicId, alias, normalize(alias), now);
}

function uniqueAliases(values: string[], topicName: string) {
  return [
    ...new Map(
      values
        .map(clean)
        .filter((value) => value && normalize(value) !== topicName)
        .map((value) => [normalize(value), value]),
    ).values(),
  ];
}

function requiredText(value: string, code: string, label: string) {
  const result = clean(value);
  if (!result || result.includes("\0")) throw failure(code, `${label} is invalid`, "usage");
  return result;
}

function clean(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalize(value: string) {
  return clean(value).toLocaleLowerCase();
}

function parseJson(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}

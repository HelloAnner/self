import type { Database } from "bun:sqlite";
import { resolve, sep } from "node:path";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import { verifyMigrationHistory } from "../../infrastructure/db/migrations/runner.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { vectorTableName } from "../../infrastructure/knowledge/vector-index.ts";
import { acquireMaintenanceLock } from "../../infrastructure/operations/maintenance-lock.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";

type Issue = {
  severity: "warning" | "error";
  code: string;
  resource_id?: string;
  relative_path?: string;
  details?: Record<string, unknown>;
};

export async function verifyWorkspaceShallow(root: string) {
  return runVerification(root, null, "shallow", false);
}

export async function verifyWorkspaceDeep(root: string, jobId: string | null) {
  const lock = await acquireMaintenanceLock(root, "verify.deep");
  try {
    return await runVerification(root, jobId, "deep", true);
  } finally {
    await lock.release();
  }
}

async function runVerification(
  root: string,
  jobId: string | null,
  mode: "shallow" | "deep",
  deep: boolean,
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const verificationId = createResourceId("verification");
  let database = await writableAutomationDatabase(root);
  try {
    database
      .prepare(
        `INSERT INTO operation_verification_runs(verification_id, job_id, mode, state, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(verificationId, jobId, mode, startedAt);
  } finally {
    database.close();
  }
  const issues: Issue[] = [];
  const checked: Record<string, number | boolean> = {};
  database = await writableAutomationDatabase(root);
  try {
    checkDatabase(database, issues, checked);
    await checkMigrations(database, issues, checked);
    if (deep) {
      await checkBlobs(database, root, issues, checked);
      checkKnowledge(database, issues, checked);
      checkFts(database, issues, checked);
      checkVectors(database, issues, checked);
      checkEvidence(database, issues, checked);
      await checkArtifacts(database, root, issues, checked);
      await checkOperationalSecrets(root, issues, checked);
    }
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const state = errorCount === 0 ? "passed" : "failed";
    database.transaction(() => {
      const insert = database.prepare(
        `INSERT INTO operation_verification_issues(verification_id, ordinal, severity,
         code, resource_id, relative_path, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      issues.forEach((issue, index) => {
        insert.run(
          verificationId,
          index + 1,
          issue.severity,
          issue.code,
          issue.resource_id ?? null,
          issue.relative_path ?? null,
          JSON.stringify(issue.details ?? {}),
        );
      });
      database
        .prepare(
          `UPDATE operation_verification_runs SET state = ?, checked_json = ?,
           issue_count = ?, error_count = ?, completed_at = ? WHERE verification_id = ?`,
        )
        .run(
          state,
          JSON.stringify(checked),
          issues.length,
          errorCount,
          new Date().toISOString(),
          verificationId,
        );
    })();
    return {
      verification_id: verificationId,
      mode,
      status: state === "passed" ? "pass" : "fail",
      checked,
      issue_count: issues.length,
      error_count: errorCount,
      issues,
    };
  } catch (cause) {
    database
      .prepare(
        `UPDATE operation_verification_runs SET state = 'failed', issue_count = 1,
         error_count = 1, completed_at = ? WHERE verification_id = ?`,
      )
      .run(new Date().toISOString(), verificationId);
    throw cause;
  } finally {
    database.close();
  }
}

function checkDatabase(
  database: Database,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  checked.integrity_rows = integrity.length;
  if (integrity.some((row) => row.integrity_check !== "ok"))
    issue(issues, "database_integrity_failed", { rows: integrity.length });
  const foreignKeys = database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
  checked.foreign_key_issues = foreignKeys.length;
  if (foreignKeys.length > 0)
    issue(issues, "database_foreign_key_broken", { count: foreignKeys.length });
  const schema = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  checked.schema_version = schema ?? 0;
  if (schema !== VERSION.databaseSchema)
    issue(issues, "database_schema_mismatch", { expected: VERSION.databaseSchema, actual: schema });
}

async function checkMigrations(
  database: Database,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const migrationIssues = await verifyMigrationHistory(database);
  checked.migration_issues = migrationIssues.length;
  for (const current of migrationIssues) issue(issues, current.code, current);
}

async function checkBlobs(
  database: Database,
  root: string,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const blobs = database
    .query<{ sha256: string; relative_path: string; size_bytes: number }, []>(
      "SELECT sha256, relative_path, size_bytes FROM source_blobs ORDER BY sha256",
    )
    .all();
  checked.blobs = blobs.length;
  for (const blob of blobs) {
    const absolute = safePath(root, blob.relative_path);
    try {
      const hash = await sha256File(absolute);
      if (hash !== blob.sha256)
        issue(
          issues,
          "blob_hash_mismatch",
          { expected: blob.sha256, actual: hash },
          blob.sha256,
          blob.relative_path,
        );
      if ((await Bun.file(absolute).size) !== blob.size_bytes)
        issue(
          issues,
          "blob_size_mismatch",
          { expected: blob.size_bytes },
          blob.sha256,
          blob.relative_path,
        );
    } catch {
      issue(issues, "blob_missing", {}, blob.sha256, blob.relative_path);
    }
  }
}

function checkKnowledge(
  database: Database,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const missingCurrent = count(
    database,
    `SELECT COUNT(*) count FROM knowledge_documents d LEFT JOIN knowledge_revisions r
     ON r.revision_id = d.current_revision_id WHERE d.state = 'active' AND r.revision_id IS NULL`,
  );
  checked.documents_missing_current_revision = missingCurrent;
  if (missingCurrent) issue(issues, "revision_chain_broken", { count: missingCurrent });
  const crossDocument = count(
    database,
    `SELECT COUNT(*) count FROM knowledge_revisions r JOIN knowledge_revisions p
     ON p.revision_id = r.previous_revision_id WHERE p.document_id <> r.document_id`,
  );
  checked.cross_document_revision_links = crossDocument;
  if (crossDocument) issue(issues, "revision_chain_cross_document", { count: crossDocument });
  const missingRevisionChunks = count(
    database,
    `SELECT COUNT(*) count FROM knowledge_chunks c LEFT JOIN knowledge_revision_chunks rc
     ON rc.chunk_id = c.chunk_id AND rc.revision_id = c.last_seen_revision_id
     WHERE c.state = 'active' AND rc.chunk_id IS NULL`,
  );
  checked.chunks_missing_revision_link = missingRevisionChunks;
  if (missingRevisionChunks)
    issue(issues, "chunk_revision_chain_broken", { count: missingRevisionChunks });
}

function checkFts(database: Database, issues: Issue[], checked: Record<string, number | boolean>) {
  const active = database
    .query<{ active_generation_id: string | null }, []>(
      "SELECT active_generation_id FROM knowledge_active_indexes WHERE index_kind = 'fts'",
    )
    .get()?.active_generation_id;
  if (!active) {
    checked.fts_active = false;
    return;
  }
  checked.fts_active = true;
  const missing = count(
    database,
    `SELECT COUNT(*) count FROM knowledge_chunks c WHERE c.state = 'active' AND NOT EXISTS
     (SELECT 1 FROM knowledge_fts f WHERE f.index_generation_id = ? AND f.chunk_id = c.chunk_id)`,
    active,
  );
  const orphan = count(
    database,
    `SELECT COUNT(*) count FROM knowledge_fts f WHERE f.index_generation_id = ? AND NOT EXISTS
     (SELECT 1 FROM knowledge_chunks c WHERE c.chunk_id = f.chunk_id AND c.state = 'active')`,
    active,
  );
  checked.fts_missing_chunks = missing;
  checked.fts_orphans = orphan;
  if (missing) issue(issues, "fts_chunk_missing", { count: missing, generation_id: active });
  if (orphan) issue(issues, "fts_orphan_row", { count: orphan, generation_id: active });
}

function checkVectors(
  database: Database,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const spaces = database
    .query<{ vector_space_id: string; dimensions: number }, []>(
      "SELECT vector_space_id, dimensions FROM vector_spaces WHERE state IN ('ready','verifying')",
    )
    .all();
  let missing = 0;
  let orphan = 0;
  for (const space of spaces) {
    const table = vectorTableName(space.dimensions);
    const exists = count(
      database,
      "SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = ?",
      table,
    );
    if (!exists) {
      const embeddings = count(
        database,
        "SELECT COUNT(*) count FROM knowledge_embeddings WHERE vector_space_id = ? AND state = 'active'",
        space.vector_space_id,
      );
      missing += embeddings;
      continue;
    }
    missing += count(
      database,
      `SELECT COUNT(*) count FROM knowledge_embeddings e WHERE e.vector_space_id = ?
       AND e.state = 'active' AND NOT EXISTS (SELECT 1 FROM ${table} v WHERE v.embedding_id = e.embedding_id)`,
      space.vector_space_id,
    );
    orphan += count(
      database,
      `SELECT COUNT(*) count FROM ${table} v WHERE v.vector_space_id = ? AND NOT EXISTS
       (SELECT 1 FROM knowledge_embeddings e WHERE e.embedding_id = v.embedding_id
        AND e.vector_space_id = ? AND e.state = 'active')`,
      space.vector_space_id,
      space.vector_space_id,
    );
  }
  checked.vector_spaces = spaces.length;
  checked.vector_rows_missing = missing;
  checked.vector_rows_orphaned = orphan;
  if (missing) issue(issues, "vector_row_missing", { count: missing });
  if (orphan) issue(issues, "vector_row_orphaned", { count: orphan });
}

function checkEvidence(
  database: Database,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const unsupportedAnswers = count(
    database,
    `SELECT COUNT(*) count FROM answer_statements s WHERE s.support_status = 'supported'
     AND NOT EXISTS (SELECT 1 FROM answer_citations c WHERE c.statement_id = s.statement_id)`,
  );
  const unsupportedTopics = count(
    database,
    `SELECT COUNT(*) count FROM topic_report_conclusions c WHERE c.support_status = 'supported'
     AND NOT EXISTS (SELECT 1 FROM topic_report_citations tc WHERE tc.conclusion_id = c.conclusion_id)`,
  );
  const graphWithoutEvidence = count(
    database,
    `SELECT COUNT(*) count FROM graph_claims c WHERE c.status IN ('accepted','user_confirmed','disputed')
     AND NOT EXISTS (SELECT 1 FROM graph_claim_evidence e WHERE e.claim_id = c.claim_id AND e.state = 'active')`,
  );
  checked.unsupported_answer_statements = unsupportedAnswers;
  checked.unsupported_topic_conclusions = unsupportedTopics;
  checked.active_claims_without_evidence = graphWithoutEvidence;
  if (unsupportedAnswers)
    issue(issues, "answer_citation_chain_broken", { count: unsupportedAnswers });
  if (unsupportedTopics) issue(issues, "topic_citation_chain_broken", { count: unsupportedTopics });
  if (graphWithoutEvidence)
    issues.push({
      severity: "warning",
      code: "claim_evidence_missing",
      details: { count: graphWithoutEvidence },
    });
}

async function checkArtifacts(
  database: Database,
  root: string,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const files = database
    .query<
      { build_id: string; relative_directory: string; relative_path: string; content_hash: string },
      []
    >(
      `SELECT b.build_id, b.relative_directory, f.relative_path, f.content_hash
       FROM artifact_builds b JOIN artifact_build_files f ON f.build_id = b.build_id
       WHERE b.state = 'ready' ORDER BY b.build_id, f.relative_path`,
    )
    .all();
  checked.artifact_files = files.length;
  for (const file of files) {
    const relativePath = `${file.relative_directory}/${file.relative_path}`;
    try {
      const hash = await sha256File(safePath(root, relativePath));
      if (hash !== file.content_hash)
        issue(
          issues,
          "artifact_hash_mismatch",
          { expected: file.content_hash, actual: hash },
          file.build_id,
          relativePath,
        );
    } catch {
      issue(issues, "artifact_file_missing", {}, file.build_id, relativePath);
    }
  }
}

async function checkOperationalSecrets(
  root: string,
  issues: Issue[],
  checked: Record<string, number | boolean>,
) {
  const config = await Bun.file(resolve(root, "self.toml")).text();
  const leaks = /(?:api[_-]?key\s*=\s*["']?(?!\$\{|env:)[^\s"']+|sk-[A-Za-z0-9_-]{8,})/iu.test(
    config,
  );
  checked.config_secret_leaks = leaks ? 1 : 0;
  if (leaks) issue(issues, "credential_material_in_config", {});
}

function count(database: Database, sql: string, ...values: Array<string | number>): number {
  const row = database.query<{ count: number }, Array<string | number>>(sql).get(...values);
  return row?.count ?? 0;
}

function issue(
  issues: Issue[],
  code: string,
  details: Record<string, unknown>,
  resourceId?: string,
  relativePath?: string,
) {
  issues.push({
    severity: "error",
    code,
    ...(resourceId ? { resource_id: resourceId } : {}),
    ...(relativePath ? { relative_path: relativePath } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  });
}

function safePath(root: string, path: string): string {
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`))
    throw new Error("path escaped root");
  return absolute;
}

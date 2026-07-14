import type { Database } from "bun:sqlite";
import { dirname, extname, normalize, posix } from "node:path";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { ensureNode, ensureRelation } from "./graph-generation-repository.ts";

type CurrentDocument = {
  document_id: string;
  source_id: string;
  logical_path: string;
  revision_id: string;
  title: string | null;
  content_text: string;
  metadata_json: string;
};

export function projectKnowledgeStructure(
  database: Database,
  generationId: string,
  sourceId?: string,
): { sources: number; documents: number; revisions: number; chunks: number; relations: number } {
  const documents = currentDocuments(database, sourceId);
  const sourceNodes = new Map<string, string>();
  let chunks = 0;
  let relations = 0;
  for (const document of documents) {
    let sourceNode = sourceNodes.get(document.source_id);
    if (!sourceNode) {
      const source = database
        .query<{ name: string }, [string]>("SELECT name FROM sources WHERE source_id = ?")
        .get(document.source_id);
      sourceNode = ensureNode(database, generationId, {
        kind: "source",
        externalRef: document.source_id,
        sourceId: document.source_id,
        label: source?.name ?? document.source_id,
        sourceKind: "structural",
      });
      sourceNodes.set(document.source_id, sourceNode);
    }
    const documentNode = ensureNode(database, generationId, {
      kind: "document",
      externalRef: document.document_id,
      sourceId: document.source_id,
      label: document.title ?? document.logical_path,
      sourceKind: "structural",
      properties: { logical_path: document.logical_path },
    });
    const revisionNode = ensureNode(database, generationId, {
      kind: "revision",
      externalRef: document.revision_id,
      sourceId: document.source_id,
      label: `${document.title ?? document.logical_path} revision`,
      sourceKind: "structural",
    });
    ensureRelation(database, generationId, {
      subjectNodeId: sourceNode,
      predicate: "contains",
      objectNodeId: documentNode,
      origin: "structural",
      status: "accepted",
    });
    ensureRelation(database, generationId, {
      subjectNodeId: documentNode,
      predicate: "contains",
      objectNodeId: revisionNode,
      origin: "structural",
      status: "accepted",
    });
    ensureRelation(database, generationId, {
      subjectNodeId: revisionNode,
      predicate: "revision_of",
      objectNodeId: documentNode,
      origin: "structural",
      status: "accepted",
    });
    relations += 3;
    const rows = database
      .query<{ chunk_id: string; ordinal: number }, [string]>(
        `SELECT c.chunk_id, rc.ordinal FROM knowledge_revision_chunks rc JOIN knowledge_chunks c ON c.chunk_id = rc.chunk_id
       WHERE rc.revision_id = ? AND c.state = 'active' ORDER BY rc.ordinal`,
      )
      .all(document.revision_id);
    for (const row of rows) {
      const chunkNode = ensureNode(database, generationId, {
        kind: "chunk",
        externalRef: row.chunk_id,
        sourceId: document.source_id,
        label: `${document.title ?? document.logical_path} #${row.ordinal + 1}`,
        sourceKind: "structural",
        properties: { ordinal: row.ordinal },
      });
      ensureRelation(database, generationId, {
        subjectNodeId: revisionNode,
        predicate: "contains",
        objectNodeId: chunkNode,
        origin: "structural",
        status: "accepted",
      });
      relations += 1;
      chunks += 1;
    }
  }
  return {
    sources: sourceNodes.size,
    documents: documents.length,
    revisions: documents.length,
    chunks,
    relations,
  };
}

export function projectExplicitLinks(
  database: Database,
  generationId: string,
  sourceId?: string,
): { resolved: number; missing: number; ambiguous: number } {
  const documents = currentDocuments(database, sourceId);
  let resolved = 0;
  let missing = 0;
  let ambiguous = 0;
  for (const document of documents) {
    const sourceNode = nodeForExternal(database, "document", document.document_id);
    if (!sourceNode) continue;
    for (const reference of parseReferences(document.content_text)) {
      const targets = resolveTarget(database, document, reference.target, reference.kind);
      const chunk = chunkAtLine(database, document.revision_id, reference.line);
      const locator = { line: reference.line, raw: reference.raw };
      if (targets.length === 1) {
        const target = targets[0];
        if (!target) continue;
        const targetNode = ensureNode(database, generationId, {
          kind: "document",
          externalRef: target.document_id,
          sourceId: target.source_id,
          label: target.title ?? target.logical_path,
          sourceKind: "structural",
          properties: { logical_path: target.logical_path },
        });
        const predicate =
          reference.kind === "embed"
            ? "embeds"
            : reference.kind === "citation"
              ? "cites"
              : "links_to";
        const relationId = ensureRelation(database, generationId, {
          subjectNodeId: sourceNode,
          predicate,
          objectNodeId: targetNode,
          qualifiers: { raw_target: reference.target },
          origin: "explicit_link",
          status: "accepted",
          confidenceLevel: "high",
          confidence: { parser: "explicit-link-v1" },
        });
        addRelationEvidence(
          database,
          relationId,
          chunk,
          document.revision_id,
          locator,
          reference.raw,
        );
        resolved += 1;
      } else {
        const state = targets.length > 1 ? "ambiguous" : "missing";
        database
          .prepare(
            `INSERT INTO graph_unresolved_references(reference_id, generation_id, source_revision_id,
           source_chunk_id, reference_kind, raw_target, normalized_target, locator_json,
           resolution_state, candidate_ids_json, last_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createResourceId("reference"),
            generationId,
            document.revision_id,
            chunk?.chunk_id ?? null,
            reference.kind,
            reference.target,
            normalizeTarget(reference.target),
            JSON.stringify(locator),
            state,
            JSON.stringify(targets.map((target) => target.document_id)),
            new Date().toISOString(),
            new Date().toISOString(),
          );
        if (state === "ambiguous") ambiguous += 1;
        else missing += 1;
      }
    }
  }
  return { resolved, missing, ambiguous };
}

function currentDocuments(database: Database, sourceId?: string): CurrentDocument[] {
  return database
    .query<CurrentDocument, [string | null, string | null]>(
      `SELECT d.document_id, d.source_id, d.logical_path, r.revision_id, r.title, r.content_text, r.metadata_json
     FROM knowledge_documents d JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
     WHERE d.state = 'active' AND (? IS NULL OR d.source_id = ?) ORDER BY d.source_id, d.logical_path`,
    )
    .all(sourceId ?? null, sourceId ?? null);
}

type Reference = {
  kind: "markdown" | "wiki" | "embed" | "citation";
  target: string;
  raw: string;
  line: number;
};

function parseReferences(content: string): Reference[] {
  const values: Reference[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const wiki = /(!?)\[\[([^\]]+)\]\]/gu;
    for (const match of line.matchAll(wiki)) {
      const target = String(match[2] ?? "")
        .split("|")[0]
        ?.trim();
      if (target)
        values.push({
          kind: match[1] === "!" ? "embed" : "wiki",
          target,
          raw: match[0],
          line: index + 1,
        });
    }
    const markdown = /(?<!!)\[[^\]]*\]\(([^)]+)\)/gu;
    for (const match of line.matchAll(markdown)) {
      const target = String(match[1] ?? "").trim();
      if (target && !/^[a-z]+:\/\//iu.test(target))
        values.push({ kind: "markdown", target, raw: match[0], line: index + 1 });
    }
    const citation = /\[@([^\]]+)\]/gu;
    for (const match of line.matchAll(citation)) {
      const target = String(match[1] ?? "").trim();
      if (target) values.push({ kind: "citation", target, raw: match[0], line: index + 1 });
    }
  }
  return values;
}

function resolveTarget(
  database: Database,
  source: CurrentDocument,
  raw: string,
  kind: Reference["kind"],
) {
  const withoutFragment = raw.split("#")[0]?.trim() ?? "";
  if (!withoutFragment) return [];
  const decoded = safeDecode(withoutFragment).replaceAll("\\", "/");
  if (kind === "wiki" || kind === "embed" || kind === "citation") {
    const base = normalizeTarget(decoded);
    const pathWithExtension = `${base}.md`;
    return database
      .query<
        { document_id: string; source_id: string; logical_path: string; title: string | null },
        [string, string, string, string, string]
      >(
        `SELECT d.document_id, d.source_id, d.logical_path, r.title FROM knowledge_documents d
       JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
       WHERE d.state = 'active' AND (lower(d.normalized_path_key) = ? OR lower(d.normalized_path_key) = ?
         OR lower(r.title) = ? OR lower(d.normalized_path_key) LIKE ?)
       ORDER BY d.source_id = ? DESC, d.logical_path LIMIT 20`,
      )
      .all(base, pathWithExtension, base, `%/${pathWithExtension}`, source.source_id);
  }
  const joined = posix.normalize(
    posix.join(dirname(source.logical_path).replaceAll("\\", "/"), decoded),
  );
  const candidates = extname(joined) ? [joined] : [joined, `${joined}.md`];
  const placeholders = candidates.map(() => "?").join(",");
  return database
    .query<
      { document_id: string; source_id: string; logical_path: string; title: string | null },
      string[]
    >(
      `SELECT d.document_id, d.source_id, d.logical_path, r.title FROM knowledge_documents d
     JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
     WHERE d.state = 'active' AND d.source_id = ? AND d.normalized_path_key IN (${placeholders})`,
    )
    .all(source.source_id, ...candidates.map((value) => normalizePathTarget(value)));
}

function chunkAtLine(database: Database, revisionId: string, line: number) {
  return (
    database
      .query<{ chunk_id: string }, [string, number, number]>(
        `SELECT chunk_id FROM knowledge_revision_chunks WHERE revision_id = ?
     AND (source_start_line IS NULL OR source_start_line <= ?) AND (source_end_line IS NULL OR source_end_line >= ?)
     ORDER BY ordinal LIMIT 1`,
      )
      .get(revisionId, line, line) ??
    database
      .query<{ chunk_id: string }, [string]>(
        "SELECT chunk_id FROM knowledge_revision_chunks WHERE revision_id = ? ORDER BY ordinal LIMIT 1",
      )
      .get(revisionId)
  );
}

function addRelationEvidence(
  database: Database,
  relationId: string,
  chunk: { chunk_id: string } | null,
  revisionId: string,
  locator: Record<string, unknown>,
  excerpt: string,
) {
  if (!chunk) return;
  const excerptHash = sha256Text(excerpt);
  const existing = database
    .query<{ evidence_id: string }, [string, string, string]>(
      "SELECT evidence_id FROM graph_relation_evidence WHERE relation_id = ? AND chunk_id = ? AND excerpt_hash = ?",
    )
    .get(relationId, chunk.chunk_id, excerptHash);
  if (existing) return;
  database
    .prepare(
      `INSERT INTO graph_relation_evidence(relation_id, evidence_id, evidence_kind, chunk_id,
     revision_id, role, directness, locator_json, excerpt_hash, state, created_at)
     VALUES (?, ?, 'chunk', ?, ?, 'support', 'direct', ?, ?, 'active', ?)`,
    )
    .run(
      relationId,
      createResourceId("evidence"),
      chunk.chunk_id,
      revisionId,
      JSON.stringify(locator),
      excerptHash,
      new Date().toISOString(),
    );
}

function nodeForExternal(database: Database, kind: string, external: string): string | null {
  return (
    database
      .query<{ node_id: string }, [string, string]>(
        "SELECT node_id FROM graph_nodes WHERE node_kind = ? AND external_ref_id = ? AND deleted_at IS NULL",
      )
      .get(kind, external)?.node_id ?? null
  );
}

function normalizeTarget(value: string): string {
  return normalize(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\.md$/iu, "")
    .normalize("NFKC")
    .toLowerCase();
}

function normalizePathTarget(value: string): string {
  return normalize(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .normalize("NFKC")
    .toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

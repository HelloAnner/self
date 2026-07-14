import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { activeGeneration } from "./graph-generation-repository.ts";

export async function graphStatus(database: Database) {
  const active = activeGeneration(database);
  const generation = active
    ? database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM graph_generations WHERE generation_id = ?",
        )
        .get(active)
    : null;
  const counts = active
    ? database
        .query<Record<string, number>, [string, string, string, string]>(
          `SELECT
      (SELECT COUNT(*) FROM graph_generation_nodes WHERE generation_id = ?) nodes,
      (SELECT COUNT(*) FROM graph_generation_relations WHERE generation_id = ?) relations,
      (SELECT COUNT(*) FROM graph_generation_claims WHERE generation_id = ?) claims,
      (SELECT COUNT(*) FROM graph_unresolved_references WHERE generation_id = ? AND resolution_state <> 'resolved') unresolved`,
        )
        .get(active, active, active, active)
    : { nodes: 0, relations: 0, claims: 0, unresolved: 0 };
  return {
    active_generation_id: active,
    generation,
    counts,
    generations: database
      .query<Record<string, unknown>, []>(
        "SELECT generation_id, generation_kind, state, node_count, relation_count, claim_count, started_at, completed_at, activated_at FROM graph_generations ORDER BY started_at DESC",
      )
      .all(),
  };
}

export function graphNeighbors(
  database: Database,
  inputId: string,
  options: { depth?: number; predicates?: string[]; maxNodes?: number; maxEdges?: number } = {},
) {
  const generationId = requireActive(database);
  const startNode = resolveNode(database, inputId);
  const depth = bounded(options.depth ?? 1, 1, 4, "depth");
  const maxNodes = bounded(options.maxNodes ?? 100, 1, 500, "nodes");
  const maxEdges = bounded(options.maxEdges ?? 300, 1, 1_000, "edges");
  const allowed = options.predicates?.length ? new Set(options.predicates) : null;
  if (allowed) validatePredicates(database, [...allowed]);
  const similarityBoundary = allowed?.has("similar_to")
    ? ""
    : "AND r.predicate_key <> 'similar_to'";
  const rows = database
    .query<
      {
        relation_id: string;
        subject_node_id: string;
        object_node_id: string;
        predicate_key: string;
        depth: number;
      },
      [string, string, string, number, string, number]
    >(
      `WITH RECURSIVE walk(node_id, depth, path) AS (
       SELECT ?, 0, '|' || ? || '|'
       UNION ALL
       SELECT CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END,
              w.depth + 1,
              w.path || CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END || '|'
       FROM walk w JOIN graph_generation_relations gm ON gm.generation_id = ?
       JOIN graph_relations r ON r.relation_id = gm.relation_id
         AND (r.subject_node_id = w.node_id OR r.object_node_id = w.node_id)
       WHERE w.depth < ? AND r.status IN ('accepted','proposed') ${similarityBoundary}
         AND instr(w.path, '|' || CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END || '|') = 0
     )
     SELECT DISTINCT r.relation_id, r.subject_node_id, r.object_node_id, r.predicate_key,
       MIN(CASE WHEN w1.depth < w2.depth THEN w1.depth ELSE w2.depth END) + 1 depth
     FROM walk w1 JOIN graph_generation_relations gm ON gm.generation_id = ?
     JOIN graph_relations r ON r.relation_id = gm.relation_id AND (r.subject_node_id = w1.node_id OR r.object_node_id = w1.node_id) ${similarityBoundary}
     JOIN walk w2 ON w2.node_id = CASE WHEN r.subject_node_id = w1.node_id THEN r.object_node_id ELSE r.subject_node_id END
     GROUP BY r.relation_id ORDER BY depth, r.predicate_key, r.relation_id LIMIT ?`,
    )
    .all(startNode, startNode, generationId, depth, generationId, maxEdges + 1);
  const filtered = rows.filter((row) => !allowed || allowed.has(row.predicate_key));
  const nodeIds = [
    ...new Set([
      startNode,
      ...filtered.flatMap((row) => [row.subject_node_id, row.object_node_id]),
    ]),
  ];
  const selectedNodeIds = new Set(nodeIds.slice(0, maxNodes));
  const edges = filtered
    .filter(
      (row) => selectedNodeIds.has(row.subject_node_id) && selectedNodeIds.has(row.object_node_id),
    )
    .slice(0, maxEdges);
  return {
    generation_id: generationId,
    seed_node_id: startNode,
    nodes: hydrateNodes(database, [...selectedNodeIds]),
    edges: hydrateEdges(
      database,
      edges.map((row) => row.relation_id),
    ),
    truncated: rows.length > maxEdges || nodeIds.length > maxNodes,
    cursor: null,
    trace: {
      depth,
      max_nodes: maxNodes,
      max_edges: maxEdges,
      predicates: allowed ? [...allowed] : "all_except_semantic_neighbors",
    },
  };
}

export function graphPath(database: Database, fromId: string, toId: string, maxDepth = 4) {
  const generationId = requireActive(database);
  const start = resolveNode(database, fromId);
  const target = resolveNode(database, toId);
  const depth = bounded(maxDepth, 1, 4, "max-depth");
  const row = database
    .query<
      { node_path: string; edge_path: string; depth: number },
      [string, string, string, number, string]
    >(
      `WITH RECURSIVE walk(node_id, node_path, edge_path, depth) AS (
       SELECT ?, ?, '', 0
       UNION ALL
       SELECT CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END,
              w.node_path || ',' || CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END,
              CASE WHEN w.edge_path = '' THEN r.relation_id ELSE w.edge_path || ',' || r.relation_id END,
              w.depth + 1
       FROM walk w JOIN graph_generation_relations gm ON gm.generation_id = ?
       JOIN graph_relations r ON r.relation_id = gm.relation_id AND (r.subject_node_id = w.node_id OR r.object_node_id = w.node_id)
       WHERE w.depth < ? AND r.status IN ('accepted','proposed') AND r.predicate_key <> 'similar_to'
         AND instr(',' || w.node_path || ',', ',' || CASE WHEN r.subject_node_id = w.node_id THEN r.object_node_id ELSE r.subject_node_id END || ',') = 0
     ) SELECT node_path, edge_path, depth FROM walk WHERE node_id = ? ORDER BY depth, node_path LIMIT 1`,
    )
    .get(start, start, generationId, depth, target);
  if (!row)
    return {
      generation_id: generationId,
      found: false,
      nodes: [],
      edges: [],
      trace: { max_depth: depth },
    };
  const nodes = row.node_path.split(",");
  const edges = row.edge_path ? row.edge_path.split(",") : [];
  return {
    generation_id: generationId,
    found: true,
    depth: row.depth,
    nodes: hydrateNodes(database, nodes),
    edges: hydrateEdges(database, edges),
    trace: { max_depth: depth },
  };
}

export function graphLinks(database: Database, documentId: string, backlinks = false) {
  const generationId = requireActive(database);
  const node = resolveNode(database, documentId);
  const direction = backlinks ? "r.object_node_id" : "r.subject_node_id";
  const rows = database
    .query<Record<string, unknown>, [string, string]>(
      `SELECT r.*, s.external_ref_id subject_ref, o.external_ref_id object_ref
     FROM graph_generation_relations gm JOIN graph_relations r ON r.relation_id = gm.relation_id
     JOIN graph_nodes s ON s.node_id = r.subject_node_id JOIN graph_nodes o ON o.node_id = r.object_node_id
     WHERE gm.generation_id = ? AND ${direction} = ? AND r.predicate_key IN ('links_to','embeds','cites','references')
     ORDER BY r.predicate_key, r.relation_id`,
    )
    .all(generationId, node);
  return {
    generation_id: generationId,
    document_id: documentId,
    direction: backlinks ? "incoming" : "outgoing",
    links: rows,
  };
}

export function graphUnresolved(database: Database, status?: string) {
  const generationId = requireActive(database);
  return database
    .query<Record<string, unknown>, [string, string | null, string | null]>(
      `SELECT * FROM graph_unresolved_references WHERE generation_id = ?
     AND (? IS NULL OR resolution_state = ?) ORDER BY normalized_target, reference_id`,
    )
    .all(generationId, status ?? null, status ?? null)
    .map(parseJsonFields);
}

export function showGraphObject(
  database: Database,
  kind: "relation" | "claim" | "entity" | "conflict" | "reference",
  id: string,
) {
  const table = {
    relation: "graph_relations",
    claim: "graph_claims",
    entity: "graph_entities",
    conflict: "graph_conflict_sets",
    reference: "graph_unresolved_references",
  }[kind];
  const key = {
    relation: "relation_id",
    claim: "claim_id",
    entity: "entity_id",
    conflict: "conflict_id",
    reference: "reference_id",
  }[kind];
  const row = database
    .query<Record<string, unknown>, [string]>(`SELECT * FROM ${table} WHERE ${key} = ?`)
    .get(id);
  if (!row) throw failure(`${kind}_not_found`, `${kind} does not exist`, "not_found");
  return parseJsonFields(row);
}

export function listEntities(database: Database, type?: string, name?: string) {
  return database
    .query<Record<string, unknown>, [string | null, string | null, string | null, string | null]>(
      `SELECT e.*, n.canonical_label node_label FROM graph_entities e JOIN graph_nodes n ON n.node_id = e.node_id
     WHERE (? IS NULL OR e.entity_type = ?) AND (? IS NULL OR e.normalized_name = lower(?))
     ORDER BY e.canonical_name, e.entity_id`,
    )
    .all(type ?? null, type ?? null, name ?? null, name ?? null);
}

export function entityAliases(database: Database, entityId: string) {
  showGraphObject(database, "entity", entityId);
  return database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM graph_entity_aliases WHERE entity_id = ? ORDER BY normalized_alias",
    )
    .all(entityId);
}

export function entityMentions(database: Database, entityId: string) {
  const entity = showGraphObject(database, "entity", entityId);
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT r.relation_id, r.subject_node_id, r.predicate_key, e.* FROM graph_relations r
     JOIN graph_relation_evidence e ON e.relation_id = r.relation_id
     WHERE r.object_node_id = ? AND r.predicate_key = 'mentions' ORDER BY e.created_at`,
    )
    .all(String(entity.node_id));
}

export function relationEvidence(database: Database, relationId: string) {
  showGraphObject(database, "relation", relationId);
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT e.*, c.document_id, d.source_id, d.logical_path, r.snapshot_id, r.blob_sha256,
       s.name source_name FROM graph_relation_evidence e
       LEFT JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
       LEFT JOIN knowledge_documents d ON d.document_id = c.document_id
       LEFT JOIN knowledge_revisions r ON r.revision_id = e.revision_id
       LEFT JOIN sources s ON s.source_id = d.source_id
       WHERE e.relation_id = ? ORDER BY e.evidence_id`,
    )
    .all(relationId)
    .map(parseJsonFields);
}

export function claimEvidence(database: Database, claimId: string) {
  showGraphObject(database, "claim", claimId);
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT e.*, c.document_id, d.source_id, d.logical_path, r.snapshot_id, r.blob_sha256,
       s.name source_name FROM graph_claim_evidence e
       JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
       JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = e.revision_id
       JOIN sources s ON s.source_id = d.source_id
       WHERE e.claim_id = ? ORDER BY e.evidence_id`,
    )
    .all(claimId)
    .map(parseJsonFields);
}

export function claimRelations(database: Database, claimId: string) {
  return database
    .query<Record<string, unknown>, [string, string]>(
      "SELECT * FROM graph_claim_relations WHERE source_claim_id = ? OR target_claim_id = ? ORDER BY relation_type, source_claim_id, target_claim_id",
    )
    .all(claimId, claimId)
    .map(parseJsonFields);
}

export function claimConflicts(database: Database, claimId: string) {
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT c.*, m.position_key, m.role FROM graph_conflict_members m
     JOIN graph_conflict_sets c ON c.conflict_id = m.conflict_id WHERE m.claim_id = ? ORDER BY c.created_at`,
    )
    .all(claimId)
    .map(parseJsonFields);
}

export function conflictDetails(database: Database, conflictId: string) {
  const conflict = showGraphObject(database, "conflict", conflictId);
  const members = database
    .query<Record<string, unknown>, [string]>(
      `SELECT m.*, c.normalized_statement, c.status claim_status, c.confidence_level, c.confidence_json
     FROM graph_conflict_members m JOIN graph_claims c ON c.claim_id = m.claim_id
     WHERE m.conflict_id = ? ORDER BY m.role, m.claim_id`,
    )
    .all(conflictId)
    .map(parseJsonFields);
  return { ...conflict, members };
}

export function listPredicates(database: Database) {
  return database
    .query<Record<string, unknown>, []>(
      "SELECT * FROM graph_predicates ORDER BY layer, predicate_key",
    )
    .all()
    .map(parseJsonFields);
}

export function showPredicate(database: Database, key: string) {
  const row = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM graph_predicates WHERE predicate_key = ?",
    )
    .get(key);
  if (!row) throw failure("unknown_predicate", `Unknown Predicate: ${key}`, "not_found");
  return parseJsonFields(row);
}

export function generationDiff(database: Database, left: string, right: string) {
  for (const id of [left, right])
    if (
      !database.query("SELECT generation_id FROM graph_generations WHERE generation_id = ?").get(id)
    )
      throw failure("graph_generation_not_found", "Graph Generation does not exist", "not_found");
  return {
    left_generation_id: left,
    right_generation_id: right,
    nodes: diffTable(database, "graph_generation_nodes", "node_id", left, right),
    relations: diffTable(database, "graph_generation_relations", "relation_id", left, right),
    claims: diffTable(database, "graph_generation_claims", "claim_id", left, right),
  };
}

export function activeSubgraph(database: Database, maxNodes = 500, maxEdges = 1_000) {
  const generationId = requireActive(database);
  const nodes = database
    .query<Record<string, unknown>, [string, number]>(
      `SELECT n.* FROM graph_generation_nodes m JOIN graph_nodes n ON n.node_id = m.node_id
     WHERE m.generation_id = ? ORDER BY n.node_kind, n.node_id LIMIT ?`,
    )
    .all(generationId, bounded(maxNodes, 1, 500, "nodes"));
  const nodeSet = new Set(nodes.map((node) => String(node.node_id)));
  const edges = database
    .query<Record<string, unknown>, [string, number]>(
      `SELECT r.* FROM graph_generation_relations m JOIN graph_relations r ON r.relation_id = m.relation_id
     WHERE m.generation_id = ? ORDER BY r.predicate_key, r.relation_id LIMIT ?`,
    )
    .all(generationId, bounded(maxEdges, 1, 1_000, "edges"))
    .filter(
      (edge) =>
        nodeSet.has(String(edge.subject_node_id)) && nodeSet.has(String(edge.object_node_id)),
    );
  return {
    generation_id: generationId,
    nodes: nodes.map(parseJsonFields),
    edges: edges.map(parseJsonFields),
    cytoscape: {
      elements: [
        ...nodes.map((node) => ({
          data: { id: node.node_id, label: node.canonical_label, kind: node.node_kind },
        })),
        ...edges.map((edge) => ({
          data: {
            id: edge.relation_id,
            source: edge.subject_node_id,
            target: edge.object_node_id,
            predicate: edge.predicate_key,
          },
        })),
      ],
    },
    truncated: nodes.length === maxNodes || edges.length === maxEdges,
  };
}

export function exportActiveGraph(database: Database) {
  const generationId = requireActive(database);
  const nodes = database
    .query<Record<string, unknown>, [string]>(
      `SELECT n.* FROM graph_generation_nodes m JOIN graph_nodes n ON n.node_id = m.node_id
       WHERE m.generation_id = ? ORDER BY n.node_kind, n.node_id`,
    )
    .all(generationId)
    .map(parseJsonFields);
  const edges = database
    .query<Record<string, unknown>, [string]>(
      `SELECT r.* FROM graph_generation_relations m JOIN graph_relations r ON r.relation_id = m.relation_id
       WHERE m.generation_id = ? ORDER BY r.predicate_key, r.relation_id`,
    )
    .all(generationId)
    .map(parseJsonFields);
  return { generation_id: generationId, nodes, edges, truncated: false };
}

function hydrateNodes(database: Database, ids: string[]) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database
    .query<Record<string, unknown>, string[]>(
      `SELECT * FROM graph_nodes WHERE node_id IN (${placeholders}) ORDER BY node_kind, node_id`,
    )
    .all(...ids)
    .map(parseJsonFields);
}

function hydrateEdges(database: Database, ids: string[]) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return database
    .query<Record<string, unknown>, string[]>(
      `SELECT * FROM graph_relations WHERE relation_id IN (${placeholders}) ORDER BY predicate_key, relation_id`,
    )
    .all(...ids)
    .map(parseJsonFields);
}

function resolveNode(database: Database, id: string): string {
  if (id.startsWith("graph-node:")) {
    if (database.query("SELECT node_id FROM graph_nodes WHERE node_id = ?").get(id)) return id;
  } else {
    const direct = database
      .query<{ node_id: string }, [string]>(
        "SELECT node_id FROM graph_nodes WHERE external_ref_id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (direct) return direct.node_id;
    const entity = database
      .query<{ node_id: string }, [string]>(
        "SELECT node_id FROM graph_entities WHERE entity_id = ? AND status <> 'deleted'",
      )
      .get(id);
    if (entity) return entity.node_id;
    const claim = database
      .query<{ node_id: string }, [string]>(
        "SELECT node_id FROM graph_claims WHERE claim_id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (claim) return claim.node_id;
  }
  throw failure("graph_node_not_found", `Graph node does not exist: ${id}`, "not_found");
}

function requireActive(database: Database): string {
  const id = activeGeneration(database);
  if (!id) throw failure("graph_generation_not_found", "No active Graph Generation", "state");
  return id;
}

function validatePredicates(database: Database, values: string[]) {
  for (const value of values)
    if (
      !database
        .query(
          "SELECT predicate_key FROM graph_predicates WHERE predicate_key = ? AND status = 'active'",
        )
        .get(value)
    )
      throw failure("unknown_predicate", `Unknown Predicate: ${value}`, "usage");
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw failure(
      "graph_traversal_limit",
      `${field} must be between ${minimum} and ${maximum}`,
      "usage",
    );
  return value;
}

function parseJsonFields(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? safeJson(value) : value,
    ]),
  );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function diffTable(database: Database, table: string, column: string, left: string, right: string) {
  const added = database
    .query<Record<string, unknown>, [string, string]>(
      `SELECT ${column} id FROM ${table} WHERE generation_id = ? EXCEPT SELECT ${column} FROM ${table} WHERE generation_id = ? ORDER BY id`,
    )
    .all(right, left);
  const removed = database
    .query<Record<string, unknown>, [string, string]>(
      `SELECT ${column} id FROM ${table} WHERE generation_id = ? EXCEPT SELECT ${column} FROM ${table} WHERE generation_id = ? ORDER BY id`,
    )
    .all(left, right);
  return { added, removed, equivalent: added.length === 0 && removed.length === 0 };
}

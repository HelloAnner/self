import { resolve } from "node:path";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import {
  readableGraphDatabase,
  writableGraphDatabase,
} from "../../infrastructure/graph/graph-db.ts";
import {
  activeSubgraph,
  claimConflicts,
  claimEvidence,
  claimRelations,
  conflictDetails,
  entityAliases,
  entityMentions,
  exportActiveGraph,
  generationDiff,
  graphLinks,
  graphNeighbors,
  graphPath,
  graphStatus,
  graphUnresolved,
  listEntities,
  listPredicates,
  relationEvidence,
  showGraphObject,
  showPredicate,
} from "../../infrastructure/graph/graph-query-repository.ts";
import { invalidateAnswers } from "../../infrastructure/retrieval/evidence-repository.ts";
import { invalidateTopics } from "../../infrastructure/topic/topic-invalidation.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";

export const graphQueries = {
  status: read(graphStatus),
  neighbors: read(graphNeighbors),
  path: read(graphPath),
  links: read(graphLinks),
  unresolved: read(graphUnresolved),
  showObject: read(showGraphObject),
  entities: read(listEntities),
  aliases: read(entityAliases),
  mentions: read(entityMentions),
  relationEvidence: read(relationEvidence),
  claimEvidence: read(claimEvidence),
  claimRelations: read(claimRelations),
  claimConflicts: read(claimConflicts),
  conflict: read(conflictDetails),
  predicates: read(listPredicates),
  predicate: read(showPredicate),
  diff: read(generationDiff),
  subgraph: read(activeSubgraph),
};

export async function exportGraph(
  root: string,
  format: "json" | "jsonld" | "graphml",
  output: string,
) {
  const database = await readableGraphDatabase(root);
  let graph: ReturnType<typeof exportActiveGraph>;
  try {
    graph = exportActiveGraph(database);
  } finally {
    database.close();
  }
  const content =
    format === "json"
      ? `${JSON.stringify(graph, null, 2)}\n`
      : format === "jsonld"
        ? `${JSON.stringify(toJsonLd(graph), null, 2)}\n`
        : toGraphMl(graph);
  const path = resolve(output);
  await atomicWrite(path, content);
  return {
    generation_id: graph.generation_id,
    format,
    output: path,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    truncated: graph.truncated,
  };
}

export async function moderateGraphObject(
  root: string,
  input: {
    kind: "entity" | "relation" | "claim";
    id: string;
    action: "confirm" | "reject";
    reason?: string;
    requestId: string;
  },
) {
  const database = await writableGraphDatabase(root);
  try {
    const table =
      input.kind === "entity"
        ? "graph_entities"
        : input.kind === "relation"
          ? "graph_relations"
          : "graph_claims";
    const key = `${input.kind}_id`;
    const row = database
      .query<{ version: number }, [string]>(`SELECT version FROM ${table} WHERE ${key} = ?`)
      .get(input.id);
    if (!row) throw failure(`${input.kind}_not_found`, `${input.kind} does not exist`, "not_found");
    const status =
      input.action === "reject"
        ? "rejected"
        : input.kind === "entity"
          ? "active"
          : input.kind === "relation"
            ? "accepted"
            : "user_confirmed";
    const now = new Date().toISOString();
    database.transaction(() => {
      if (input.kind === "entity")
        database
          .prepare(
            `UPDATE ${table} SET status = ?, user_confirmed = ?, version = version + 1, updated_at = ? WHERE ${key} = ?`,
          )
          .run(status, input.action === "confirm" ? 1 : 0, now, input.id);
      else
        database
          .prepare(
            `UPDATE ${table} SET status = ?, version = version + 1, updated_at = ? WHERE ${key} = ?`,
          )
          .run(status, now, input.id);
      database
        .prepare(
          `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash,
         result_json, created_at, completed_at) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)`,
        )
        .run(
          createResourceId("operation"),
          input.requestId,
          `${input.kind}.${input.action}`,
          input.id,
          new Bun.CryptoHasher("sha256")
            .update(`${input.id}\n${input.action}\n${input.reason ?? ""}`)
            .digest("hex"),
          JSON.stringify({ status, reason: input.reason ?? null }),
          now,
          now,
        );
    })();
    if (input.kind === "claim") {
      const { recalculateClaimConfidence } = await import(
        "../../infrastructure/graph/graph-claim-alignment.ts"
      );
      recalculateClaimConfidence(database, input.id);
    }
    invalidateAnswers(database, `${input.kind}_moderated:${input.id}`);
    invalidateTopics(database, {
      reason: `${input.kind}_moderated:${input.id}`,
      ...(input.kind === "claim" ? { claimId: input.id, review: true } : {}),
    });
    return { [`${input.kind}_id`]: input.id, status, version: row.version + 1 };
  } finally {
    database.close();
  }
}

function read<TArgs extends unknown[], TResult>(
  fn: (database: Awaited<ReturnType<typeof readableGraphDatabase>>, ...args: TArgs) => TResult,
) {
  return async (root: string, ...args: TArgs): Promise<TResult> => {
    const database = await readableGraphDatabase(root);
    try {
      return fn(database, ...args);
    } finally {
      database.close();
    }
  };
}

function toJsonLd(graph: ReturnType<typeof exportActiveGraph>) {
  return {
    "@context": { predicate: "https://schema.self.local/predicate/", kind: "@type" },
    "@graph": [
      ...graph.nodes.map((node) => ({
        "@id": node.node_id,
        kind: node.node_kind,
        label: node.canonical_label,
        externalRef: node.external_ref_id,
      })),
      ...graph.edges.map((edge) => ({
        "@id": edge.relation_id,
        "@type": `predicate:${edge.predicate_key}`,
        subject: { "@id": edge.subject_node_id },
        object: { "@id": edge.object_node_id },
        status: edge.status,
      })),
    ],
  };
}

function toGraphMl(graph: ReturnType<typeof exportActiveGraph>): string {
  const nodes = graph.nodes
    .map(
      (node) =>
        `    <node id="${xml(String(node.node_id))}"><data key="label">${xml(String(node.canonical_label))}</data><data key="kind">${xml(String(node.node_kind))}</data></node>`,
    )
    .join("\n");
  const edges = graph.edges
    .map(
      (edge) =>
        `    <edge id="${xml(String(edge.relation_id))}" source="${xml(String(edge.subject_node_id))}" target="${xml(String(edge.object_node_id))}"><data key="predicate">${xml(String(edge.predicate_key))}</data></edge>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n  <key id="label" for="node" attr.name="label" attr.type="string"/>\n  <key id="kind" for="node" attr.name="kind" attr.type="string"/>\n  <key id="predicate" for="edge" attr.name="predicate" attr.type="string"/>\n  <graph id="${xml(graph.generation_id)}" edgedefault="directed">\n${nodes}\n${edges}\n  </graph>\n</graphml>\n`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

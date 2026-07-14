import { readonlyModelDatabase } from "../../infrastructure/model/model-db.ts";
import { traceObject } from "../../infrastructure/retrieval/answer-repository.ts";
import { graphEvidenceForSeeds } from "../../infrastructure/retrieval/evidence-repository.ts";
import { hydrateCandidates } from "../../infrastructure/retrieval/search-repository.ts";
import { graphQueries } from "../graph/graph-queries.ts";
import { searchKnowledge } from "./search.ts";

export async function relatedKnowledge(
  root: string,
  target: string,
  options: { depth?: number; limit?: number } = {},
) {
  if (/^(entity|claim|chunk|document|source|graph-node):/u.test(target))
    return graphQueries.neighbors(root, target, {
      depth: options.depth ?? 1,
      maxNodes: Math.min(500, options.limit ?? 50),
      maxEdges: Math.min(1_000, (options.limit ?? 50) * 3),
    });
  const search = await searchKnowledge(root, {
    query: target,
    mode: "text",
    limit: Math.min(100, options.limit ?? 10),
    explain: true,
  });
  const database = await readonlyModelDatabase(root);
  try {
    const graph = graphEvidenceForSeeds(
      database,
      search.results.map((row) => String(row.chunk_id)),
      options.limit ?? 20,
    );
    const chunks = hydrateCandidates(database, [...new Set(graph.map((row) => row.chunk_id))], {});
    return { target, seeds: search.results, graph_claim_evidence: graph, related_chunks: chunks };
  } finally {
    database.close();
  }
}

export async function traceKnowledge(root: string, id: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return traceObject(database, id);
  } finally {
    database.close();
  }
}

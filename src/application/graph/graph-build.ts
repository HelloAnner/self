import {
  readableGraphDatabase,
  writableGraphDatabase,
} from "../../infrastructure/graph/graph-db.ts";
import { extractGenerationClaims } from "../../infrastructure/graph/graph-extraction.ts";
import {
  activateGeneration,
  activeGeneration,
  carryForwardStableGraph,
  createGeneration,
  finalizeGeneration,
  verifyGeneration,
} from "../../infrastructure/graph/graph-generation-repository.ts";
import {
  projectExplicitLinks,
  projectKnowledgeStructure,
} from "../../infrastructure/graph/graph-projection.ts";
import { buildSemanticNeighbors } from "../../infrastructure/graph/semantic-neighbors.ts";
import { invalidateAnswers } from "../../infrastructure/retrieval/evidence-repository.ts";
import { invalidateTopics } from "../../infrastructure/topic/topic-invalidation.ts";
import { failure } from "../../shared/errors/self-error.ts";

export type GraphLayer =
  | "structure"
  | "links"
  | "mentions"
  | "relations"
  | "claims"
  | "neighbors"
  | "all";

export async function buildGraph(
  root: string,
  input: {
    kind?: "incremental" | "full";
    layer?: GraphLayer;
    modelId?: string;
    maxChunks?: number;
    vectorSpaceId?: string;
    activate?: boolean;
  } = {},
) {
  const database = await writableGraphDatabase(root);
  let generationId: string;
  let parentId: string | null;
  try {
    parentId = activeGeneration(database);
    generationId = createGeneration(database, {
      kind: input.kind ?? "full",
      ...(parentId ? { parentId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });
    if (parentId) carryForwardStableGraph(database, generationId, parentId);
  } finally {
    database.close();
  }
  const layer = input.layer ?? "all";
  const result: Record<string, unknown> = { generation_id: generationId, layer };
  try {
    if (
      ["structure", "links", "mentions", "relations", "claims", "neighbors", "all"].includes(layer)
    ) {
      const db = await writableGraphDatabase(root);
      try {
        db.transaction(() => {
          result.structure = projectKnowledgeStructure(db, generationId);
          if (["links", "mentions", "relations", "claims", "neighbors", "all"].includes(layer))
            result.links = projectExplicitLinks(db, generationId);
        })();
      } finally {
        db.close();
      }
    }
    if (["mentions", "relations", "claims", "all"].includes(layer) && input.modelId)
      result.extraction = await extractGenerationClaims(root, generationId, {
        modelId: input.modelId,
        ...(input.maxChunks ? { maxChunks: input.maxChunks } : {}),
      });
    else if (["mentions", "relations", "claims"].includes(layer) && !input.modelId)
      throw failure("graph_model_required", "This Graph layer requires --model", "usage");
    if (["neighbors", "all"].includes(layer) && input.vectorSpaceId)
      result.neighbors = await buildSemanticNeighbors(root, generationId, input.vectorSpaceId);
    else if (layer === "neighbors")
      throw failure("vector_space_not_active", "neighbors requires --vector-space", "usage");
    if (process.env.SELF_TEST_CRASH_GRAPH_BEFORE_VERIFY === "1") process.exit(97);
    const final = await writableGraphDatabase(root);
    try {
      final.transaction(() => finalizeGeneration(final, generationId))();
      result.verification = verifyGeneration(final, generationId);
      const shouldActivate = input.activate === true || (!parentId && input.activate !== false);
      if (shouldActivate) {
        if (process.env.SELF_TEST_CRASH_GRAPH_BEFORE_ACTIVATE === "1") process.exit(96);
        activateGeneration(final, generationId);
        invalidateAnswers(final, `graph_generation_changed:${generationId}`);
        invalidateTopics(final, { reason: `graph_generation_changed:${generationId}` });
        result.activated = true;
      } else result.activated = false;
      result.generation = final
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM graph_generations WHERE generation_id = ?",
        )
        .get(generationId);
    } finally {
      final.close();
    }
    return result;
  } catch (cause) {
    const db = await writableGraphDatabase(root);
    try {
      db.prepare(
        `UPDATE graph_generations SET state = CASE WHEN state IN ('active','ready') THEN state ELSE 'failed' END,
         failure_json = CASE WHEN state IN ('active','ready') THEN failure_json ELSE ? END,
         completed_at = COALESCE(completed_at, ?) WHERE generation_id = ?`,
      ).run(JSON.stringify({ code: errorCode(cause) }), new Date().toISOString(), generationId);
    } finally {
      db.close();
    }
    throw cause;
  }
}

export async function verifyGraph(root: string, generationId?: string) {
  const database = await readableGraphDatabase(root);
  try {
    const id = generationId ?? activeGeneration(database);
    if (!id) return { status: "pass", generation_id: null, checks: {}, empty: true };
    return { generation_id: id, ...verifyGeneration(database, id), empty: false };
  } finally {
    database.close();
  }
}

export async function refreshActiveGraphAfterKnowledgeChange(root: string) {
  const database = await writableGraphDatabase(root);
  let active: string | null;
  try {
    active = activeGeneration(database);
  } finally {
    database.close();
  }
  if (!active) return { graph_status: "not_started" };
  const result = await buildGraph(root, { kind: "incremental", layer: "all", activate: true });
  return {
    graph_status: "ready",
    generation_id: result.generation_id,
    extraction_status: "unchanged_outputs_reused_changed_chunks_pending_explicit_model_build",
  };
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === "object" && "selfError" in cause
    ? String((cause as { selfError: { code: string } }).selfError.code)
    : "graph_build_failed";
}

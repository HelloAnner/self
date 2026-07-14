import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerGraphCommands(program: Command): void {
  registerGraph(program);
  registerEntity(program);
  registerRelation(program);
  registerClaim(program);
  registerConflict(program);
}

function registerGraph(program: Command) {
  const graph = program.command("graph").description("query and rebuild the evidence-backed Graph");
  const status = graph.command("status").option("--json");
  status.action(() => query(status, "status"));
  const verify = graph
    .command("verify")
    .option("--deep")
    .option("--generation <id>")
    .option("--json");
  verify.action(() =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root }) => {
        const { verifyGraph } = await import("../../application/graph/graph-build.ts");
        return verifyGraph(root ?? "", verify.opts<{ generation?: string }>().generation);
      },
      present: presentKeyValues,
    }),
  );
  const build = graph
    .command("build")
    .option("--changed-only")
    .option("--model <id>")
    .option("--max-chunks <n>")
    .option("--vector-space <id>")
    .option("--detach")
    .option("--json");
  build.action(() => runBuild(build, true));
  const rebuild = graph
    .command("rebuild")
    .requiredOption("--layer <layer>")
    .option("--model <id>")
    .option("--max-chunks <n>")
    .option("--vector-space <id>")
    .option("--detach")
    .option("--json");
  rebuild.action(() => runBuild(rebuild, false));
  const neighbors = graph
    .command("neighbors <id>")
    .option("--depth <n>")
    .option("--predicate <keys>")
    .option("--nodes <n>")
    .option("--edges <n>")
    .option("--json");
  neighbors.action((id: string) => query(neighbors, "neighbors", id, graphLimits(neighbors)));
  const path = graph
    .command("path <from-id> <to-id>")
    .option("--max-depth <n>", "maximum depth", "4")
    .option("--json");
  path.action((from: string, to: string) =>
    query(path, "path", from, to, Number(path.opts<{ maxDepth: string }>().maxDepth)),
  );
  const subgraph = graph
    .command("subgraph")
    .option("--seed <id>")
    .option("--nodes <n>")
    .option("--edges <n>")
    .option("--json");
  subgraph.action(() => {
    const options = subgraph.opts<{ seed?: string; nodes?: string; edges?: string }>();
    return options.seed
      ? query(subgraph, "neighbors", options.seed, {
          depth: 2,
          maxNodes: numberOption(options.nodes, 100),
          maxEdges: numberOption(options.edges, 300),
        })
      : query(
          subgraph,
          "subgraph",
          numberOption(options.nodes, 500),
          numberOption(options.edges, 1_000),
        );
  });
  for (const [name, backlinks] of [
    ["links", false],
    ["backlinks", true],
  ] as const) {
    const command = graph.command(`${name} <document-id>`).option("--json");
    command.action((id: string) => query(command, "links", id, backlinks));
  }
  const diff = graph.command("diff <left-id> <right-id>").option("--json");
  diff.action((left: string, right: string) => query(diff, "diff", left, right));
  const activate = graph
    .command("activate <generation-id>")
    .requiredOption("--plan")
    .option("--json");
  activate.action((id: string) => plan(activate, "generation_activate", { generation_id: id }));
  const unresolved = graph.command("unresolved");
  const unresolvedList = unresolved.command("list").option("--status <status>").option("--json");
  unresolvedList.action(() =>
    query(unresolvedList, "unresolved", unresolvedList.opts<{ status?: string }>().status),
  );
  const unresolvedShow = unresolved.command("show <reference-id>").option("--json");
  unresolvedShow.action((id: string) => query(unresolvedShow, "showObject", "reference", id));
  const unresolvedRetry = unresolved.command("retry").requiredOption("--all").option("--json");
  unresolvedRetry.action(() =>
    runCliAction({
      command: unresolvedRetry,
      root: "required",
      handler: async ({ root }) => {
        const { buildGraph } = await import("../../application/graph/graph-build.ts");
        return buildGraph(root ?? "", { kind: "full", layer: "all", activate: true });
      },
      present: presentKeyValues,
    }),
  );
  const predicate = graph.command("predicate");
  const predicateList = predicate.command("list").option("--json");
  predicateList.action(() => query(predicateList, "predicates"));
  const predicateShow = predicate.command("show <key>").option("--json");
  predicateShow.action((key: string) => query(predicateShow, "predicate", key));
  const exportCommand = graph
    .command("export")
    .requiredOption("--format <format>")
    .requiredOption("--output <path>")
    .option("--scope <scope>")
    .option("--json");
  exportCommand.action(() =>
    runCliAction({
      command: exportCommand,
      root: "required",
      handler: async ({ root }) => {
        const options = exportCommand.opts<{ format: string; output: string }>();
        if (!["json", "jsonld", "graphml"].includes(options.format))
          throw failure(
            "graph_export_format_invalid",
            "format must be json, jsonld, or graphml",
            "usage",
          );
        const { exportGraph } = await import("../../application/graph/graph-queries.ts");
        return exportGraph(
          root ?? "",
          options.format as "json" | "jsonld" | "graphml",
          options.output,
        );
      },
      present: presentKeyValues,
    }),
  );
}

function registerEntity(program: Command) {
  const entity = program.command("entity").description("inspect and moderate Graph Entities");
  const list = entity.command("list").option("--type <type>").option("--json");
  list.action(() => query(list, "entities", list.opts<{ type?: string }>().type));
  const show = entity.command("show <entity-id>").option("--json");
  show.action((id: string) => query(show, "showObject", "entity", id));
  const aliases = entity.command("aliases <entity-id>").option("--json");
  aliases.action((id: string) => query(aliases, "aliases", id));
  const mentions = entity.command("mentions <entity-id>").option("--json");
  mentions.action((id: string) => query(mentions, "mentions", id));
  const candidates = entity
    .command("candidates")
    .requiredOption("--name <name>")
    .option("--type <type>")
    .option("--json");
  candidates.action(() => {
    const options = candidates.opts<{ name: string; type?: string }>();
    return query(candidates, "entities", options.type, options.name);
  });
  const create = entity
    .command("create")
    .requiredOption("--type <type>")
    .requiredOption("--name <name>")
    .requiredOption("--user-asserted")
    .option("--description <text>")
    .option("--identity-key <key>")
    .requiredOption("--plan")
    .option("--json");
  create.action(() => {
    const options = create.opts<Record<string, string | boolean>>();
    return plan(create, "entity_create", {
      entity_type: options.type,
      name: options.name,
      description: options.description,
      identity_key: options.identityKey,
      user_asserted: true,
    });
  });
  const merge = entity
    .command("merge <source-id> <target-id>")
    .option("--reason <reason>", "merge reason", "user confirmed identity")
    .requiredOption("--plan")
    .option("--json");
  merge.action((source: string, target: string) =>
    plan(merge, "entity_merge", {
      source_entity_id: source,
      target_entity_id: target,
      reason: merge.opts<{ reason: string }>().reason,
    }),
  );
  moderation(entity, "entity");
  lifecycle(entity, "entity");
}

function registerRelation(program: Command) {
  const relation = program.command("relation").description("inspect and moderate typed Relations");
  const show = relation.command("show <relation-id>").option("--json");
  show.action((id: string) => query(show, "showObject", "relation", id));
  const evidence = relation.command("evidence <relation-id>").option("--json");
  evidence.action((id: string) => query(evidence, "relationEvidence", id));
  const create = relation
    .command("create <subject-id> <predicate> <object-id>")
    .option("--evidence <chunk-id>")
    .option("--user-asserted")
    .requiredOption("--plan")
    .option("--json");
  create.action((subject: string, predicate: string, object: string) => {
    const options = create.opts<{ evidence?: string; userAsserted?: boolean }>();
    return plan(create, "relation_create", {
      subject_id: subject,
      predicate,
      object_id: object,
      evidence_chunk_id: options.evidence,
      user_asserted: options.userAsserted === true,
    });
  });
  moderation(relation, "relation");
  lifecycle(relation, "relation");
}

function registerClaim(program: Command) {
  const claim = program.command("claim").description("inspect and moderate evidence-backed Claims");
  const show = claim.command("show <claim-id>").option("--json");
  show.action((id: string) => query(show, "showObject", "claim", id));
  const evidence = claim.command("evidence <claim-id>").option("--json");
  evidence.action((id: string) => query(evidence, "claimEvidence", id));
  const relations = claim.command("relations <claim-id>").option("--json");
  relations.action((id: string) => query(relations, "claimRelations", id));
  const conflicts = claim.command("conflicts <claim-id>").option("--json");
  conflicts.action((id: string) => query(conflicts, "claimConflicts", id));
  moderation(claim, "claim");
  lifecycle(claim, "claim");
}

function registerConflict(program: Command) {
  const conflict = program.command("conflict");
  const show = conflict.command("show <conflict-id>").option("--json");
  show.action((id: string) => query(show, "conflict", id));
}

function moderation(parent: Command, kind: "entity" | "relation" | "claim") {
  for (const action of ["confirm", "reject"] as const) {
    const command = parent
      .command(`${action} <id>`)
      .option("--reason <reason>")
      .option("--if-version <version>")
      .option("--idempotency-key <key>")
      .option("--json");
    command.action((id: string) =>
      runCliAction({
        command,
        root: "required",
        handler: async ({ root, requestId }) => {
          const { moderateGraphObject } = await import(
            "../../application/graph/graph-moderation.ts"
          );
          const options = command.opts<{
            reason?: string;
            ifVersion?: string;
            idempotencyKey?: string;
          }>();
          const ifVersion = options.ifVersion ? positiveVersion(options.ifVersion) : undefined;
          return moderateGraphObject(root ?? "", {
            kind,
            id,
            action,
            ...(options.reason ? { reason: options.reason } : {}),
            ...(ifVersion !== undefined ? { ifVersion } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            requestId,
          });
        },
        present: presentKeyValues,
      }),
    );
  }
}

function lifecycle(parent: Command, kind: "entity" | "relation" | "claim") {
  const remove = parent
    .command("delete <id>")
    .requiredOption("--plan")
    .option("--idempotency-key <key>")
    .option("--json");
  remove.action((id: string) =>
    runCliAction({
      command: remove,
      root: "required",
      handler: async ({ root, requestId }) => {
        const idempotencyKey = remove.opts<{ idempotencyKey?: string }>().idempotencyKey;
        const { createResourceMutationPlan } = await import(
          "../../application/automation/resource-lifecycle.ts"
        );
        return createResourceMutationPlan(
          root ?? "",
          `${kind}_delete` as "entity_delete" | "relation_delete" | "claim_delete",
          id,
          requestId,
          { ...(idempotencyKey ? { idempotencyKey } : {}) },
        );
      },
      present: presentKeyValues,
    }),
  );
  const restore = parent
    .command("restore <id>")
    .option("--if-version <version>")
    .option("--idempotency-key <key>")
    .option("--json");
  restore.action((id: string) =>
    runCliAction({
      command: restore,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = restore.opts<{ ifVersion?: string; idempotencyKey?: string }>();
        const ifVersion = options.ifVersion ? positiveVersion(options.ifVersion) : undefined;
        const { restoreDeletedResource } = await import(
          "../../application/automation/resource-lifecycle.ts"
        );
        return restoreDeletedResource(root ?? "", kind, id, requestId, {
          ...(ifVersion !== undefined ? { ifVersion } : {}),
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        });
      },
      present: presentKeyValues,
    }),
  );
}

function positiveVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw failure("version_invalid", "--if-version must be a positive integer", "usage");
  }
  return parsed;
}

function query(command: Command, method: string, ...args: unknown[]) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const { graphQueries } = await import("../../application/graph/graph-queries.ts");
      return (graphQueries as Record<string, (...values: unknown[]) => Promise<unknown>>)[method]?.(
        root ?? "",
        ...args,
      );
    },
    present: (data) =>
      Array.isArray(data) ? presentList(data) : presentKeyValues(data as Record<string, unknown>),
  });
}

function plan(
  command: Command,
  action: "entity_create" | "entity_merge" | "relation_create" | "generation_activate",
  input: Record<string, unknown>,
) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const { createGraphPlan } = await import("../../application/graph/graph-plans.ts");
      return createGraphPlan(root ?? "", action, input, requestId);
    },
    present: presentKeyValues,
  });
}

function runBuild(command: Command, activate: boolean) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<{
        layer?: string;
        model?: string;
        maxChunks?: string;
        vectorSpace?: string;
        detach?: boolean;
        changedOnly?: boolean;
      }>();
      const layer = options.layer ?? "all";
      if (
        !["structure", "links", "mentions", "relations", "claims", "neighbors", "all"].includes(
          layer,
        )
      )
        throw failure("graph_layer_invalid", "Unknown Graph rebuild layer", "usage");
      const kind: "incremental" | "full" = options.changedOnly ? "incremental" : "full";
      const graphLayer = layer as
        | "structure"
        | "links"
        | "mentions"
        | "relations"
        | "claims"
        | "neighbors"
        | "all";
      const input = {
        kind,
        layer: graphLayer,
        activate,
        ...(options.model ? { modelId: options.model } : {}),
        ...(options.maxChunks ? { maxChunks: Number(options.maxChunks) } : {}),
        ...(options.vectorSpace ? { vectorSpaceId: options.vectorSpace } : {}),
      };
      if (options.detach) {
        const jobs = await import("../../application/automation/job-workflows.ts");
        return jobs.enqueueJob(root ?? "", {
          kind: "graph.build",
          values: {
            kind: input.kind,
            layer,
            activate,
            ...(options.model ? { model_id: options.model } : {}),
            ...(options.maxChunks ? { max_chunks: Number(options.maxChunks) } : {}),
            ...(options.vectorSpace ? { vector_space_id: options.vectorSpace } : {}),
          },
          requestId,
        });
      }
      const { buildGraph } = await import("../../application/graph/graph-build.ts");
      return buildGraph(root ?? "", input);
    },
    present: presentKeyValues,
  });
}

function graphLimits(command: Command) {
  const options = command.opts<{
    depth?: string;
    predicate?: string;
    nodes?: string;
    edges?: string;
  }>();
  return {
    depth: numberOption(options.depth, 1),
    predicates: options.predicate?.split(",").filter(Boolean),
    maxNodes: numberOption(options.nodes, 100),
    maxEdges: numberOption(options.edges, 300),
  };
}

function numberOption(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

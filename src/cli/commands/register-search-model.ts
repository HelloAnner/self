import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerSearchModelCommands(program: Command): void {
  registerModel(program);
  registerVectorSpace(program);
  registerSearch(program);
}

function registerModel(program: Command): void {
  const model = program.command("model").description("register and test replaceable models");
  const add = model
    .command("add")
    .requiredOption("--provider <name>")
    .requiredOption("--capability <capability>")
    .requiredOption("--model <provider-model-id>")
    .requiredOption("--revision <revision>")
    .option("--dimensions <dimensions>")
    .option("--json");
  add.action(() =>
    runCliAction({
      command: add,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = add.opts<{
          provider: string;
          capability: string;
          model: string;
          revision: string;
          dimensions?: string;
        }>();
        if (!["embedding", "chat"].includes(options.capability))
          throw failure(
            "model_capability_unavailable",
            "Model capability must be embedding or chat",
            "usage",
          );
        if (options.capability === "chat") {
          const { registerStructuredModel } = await import(
            "../../infrastructure/model/model-repository.ts"
          );
          return registerStructuredModel(root ?? "", {
            providerName: options.provider,
            providerModelId: options.model,
            revision: options.revision,
            capability: "chat",
            requestId,
          });
        }
        if (!options.dimensions)
          throw failure(
            "model_dimension_invalid",
            "Embedding models require --dimensions",
            "usage",
          );
        const dimensions = options.dimensions.split(",").map(Number);
        if (dimensions.some((value) => !Number.isInteger(value) || value < 1 || value > 8192))
          throw failure("model_dimension_invalid", "Model dimensions are invalid", "usage");
        const { registerEmbeddingModel } = await import(
          "../../infrastructure/model/model-repository.ts"
        );
        return registerEmbeddingModel(root ?? "", {
          providerName: options.provider,
          providerModelId: options.model,
          revision: options.revision,
          dimensions: [...new Set(dimensions)].sort((left, right) => left - right),
          requestId,
        });
      },
      present: presentKeyValues,
    }),
  );
  const list = model.command("list").option("--capability <capability>").option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const { listModels } = await import("../../infrastructure/model/model-repository.ts");
        return listModels(root ?? "", list.opts<{ capability?: string }>().capability);
      },
      present: presentList,
    }),
  );
  const show = model.command("show <model-id>").option("--json");
  show.action((modelId: string) =>
    runCliAction({
      command: show,
      root: "required",
      handler: async ({ root }) => {
        const { getModel } = await import("../../infrastructure/model/model-repository.ts");
        return getModel(root ?? "", modelId);
      },
      present: presentKeyValues,
    }),
  );
  const test = model.command("test <model-id>").requiredOption("--suite <suite>").option("--json");
  test.action((modelId: string) =>
    runCliAction({
      command: test,
      root: "required",
      handler: async ({ root }) => {
        if (test.opts<{ suite: string }>().suite !== "embedding-compat")
          throw failure("model_suite_unavailable", "Unknown Model test suite", "usage");
        const { testEmbeddingModel } = await import(
          "../../application/knowledge/model-sentinel-workflows.ts"
        );
        return testEmbeddingModel(root ?? "", modelId);
      },
      present: presentKeyValues,
    }),
  );
}

function registerVectorSpace(program: Command): void {
  const vector = program.command("vector-space").description("manage immutable VectorSpaces");
  const create = vector
    .command("create")
    .requiredOption("--model <model-id>")
    .requiredOption("--dimensions <dimensions>")
    .option("--distance <distance>", "distance metric", "cosine")
    .option("--normalize <normalize>", "normalization", "l2")
    .option("--query-instruction <id>", "Query Instruction ID", "personal-knowledge-retrieval-v1")
    .requiredOption("--plan")
    .option("--json");
  create.action(() => planCreate(create));
  const list = vector.command("list").option("--json");
  list.action(() => vectorQuery(list, "list"));
  const active = vector.command("active").option("--json");
  active.action(() => vectorQuery(active, "active"));
  const show = vector.command("show <vector-space-id>").option("--json");
  show.action((id: string) => vectorQuery(show, "show", id));
  const build = vector
    .command("build <vector-space-id>")
    .option("--batch-size <n>")
    .option("--detach")
    .option("--wait")
    .option("--json");
  build.action((id: string) =>
    runCliAction({
      command: build,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = build.opts<{ batchSize?: string; detach?: boolean; wait?: boolean }>();
        if (options.detach || options.wait) {
          const jobs = await import("../../application/automation/job-workflows.ts");
          return jobs.enqueueJob(root ?? "", {
            kind: "vector-space.build",
            values: {
              vector_space_id: id,
              ...(options.batchSize ? { batch_size: Number(options.batchSize) } : {}),
            },
            requestId,
            wait: options.wait === true,
          });
        }
        const { buildVectorSpace } = await import(
          "../../application/knowledge/vector-space-workflows.ts"
        );
        return buildVectorSpace(
          root ?? "",
          id,
          options.batchSize ? { batchSize: Number(options.batchSize) } : {},
        );
      },
      present: presentKeyValues,
    }),
  );
  const verify = vector.command("verify <vector-space-id>").option("--deep").option("--json");
  verify.action((id: string) =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root }) => {
        const { verifyVectorSpace } = await import(
          "../../application/knowledge/vector-space-workflows.ts"
        );
        return verifyVectorSpace(root ?? "", id);
      },
      present: presentKeyValues,
    }),
  );
  const compare = vector
    .command("compare <left-id> <right-id>")
    .requiredOption("--fixture <fixture>")
    .option("--json");
  compare.action((left: string, right: string) =>
    runCliAction({
      command: compare,
      root: "required",
      handler: async ({ root }) => {
        const { compareVectorSpaces } = await import(
          "../../application/knowledge/vector-space-workflows.ts"
        );
        return compareVectorSpaces(
          root ?? "",
          left,
          right,
          compare.opts<{ fixture: string }>().fixture,
        );
      },
      present: presentKeyValues,
    }),
  );
  for (const action of ["activate", "delete"] as const) {
    const command = vector
      .command(`${action} <vector-space-id>`)
      .requiredOption("--plan")
      .option("--json");
    command.action((id: string) => planExisting(command, action, id));
  }
  const migrate = vector
    .command("migrate")
    .requiredOption("--from <vector-space-id>")
    .requiredOption("--to-model <model-id>")
    .requiredOption("--dimensions <dimensions>")
    .requiredOption("--from-local-chunks")
    .option("--query-instruction <id>", "Query Instruction ID", "personal-knowledge-retrieval-v1")
    .requiredOption("--plan")
    .option("--json");
  migrate.action(() => planMigrate(migrate));
}

function registerSearch(program: Command): void {
  const search = program
    .command("search <query>")
    .option("--mode <mode>")
    .option("--limit <n>")
    .option("--source <source-id>")
    .option("--path <prefix>")
    .option("--type <media-type>")
    .option("--tag <tag>")
    .option("--since <iso>")
    .option("--until <iso>")
    .option("--explain")
    .option("--json");
  search.action((query: string) =>
    runCliAction({
      command: search,
      root: "required",
      handler: async ({ root }) => {
        const options = search.opts<Record<string, string | boolean | undefined>>();
        if (options.mode && !["text", "vector", "hybrid"].includes(String(options.mode)))
          throw failure("search_mode_invalid", "Search mode is invalid", "usage");
        const { searchKnowledge } = await import("../../application/retrieval/search.ts");
        return searchKnowledge(root ?? "", {
          query,
          ...(options.mode ? { mode: options.mode as "text" | "vector" | "hybrid" } : {}),
          ...(options.limit ? { limit: Number(options.limit) } : {}),
          filters: {
            ...(options.source ? { sourceId: String(options.source) } : {}),
            ...(options.path ? { pathPrefix: String(options.path) } : {}),
            ...(options.type ? { mediaType: String(options.type) } : {}),
            ...(options.tag ? { tag: String(options.tag) } : {}),
            ...(options.since ? { since: String(options.since) } : {}),
            ...(options.until ? { until: String(options.until) } : {}),
          },
          explain: options.explain === true,
        });
      },
      present: presentKeyValues,
    }),
  );
}

function vectorQuery(command: Command, query: "list" | "show" | "active", id?: string) {
  if (query === "list")
    return runCliAction({
      command,
      root: "required",
      handler: async ({ root }) => {
        const { vectorSpaceQueries } = await import(
          "../../application/knowledge/vector-space-workflows.ts"
        );
        return vectorSpaceQueries.list(root ?? "");
      },
      present: presentList,
    });
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const { vectorSpaceQueries } = await import(
        "../../application/knowledge/vector-space-workflows.ts"
      );
      if (query === "show") return vectorSpaceQueries.show(root ?? "", id ?? "");
      return (await vectorSpaceQueries.active(root ?? "")) ?? { active_vector_space_id: null };
    },
    present: presentKeyValues,
  });
}

function planCreate(command: Command) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<Record<string, string>>();
      if (options.distance !== "cosine" || options.normalize !== "l2")
        throw failure("vector_space_input_invalid", "Phase 4 requires cosine + l2", "usage");
      const { createVectorSpacePlan } = await import(
        "../../application/knowledge/vector-space-plans.ts"
      );
      return createVectorSpacePlan(
        root ?? "",
        {
          action: "create",
          modelId: options.model ?? "",
          dimensions: Number(options.dimensions),
          queryInstructionId: options.queryInstruction ?? "personal-knowledge-retrieval-v1",
        },
        requestId,
      );
    },
    present: presentKeyValues,
  });
}

function planExisting(command: Command, action: "activate" | "delete", id: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const { showVectorSpace } = await import(
        "../../infrastructure/knowledge/vector-space-repository.ts"
      );
      const { createVectorSpacePlan } = await import(
        "../../application/knowledge/vector-space-plans.ts"
      );
      const space = await showVectorSpace(root ?? "", id);
      return createVectorSpacePlan(
        root ?? "",
        {
          action,
          vectorSpaceId: id,
          vectorSpaceVersion: Number(space.version),
        },
        requestId,
      );
    },
    present: presentKeyValues,
  });
}

function planMigrate(command: Command) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<Record<string, string>>();
      const { createVectorSpacePlan } = await import(
        "../../application/knowledge/vector-space-plans.ts"
      );
      return createVectorSpacePlan(
        root ?? "",
        {
          action: "migrate",
          fromVectorSpaceId: options.from ?? "",
          modelId: options.toModel ?? "",
          dimensions: Number(options.dimensions),
          queryInstructionId: options.queryInstruction ?? "personal-knowledge-retrieval-v1",
        },
        requestId,
      );
    },
    present: presentKeyValues,
  });
}

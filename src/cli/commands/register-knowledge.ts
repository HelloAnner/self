import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerKnowledgeCommands(program: Command): void {
  const knowledge = program
    .command("knowledge")
    .description("build and inspect normalized knowledge");
  registerBuild(knowledge);
  registerRead(knowledge);
  registerDocuments(knowledge);
  registerChunks(knowledge);
  registerIngestion(program);
}

function registerBuild(knowledge: Command): void {
  const build = knowledge
    .command("build")
    .option("--source <source-id>")
    .option("--snapshot <snapshot-id>")
    .option("--all")
    .option("--json");
  build.action(() => buildAction(build, false));
  const rebuild = knowledge
    .command("rebuild")
    .requiredOption("--layer <layer>")
    .option("--source <source-id>")
    .option("--all")
    .option("--json");
  rebuild.action(() => {
    const layer = rebuild.opts<{ layer: string }>().layer;
    if (!["parse", "chunks", "all"].includes(layer)) {
      return runCliAction({
        command: rebuild,
        root: "required",
        handler: () => {
          throw failure(
            "knowledge_layer_unavailable",
            `Layer ${layer} is not available before its Roadmap phase`,
            "state",
          );
        },
        present: presentKeyValues,
      });
    }
    return buildAction(rebuild, true);
  });
}

function buildAction(command: Command, rebuild: boolean) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root, requestId }) => {
      const options = command.opts<{ source?: string; snapshot?: string; all?: boolean }>();
      if (options.source && options.snapshot) {
        throw failure("knowledge_input_invalid", "Choose either --source or --snapshot", "usage");
      }
      const { buildKnowledge } = await import("../../application/knowledge/knowledge-workflows.ts");
      return buildKnowledge(
        root ?? "",
        {
          ...(options.source ? { sourceId: options.source } : {}),
          ...(options.snapshot ? { snapshotId: options.snapshot } : {}),
          ...(options.all ? { all: true } : {}),
          rebuild,
        },
        requestId,
      );
    },
    present: presentList,
  });
}

function registerRead(knowledge: Command): void {
  const status = knowledge.command("status").option("--source <source-id>").option("--json");
  status.action(() => queryList(status, "status"));
  const failures = knowledge.command("failures").option("--source <source-id>").option("--json");
  failures.action(() => queryList(failures, "failures"));
  const verify = knowledge.command("verify").option("--deep").option("--json");
  verify.action(() =>
    runCliAction({
      command: verify,
      root: "required",
      handler: async ({ root }) => {
        const { knowledgeQueries } = await import(
          "../../application/knowledge/knowledge-workflows.ts"
        );
        return knowledgeQueries.verify(root ?? "");
      },
      present: presentKeyValues,
    }),
  );
  const explain = knowledge.command("explain <chunk-id>").option("--json");
  explain.action((chunkId: string) => queryOne(explain, "chunk", chunkId));
}

function registerDocuments(knowledge: Command): void {
  const document = knowledge.command("document");
  const list = document.command("list").option("--source <source-id>").option("--json");
  list.action(() => queryList(list, "documents"));
  const show = document.command("show <document-id>").option("--json");
  show.action((documentId: string) => queryOne(show, "document", documentId));
}

function registerChunks(knowledge: Command): void {
  const chunk = knowledge.command("chunk");
  const list = chunk
    .command("list")
    .option("--source <source-id>")
    .option("--document <document-id>")
    .option("--include-tombstoned")
    .option("--json");
  list.action(() =>
    runCliAction({
      command: list,
      root: "required",
      handler: async ({ root }) => {
        const { knowledgeQueries } = await import(
          "../../application/knowledge/knowledge-workflows.ts"
        );
        const options = list.opts<{
          source?: string;
          document?: string;
          includeTombstoned?: boolean;
        }>();
        return knowledgeQueries.chunks(root ?? "", {
          ...(options.source ? { sourceId: options.source } : {}),
          ...(options.document ? { documentId: options.document } : {}),
          ...(options.includeTombstoned ? { includeTombstoned: true } : {}),
        });
      },
      present: presentList,
    }),
  );
  const show = chunk.command("show <chunk-id>").option("--json");
  show.action((chunkId: string) => queryOne(show, "chunk", chunkId));
}

function registerIngestion(program: Command): void {
  const ingestion = program.command("ingestion").description("inspect and retry IngestionRuns");
  const show = ingestion.command("show <ingestion-id>").option("--json");
  show.action((runId: string) => queryOne(show, "run", runId));
  const retry = ingestion.command("retry <ingestion-id>").option("--json");
  retry.action((runId: string) =>
    runCliAction({
      command: retry,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { retryIngestion } = await import(
          "../../application/knowledge/knowledge-workflows.ts"
        );
        return retryIngestion(root ?? "", runId, requestId);
      },
      present: presentKeyValues,
    }),
  );
}

function queryList(command: Command, query: "status" | "failures" | "documents") {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const { knowledgeQueries } = await import(
        "../../application/knowledge/knowledge-workflows.ts"
      );
      return knowledgeQueries[query](root ?? "", command.opts<{ source?: string }>().source);
    },
    present: presentList,
  });
}

function queryOne(command: Command, query: "run" | "document" | "chunk", id: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const { knowledgeQueries } = await import(
        "../../application/knowledge/knowledge-workflows.ts"
      );
      return knowledgeQueries[query](root ?? "", id);
    },
    present: presentKeyValues,
  });
}

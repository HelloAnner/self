import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerRetrievalCommands(program: Command): void {
  const ask = program
    .command("ask <query>")
    .description("answer from a persisted EvidenceContext")
    .option("--mode <mode>")
    .option("--depth <depth>", "shallow, normal, or deep", "normal")
    .option("--model <model-id>")
    .option("--source <source-id>")
    .option("--tokens <n>")
    .option("--allow-model-knowledge")
    .option("--json");
  ask.action((query: string) =>
    runCliAction({
      command: ask,
      root: "required",
      handler: async ({ root }) => {
        const options = ask.opts<Record<string, string | boolean | undefined>>();
        const mode = options.mode ? String(options.mode) : undefined;
        const depth = String(options.depth ?? "normal");
        if (mode && !["text", "vector", "hybrid"].includes(mode))
          throw failure("search_mode_invalid", "Ask mode is invalid", "usage");
        if (!["shallow", "normal", "deep"].includes(depth))
          throw failure("ask_depth_invalid", "Ask depth is invalid", "usage");
        const actualQuery = query === "-" ? await Bun.stdin.text() : query;
        const { askKnowledge } = await import("../../application/retrieval/ask.ts");
        return askKnowledge(root ?? "", {
          query: actualQuery,
          ...(mode ? { mode: mode as "text" | "vector" | "hybrid" } : {}),
          depth: depth as "shallow" | "normal" | "deep",
          ...(options.model ? { modelId: String(options.model) } : {}),
          ...(options.source ? { filters: { sourceId: String(options.source) } } : {}),
          ...(options.tokens ? { tokenBudget: Number(options.tokens) } : {}),
          allowModelKnowledge: options.allowModelKnowledge === true,
        });
      },
      present: presentKeyValues,
    }),
  );

  const related = program
    .command("related <target>")
    .description("find bounded Graph and evidence relations")
    .option("--depth <n>", "Graph depth", "1")
    .option("--limit <n>", "result limit", "50")
    .option("--json");
  related.action((target: string) =>
    runCliAction({
      command: related,
      root: "required",
      handler: async ({ root }) => {
        const options = related.opts<{ depth: string; limit: string }>();
        const depth = Number(options.depth);
        const limit = Number(options.limit);
        if (!Number.isInteger(depth) || depth < 1 || depth > 4)
          throw failure("graph_traversal_limit", "depth must be between 1 and 4", "usage");
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
          throw failure("related_limit_invalid", "limit must be between 1 and 500", "usage");
        const { relatedKnowledge } = await import(
          "../../application/retrieval/evidence-queries.ts"
        );
        return relatedKnowledge(root ?? "", target, { depth, limit });
      },
      present: presentKeyValues,
    }),
  );

  const trace = program
    .command("trace <id>")
    .description("trace Answer, Report Section, Claim, or Chunk evidence to Source Snapshot")
    .option("--json");
  trace.action((id: string) =>
    runCliAction({
      command: trace,
      root: "required",
      handler: async ({ root }) => {
        const { traceKnowledge } = await import("../../application/retrieval/evidence-queries.ts");
        return traceKnowledge(root ?? "", id);
      },
      present: presentKeyValues,
    }),
  );
}

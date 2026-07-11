import { join } from "node:path";
import { loadLatestInitJournal, saveInitJournal } from "../../domains/workspace/init/journal.ts";
import type {
  InitJournal,
  InitPlan,
  InitResult,
  InitStep,
} from "../../domains/workspace/init/types.ts";
import { canonicalizePotentialPath } from "../../domains/workspace/root/discovery.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { REQUIRED_DIRECTORIES } from "./init-layout.ts";
import { createAndSaveInitPlan } from "./init-plan.ts";
import { assertRootIdentity, existingWorkspace, prepareJournal } from "./init-preparation.ts";
import { executeInitSteps } from "./init-steps.ts";

export type InitWorkspaceOptions = {
  target: string;
  requestId: string;
  offline?: boolean;
  planOnly?: boolean;
  resume?: boolean;
  approvedPlan?: InitPlan;
  afterCheckpoint?: (step: InitStep) => void | Promise<void>;
};

export async function initWorkspace(options: InitWorkspaceOptions): Promise<InitResult | InitPlan> {
  const root = await canonicalizePotentialPath(options.target);
  if (options.planOnly) {
    return createAndSaveInitPlan(
      root,
      options.requestId,
      options.offline ?? true,
      REQUIRED_DIRECTORIES,
    );
  }
  if (await Bun.file(join(root, "self.toml")).exists()) return existingWorkspace(root);

  let journal: InitJournal | undefined;
  try {
    journal = options.resume
      ? await loadLatestInitJournal(root)
      : await prepareJournal(root, options);
    await assertRootIdentity(journal);
    await executeInitSteps(journal, options.afterCheckpoint);
    journal.state = "completed";
    await saveInitJournal(journal);
    return resultFromJournal(journal, Boolean(options.resume));
  } catch (cause) {
    if (journal) {
      journal.state = "failed";
      journal.error_code = cause instanceof SelfFailure ? cause.selfError.code : "init_failed";
      await saveInitJournal(journal);
    }
    if (cause instanceof SelfFailure) throw cause;
    throw failure("init_failed", "Workspace initialization failed and can be resumed", "internal", {
      details: { reason: cause instanceof Error ? cause.message : String(cause) },
      suggestedActions: [`Run \`self init resume ${root}\`.`],
    });
  }
}

function resultFromJournal(journal: InitJournal, resumed: boolean): InitResult {
  return {
    workspace_id: journal.workspace_id,
    operation_id: journal.operation_id,
    root: journal.target_root,
    state: "active",
    resumed,
    offline: journal.offline,
  };
}

import { initWorkspace } from "../../src/application/workspace/init-workspace.ts";
import { continueSetupSession } from "../../src/application/workspace/setup-workspace.ts";
import { type SetupSession, saveSetupSession } from "../../src/domains/workspace/setup/session.ts";
import { SelfFailure } from "../../src/shared/errors/self-error.ts";
import { createRequestId, createResourceId } from "../../src/shared/ids/id.ts";

const [root] = process.argv.slice(2);
if (!root?.includes("/data/test-runs/"))
  throw new Error("Setup helper only accepts data/test-runs paths");
const initialized = await initWorkspace({
  target: root,
  requestId: createRequestId(),
  offline: false,
});
if (!("state" in initialized)) throw new Error("Expected initialized Workspace");
const now = new Date().toISOString();
const session: SetupSession = {
  session_id: createResourceId("setup"),
  workspace_id: initialized.workspace_id,
  state: "workspace_ready",
  current_step: "workspace",
  profile: "hosted",
  answers: {
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api_key_env: "SELF_TEST_MISSING_DASHSCOPE_KEY",
  },
  created_resource_ids: [initialized.workspace_id],
  warnings: [],
  started_at: now,
  updated_at: now,
};
await saveSetupSession(root, session);
try {
  await continueSetupSession(root, session, createRequestId());
  throw new Error("Expected hosted setup to fail without a secret environment variable");
} catch (cause) {
  if (cause instanceof SelfFailure && cause.selfError.code === "setup_secret_unavailable") {
    process.exitCode = 6;
  } else {
    throw cause;
  }
}

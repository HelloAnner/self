import { initWorkspace } from "../../src/application/workspace/init-workspace.ts";
import { createRequestId } from "../../src/shared/ids/id.ts";

const [target, step = "directories"] = process.argv.slice(2);
if (!target?.includes("/data/test-runs/"))
  throw new Error("Failure helper only accepts data/test-runs paths");

try {
  await initWorkspace({
    target,
    requestId: createRequestId(),
    offline: true,
    afterCheckpoint(completed) {
      if (completed === step) throw new Error(`Injected test interruption after ${step}`);
    },
  });
  throw new Error("Expected injected interruption");
} catch (cause) {
  if (cause instanceof Error && cause.message.includes("can be resumed")) process.exitCode = 20;
  else throw cause;
}

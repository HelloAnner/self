import type { Command } from "commander";
import { presentKeyValues } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerOperationsCommands(program: Command): void {
  const migration = program
    .command("migration")
    .description("inspect or apply database migrations");
  const plan = migration.command("plan").option("--json");
  plan.action(() =>
    runCliAction({
      command: plan,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { createDatabaseMigrationPlan } = await import(
          "../../application/operations/database-migration.ts"
        );
        return createDatabaseMigrationPlan(root ?? "", requestId);
      },
      present: presentKeyValues,
    }),
  );
}

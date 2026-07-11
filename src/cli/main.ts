#!/usr/bin/env bun

if (import.meta.main) {
  if (process.argv.includes("--no-color")) process.env.NO_COLOR = "1";
  if (isVersionInvocation(process.argv.slice(2))) {
    await runVersionFastPath(process.argv.includes("--json"));
    process.exit(0);
  }
  const { CommanderError } = await import("commander");
  const { createProgram } = await import("./create-program.ts");
  const program = createProgram();
  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (cause) {
    if (cause instanceof CommanderError) {
      if (cause.exitCode === 0) {
        process.exitCode = 0;
      } else {
        process.exitCode = 2;
        if (process.argv.includes("--json")) {
          const [{ failureEnvelope }, { createRequestId }] = await Promise.all([
            import("./protocol/envelope.ts"),
            import("../shared/ids/id.ts"),
          ]);
          process.stdout.write(
            `${JSON.stringify(
              failureEnvelope(
                {
                  code: "invalid_arguments",
                  message: cause.message,
                  category: "usage",
                  retryable: false,
                },
                createRequestId(),
                null,
              ),
            )}\n`,
          );
        }
      }
    } else {
      process.stderr.write(
        `internal_error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.exitCode = 20;
    }
  }
}

function isVersionInvocation(argv: string[]): boolean {
  const normalized = argv.filter((argument) => argument !== "--no-color");
  return (
    (normalized.length === 1 && normalized[0] === "version") ||
    (normalized.length === 2 && normalized.includes("version") && normalized.includes("--json"))
  );
}

async function runVersionFastPath(json: boolean): Promise<void> {
  const [{ getVersionInfo }, { presentVersion }] = await Promise.all([
    import("./commands/version/handler.ts"),
    import("./commands/version/presenter.ts"),
  ]);
  const data = getVersionInfo();
  if (!json) {
    process.stdout.write(presentVersion(data));
    return;
  }
  const [{ successEnvelope }, { createRequestId }] = await Promise.all([
    import("./protocol/envelope.ts"),
    import("../shared/ids/id.ts"),
  ]);
  process.stdout.write(`${JSON.stringify(successEnvelope(data, createRequestId()))}\n`);
}

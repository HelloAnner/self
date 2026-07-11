import { describe, expect, test } from "bun:test";

const command = ["bun", "run", "src/cli/main.ts", "version"];

describe("version CLI contract", () => {
  test("prints human-readable versions", async () => {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      await Bun.file("tests/fixtures/golden/version-human.txt").text(),
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("prints one JSON envelope", async () => {
    const result = Bun.spawnSync([...command, "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    output.meta.request_id = "<request-id>";
    expect(output).toEqual(
      JSON.parse(await Bun.file("tests/fixtures/golden/version-json.json").text()),
    );
  });
});

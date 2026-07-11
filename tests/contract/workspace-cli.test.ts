import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("data/test-runs/contract-workspace-cli");
const command = ["bun", "run", "src/cli/main.ts"];

describe("Workspace CLI golden contracts", () => {
  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    const result = Bun.spawnSync([...command, "init", root, "--offline", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  });

  afterAll(async () => rm(root, { recursive: true, force: true }));

  test("status JSON matches the normalized golden", async () => {
    const result = Bun.spawnSync([...command, "--root", root, "status", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(normalize(JSON.parse(result.stdout.toString()))).toEqual(
      JSON.parse(await Bun.file("tests/fixtures/golden/status-json.json").text()),
    );
  });

  test("doctor human output matches the golden", async () => {
    const result = Bun.spawnSync([...command, "--root", root, "doctor"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      await Bun.file("tests/fixtures/golden/doctor-workspace-human.txt").text(),
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("config human output matches the golden", async () => {
    const result = Bun.spawnSync([...command, "--root", root, "config", "get", "logging.level"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      await Bun.file("tests/fixtures/golden/config-get-human.txt").text(),
    );
  });

  test("non-empty Init Plan preserves existing files", async () => {
    const target = resolve(root, "plan-target");
    await mkdir(target, { recursive: true });
    await Bun.write(resolve(target, "keep.txt"), "keep");
    const result = Bun.spawnSync([...command, "init", target, "--plan", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = normalize(JSON.parse(result.stdout.toString()));
    expect(output).toMatchObject({ data: { existing_paths: ["keep.txt"] } });
    expect(await Bun.file(resolve(target, "keep.txt")).text()).toBe("keep");
    expect(await Bun.file(resolve(target, "self.toml")).exists()).toBe(false);
  });
});

function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        entryKey === "database_size_bytes" ? "<bytes>" : normalize(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (value.startsWith("workspace:ws_")) return "<workspace-id>";
  if (value.startsWith("req_")) return "<request-id>";
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "<time>";
  if (["root", "target_root"].includes(key)) return "<root>";
  return value.replaceAll(root, "<root>");
}

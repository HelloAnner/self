import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOTS = ["src", "scripts"];
const LIMITS: Record<string, number> = { ".ts": 500, ".tsx": 400 };
const violations: string[] = [];

for (const root of ROOTS) await checkDirectory(root);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Source size limits passed.\n");
}

async function checkDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(path);
    else await checkFile(path);
  }
}

async function checkFile(path: string): Promise<void> {
  const limit = LIMITS[extname(path)];
  if (!limit) return;

  const content = await Bun.file(path).text();
  const logicalLines = content
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("//")).length;
  if (logicalLines > limit) {
    violations.push(
      `${relative(process.cwd(), path)}: ${logicalLines} logical lines exceeds ${limit}`,
    );
  }
}

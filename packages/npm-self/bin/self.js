#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageName = selectPlatformPackage(process.platform, process.arch);

try {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const binaryName = process.platform === "win32" ? "self.exe" : "self";
  const result = spawnSync(join(dirname(packagePath), "bin", binaryName), process.argv.slice(2), {
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.status ?? 20;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`platform_package_missing: ${packageName}: ${message}\n`);
  process.exitCode = 6;
}

function selectPlatformPackage(platform, arch) {
  const key = `${platform}-${arch}`;
  const packages = {
    "darwin-arm64": "@helloanner/self-darwin-arm64",
    "darwin-x64": "@helloanner/self-darwin-x64",
    "linux-arm64": "@helloanner/self-linux-arm64",
    "linux-x64": "@helloanner/self-linux-x64",
    "win32-x64": "@helloanner/self-windows-x64",
  };
  const selected = packages[key];
  if (!selected) throw new Error(`unsupported_platform: ${key}`);
  return selected;
}

import { join } from "node:path";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId, isResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";
import { showMaintenanceStatus } from "../operations/maintenance.ts";
import { doctorWorkspace } from "./workspace-doctor.ts";
import { getWorkspaceStatus } from "./workspace-status.ts";

export async function collectDiagnostics(root: string) {
  const id = createResourceId("diagnostics");
  const directory = diagnosticsDirectory(root, id);
  const reportPath = join(directory, "diagnostics.json");
  const status = await getWorkspaceStatus(root);
  const doctor = await doctorWorkspace(root);
  const maintenance = await showMaintenanceStatus(root);
  const report = {
    diagnostics_id: id,
    collected_at: new Date().toISOString(),
    cli_version: VERSION.cli,
    platform: process.platform,
    arch: process.arch,
    workspace: {
      workspace_id: status.workspace_id,
      state: status.state,
      database_schema_version: status.database_schema_version,
      capabilities: status.capabilities,
      warnings: status.warnings,
    },
    doctor,
    operations: {
      maintenance,
      note: "Job messages and operational errors are redacted before persistence.",
    },
    redaction: {
      secrets: "excluded",
      config_values: "excluded",
      source_paths: "excluded",
      source_content: "excluded",
    },
  };
  await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const manifest = {
    diagnostics_id: id,
    report: "diagnostics.json",
    sha256: await sha256File(reportPath),
  };
  await atomicWrite(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    diagnostics_id: id,
    root_relative_path: relativeDiagnosticsPath(id),
    status: doctor.status,
  };
}

export async function showDiagnostics(root: string, id: string): Promise<unknown> {
  assertDiagnosticsId(id);
  const path = join(diagnosticsDirectory(root, id), "diagnostics.json");
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw failure("diagnostics_not_found", "Diagnostics bundle does not exist", "not_found");
  return JSON.parse(await file.text());
}

export async function verifyDiagnostics(root: string, id: string) {
  assertDiagnosticsId(id);
  const directory = diagnosticsDirectory(root, id);
  const manifestFile = Bun.file(join(directory, "manifest.json"));
  if (!(await manifestFile.exists()))
    throw failure("diagnostics_not_found", "Diagnostics manifest is missing", "not_found");
  const manifest: unknown = JSON.parse(await manifestFile.text());
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("sha256" in manifest) ||
    typeof manifest.sha256 !== "string"
  ) {
    throw failure("diagnostics_invalid", "Diagnostics manifest is invalid", "state");
  }
  const actual = await sha256File(join(directory, "diagnostics.json"));
  return {
    diagnostics_id: id,
    valid: actual === manifest.sha256,
    expected_sha256: manifest.sha256,
    actual_sha256: actual,
  };
}

function assertDiagnosticsId(id: string): void {
  if (!isResourceId(id, "diagnostics"))
    throw failure("diagnostics_not_found", "Diagnostics ID is invalid", "not_found");
}

function diagnosticsDirectory(root: string, id: string): string {
  return join(root, "runtime/diagnostics", id.replace(":", "_"));
}

function relativeDiagnosticsPath(id: string): string {
  return `runtime/diagnostics/${id.replace(":", "_")}`;
}

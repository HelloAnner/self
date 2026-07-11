import { copyFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSelfConfig, stringifySelfConfig } from "../../domains/workspace/config/codec.ts";
import { createDefaultConfig } from "../../domains/workspace/config/defaults.ts";
import { saveInitJournal } from "../../domains/workspace/init/journal.ts";
import { INIT_STEPS, type InitJournal, type InitStep } from "../../domains/workspace/init/types.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File, sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { installRuntimeAssets, locateReleaseAssets } from "../../infrastructure/runtime/assets.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createWorkspaceDatabase, verifyWorkspaceRow } from "./init-database.ts";
import { ensureDirectory, recordCreatedFile } from "./init-files.ts";
import { REQUIRED_DIRECTORIES } from "./init-layout.ts";

export async function executeInitSteps(
  journal: InitJournal,
  hook?: (step: InitStep) => void | Promise<void>,
): Promise<void> {
  for (const step of INIT_STEPS) {
    if (journal.completed_steps.includes(step)) continue;
    if (step === "directories") await createDirectories(journal);
    if (step === "runtime_assets") await createRuntimeAssets(journal);
    if (step === "database") await createWorkspaceDatabase(journal);
    if (step === "verification") await verifyDraft(journal);
    if (step === "config_publish") await publishConfig(journal);
    journal.current_step = step;
    journal.completed_steps.push(step);
    await saveInitJournal(journal);
    await hook?.(step);
  }
}

async function createDirectories(journal: InitJournal): Promise<void> {
  for (const path of REQUIRED_DIRECTORIES) {
    await ensureDirectory(journal, join(journal.target_root, path));
  }
}

async function createRuntimeAssets(journal: InitJournal): Promise<void> {
  const assets = await installRuntimeAssets(journal.target_root);
  await recordCreatedFile(journal, assets.sqliteLibrary);
  await recordCreatedFile(journal, assets.sqliteVecExtension);
  const manifest = join(
    journal.target_root,
    "runtime/extensions",
    `${process.platform}-${process.arch}`,
    "manifest.json",
  );
  await recordCreatedFile(journal, manifest);
  const release = await locateReleaseAssets();
  await copyTemplateDirectory(
    journal,
    release.templateDirectory,
    join(journal.target_root, "templates"),
  );
}

async function copyTemplateDirectory(
  journal: InitJournal,
  source: string,
  target: string,
): Promise<void> {
  await ensureDirectory(journal, target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) await copyTemplateDirectory(journal, sourcePath, targetPath);
    if (!entry.isFile()) continue;
    if (await Bun.file(targetPath).exists()) {
      if ((await sha256File(sourcePath)) !== (await sha256File(targetPath))) {
        throw failure("init_path_conflict", `Template path changed: ${targetPath}`, "conflict");
      }
    } else {
      await ensureDirectory(journal, dirname(targetPath));
      await copyFile(sourcePath, targetPath);
    }
    await recordCreatedFile(journal, targetPath);
  }
}

async function verifyDraft(journal: InitJournal): Promise<void> {
  const config = createDefaultConfig(
    journal.target_root,
    journal.workspace_id,
    journal.created_at,
    journal.offline,
  );
  parseSelfConfig(stringifySelfConfig(config));
  await verifyWorkspaceRow(join(journal.target_root, "data/self.sqlite3"), journal);
}

async function publishConfig(journal: InitJournal): Promise<void> {
  const path = join(journal.target_root, "self.toml");
  const content = stringifySelfConfig(
    createDefaultConfig(
      journal.target_root,
      journal.workspace_id,
      journal.created_at,
      journal.offline,
    ),
  );
  if (await Bun.file(path).exists()) {
    if ((await sha256File(path)) !== sha256Text(content)) {
      throw failure("init_path_conflict", "self.toml changed during initialization", "conflict");
    }
    return;
  }
  await atomicWrite(path, content);
  await recordCreatedFile(journal, path);
}

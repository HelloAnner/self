import type { Command } from "commander";
import { failure } from "../../shared/errors/self-error.ts";
import { presentKeyValues, presentList } from "../protocol/presenter.ts";
import { runCliAction } from "../runtime.ts";

export function registerNoteCommands(program: Command): void {
  const note = program.command("note").description("create and version managed Notes");
  const create = note.command("create <title>").requiredOption("--content <text>").option("--json");
  create.action((title: string) =>
    runCliAction({
      command: create,
      root: "required",
      handler: async ({ root, requestId }) => {
        const { createNote } = await import("../../application/knowledge/note-workflows.ts");
        return createNote(
          root ?? "",
          { title, content: create.opts<{ content: string }>().content },
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
  const update = note
    .command("update <note-id>")
    .requiredOption("--content <text>")
    .requiredOption("--if-version <version>")
    .option("--title <title>")
    .option("--json");
  update.action((noteId: string) =>
    runCliAction({
      command: update,
      root: "required",
      handler: async ({ root, requestId }) => {
        const options = update.opts<{ content: string; ifVersion: string; title?: string }>();
        const version = Number(options.ifVersion);
        if (!Number.isInteger(version) || version < 1) {
          throw failure("note_input_invalid", "--if-version must be a positive integer", "usage");
        }
        const { updateNote } = await import("../../application/knowledge/note-workflows.ts");
        return updateNote(
          root ?? "",
          noteId,
          {
            content: options.content,
            ifVersion: version,
            ...(options.title ? { title: options.title } : {}),
          },
          requestId,
        );
      },
      present: presentKeyValues,
    }),
  );
  const list = note.command("list").option("--json");
  list.action(() => noteQuery(list, "list"));
  const show = note.command("show <note-id>").option("--json");
  show.action((noteId: string) => noteQuery(show, "show", noteId));
}

function noteQuery(command: Command, action: "list" | "show", noteId?: string) {
  return runCliAction({
    command,
    root: "required",
    handler: async ({ root }) => {
      const notes = await import("../../application/knowledge/note-workflows.ts");
      return action === "list"
        ? notes.listNotes(root ?? "")
        : notes.getNote(root ?? "", noteId ?? "");
    },
    present: (data) => (Array.isArray(data) ? presentList(data) : presentKeyValues(data)),
  });
}

import { uniqueName, windowTaken } from "../core/doc/commands";
import type { DocState } from "../core/doc/types";
import { download, pickFile } from "./actions";
import { doc, runGui, showError } from "./session";

/**
 * The name a Markdown file is imported under: its name without `.md`, made
 * into a window name (letters, digits and "_", starting with a letter),
 * and numbered if a window has that name already.
 */
export function importedNoteName(state: DocState, filename: string): string {
  let base = filename
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z]/.test(base)) base = `Note_${base}`.replace(/_+$/, "");
  base = base.slice(0, 200);
  const taken = windowTaken(state);
  return taken(base) ? uniqueName(`${base}_`, taken) : base;
}

/** Asks for Markdown files and makes a note of each. */
export function importNotes(): void {
  pickFile(".md,.markdown,.txt,text/markdown,text/plain", true, (picked) => {
    void (async () => {
      for (const file of picked) {
        try {
          const name = importedNoteName(doc.getState(), file.name);
          runGui({ op: "newNote", name, text: await file.text() });
        } catch (error) {
          showError(`Could not import ${file.name}`, error);
        }
      }
    })();
  });
}

/** Hands the user a note's text as `<name>.md`. */
export function exportNote(name: string): void {
  const note = doc.getState().notes[name];
  if (!note) return;
  download(new Blob([note.text], { type: "text/markdown" }), `${name}.md`);
}

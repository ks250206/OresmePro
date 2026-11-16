import { uniqueName, windowTaken } from "../core/doc/commands";
import type { DocState } from "../core/doc/types";
import { download, pickFile } from "./actions";
import { doc, note, runGui, showError } from "./session";

/**
 * The procedure name a file of Python is imported under: its name without
 * `.py`, made into a module name (ASCII letters, digits and "_", not
 * starting with a digit), and numbered if a window has that name already.
 */
export function importedProcedureName(state: DocState, filename: string): string {
  let base = filename
    .replace(/\.py$/i, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "Procedure";
  if (/^[0-9]/.test(base)) base = `p_${base}`;
  base = base.slice(0, 200);
  const taken = windowTaken(state);
  return taken(base) ? uniqueName(`${base}_`, taken) : base;
}

/**
 * Asks for .py files and makes a procedure of each. Nothing in them runs:
 * an imported procedure does not run when the experiment opens until the
 * user says so, as a file from somewhere else is code they have not seen.
 */
export function importProcedures(): void {
  pickFile(".py,text/x-python", true, (picked) => {
    void (async () => {
      for (const file of picked) {
        try {
          const name = importedProcedureName(doc.getState(), file.name);
          const code = await file.text();
          if (runGui({ op: "newProcedure", name, code, autoRun: false }) === undefined) continue;
          note(
            `${file.name} is the procedure ${name}. It has not run: run it from its window, ` +
              `or tick "Run when the experiment opens".`,
          );
        } catch (error) {
          showError(`Could not import ${file.name}`, error);
        }
      }
    })();
  });
}

/** Hands the user a procedure's text as `<name>.py`. */
export function exportProcedure(name: string): void {
  const procedure = doc.getState().procedures[name];
  if (!procedure) return;
  download(new Blob([procedure.code], { type: "text/x-python" }), `${name}.py`);
}

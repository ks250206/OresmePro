import { useState } from "react";
import { experimentFileName, saveExperimentAs, savedFileName } from "../app/actions";
import { doc, runGui, ui, useDoc } from "../app/session";
import { procedureName, windowTaken, type Command } from "../core/doc/commands";
import type { WindowState } from "../core/doc/types";
import { Button, Dialog, Field, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** Runs a command and closes the dialog if it was accepted. */
function submit(command: Command) {
  if (runGui(command) !== undefined) close();
}

/** What a window shows, in words: "graph", "page layout". */
export const KIND_WORDS: Record<WindowState["kind"], string> = {
  graph: "graph",
  table: "table",
  procedure: "procedure",
  page: "page layout",
  panel: "panel",
};

/**
 * Asked by a window's close button: close the window and keep what it
 * shows, to reopen it from the Windows menu, or kill it. Igor asks the
 * same, keeping a recreation macro where this keeps the window itself.
 */
export function CloseWindowDialog({ name }: { name: string }) {
  const window = useDoc((state) => state.windows.find((item) => item.name === name));
  if (!window) return null;
  const kind = KIND_WORDS[window.kind];
  return (
    <Dialog
      title={`Close ${name}`}
      width={400}
      onClose={close}
      submitLabel="Close"
      onSubmit={() => submit({ op: "closeWindow", name })}
      buttons={<Button onClick={() => submit({ op: "killWindow", name })}>Kill</Button>}
    >
      <p className="leading-relaxed">
        <b>Close</b> keeps the {kind} in the experiment: reopen it from{" "}
        <b>Windows › {kind === "page layout" ? "Layouts" : `${capitalize(kind)}s`}</b>, as it is
        then.
      </p>
      <p className="leading-relaxed">
        <b>Kill</b> removes the {kind}
        {window.kind === "procedure" ? " and its code" : ""}
        {window.kind === "graph" || window.kind === "table" ? "; the waves stay" : ""}.
      </p>
      <p className="text-[11px] text-muted">
        Alt-click (Option-click) the close button to kill a window without asking. Either can be
        undone.
      </p>
    </Dialog>
  );
}

const capitalize = (word: string): string => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** Gives a graph, table, procedure, page layout or panel another name. */
export function RenameWindowDialog({ name }: { name: string }) {
  const window = useDoc((state) => state.windows.find((item) => item.name === name));
  const [value, setValue] = useState(name);
  if (!window) return null;
  const newName = value.trim();
  const problem = nameProblem(window.kind, newName, name);
  return (
    <Dialog
      title={`Rename ${name}`}
      width={360}
      onClose={close}
      submitLabel="Rename"
      submitDisabled={problem !== null || newName === name}
      onSubmit={() => submit({ op: "renameWindow", name, newName })}
    >
      <Field label="New name">
        <TextInput
          aria-label="New name"
          aria-invalid={problem !== null}
          className="flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div className={`pl-[104px] text-[11px] ${problem ? "text-danger" : "text-muted"}`}>
        {problem ??
          (window.kind === "procedure"
            ? "Also the name to import it by: ASCII letters, digits and _."
            : window.kind === "graph"
              ? "Page layouts that show it follow the new name."
              : "Starts with a letter; letters, digits and _.")}
      </div>
    </Dialog>
  );
}

/** Why a window cannot take this name, or null if it can. */
function nameProblem(kind: WindowState["kind"], name: string, current: string): string | null {
  if (name === "") return "Type a name.";
  if (name === current) return null;
  try {
    if (kind === "procedure") procedureName(name);
    else if (!/^[\p{L}][\p{L}\p{N}_]*$/u.test(name)) {
      return "A name starts with a letter and has only letters, digits and _.";
    }
  } catch (error) {
    return (error as Error).message;
  }
  return windowTaken(doc.getState())(name) ? `A window named ${name} already exists.` : null;
}

/** Makes a procedure, asking its name as Igor's New Procedure does. */
export function NewProcedureDialog() {
  const [value, setValue] = useState(() => {
    const taken = windowTaken(doc.getState());
    if (!taken("Procedure")) return "Procedure";
    for (let count = 1; ; count += 1) if (!taken(`Procedure${count}`)) return `Procedure${count}`;
  });
  const name = value.trim();
  const problem = nameProblem("procedure", name, "");
  return (
    <Dialog
      title="New Procedure"
      width={360}
      onClose={close}
      submitDisabled={problem !== null}
      onSubmit={() => submit({ op: "newProcedure", name })}
    >
      <Field label="Name">
        <TextInput
          aria-label="Procedure name"
          aria-invalid={problem !== null}
          className="flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div className={`pl-[104px] text-[11px] ${problem ? "text-danger" : "text-muted"}`}>
        {problem ?? `It is the file ${name}.py, which other code can import as ${name}.`}
      </div>
    </Dialog>
  );
}

/** Asks the file name to save the experiment as, then hands the user the file. */
export function SaveExperimentDialog() {
  const [value, setValue] = useState(() => experimentFileName());
  const filename = savedFileName(value);
  return (
    <Dialog
      title="Save Experiment As"
      width={400}
      onClose={close}
      submitLabel="Save"
      submitDisabled={filename === null}
      onSubmit={() => {
        if (filename && saveExperimentAs(filename)) close();
      }}
    >
      <Field label="File name">
        <TextInput
          aria-label="File name"
          aria-invalid={filename === null}
          className="flex-1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        {filename
          ? `Saved as ${filename}, where the browser puts downloads (it may ask where).`
          : "Type a file name."}
      </div>
    </Dialog>
  );
}

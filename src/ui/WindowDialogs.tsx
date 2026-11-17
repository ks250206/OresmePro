import { useState } from "react";
import {
  experimentFileName,
  leaveFor,
  saveExperimentAs,
  savedFileName,
  switchExperiment,
} from "../app/actions";
import { doc, experiment, runGui, ui, useDoc } from "../app/session";
import { procedureName, windowTaken, type Command } from "../core/doc/commands";
import type { WindowState } from "../core/doc/types";
import { Button, Checkbox, Dialog, Field, ListBox, Select, TextInput } from "./controls";

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
  note: "note",
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
      help="guides/experiments/"
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
      help="guides/python/"
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
      help="guides/experiments/"
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

/**
 * Links graphs so that their axes zoom together and their cursors follow
 * each other by X, or takes them out of their links.
 */
export function LinkGraphsDialog({ graph: initial }: { graph?: string }) {
  const graphs = useDoc((state) => state.graphs);
  const names = Object.keys(graphs).sort((a, b) => a.localeCompare(b));
  const [chosen, setChosen] = useState<string[]>(() => {
    const own = initial ? graphs[initial]?.link?.group : undefined;
    return own
      ? names.filter((name) => graphs[name]?.link?.group === own)
      : initial
        ? [initial]
        : [];
  });
  const [axes, setAxes] = useState<"x" | "xy">(
    () => (initial ? graphs[initial]?.link?.axes : undefined) ?? "x",
  );
  const [cursors, setCursors] = useState(
    () => (initial ? graphs[initial]?.link?.cursors : undefined) ?? true,
  );
  const linked = chosen.filter((name) => graphs[name]?.link);
  const describe = (name: string) => {
    const link = graphs[name]?.link;
    return link ? `${name} (${link.group})` : name;
  };
  return (
    <Dialog
      title="Link Graphs"
      width={420}
      onClose={close}
      submitLabel="Link"
      submitDisabled={chosen.length < 2}
      onSubmit={() => submit({ op: "linkGraphs", graphs: chosen, axes, cursors })}
      buttons={
        <Button
          disabled={linked.length === 0}
          onClick={() => submit({ op: "unlinkGraphs", graphs: linked })}
        >
          Unlink
        </Button>
      }
    >
      <p className="m-0 text-muted">
        Zooming or panning one of the graphs linked zooms the others alike; they start at the range
        of the first.
      </p>
      <ListBox
        label="Graphs to link"
        items={names.map((name) => ({ key: name, text: describe(name) }))}
        selected={chosen}
        onChange={setChosen}
        style={{ height: 140 }}
      />
      <Field label="Axes">
        <Select
          aria-label="Linked axes"
          value={axes}
          onChange={(event) => setAxes(event.target.value as "x" | "xy")}
        >
          <option value="x">X (bottom)</option>
          <option value="xy">X and Y (bottom and left)</option>
        </Select>
      </Field>
      <Field label="" group>
        <Checkbox
          label="Cursors follow each other by X"
          checked={cursors}
          onChange={(event) => setCursors(event.target.checked)}
        />
      </Field>
    </Dialog>
  );
}

/**
 * Asked when this experiment could not be saved before another one opens:
 * leaving now would lose what is unsaved. Try again, keep a copy as a file,
 * or leave anyway. Where this tab does not save the experiment and was
 * changed, the way to keep the changes is to save here instead.
 */
export function UnsavedLeaveDialog({ target }: { target: string }) {
  const error = experiment.getState();
  if (experiment.unsavedHere()) return <ChangedHereDialog target={target} />;
  return (
    <Dialog
      title="The Experiment Is Not Saved"
      width={440}
      onClose={close}
      submitLabel="Try Again"
      onSubmit={() => {
        close();
        void switchExperiment(target);
      }}
      buttons={
        <>
          <Button onClick={() => saveExperimentAs(experimentFileName())}>Save as File…</Button>
          <Button
            onClick={() => {
              if (window.confirm("Leave without saving? The unsaved changes are lost.")) {
                close();
                leaveFor(target);
              }
            }}
          >
            Leave Without Saving
          </Button>
        </>
      }
    >
      <p className="leading-relaxed">
        This experiment could not be saved in the browser, so opening another one now would lose the
        changes since it was last saved.
      </p>
      {error.kind === "failed" ? <p className="text-[11px] text-danger">{error.error}</p> : null}
      <p className="text-[11px] text-muted">
        Free up the browser&apos;s storage and try again, or keep a copy as a .oresme file first.
      </p>
    </Dialog>
  );
}

/** The changes of a tab that does not save its experiment, about to be left. */
function ChangedHereDialog({ target }: { target: string }) {
  const elsewhere = experiment.getState().kind === "elsewhere";
  return (
    <Dialog
      title="Changes Made in This Tab Are Not Saved"
      width={460}
      onClose={close}
      submitLabel={elsewhere ? "Save Here, Then Open" : undefined}
      onSubmit={
        elsewhere
          ? () => {
              close();
              void experiment.takeOver().then(() => switchExperiment(target));
            }
          : undefined
      }
      buttons={
        <>
          <Button onClick={() => saveExperimentAs(experimentFileName())}>Save as File…</Button>
          <Button
            onClick={() => {
              if (window.confirm("Leave without the changes made in this tab? They are lost.")) {
                close();
                leaveFor(target);
              }
            }}
          >
            Leave Without Saving
          </Button>
        </>
      }
    >
      <p className="leading-relaxed">
        {elsewhere
          ? "Another tab saves this experiment, so what was changed in this tab is kept nowhere: opening another experiment here would lose it."
          : "What is saved of this experiment could not be read, so it is not saved over, and what was changed in this tab is kept nowhere: opening another experiment here would lose it."}
      </p>
      <p className="text-[11px] text-muted">
        {elsewhere
          ? "Save Here makes this tab the one that saves the experiment, as it is here: what the other tab saved is replaced. Or keep a copy as a .oresme file first."
          : "Keep a copy as a .oresme file first, or leave without the changes."}
      </p>
    </Dialog>
  );
}

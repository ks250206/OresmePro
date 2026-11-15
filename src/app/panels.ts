import { useSyncExternalStore } from "react";
import type { ActionSpec } from "../core/actions";
import { uniqueName, windowTaken } from "../core/doc/commands";
import { codeActions, panelFile, readPanelFile, resolveButton } from "../core/doc/panels";
import { download, pickFile } from "./actions";
import {
  actionCatalog,
  doc,
  invokeAction,
  note,
  runGui,
  showError,
  subscribeCatalog,
} from "./session";
import { createStore, useStore } from "./store";

/**
 * What a panel window shows besides the document: which button's call is
 * running, what went wrong with the last press of each button, and the
 * state of building it (edit mode, the control selected). None of it is
 * saved or undone.
 */
export interface PanelRuntime {
  /** The button whose call is running, by panel. While it runs, no button of the panel starts another. */
  busy: Readonly<Record<string, string>>;
  /** What was wrong with the last press of a button, by {@link buttonKey}. */
  errors: Readonly<Record<string, string>>;
  /** The panels in edit mode. */
  editing: Readonly<Record<string, boolean>>;
  /** The control selected in a panel in edit mode, by panel. */
  selected: Readonly<Record<string, string>>;
}

export const panelRuntime = createStore<PanelRuntime>({
  busy: {},
  errors: {},
  editing: {},
  selected: {},
});

export const usePanelRuntime = <T>(selector: (state: PanelRuntime) => T): T =>
  useStore(panelRuntime, selector);

/** The key of a button in {@link PanelRuntime.errors}. */
export const buttonKey = (panel: string, button: string): string => `${panel}\u0000${button}`;

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

/** The actions there are (Python's and the plugins'), following changes. */
export const useCatalog = (): readonly ActionSpec[] =>
  useSyncExternalStore(subscribeCatalog, actionCatalog);

/**
 * Presses a button: resolves its arguments from the panel's values as they
 * are now and calls its action. Nothing happens while a call of the same
 * panel is running, so a double click calls once; values changed meanwhile
 * do not reach the running call. What is wrong (a value missing, the call
 * refused or failed) is kept to show by the button; the values stay.
 */
export function pressButton(panel: string, button: string): Promise<void> {
  if (Object.hasOwn(panelRuntime.get().busy, panel)) return Promise.resolve();
  const state = doc.getState();
  const spec = Object.hasOwn(state.panels, panel) ? state.panels[panel] : undefined;
  if (!spec) return Promise.resolve();
  const key = buttonKey(panel, button);
  const { call, problems } = resolveButton(spec, button, {
    waveExists: (name) => name in doc.getState().waves,
    catalog: actionCatalog(),
  });
  if (!call) {
    panelRuntime.set((now) => ({ errors: { ...now.errors, [key]: problems.join("\n") } }));
    return Promise.resolve();
  }
  // Marked before anything else can happen: a second click finds the panel busy.
  panelRuntime.set((now) => ({
    busy: { ...now.busy, [panel]: button },
    errors: without(now.errors, key),
  }));
  const done = (error: string | null) =>
    panelRuntime.set((now) => ({
      busy: without(now.busy, panel),
      errors: error === null ? now.errors : { ...now.errors, [key]: error },
    }));
  return invokeAction(call.action, call.args, call.version ?? undefined).then(
    () => done(null),
    (error: unknown) =>
      done((error instanceof Error ? error.message : String(error)).replace(/^OresmeError: /, "")),
  );
}

/** Puts a panel in edit mode or takes it out, widening its window for the form beside the controls. */
export function setEditing(panel: string, on: boolean): void {
  panelRuntime.set((now) => ({ editing: { ...now.editing, [panel]: on } }));
  const window = doc.getState().windows.find((item) => item.name === panel);
  if (on && window && window.w < 640) {
    doc.dispatch({ op: "moveWindow", name: panel, w: 640, h: Math.max(window.h, 360) });
  }
}

export function selectControl(panel: string, control: string | null): void {
  panelRuntime.set((now) => ({
    selected:
      control === null ? without(now.selected, panel) : { ...now.selected, [panel]: control },
  }));
}

/** Makes an empty panel and opens it for building. */
export function newPanel(): void {
  const name = runGui({ op: "newPanel" });
  if (name) setEditing(name, true);
}

/** Saves a panel to a JSON file the user downloads, for sharing. */
export function exportPanel(name: string): void {
  const panel = doc.getState().panels[name];
  if (!panel) return;
  const text = `${JSON.stringify(panelFile(panel), null, 2)}\n`;
  download(new Blob([text], { type: "application/json" }), `${name}.panel.json`);
}

/**
 * Asks for exported panels and adds each to the experiment, under its own
 * name unless a window has it already. A panel that calls the user's own
 * actions is said to, since pressing its buttons runs Python of the
 * procedures, not only the application's analyses.
 */
export function importPanels(): void {
  pickFile(".json,application/json", true, (picked) => {
    void (async () => {
      for (const file of picked) {
        try {
          const { name, ...content } = readPanelFile(await file.text());
          const taken = windowTaken(doc.getState());
          const free = taken(name) ? uniqueName(`${name}_`, taken) : name;
          if (!runGui({ op: "setPanel", name: free, panel: content })) continue;
          const actions = codeActions({ name: free, ...content });
          if (actions.length > 0) {
            note(
              `${free} calls ${actions.join(", ")}: actions of procedures, so its buttons run Python of this experiment.`,
            );
          }
        } catch (error) {
          showError(`Could not import ${file.name}`, error);
        }
      }
    })();
  });
}

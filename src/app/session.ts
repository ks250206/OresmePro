import { type Command, isTransient } from "../core/doc/commands";
import { Doc } from "../core/doc/doc";
import { echoPython } from "../core/doc/echo";
import type { AxisName, DocState } from "../core/doc/types";
import { History } from "../core/history/history";
import { layoutGraph } from "../core/plot/layout";
import { toSvg } from "../core/plot/svg";
import { KernelClient } from "../kernel/client";
import { measureText } from "./measure";
import { createStore, useStore } from "./store";
import { useSyncExternalStore } from "react";

export type DialogRequest =
  | { kind: "newGraph" }
  | { kind: "newTable" }
  | { kind: "appendTraces"; graph: string }
  | { kind: "modifyTrace"; graph: string; trace?: string }
  | { kind: "modifyAxis"; graph: string; axis?: AxisName }
  | { kind: "modifyGraph"; graph: string }
  | { kind: "addText"; graph: string }
  | { kind: "renameWave"; wave: string }
  | { kind: "duplicateWave"; wave: string }
  | { kind: "waveScaling"; wave: string }
  | { kind: "about" };

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export interface UiState {
  dialog: DialogRequest | null;
  /** A message shown in a modal box; errors from GUI actions land here. */
  alert: { title: string; message: string } | null;
  contextMenu: { x: number; y: number; items: MenuItem[] } | null;
  /** Cursor position readout shown in the status bar. */
  readout: string;
  showBrowser: boolean;
  showCommand: boolean;
  browserWidth: number;
  commandHeight: number;
  /** Waves selected in the data browser. */
  selectedWaves: readonly string[];
  /** Text waiting to be placed in the command line; the editor consumes it. */
  commandLineInsert: { text: string; token: number } | null;
}

export const doc = new Doc();
export const history = new History();
export const ui = createStore<UiState>({
  dialog: null,
  alert: null,
  contextMenu: null,
  readout: "",
  showBrowser: true,
  showCommand: true,
  browserWidth: 220,
  commandHeight: 240,
  selectedWaves: [],
  commandLineInsert: null,
});

/** Renders a graph to SVG at a given size, defaulting to its window's plot size. */
export function renderGraphSvg(name: string, width: number | null, height: number | null): string {
  const state = doc.getState();
  const graph = state.graphs[name];
  if (!graph) throw new Error(`No graph named ${JSON.stringify(name)}.`);
  const window = state.windows.find((item) => item.name === name);
  const w = width ?? (window ? window.w : 440);
  const h = height ?? (window ? window.h - TITLE_BAR_HEIGHT : 280);
  const layout = layoutGraph(graph, state.waves, w, h, measureText);
  return toSvg(layout.prims, layout.width, layout.height);
}

/** Height of a window's title bar; the content area is the window minus this. */
export const TITLE_BAR_HEIGHT = 24;

const PYODIDE_URL =
  (import.meta.env.VITE_PYODIDE_URL as string | undefined) ??
  "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

export const kernel = new KernelClient({
  doc,
  history,
  renderSvg: renderGraphSvg,
  indexURL: PYODIDE_URL,
});

export function showError(title: string, error: unknown): void {
  ui.set({ alert: { title, message: error instanceof Error ? error.message : String(error) } });
}

let batchCounter = 0;

/**
 * Performs GUI actions: applies the commands as one undo step and writes the
 * equivalent Python into the history, as Igor does for its dialogs. Returns
 * the result of the last command, or undefined if a command was rejected (the
 * user is told why).
 */
export function runGui(commands: Command | readonly Command[]): string | null | undefined {
  const list: readonly Command[] = Array.isArray(commands) ? commands : [commands as Command];
  if (list.length === 0) return null;
  batchCounter += 1;
  const group = `gui${batchCounter}`;
  const echoes: string[] = [];
  let result: string | null = null;
  try {
    for (const command of list) {
      result = doc.dispatch(command, { group });
      const echo = isTransient(command) ? null : echoPython(command);
      if (echo) echoes.push(echo);
    }
  } catch (error) {
    showError("That did not work", error);
    if (echoes.length > 0) history.add("gui", echoes.join("\n"));
    return undefined;
  }
  if (echoes.length > 0) history.add("gui", echoes.join("\n"));
  return result;
}

const pendingEchoes = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; text: () => string }
>();

/**
 * Applies commands immediately but writes their echo only once the stream of
 * calls with the same key goes quiet. For continuous gestures such as wheel
 * zooming, where one history line for the final state is what is wanted.
 */
export function runGuiCoalesced(
  key: string,
  commands: readonly Command[],
  echo: () => string,
): void {
  try {
    for (const command of commands) doc.dispatch(command, { group: `coalesced:${key}` });
  } catch (error) {
    showError("That did not work", error);
    return;
  }
  const previous = pendingEchoes.get(key);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    pendingEchoes.delete(key);
    history.add("gui", echo());
  }, 500);
  pendingEchoes.set(key, { timer, text: echo });
}

/** Records a note in the history (a file load, say) without running anything. */
export function note(text: string): void {
  history.add("system", text);
}

export function requestCommandLine(text: string): void {
  ui.set({ commandLineInsert: { text, token: Date.now() + Math.random() }, showCommand: true });
}

export function useDoc<T>(selector: (state: DocState) => T): T {
  return useSyncExternalStore(doc.subscribe, () => selector(doc.getState()));
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(ui, selector);
}

export function useKernelState() {
  return useSyncExternalStore(kernel.subscribe, kernel.getState);
}

export function useHistoryEntries() {
  return useSyncExternalStore(history.subscribe, history.getEntries);
}

/** The frontmost window, if any. */
export const activeWindow = (state: DocState) => state.windows.at(-1) ?? null;

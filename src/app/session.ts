import { type Command, isTransient } from "../core/doc/commands";
import { Doc } from "../core/doc/doc";
import { echoPython } from "../core/doc/echo";
import type { DocState } from "../core/doc/types";
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
  | { kind: "matrixPlot"; plot: "image" | "contour"; graph?: string }
  | { kind: "modifyTrace"; graph: string; trace?: string }
  | { kind: "modifyAxis"; graph: string; axis?: string }
  | { kind: "modifyImage"; graph: string; image: string }
  | { kind: "modifyContour"; graph: string; contour: string }
  | { kind: "addAxis"; graph: string }
  | { kind: "modifyGraph"; graph: string }
  | { kind: "addText"; graph: string }
  | { kind: "renameWave"; wave: string }
  | { kind: "duplicateWave"; wave: string }
  | { kind: "waveScaling"; wave: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "renameFolder"; folder: string }
  | { kind: "curveFit"; wave?: string }
  | { kind: "analysis"; operation: string; wave?: string }
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
  /** Data folders shown collapsed in the data browser. */
  collapsedFolders: readonly string[];
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
  collapsedFolders: [],
  commandLineInsert: null,
});

/** Height of a window's title bar; the content area is the window minus this. */
export const TITLE_BAR_HEIGHT = 24;
/** Height of the cursor readout bar under a graph. */
export const INFO_BAR_HEIGHT = 56;

/** The size at which a graph is drawn in its window. */
export function graphSize(state: DocState, name: string): { width: number; height: number } {
  const window = state.windows.find((item) => item.name === name);
  const info = state.graphs[name]?.showInfo ? INFO_BAR_HEIGHT : 0;
  return window
    ? { width: window.w, height: window.h - TITLE_BAR_HEIGHT - info }
    : { width: 440, height: 280 };
}

/**
 * Lays a graph out for export, at its window's size unless told otherwise.
 * Cursors are left out unless asked for, as in Igor.
 */
export function exportLayout(
  name: string,
  width: number | null,
  height: number | null,
  cursors = false,
) {
  const state = doc.getState();
  const graph = state.graphs[name];
  if (!graph) throw new Error(`No graph named ${JSON.stringify(name)}.`);
  const size = graphSize(state, name);
  return layoutGraph(graph, state.waves, width ?? size.width, height ?? size.height, measureText, {
    cursors,
  });
}

export function renderGraphSvg(
  name: string,
  width: number | null,
  height: number | null,
  cursors = false,
): string {
  const layout = exportLayout(name, width, height, cursors);
  return toSvg(layout.prims, layout.width, layout.height);
}

let exportHandler: (graph: string, filename: string, cursors: boolean) => void = () => {};
/** Lets the export code (which depends on this module) serve Python's g.save(). */
export function setExportHandler(handler: typeof exportHandler): void {
  exportHandler = handler;
}

const PYODIDE_URL =
  (import.meta.env.VITE_PYODIDE_URL as string | undefined) ??
  "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";

export const kernel = new KernelClient({
  doc,
  history,
  renderSvg: renderGraphSvg,
  exportGraph: (graph, filename, cursors) => exportHandler(graph, filename, cursors),
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

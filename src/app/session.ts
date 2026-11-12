import { type Command, isTransient } from "../core/doc/commands";
import { Doc } from "../core/doc/doc";
import { echoPython } from "../core/doc/echo";
import { figureSize, type DocState } from "../core/doc/types";
import { FileStore } from "../core/files/files";
import { History } from "../core/history/history";
import { layoutGraph } from "../core/plot/layout";
import { layoutPage } from "../core/plot/page";
import { toSvg } from "../core/plot/svg";
import { KernelClient } from "../kernel/client";
import { DEFAULT_EXPERIMENT, ExperimentSession, isExperimentId } from "./experiments";
import { PresetStore } from "./importPresets";
import { measureText } from "./measure";
import { createStore, useStore } from "./store";
import { useEffect, useSyncExternalStore } from "react";
import { browserLibrary, LIBRARY_KEY } from "./styleLibrary";

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
  | { kind: "editAnnotation"; graph: string; annotation: string }
  | { kind: "renameWave"; wave: string }
  | { kind: "duplicateWave"; wave: string }
  | { kind: "waveScaling"; wave: string }
  | { kind: "waveType"; wave: string }
  | { kind: "newFolder"; parent: string }
  | { kind: "renameFolder"; folder: string }
  | { kind: "curveFit"; wave?: string }
  | { kind: "analysis"; operation: string; wave?: string }
  | { kind: "background"; wave?: string }
  | { kind: "onset"; wave?: string }
  | { kind: "graphScript"; graph: string }
  /** The styles of the experiment and the library; `graph` is the one to save or apply to. */
  | { kind: "styles"; graph?: string }
  | { kind: "timeZone" }
  | { kind: "pageText"; layout: string; item?: string }
  /** `items`: the graphs to put in the grid, in order; empty for all of the page's graphs. */
  | { kind: "arrangeLayout"; layout: string; items: readonly string[] }
  | { kind: "importData"; file: PendingData; rest: readonly PendingData[] }
  | { kind: "experiments" }
  | { kind: "about" };

/** A file of data read into memory, waiting to be loaded through the Load Data dialog. */
export interface PendingData {
  name: string;
  bytes: Uint8Array;
}

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
  /** Items of a menu that opens beside this one. */
  submenu?: MenuItem[];
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
  /**
   * The items selected on each page layout, by layout name, in the order they
   * were selected: the first is what "same size" matches.
   */
  pageSelection: Readonly<Record<string, readonly string[]>>;
  /** Text waiting to be placed in the command line; the editor consumes it. */
  commandLineInsert: { text: string; token: number } | null;
}

export const doc = new Doc();
export const history = new History();
/** The experiment's files: what Python wrote, and what was added for it to read. */
export const files = new FileStore();
const LAST_EXPERIMENT = "oresme.experiment";

/** The experiment this tab is for: the one named in the address, or the one opened last. */
function experimentId(): string {
  if (typeof location === "undefined") return DEFAULT_EXPERIMENT;
  const named = /^#e=([a-z0-9]+)$/.exec(location.hash)?.[1];
  if (isExperimentId(named)) return named;
  try {
    const last = localStorage.getItem(LAST_EXPERIMENT);
    if (isExperimentId(last)) return last;
  } catch {
    // No storage for it: the first experiment.
  }
  return DEFAULT_EXPERIMENT;
}

/** Keeps the experiment in the browser, and decides whether this tab is the one saving it. */
export const experiment = new ExperimentSession({ doc, history, files }, experimentId());

/** Opens the experiment in this tab, to be opened again by a tab that names none. */
export async function startExperiment(): Promise<void> {
  try {
    localStorage.setItem(LAST_EXPERIMENT, experiment.id);
  } catch {
    // It is only a convenience.
  }
  await experiment.start();
}

/** Ways of reading data files, kept in the browser from one experiment to the next. */
export const importPresets = new PresetStore();
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
  pageSelection: {},
  commandLineInsert: null,
});

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** How the command key is written in menus. */
export const MOD = isMac ? "⌘" : "Ctrl+";

export { INFO_BAR_HEIGHT, TITLE_BAR_HEIGHT } from "../core/doc/types";

/** The size at which a graph is drawn in its window. */
export function graphSize(state: DocState, name: string): { width: number; height: number } {
  const window = state.windows.find((item) => item.name === name);
  return window ? figureSize(window, state.graphs[name]) : { width: 440, height: 280 };
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
    timeZone: state.timeZone,
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

/** Lays a page layout out, in points. */
export function pageLayout(name: string) {
  const state = doc.getState();
  const page = state.pages[name];
  if (!page) throw new Error(`No page layout named ${JSON.stringify(name)}.`);
  return layoutPage(page, state, measureText);
}

export function renderPageSvg(name: string): string {
  const layout = pageLayout(name);
  return toSvg(layout.prims, layout.width, layout.height);
}

let pageExportHandler: (page: string, filename: string) => void = () => {};
export function setPageExportHandler(handler: typeof pageExportHandler): void {
  pageExportHandler = handler;
}

let exportHandler: (graph: string, filename: string, cursors: boolean) => void = () => {};
/** Lets the export code (which depends on this module) serve Python's g.save(). */
export function setExportHandler(handler: typeof exportHandler): void {
  exportHandler = handler;
}

// Pyodide is served with the app (see scripts/fetch-pyodide.mjs). The worker
// imports it by URL, so the URL has to be absolute.
export const PYODIDE_URL =
  (import.meta.env.VITE_PYODIDE_URL as string | undefined) ??
  new URL(`${import.meta.env.BASE_URL}pyodide/`, globalThis.location?.href ?? "http://localhost/")
    .href;

/** The Python that runs a procedure, as it is written into the history. */
export const runProcedureCode = (name: string): string =>
  `op.procedure(${JSON.stringify(name)}).run()`;

/**
 * Runs the procedures of the experiment, as Igor compiles its procedure
 * windows: what they define is there whenever Python is, after a restart or
 * after opening an experiment.
 */
function runProcedures(): void {
  for (const procedure of Object.values(doc.getState().procedures)) {
    if (procedure.autoRun && procedure.code.trim()) {
      kernel.execute(runProcedureCode(procedure.name), "gui");
    }
  }
}

export const kernel: KernelClient = new KernelClient({
  doc,
  history,
  files,
  onStart: runProcedures,
  renderSvg: renderGraphSvg,
  exportGraph: (graph, filename, cursors) => exportHandler(graph, filename, cursors),
  renderPageSvg,
  exportPage: (page, filename) => pageExportHandler(page, filename),
  measureText,
  importPresets: () => importPresets.list(),
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
 *
 * `echo` is the Python to write instead of a line per command, for an action
 * that Python does in one call although it takes several commands. Should a
 * command fail midway, the lines for those that ran are written instead.
 */
export function runGui(
  commands: Command | readonly Command[],
  options: { echo?: string } = {},
): string | null | undefined {
  const list: readonly Command[] = Array.isArray(commands) ? commands : [commands as Command];
  if (list.length === 0) return null;
  batchCounter += 1;
  const group = `gui${batchCounter}`;
  const echoes: string[] = [];
  let result: string | null = null;
  try {
    for (const command of list) {
      result = doc.dispatch(command, { group });
      const echo = isTransient(command)
        ? null
        : echoPython(command, (wave) => doc.getState().waves[wave]?.shape);
      if (echo) echoes.push(echo);
    }
  } catch (error) {
    showError("That did not work", error);
    if (echoes.length > 0) history.add("gui", echoes.join("\n"));
    return undefined;
  }
  if (options.echo !== undefined) history.add("gui", options.echo);
  else if (echoes.length > 0) history.add("gui", echoes.join("\n"));
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

export function useExperimentState() {
  return useSyncExternalStore(experiment.subscribe, experiment.getState);
}

export function useExperimentInfo() {
  return useSyncExternalStore(experiment.subscribe, experiment.getInfo);
}

export function useKernelState() {
  return useSyncExternalStore(kernel.subscribe, kernel.getState);
}

export function useFiles() {
  return useSyncExternalStore(files.subscribe, files.list);
}

/** The styles in the browser's library, following changes made in other tabs too. */
export function useLibraryStyles() {
  const library = browserLibrary();
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === LIBRARY_KEY) library.changed();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [library]);
  return useSyncExternalStore(library.subscribe, library.list);
}

export function useHistoryEntries() {
  return useSyncExternalStore(history.subscribe, history.getEntries);
}

/** The frontmost window, if any. */
export const activeWindow = (state: DocState) => state.windows.at(-1) ?? null;

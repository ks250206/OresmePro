import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { applyCommand, checkName } from "../doc/commands";
import { dict, dictFrom } from "../doc/dict";
import {
  AXIS_SIDES,
  CURSOR_NAMES,
  DEFAULT_TABLE_DIGITS,
  defaultAxis,
  defaultTraceStyle,
  emptyDoc,
  type AxisSide,
  type AxisSpec,
  type DocState,
  type GraphSpec,
  type PageSpec,
  type ProcedureSpec,
  type TableSpec,
  type TraceSpec,
  type Wave,
  type WindowState,
} from "../doc/types";
import type { HistoryEntry } from "../history/history";
import { isTimeZone } from "../plot/ticks";
import { decodeNpy, encodeNpy } from "./npy";

/**
 * The saved form of an experiment: `experiment.json` describes everything,
 * numeric wave data sits beside it as .npy files (readable with NumPy), and
 * `history.json` holds the command history. The same layout is used for the
 * browser's private storage and, zipped, for .oresme files.
 */
export interface SavedWave {
  name: string;
  /** The .npy file with the values; null for a text wave. */
  file: string | null;
  text?: readonly string[];
  x0: number;
  dx: number;
  xUnit: string;
  y0?: number;
  dy?: number;
  yUnit?: string;
  unit: string;
  note: string;
}

export interface SavedExperiment {
  version: number;
  waves: SavedWave[];
  folders?: string[];
  graphs: Record<string, GraphSpec>;
  tables: Record<string, TableSpec>;
  procedures?: Record<string, ProcedureSpec>;
  pages?: Record<string, PageSpec>;
  timeZone?: string;
  windows: WindowState[];
}

/** Where the experiment's files (see FileStore) sit in an .oresme archive. */
const FILES_PREFIX = "files/";

const MAX_SAVED_ENTRIES = 2000;
const MAX_SAVED_IMAGE = 300_000;

export function describeExperiment(
  state: DocState,
  fileFor: (wave: Wave) => string,
): SavedExperiment {
  return {
    version: 2,
    waves: state.waveOrder.map((name) => {
      const wave = state.waves[name]!;
      const { x0, dx, xUnit, y0, dy, yUnit, unit, note } = wave;
      const scaling = { x0, dx, xUnit, y0, dy, yUnit, unit, note };
      return wave.text
        ? { name, file: null, text: wave.text, ...scaling }
        : { name, file: fileFor(wave), ...scaling };
    }),
    folders: [...state.folders],
    graphs: dictFrom(state.graphs),
    tables: dictFrom(state.tables),
    procedures: dictFrom(state.procedures),
    pages: dictFrom(state.pages),
    timeZone: state.timeZone,
    windows: [...state.windows],
  };
}

/** Fills in what graphs saved by earlier versions do not have. */
function upgradeGraph(graphName: string, saved: GraphSpec): GraphSpec {
  const axes = dict<AxisSpec>();
  for (const side of AXIS_SIDES) axes[side] = defaultAxis(side);
  for (const [name, axis] of Object.entries(saved.axes ?? {})) {
    const side = (axis.side as AxisSide | undefined) ?? (name as AxisSide);
    axes[checkName(name, "axis")] = { ...defaultAxis(side), ...axis, side };
  }
  const cursors = saved.cursors ?? {};
  return {
    ...saved,
    name: graphName,
    traces: (saved.traces ?? []).map((trace, index): TraceSpec => ({
      ...defaultTraceStyle(index),
      ...trace,
    })),
    images: (saved.images ?? []).map((image) => ({
      ...image,
      layer: image.layer ?? 0,
      chunk: image.chunk ?? 0,
      part: image.part ?? "real",
    })),
    contours: (saved.contours ?? []).map((contour) => ({
      ...contour,
      layer: contour.layer ?? 0,
      chunk: contour.chunk ?? 0,
      labels: contour.labels ?? false,
    })),
    annotations: (saved.annotations ?? []).map((annotation) => ({
      ...annotation,
      x: annotation.x ?? 0,
      y: annotation.y ?? 0,
      trace: annotation.trace ?? null,
      point: annotation.point ?? 0,
    })),
    cursors: dict(
      CURSOR_NAMES.filter((cursor) => Object.hasOwn(cursors, cursor)).map((cursor) => [
        cursor,
        cursors[cursor]!,
      ]),
    ),
    showInfo: saved.showInfo ?? false,
    axes,
  };
}

/** Rebuilds a document from its saved description and the files it refers to. */
export function buildState(
  saved: SavedExperiment,
  files: ReadonlyMap<string, Uint8Array>,
): DocState {
  let state = emptyDoc();
  for (const folder of saved.folders ?? []) {
    if (!state.folders.includes(folder)) {
      state = applyCommand(state, { op: "newFolder", path: folder }).state;
    }
  }
  for (const item of saved.waves) {
    const { name, x0, dx, xUnit, y0, dy, yUnit, unit, note } = item;
    const scaling = { x0, dx, xUnit, y0, dy, yUnit, unit, note };
    if (item.file === null) {
      state = applyCommand(state, {
        op: "makeWave",
        name,
        text: item.text ?? [],
        ...scaling,
      }).state;
      continue;
    }
    const bytes = files.get(item.file);
    if (!bytes) throw new Error(`The experiment is missing ${item.file}.`);
    // Waves are rebuilt through makeWave so the document assigns their revisions.
    state = applyCommand(state, { op: "makeWave", name, ...decodeNpy(bytes), ...scaling }).state;
  }
  // Names are checked as the commands that make these would check them. The
  // records are rebuilt without a prototype (see ../doc/dict), whatever JSON gave.
  const graphs = dict<GraphSpec>();
  for (const [name, graph] of Object.entries(saved.graphs)) {
    graphs[checkName(name, "graph")] = upgradeGraph(name, graph);
  }
  const tables = dict<TableSpec>();
  for (const [name, table] of Object.entries(saved.tables)) {
    tables[checkName(name, "table")] = {
      ...table,
      name,
      digits: table.digits ?? DEFAULT_TABLE_DIGITS,
      widths: dictFrom(table.widths),
    };
  }
  const procedures = dict<ProcedureSpec>();
  for (const [name, procedure] of Object.entries(saved.procedures ?? {})) {
    procedures[checkName(name, "procedure")] = {
      name,
      code: procedure.code ?? "",
      autoRun: procedure.autoRun ?? true,
    };
  }
  // A window whose content did not come along would be an empty frame.
  const pages = dict<PageSpec>();
  for (const [name, page] of Object.entries(saved.pages ?? {})) {
    checkName(name, "page layout");
    // A page keeps only the graphs that came along.
    const items = (page.items ?? []).filter((item) => item.graph === null || item.graph in graphs);
    pages[name] = { ...page, name, items };
  }
  const windows = saved.windows.filter(
    (window) =>
      window.name in graphs ||
      window.name in tables ||
      window.name in procedures ||
      window.name in pages,
  );
  const timeZone = isTimeZone(saved.timeZone) ? saved.timeZone : "UTC";
  return { ...state, graphs, tables, procedures, pages, timeZone, windows };
}

/** The history as it is saved: bounded, and without oversized inline images. */
export function trimHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.slice(-MAX_SAVED_ENTRIES).map((entry) => ({
    ...entry,
    outputs: entry.outputs.map((output) =>
      output.kind === "result" &&
      (output.svg?.length ?? 0) + (output.png?.length ?? 0) > MAX_SAVED_IMAGE
        ? { kind: "result" as const, text: output.text }
        : output,
    ),
  }));
}

/** Packs an experiment into a single .oresme file (a zip archive). */
export function zipExperiment(
  state: DocState,
  entries: readonly HistoryEntry[],
  stored: Iterable<{ path: string; bytes: Uint8Array }> = [],
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const { path, bytes } of stored) files[FILES_PREFIX + path] = bytes;
  let counter = 0;
  const saved = describeExperiment(state, (wave) => {
    counter += 1;
    const file = `waves/${counter}.npy`;
    files[file] = encodeNpy(wave.data, wave.shape, wave.type, wave.imag);
    return file;
  });
  files["experiment.json"] = strToU8(JSON.stringify(saved));
  files["history.json"] = strToU8(JSON.stringify(trimHistory(entries)));
  return zipSync(files, { level: 6 });
}

export function unzipExperiment(bytes: Uint8Array): {
  state: DocState;
  history: HistoryEntry[];
  files: [string, Uint8Array][];
} {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This is not an OresmePro experiment file.");
  }
  const index = files["experiment.json"];
  if (!index) throw new Error("This is not an OresmePro experiment file.");
  const saved = JSON.parse(strFromU8(index)) as SavedExperiment;
  const history = files["history.json"]
    ? (JSON.parse(strFromU8(files["history.json"])) as HistoryEntry[])
    : [];
  const stored = Object.entries(files)
    .filter(([name]) => name.startsWith(FILES_PREFIX) && !name.endsWith("/"))
    .map(([name, data]): [string, Uint8Array] => [name.slice(FILES_PREFIX.length), data]);
  return { state: buildState(saved, new Map(Object.entries(files))), history, files: stored };
}

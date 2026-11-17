import { strFromU8, strToU8, unzip, unzipSync, zip, zipSync } from "fflate";
import {
  applyCommand,
  checkGraphTemplate,
  checkEditorMemory,
  checkName,
  checkStyle,
  editorMemoryKey,
  savedPlotSize,
} from "../doc/commands";
import { checkAttributeName, checkAttributeValue, isFolderKey } from "../doc/attributes";
import { dict, dictFrom } from "../doc/dict";
import { savedPythonEnv, type PythonEnv } from "../doc/pythonEnv";
import { formulaCurrent, parseFormula } from "../doc/formula";
import { checkPanel } from "../doc/panels";
import { checkResult, type AnalysisResult } from "../doc/results";
import {
  checkAnalysisTemplate,
  checkRun,
  type AnalysisTemplate,
  type TemplateRun,
} from "../doc/analysisTemplates";
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
  type EditorMemory,
  type GraphSpec,
  type PageSpec,
  type PanelSpec,
  defaultDrawing,
  DRAWING_KINDS,
  type NoteSpec,
  type ProcedureSpec,
  type GraphTemplate,
  type StyleSpec,
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
  /** Left out for a wave without a formula. */
  formula?: SavedFormula;
}

/**
 * A wave's formula as saved. Revisions are not (a loaded document has new
 * ones), so whether the values were out of date is kept instead.
 */
export interface SavedFormula {
  expr: string;
  auto: boolean;
  /** True when the values were not those the inputs give (a manual formula not recalculated). */
  stale?: boolean;
  error?: string;
  zeroDivisions?: number;
}

export interface SavedExperiment {
  version: number;
  waves: SavedWave[];
  folders?: string[];
  graphs: Record<string, GraphSpec>;
  tables: Record<string, TableSpec>;
  procedures?: Record<string, ProcedureSpec>;
  pages?: Record<string, PageSpec>;
  panels?: Record<string, PanelSpec>;
  notes?: Record<string, NoteSpec>;
  styles?: Record<string, StyleSpec>;
  defaultStyle?: string | null;
  graphTemplates?: Record<string, GraphTemplate>;
  results?: Record<string, AnalysisResult>;
  templates?: Record<string, AnalysisTemplate>;
  runs?: Record<string, TemplateRun>;
  timeZone?: string;
  windows: WindowState[];
  /** By data folder ("run1:") or wave; left out by files from before attributes. */
  attributes?: Record<string, Record<string, number | string>>;
  /** The Python packages it uses; left out by files from before. */
  python?: PythonEnv;
  /** What plugins' editors and views held, by "<plugin>/<editor>"; left out by files from before. */
  editors?: Record<string, EditorMemory>;
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
      const saved: SavedWave = wave.text
        ? { name, file: null, text: wave.text, ...scaling }
        : { name, file: fileFor(wave), ...scaling };
      const { formula } = wave;
      if (formula) {
        saved.formula = { expr: formula.expr, auto: formula.auto };
        if (!formulaCurrent(state, name, formula)) saved.formula.stale = true;
        if (formula.error !== null) saved.formula.error = formula.error;
        if (formula.zeroDivisions > 0) saved.formula.zeroDivisions = formula.zeroDivisions;
      }
      return saved;
    }),
    folders: [...state.folders],
    graphs: dictFrom(state.graphs),
    tables: dictFrom(state.tables),
    procedures: dictFrom(state.procedures),
    pages: dictFrom(state.pages),
    panels: dictFrom(state.panels),
    notes: dictFrom(state.notes),
    styles: dictFrom(state.styles),
    defaultStyle: state.defaultStyle,
    graphTemplates: dictFrom(state.graphTemplates),
    results: dictFrom(state.results),
    templates: dictFrom(state.templates),
    runs: dictFrom(state.runs),
    timeZone: state.timeZone,
    windows: [...state.windows],
    attributes: dictFrom(state.attributes),
    python: state.python,
    editors: dictFrom(state.editors),
  };
}

/** A graph's link as saved, or null where there is none or it cannot be read. */
function savedLink(value: unknown): GraphSpec["link"] {
  if (typeof value !== "object" || value === null) return null;
  const { group, axes, cursors } = value as Record<string, unknown>;
  if (typeof group !== "string" || !group) return null;
  return { group, axes: axes === "xy" ? "xy" : "x", cursors: cursors !== false };
}

/** Fills in what graphs saved by earlier versions do not have. */
function upgradeGraph(
  graphName: string,
  saved: GraphSpec,
  styles: Readonly<Record<string, StyleSpec>>,
): GraphSpec {
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
    // Older experiments have none; one that cannot be read does not keep the graph from opening.
    drawings: (saved.drawings ?? []).flatMap((drawing) =>
      drawing && (DRAWING_KINDS as readonly string[]).includes(drawing.kind)
        ? [{ ...defaultDrawing(drawing.kind), ...drawing }]
        : [],
    ),
    cursors: dict(
      CURSOR_NAMES.filter((cursor) => Object.hasOwn(cursors, cursor)).map((cursor) => [
        cursor,
        cursors[cursor]!,
      ]),
    ),
    showInfo: saved.showInfo ?? false,
    marginLeft: saved.marginLeft ?? null,
    marginBottom: saved.marginBottom ?? null,
    marginRight: saved.marginRight ?? null,
    marginTop: saved.marginTop ?? null,
    magnification: saved.magnification ?? 1,
    link: savedLink(saved.link),
    ...savedPlotSize(saved.width, saved.height, axes),
    style: typeof saved.style === "string" && saved.style in styles ? saved.style : null,
    axes,
  };
}

/**
 * Gives the waves of a document being rebuilt the formulas they were saved
 * with, up to date as they were then: as of the revisions the waves have
 * now, or, for values that were out of date, of none. A formula that cannot
 * be read (from a later version, say) is left behind; the values stay.
 */
function withFormulas(state: DocState, saved: readonly SavedWave[]): DocState {
  const waves = dictFrom(state.waves);
  for (const item of saved) {
    const wave = waves[item.name];
    const formula = item.formula;
    if (!wave || !formula || typeof formula.expr !== "string") continue;
    let inputs: readonly string[];
    try {
      inputs = parseFormula(formula.expr).inputs;
    } catch {
      continue;
    }
    // Revisions start at 1, so -1 matches no wave: the values stay out of date.
    const stale = formula.stale === true;
    waves[item.name] = {
      ...wave,
      formula: {
        expr: formula.expr,
        auto: formula.auto !== false,
        inputs: dict(
          inputs.map((input) => [input, stale ? -1 : (state.waves[input]?.rev ?? null)]),
        ),
        rev: stale ? -1 : wave.rev,
        error: typeof formula.error === "string" ? formula.error : null,
        zeroDivisions: typeof formula.zeroDivisions === "number" ? formula.zeroDivisions : 0,
      },
    };
  }
  return { ...state, waves };
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
  state = withFormulas(state, saved.waves);
  // Names are checked as the commands that make these would check them. The
  // records are rebuilt without a prototype (see ../doc/dict), whatever JSON gave.
  const styles = dict<StyleSpec>();
  for (const [name, style] of Object.entries(saved.styles ?? {})) {
    checkName(name, "style");
    // A style that cannot be read (one written by a later version, say) is
    // left behind rather than keeping the experiment's data from opening.
    try {
      styles[name] = checkStyle(style);
    } catch {
      continue;
    }
  }
  const defaultStyle =
    typeof saved.defaultStyle === "string" && saved.defaultStyle in styles
      ? saved.defaultStyle
      : null;
  const graphTemplates = dict<GraphTemplate>();
  for (const [name, template] of Object.entries(saved.graphTemplates ?? {})) {
    checkName(name, "graph template");
    // As with styles: one that cannot be read does not keep the data from opening.
    try {
      graphTemplates[name] = checkGraphTemplate(template);
    } catch {
      continue;
    }
  }
  const graphs = dict<GraphSpec>();
  for (const [name, graph] of Object.entries(saved.graphs)) {
    graphs[checkName(name, "graph")] = upgradeGraph(name, graph, styles);
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
      importAs: typeof procedure.importAs === "string" ? procedure.importAs : null,
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
  const panels = dict<PanelSpec>();
  for (const [name, panel] of Object.entries(saved.panels ?? {})) {
    checkName(name, "panel");
    // As with styles: one that cannot be read does not keep the data from opening.
    try {
      panels[name] = { name, ...checkPanel({ title: panel.title, controls: panel.controls }) };
    } catch {
      continue;
    }
  }
  const notes = dict<NoteSpec>();
  for (const [name, note] of Object.entries(saved.notes ?? {})) {
    checkName(name, "note");
    notes[name] = { name, text: typeof note?.text === "string" ? note.text : "" };
  }
  const windows = saved.windows.filter(
    (window) =>
      window.name in graphs ||
      window.name in tables ||
      window.name in procedures ||
      window.name in pages ||
      window.name in panels ||
      window.name in notes,
  );
  const results = dict<AnalysisResult>();
  for (const [name, result] of Object.entries(saved.results ?? {})) {
    checkName(name, "result");
    // As with styles: one that cannot be read does not keep the data from opening.
    try {
      results[name] = checkResult(result, name, null);
    } catch {
      continue;
    }
  }
  const templates = dict<AnalysisTemplate>();
  for (const [name, template] of Object.entries(saved.templates ?? {})) {
    checkName(name, "template");
    try {
      templates[name] = checkAnalysisTemplate(template);
    } catch {
      continue;
    }
  }
  const runs = dict<TemplateRun>();
  for (const [name, run] of Object.entries(saved.runs ?? {})) {
    checkName(name, "run");
    try {
      runs[name] = checkRun(run, name);
    } catch {
      continue;
    }
  }
  const timeZone = isTimeZone(saved.timeZone) ? saved.timeZone : "UTC";
  // Those of waves and folders that are there, with names and values that can be read.
  const attributes = dict<Record<string, number | string>>();
  for (const [key, values] of Object.entries(saved.attributes ?? {})) {
    const there = isFolderKey(key) ? state.folders.includes(key.slice(0, -1)) : key in state.waves;
    if (!there || typeof values !== "object" || values === null) continue;
    const kept: Record<string, number | string> = {};
    for (const [name, value] of Object.entries(values)) {
      try {
        kept[checkAttributeName(name)] = checkAttributeValue(value, name);
      } catch {
        continue;
      }
    }
    if (Object.keys(kept).length > 0) attributes[key] = kept;
  }
  // As with results: one that cannot be read is left behind, the plugin starts afresh.
  const editors = dict<EditorMemory>();
  for (const value of Object.values(saved.editors ?? {})) {
    try {
      const memory = checkEditorMemory(value);
      editors[editorMemoryKey(memory.plugin, memory.editor)] = memory;
    } catch {
      continue;
    }
  }
  return {
    ...state,
    graphs,
    tables,
    procedures,
    pages,
    panels,
    notes,
    styles,
    defaultStyle,
    graphTemplates,
    results,
    templates,
    runs,
    timeZone,
    windows,
    attributes,
    python: savedPythonEnv(saved.python),
    editors,
  };
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

/** The files of an experiment's .oresme archive, by their path in it. */
function experimentFiles(
  state: DocState,
  entries: readonly HistoryEntry[],
  stored: Iterable<{ path: string; bytes: Uint8Array }>,
): Record<string, Uint8Array> {
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
  return files;
}

/** Packs an experiment into a single .oresme file (a zip archive). */
export function zipExperiment(
  state: DocState,
  entries: readonly HistoryEntry[],
  stored: Iterable<{ path: string; bytes: Uint8Array }> = [],
): Uint8Array {
  return zipSync(experimentFiles(state, entries, stored), { level: 6 });
}

/**
 * As zipExperiment, with the large files compressed in workers, so that the
 * page goes on answering meanwhile. What is given is copied to them, not
 * handed over: the experiment's arrays stay as they are.
 */
export function zipExperimentAsync(
  state: DocState,
  entries: readonly HistoryEntry[],
  stored: Iterable<{ path: string; bytes: Uint8Array }> = [],
): Promise<Uint8Array> {
  const files = experimentFiles(state, entries, stored);
  return new Promise((resolve, reject) =>
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data))),
  );
}

type OpenedExperiment = {
  state: DocState;
  history: HistoryEntry[];
  files: [string, Uint8Array][];
};

const NOT_AN_EXPERIMENT = "This is not an OresmePro experiment file.";

export function unzipExperiment(bytes: Uint8Array): OpenedExperiment {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(NOT_AN_EXPERIMENT);
  }
  return readExperimentFiles(files);
}

/** As unzipExperiment, with the large files decompressed in workers. */
export async function unzipExperimentAsync(bytes: Uint8Array): Promise<OpenedExperiment> {
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, (error, data) => (error ? reject(new Error(NOT_AN_EXPERIMENT)) : resolve(data))),
  );
  return readExperimentFiles(files);
}

function readExperimentFiles(files: Record<string, Uint8Array>): OpenedExperiment {
  const index = files["experiment.json"];
  if (!index) throw new Error(NOT_AN_EXPERIMENT);
  const saved = JSON.parse(strFromU8(index)) as SavedExperiment;
  const history = files["history.json"]
    ? (JSON.parse(strFromU8(files["history.json"])) as HistoryEntry[])
    : [];
  const stored = Object.entries(files)
    .filter(([name]) => name.startsWith(FILES_PREFIX) && !name.endsWith("/"))
    .map(([name, data]): [string, Uint8Array] => [name.slice(FILES_PREFIX.length), data]);
  return { state: buildState(saved, new Map(Object.entries(files))), history, files: stored };
}

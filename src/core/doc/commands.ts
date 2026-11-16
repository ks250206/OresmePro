import { MAX_PLOT_SIZE, MIN_PLOT_SIZE, SCREEN_UNITS_PER_POINT, toPoints } from "../plot/plotSize";
import { isTickFormat, isTimeZone } from "../plot/ticks";
import { normalizeColor } from "./colors";
import {
  checkAttributeName,
  checkAttributeValue,
  dropAttributes,
  isFolderKey,
  renameAttributeKeys,
} from "./attributes";
import { dict, filterDict, withEntry, withoutEntries, type Dict } from "./dict";
import { checkPackage, withPackages, withoutPackages } from "./pythonEnv";
import {
  checkCycle,
  evaluateFormula,
  formulaCurrent,
  formulaOrder,
  FormulaError,
  parseFormula,
  renameInFormula,
  type FormulaOutcome,
} from "./formula";
import {
  checkResult,
  keptFolder,
  renameInResult,
  RESULT_BASE,
  RESULT_KINDS,
  type AnalysisResult,
} from "./results";
import { captureTemplate, makeFromTemplate, RESERVED_SLOT_NAMES } from "./graphTemplates";
import { applyPanelCommand, renameInPanels } from "./panels";
import {
  checkAnalysisTemplate,
  checkRun,
  renameInRun,
  renameResultInRun,
  RUN_BASE,
  withSampleOutcome,
  type AnalysisTemplate,
  type SampleOutcome,
  type TemplateRun,
} from "./analysisTemplates";
import { axisLook, captureStyle, styledGraph, styledWindows, traceLook } from "./styles";
import {
  ANCHORS,
  ANNOTATION_KINDS,
  AXIS_DATA,
  AXIS_LOOK,
  AXIS_ROLES,
  AXIS_SIDES,
  COLOR_TABLES,
  COMPLEX_PARTS,
  CURSOR_NAMES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_TABLE_DIGITS,
  DocError,
  FILL_MODES,
  GRAPH_LOOK,
  GRID_MODES,
  LABEL_STYLES,
  AXIS_LABEL_MODES,
  MAX_MAGNIFICATION,
  MAX_MARGIN,
  MIN_MAGNIFICATION,
  LENGTH_UNITS,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  PAGE_SIZES,
  PLOT_SIZE_MODES,
  SLOT_ROLES,
  TAG_OFFSET,
  TICK_MODES,
  TRACE_DATA,
  TRACE_LOOK,
  TRACE_MODES,
  WAVE_TYPES,
  isComplexType,
  newWaveData,
  storeValues,
  toWaveData,
  typeOfData,
  type WaveData,
  defaultAxis,
  defaultTraceStyle,
  infoBarHeight,
  figureSize,
  windowSizeFor,
  dependsOnOther,
  sizeAxes,
  AUTO_SIZE,
  isVerticalSide,
  leafName,
  parentFolder,
  type AnnotationSpec,
  type AxisLook,
  type AxisRole,
  type AxisSide,
  type AxisSpec,
  type ContourSpec,
  type CursorName,
  type DocState,
  type ErrorSource,
  type Formula,
  type FigureSize,
  type GraphLook,
  type GraphSpec,
  type GraphStyle,
  type GraphTemplate,
  type ImageSpec,
  type PlotDimension,
  type TableSpec,
  type StyleSpec,
  type TemplateAnnotation,
  type TemplateAxis,
  type TemplateContour,
  type TemplateImage,
  type TemplateSlot,
  type TemplateTrace,
  type TraceLook,
  type TraceSpec,
  type TraceStyle,
  type Wave,
  type WindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type PageItem,
  type PageSpec,
  type ProcedureSpec,
} from "./types";

type Props = Readonly<Record<string, unknown>>;

/**
 * Every change to the document is one of these. GUI actions and the Python
 * API both go through {@link applyCommand}, so they cannot disagree.
 */
export type Command =
  | {
      op: "makeWave";
      name: string;
      /** Numeric values in C order. Give either this or `text`. */
      data?: WaveData;
      /** The imaginary parts, for a complex wave. */
      imag?: WaveData;
      /** The number type; by default the type of `data`. Values are converted to it. */
      type?: string;
      text?: readonly string[];
      /** Defaults to one dimension. */
      shape?: readonly number[];
      x0?: number;
      dx?: number;
      xUnit?: string;
      y0?: number;
      dy?: number;
      yUnit?: string;
      unit?: string;
      note?: string;
      /** Defaults to true, like Igor's Make/O. */
      overwrite?: boolean;
    }
  | {
      op: "setWaveData";
      name: string;
      data?: WaveData;
      imag?: WaveData;
      type?: string;
      text?: readonly string[];
      shape?: readonly number[];
    }
  | {
      /**
       * Writes a run of points from `start`. `imag` holds the imaginary parts
       * for a complex wave; left out, they stay as they are.
       */
      op: "setWavePoints";
      name: string;
      start: number;
      values: ArrayLike<number>;
      imag?: ArrayLike<number>;
    }
  /** Changes a wave's number type, converting its values (Igor's Redimension). */
  | { op: "redimension"; name: string; type: string }
  | { op: "setWaveText"; name: string; start: number; values: readonly string[] }
  | { op: "insertPoints"; name: string; at: number; count: number }
  | { op: "deletePoints"; name: string; at: number; count: number }
  | {
      op: "setWaveScale";
      name: string;
      x0?: number;
      dx?: number;
      xUnit?: string;
      y0?: number;
      dy?: number;
      yUnit?: string;
    }
  | { op: "setWaveMeta"; name: string; unit?: string; note?: string }
  | { op: "renameWave"; name: string; newName: string }
  /**
   * Gives a wave a formula and computes it now, making the wave if it does
   * not exist (see ./formula). `auto` (true when left out) keeps it up to
   * date as its inputs change; otherwise it is computed again only by
   * recalculate. An `expr` of null removes the formula and keeps the values.
   */
  | { op: "setFormula"; name: string; expr: string | null; auto?: boolean }
  /** Computes again the formulas of these waves (all, when left out) that are out of date or failed. */
  | { op: "recalculate"; names?: readonly string[] }
  | { op: "duplicateWave"; name: string; newName: string; overwrite?: boolean }
  | { op: "killWaves"; names: readonly string[] }
  | { op: "newFolder"; path: string }
  | { op: "renameFolder"; path: string; newPath: string }
  | { op: "killFolder"; path: string }
  | {
      op: "display";
      y: readonly string[];
      x?: string | null;
      name?: string;
      /** The style to give the new graph: left out, the default style; null, none. */
      style?: string | null;
    }
  | {
      op: "appendTraces";
      graph: string;
      y: readonly string[];
      x?: string | null;
      vAxis?: string;
      hAxis?: string;
    }
  | { op: "removeTraces"; graph: string; traces: readonly string[] }
  | { op: "modifyTrace"; graph: string; trace: string; props: Props }
  | { op: "addAxis"; graph: string; name: string; side: string }
  | { op: "removeAxis"; graph: string; axis: string }
  | { op: "modifyAxis"; graph: string; axis: string; props: Props }
  | { op: "modifyGraph"; graph: string; props: Props }
  | {
      op: "appendImage";
      graph: string;
      wave: string;
      vAxis?: string;
      hAxis?: string;
      props?: Props;
    }
  | { op: "modifyImage"; graph: string; image: string; props: Props }
  | { op: "removeImage"; graph: string; image: string }
  | {
      op: "appendContour";
      graph: string;
      wave: string;
      vAxis?: string;
      hAxis?: string;
      props?: Props;
    }
  | { op: "modifyContour"; graph: string; contour: string; props: Props }
  | { op: "removeContour"; graph: string; contour: string }
  | { op: "setCursor"; graph: string; cursor: string; trace: string; point: number }
  | { op: "removeCursor"; graph: string; cursor: string }
  | {
      op: "addAnnotation";
      graph: string;
      kind: string;
      text?: string;
      anchor?: string;
      frame?: boolean;
      x?: number;
      y?: number;
      /** For a tag: what it points at. */
      trace?: string;
      point?: number;
    }
  | { op: "modifyAnnotation"; graph: string; annotation: string; props: Props }
  | { op: "removeAnnotation"; graph: string; annotation: string }
  | { op: "edit"; waves: readonly string[]; name?: string }
  | { op: "appendToTable"; table: string; waves: readonly string[] }
  | { op: "removeFromTable"; table: string; waves: readonly string[] }
  | { op: "modifyTable"; table: string; props: Props }
  | { op: "resizeColumn"; table: string; wave: string; width: number }
  | { op: "setTimeZone"; zone: string }
  | { op: "newLayout"; name?: string; width?: number; height?: number }
  | { op: "modifyLayout"; layout: string; props: Props }
  | {
      /** Puts a graph or a block of text on a page. Left out, the place is chosen. */
      op: "addLayoutItem";
      layout: string;
      kind: string;
      graph?: string;
      text?: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      size?: number;
    }
  | { op: "modifyLayoutItem"; layout: string; item: string; props: Props }
  | { op: "removeLayoutItem"; layout: string; item: string }
  /** Makes an empty panel (see PanelSpec) with its window. */
  | { op: "newPanel"; name?: string; title?: string }
  /**
   * Gives a panel its title and controls, as data (see checkPanel): an
   * imported panel, say. Makes the panel and its window if there is none.
   */
  | { op: "setPanel"; name: string; panel: unknown }
  | { op: "modifyPanel"; panel: string; props: Props }
  /** Adds a control at the end. Left out, the name is chosen from its kind. */
  | { op: "addControl"; panel: string; kind: string; name?: string; props?: Props }
  /** Changes a control's properties; `name` among them renames it, and buttons follow. */
  | { op: "modifyControl"; panel: string; control: string; props: Props }
  | { op: "removeControl"; panel: string; control: string }
  /** Puts a control at a place in the panel's order, counted from 0. */
  | { op: "moveControl"; panel: string; control: string; to: number }
  | { op: "setControlValue"; panel: string; control: string; value: unknown }
  | { op: "newProcedure"; name?: string; code?: string; autoRun?: boolean }
  | { op: "setProcedure"; name: string; code?: string; autoRun?: boolean }
  | { op: "newNote"; name?: string; text?: string }
  | { op: "setNote"; name: string; text: string }
  /** Keeps the look of a graph as a style; with `size`, the size it is drawn at too. */
  | { op: "saveStyle"; name: string; graph: string; size?: boolean }
  /** Defines a style from its parts (see StyleSpec), replacing one of that name. */
  | { op: "setStyle"; name: string; style: unknown }
  | { op: "removeStyle"; name: string }
  | { op: "renameStyle"; name: string; newName: string }
  | { op: "applyStyle"; style: string; graphs: readonly string[] }
  | { op: "setDefaultStyle"; name: string | null }
  /**
   * Keeps a graph as a template (see GraphTemplate). The axes in `fixed`
   * keep their ranges; the others are worked out from the data of each graph.
   */
  | { op: "saveGraphTemplate"; name: string; graph: string; fixed?: readonly string[] }
  /** Defines a template from its parts, replacing one of that name. */
  | { op: "setGraphTemplate"; name: string; template: unknown }
  | { op: "removeGraphTemplate"; name: string }
  | { op: "renameGraphTemplate"; name: string; newName: string }
  /**
   * Makes a graph from a template for each sample: wave names by slot. All
   * are made or none. `names` names the graphs; left out, they are chosen.
   */
  | {
      op: "makeGraphs";
      template: string;
      samples: readonly Readonly<Record<string, string | null>>[];
      names?: readonly string[];
    }
  /** Keeps the outcome of an analysis. `result` is as Python reports it (see checkResult). */
  | { op: "addResult"; result: unknown; name?: string }
  | { op: "removeResults"; names: readonly string[] }
  | { op: "renameResult"; name: string; newName: string }
  /** Defines an analysis template (see AnalysisTemplate), replacing one of that name. */
  | { op: "setTemplate"; name: string; template: unknown }
  | { op: "removeTemplate"; name: string }
  | { op: "renameTemplate"; name: string; newName: string }
  /**
   * Keeps the record of a template run on samples (see TemplateRun), as
   * Python starts it: every sample pending. Named Run0, Run1, ... unless named.
   */
  | { op: "addRun"; run: unknown; name?: string }
  /** Records how one sample of a run went; the inputs are fingerprinted as they are now. */
  | ({ op: "updateRunSample"; run: string; index: number } & SampleOutcome)
  | { op: "removeRuns"; names: readonly string[] }
  | { op: "killWindow"; name: string }
  /**
   * Records Python packages the experiment uses, as op.install found them
   * installed (see ./pythonEnv), under the Pyodide version it ran.
   */
  | { op: "recordPackages"; packages: readonly unknown[]; pyodide: string }
  /** Stops using packages: they and what only they needed are no longer recorded. */
  | { op: "forgetPackages"; names: readonly string[] }
  /**
   * Links graphs (at least two) so that their axes zoom together, the
   * bottom ("x") or the bottom and the left ("xy"), and, with `cursors`,
   * their cursors follow each other by X. They leave any group they were in.
   */
  | { op: "linkGraphs"; graphs: readonly string[]; axes?: string; cursors?: boolean }
  | { op: "unlinkGraphs"; graphs: readonly string[] }
  /**
   * Sets attributes of a sample: of a data folder ("run1:", with a colon) or
   * of a wave. A value of null removes that attribute.
   */
  | { op: "setAttributes"; target: string; values: Record<string, unknown> }
  /** Closes a window but keeps what it shows, to reopen it (see WindowState.hidden). */
  | { op: "closeWindow"; name: string }
  | { op: "reopenWindow"; name: string }
  /** Gives a graph, table, procedure, page layout, panel or note and its window another name. */
  | { op: "renameWindow"; name: string; newName: string }
  | { op: "moveWindow"; name: string; x?: number; y?: number; w?: number; h?: number }
  | { op: "activateWindow"; name: string };

/**
 * Window geometry, focus and column widths are view state: not undoable and
 * not echoed. Neither is the text of a procedure or a note: its editor has
 * its own undo.
 */
export const isTransient = (command: Command): boolean =>
  command.op === "moveWindow" ||
  command.op === "activateWindow" ||
  command.op === "resizeColumn" ||
  command.op === "setProcedure" ||
  command.op === "setNote";

export interface CommandOutcome {
  state: DocState;
  /** Name of whatever the command created, when it created something. */
  result: string | null;
}

const NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_]*$/u;
const NO_DATA = new Float64Array(0);

export function checkName(name: unknown, what: string): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > 255) {
    throw new DocError(
      `${JSON.stringify(name)} is not a valid ${what} name. Names start with a letter and contain only letters, digits and "_".`,
    );
  }
  return name;
}

/**
 * Checks a wave or folder path and returns it without the optional leading
 * "root:". Folders are separated by ":", as in Igor.
 */
export function checkPath(path: unknown, what: string): string {
  if (typeof path !== "string") throw new DocError(`A ${what} name must be text.`);
  const relative = path.startsWith("root:") ? path.slice(5) : path;
  for (const part of relative.split(":")) checkName(part, what);
  return relative;
}

/** Turns arbitrary text (a file column header, say) into a legal name. */
export function sanitizeName(text: string, fallback = "wave"): string {
  let name = text
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = fallback;
  if (!/^\p{L}/u.test(name)) name = `${fallback}_${name}`;
  return name.slice(0, 255);
}

/** Returns `base0`, `base1`, ... : the first one for which `taken` is false. */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  for (let index = 0; ; index += 1) {
    const candidate = `${base}${index}`;
    if (!taken(candidate)) return candidate;
  }
}

function requireWave(state: DocState, name: string): Wave {
  const key = typeof name === "string" && name.startsWith("root:") ? name.slice(5) : name;
  const wave = state.waves[key];
  if (!wave) throw new DocError(`No wave named ${JSON.stringify(name)}.`);
  return wave;
}

function requireGraph(state: DocState, name: string): GraphSpec {
  const graph = state.graphs[name];
  if (!graph) throw new DocError(`No graph named ${JSON.stringify(name)}.`);
  return graph;
}

function requireTable(state: DocState, name: string): TableSpec {
  const table = state.tables[name];
  if (!table) throw new DocError(`No table named ${JSON.stringify(name)}.`);
  return table;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DocError(`${what} must be a finite number.`);
  }
  return value;
}

function positive(value: unknown, what: string): number {
  const number = finite(value, what);
  if (number <= 0) throw new DocError(`${what} must be greater than 0.`);
  return number;
}

function step(value: unknown, what: string): number {
  const number = finite(value, what);
  if (number === 0) throw new DocError(`${what} must not be 0.`);
  return number;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new DocError(`${what} must be true or false.`);
  return value;
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[], what: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new DocError(`${what} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

// Revisions are unique across all waves and never reused, so a (name, rev)
// pair identifies one exact state of a wave even after kill-and-remake or undo.
let lastRev = 0;
const nextRev = (): number => (lastRev += 1);

function withFolders(state: DocState, folder: string): DocState {
  if (folder === "" || state.folders.includes(folder)) return state;
  const added: string[] = [];
  const parts = folder.split(":");
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const path = parts.slice(0, depth).join(":");
    if (!state.folders.includes(path)) added.push(path);
  }
  return { ...state, folders: [...state.folders, ...added] };
}

/** The graphs linked to `graph`, but itself. */
function linkedTo(state: DocState, graph: GraphSpec): GraphSpec[] {
  const group = graph.link?.group;
  if (group === undefined) return [];
  return Object.values(state.graphs).filter(
    (other) => other.name !== graph.name && other.link?.group === group,
  );
}

/**
 * The state with the range just given to an axis of `graph` given to the
 * same axis of the graphs linked to it, where the link covers that axis.
 */
function followRange(state: DocState, graph: GraphSpec, axis: string, props: Props): DocState {
  const link = graph.link;
  if (!link || !("min" in props || "max" in props)) return state;
  if (axis !== "bottom" && !(axis === "left" && link.axes === "xy")) return state;
  const given = state.graphs[graph.name]!.axes[axis]!;
  const range: Partial<AxisSpec> = {
    ...("min" in props ? { min: given.min } : {}),
    ...("max" in props ? { max: given.max } : {}),
  };
  let next = state;
  for (const other of linkedTo(state, graph)) {
    const current = other.axes[axis];
    if (!current) continue;
    const moved: AxisSpec = { ...current, ...range };
    // A log axis cannot take a range through zero: it keeps its own.
    if (moved.log && ((moved.min ?? 1) <= 0 || (moved.max ?? 1) <= 0)) continue;
    next = putGraph(next, {
      ...next.graphs[other.name]!,
      axes: withEntry(other.axes, axis, moved),
    });
  }
  return next;
}

/** The X of a point of a trace, as the graph plots it. */
function cursorX(state: DocState, trace: TraceSpec, point: number): number | null {
  const y = state.waves[trace.y];
  if (!y) return null;
  const x = trace.x === null ? undefined : state.waves[trace.x];
  const value = x ? (x.text ? point : Number(x.data[point])) : y.x0 + point * y.dx;
  return Number.isFinite(value) ? value + trace.xOffset : null;
}

/** The point of a trace nearest an X. */
function nearestPointTo(state: DocState, trace: TraceSpec, target: number): number | null {
  const y = state.waves[trace.y];
  if (!y || y.data.length === 0) return null;
  const x = trace.x === null ? undefined : state.waves[trace.x];
  const want = target - trace.xOffset;
  if (!x || x.text) {
    const at = x ? want : (want - y.x0) / y.dx;
    return Math.min(y.data.length - 1, Math.max(0, Math.round(at)));
  }
  let best: number | null = null;
  let distance = Infinity;
  const count = Math.min(x.data.length, y.data.length);
  for (let index = 0; index < count; index += 1) {
    const gap = Math.abs(Number(x.data[index]) - want);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  }
  return best;
}

/**
 * The state with a cursor just set on `graph` (at X, or removed when null)
 * set on the graphs linked to it whose link takes cursors along: on the
 * trace the cursor is on there, or the first, at the point nearest X.
 */
function followCursor(
  state: DocState,
  graph: GraphSpec,
  cursor: CursorName,
  x: number | null,
): DocState {
  if (!graph.link?.cursors) return state;
  let next = state;
  for (const other of linkedTo(state, graph)) {
    if (x === null) {
      next = putGraph(next, { ...other, cursors: withoutEntries(other.cursors, [cursor]) });
      continue;
    }
    const placed = other.cursors[cursor]?.trace;
    const trace = other.traces.find((item) => item.name === placed) ?? other.traces[0];
    const point = trace ? nearestPointTo(state, trace, x) : null;
    if (!trace || point === null) continue;
    next = putGraph(next, {
      ...other,
      cursors: withEntry(other.cursors, cursor, { trace: trace.name, point }),
    });
  }
  return next;
}

/** The graphs taken out of their groups, and a group left with one graph undone. */
function unlink(state: DocState, names: readonly string[]): DocState {
  let next = state;
  const groups = new Set<string>();
  for (const name of names) {
    const graph = next.graphs[name];
    if (!graph?.link) continue;
    groups.add(graph.link.group);
    next = putGraph(next, { ...graph, link: null });
  }
  for (const group of groups) {
    const left = Object.values(next.graphs).filter((graph) => graph.link?.group === group);
    if (left.length === 1) next = putGraph(next, { ...left[0]!, link: null });
  }
  return next;
}

/**
 * Copies the waves a result made into its own data folder (see keptFolder),
 * so that what it made stays when the analysis is run again and makes the
 * same names anew. Waves that are gone are left out.
 */
function keepOutputs(
  state: DocState,
  result: string,
  outputs: Readonly<Record<string, string>>,
): { state: DocState; kept: Record<string, string> } {
  const kept: Record<string, string> = {};
  const roles = Object.entries(outputs).filter(([, wave]) => wave in state.waves);
  if (roles.length === 0) return { state, kept };
  let next = withFolders(state, keptFolder(result));
  for (const [role, wave] of roles) {
    const source = next.waves[wave]!;
    const name = `${keptFolder(result)}:${role}`;
    next = putWave(
      next,
      withoutFormula(
        changed(source, { name, data: source.data.slice(), imag: source.imag?.slice() ?? null }),
      ),
    );
    kept[role] = name;
  }
  return { state: next, kept };
}

/**
 * Removes a result's own copies, except those something still shows (a
 * graph, a table), and its folder and the results folder if that empties
 * them.
 */
function dropKept(state: DocState, result: AnalysisResult): DocState {
  const unused = Object.values(result.kept).filter(
    (name) => name in state.waves && waveUsers(state, name).length === 0,
  );
  let next = unused.length > 0 ? removeWaves(state, unused) : state;
  for (const folder of [keptFolder(result.name), "results"]) {
    const holds = (name: string) => name.startsWith(`${folder}:`);
    if (next.folders.includes(folder) && !next.waveOrder.some(holds) && !next.folders.some(holds)) {
      next = { ...next, folders: next.folders.filter((item) => item !== folder) };
    }
  }
  return next;
}

function putWave(state: DocState, wave: Wave): DocState {
  const known = wave.name in state.waves;
  const next = withFolders(state, parentFolder(wave.name));
  return {
    ...next,
    waves: withEntry(next.waves, wave.name, wave),
    waveOrder: known ? next.waveOrder : [...next.waveOrder, wave.name],
  };
}

function putGraph(state: DocState, graph: GraphSpec): DocState {
  return { ...state, graphs: withEntry(state.graphs, graph.name, graph) };
}

function putTable(state: DocState, table: TableSpec): DocState {
  return { ...state, tables: withEntry(state.tables, table.name, table) };
}

function checkShape(shape: readonly number[] | undefined, length: number): readonly number[] {
  if (shape === undefined) return [length];
  if (
    !Array.isArray(shape) ||
    shape.length < 1 ||
    shape.length > 4 ||
    shape.some((size) => !Number.isInteger(size) || size < 0)
  ) {
    throw new DocError("A wave has 1 to 4 dimensions, each a whole number of points.");
  }
  const total = shape.reduce((product, size) => product * size, 1);
  if (total !== length) {
    throw new DocError(`Shape (${shape.join(", ")}) does not match ${length} values.`);
  }
  return [...shape];
}

/** The values a command carries: numeric data with a shape, or text. */
const isWaveData = (value: unknown): value is WaveData =>
  ArrayBuffer.isView(value) &&
  !(value instanceof DataView) &&
  !(value instanceof Uint8ClampedArray);

function contentOf(command: {
  data?: WaveData;
  imag?: WaveData;
  type?: string;
  text?: readonly string[];
  shape?: readonly number[];
}): Pick<Wave, "data" | "imag" | "type" | "text" | "shape"> {
  if (command.text !== undefined) {
    if (!Array.isArray(command.text) || command.text.some((item) => typeof item !== "string")) {
      throw new DocError("A text wave holds a list of strings.");
    }
    return {
      data: NO_DATA,
      imag: null,
      type: "float64",
      text: [...command.text],
      shape: [command.text.length],
    };
  }
  if (!isWaveData(command.data)) throw new DocError("Missing wave data.");
  const given = command.imag;
  if (given !== undefined && !isWaveData(given)) throw new DocError("imag must be numbers.");
  const type =
    command.type === undefined
      ? typeOfData(command.data, given !== undefined)
      : oneOf(command.type, WAVE_TYPES, "type");
  const data = toWaveData(command.data, type);
  let imag: WaveData | null = null;
  if (isComplexType(type)) {
    if (given && given.length !== data.length) {
      throw new DocError("The real and imaginary parts have different lengths.");
    }
    imag = given ? toWaveData(given, type) : newWaveData(type, data.length);
  } else if (given) {
    throw new DocError(`A wave of type ${type} has no imaginary part.`);
  }
  return { data, imag, type, text: null, shape: checkShape(command.shape, data.length) };
}

/** A copy of wave data with points removed and added at a position; new points hold `fill`. */
function resized(source: WaveData, at: number, removed: number, added: number, fill: number) {
  const data = source.slice(0, 0).constructor as new (length: number) => WaveData;
  const next = new data(source.length - removed + added);
  next.set(source.subarray(0, at));
  next.fill(fill, at, at + added);
  next.set(source.subarray(at + removed), at + added);
  return next;
}

/** Whether a window (graph, table, procedure, page layout, panel or note) already has this name. */
export const windowTaken = (state: DocState) => (name: string) =>
  name in state.graphs ||
  name in state.tables ||
  name in state.procedures ||
  name in state.pages ||
  name in state.panels ||
  name in state.notes;

/**
 * Checks the name of a procedure: a window name that is also the name of
 * the Python module the procedure is (`import name`), so ASCII only.
 */
export function procedureName(name: unknown): string {
  const checked = checkName(name, "procedure");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(checked)) {
    throw new DocError('A procedure name can have only ASCII letters, digits and "_".');
  }
  return checked;
}

function requireWindow(state: DocState, name: string): WindowState {
  const window = state.windows.find((item) => item.name === name);
  if (!window) throw new DocError(`No window named ${JSON.stringify(name)}.`);
  return window;
}

/** A record kept by name, renamed: its key and its own `name`. */
function renamedEntry<T extends { name: string }>(
  records: Dict<T>,
  name: string,
  newName: string,
): Dict<T> {
  const record = records[name];
  if (!record) return records;
  return dict<T>(
    Object.entries(records).map(([key, value]): [string, T] =>
      key === name ? [newName, { ...value, name: newName }] : [key, value],
    ),
  );
}

export function placeWindow(state: DocState, name: string, kind: WindowState["kind"]): WindowState {
  const slot = state.windows.length % 8;
  const size =
    kind === "graph"
      ? { w: 440, h: 300 }
      : kind === "table"
        ? { w: 360, h: 300 }
        : kind === "page"
          ? { w: 440, h: 560 }
          : kind === "panel"
            ? { w: 340, h: 280 }
            : kind === "note"
              ? { w: 560, h: 380 }
              : { w: 520, h: 340 };
  return { name, kind, x: 24 + slot * 28, y: 16 + slot * 28, ...size };
}

function nextItemName(taken: readonly { name: string }[], base: string): string {
  const names = new Set(taken.map((item) => item.name));
  if (!names.has(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}#${index}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** A numeric wave with exactly `dimensions` dimensions, or an error saying why not. */
function requireNumeric(state: DocState, name: string, dimensions: 1 | 2, use: string): Wave {
  const wave = requireWave(state, name);
  if (wave.text) throw new DocError(`${wave.name} is a text wave and cannot be ${use}.`);
  // Images and contours show one plane, so anything from 2-D up will do.
  if (dimensions === 1 ? wave.shape.length !== 1 : wave.shape.length < 2) {
    throw new DocError(
      dimensions === 1
        ? `${wave.name} has ${wave.shape.length} dimensions; a trace needs a 1-D wave. Show it as an image or contour instead.`
        : `${wave.name} has one dimension and cannot be ${use}.`,
    );
  }
  return wave;
}

/** The X wave of a trace: numbers, or text for a category plot. */
function requireXWave(state: DocState, name: string): Wave {
  const wave = requireWave(state, name);
  if (wave.shape.length !== 1)
    throw new DocError(`${wave.name} is not 1-D and cannot be an X wave.`);
  return wave;
}

/** Checks that an image's or contour's plane exists in its wave. */
function checkPlane(wave: Wave, item: { layer: number; chunk: number }): void {
  const layers = wave.shape[2] ?? 1;
  const chunks = wave.shape[3] ?? 1;
  if (item.layer >= layers || item.chunk >= chunks) {
    throw new DocError(
      `${wave.name} has ${layers} layer${layers === 1 ? "" : "s"} and ${chunks} chunk${chunks === 1 ? "" : "s"}; layer ${item.layer}, chunk ${item.chunk} does not exist.`,
    );
  }
}

function index(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DocError(`${what} must be a whole number, 0 or more.`);
  }
  return value;
}

function requireAxis(graph: GraphSpec, name: string, vertical: boolean): string {
  const axis = graph.axes[name];
  if (!axis) {
    throw new DocError(
      `${graph.name} has no axis named ${JSON.stringify(name)}. Axes: ${Object.keys(graph.axes).join(", ")}.`,
    );
  }
  if (isVerticalSide(axis.side) !== vertical) {
    throw new DocError(
      `Axis ${JSON.stringify(name)} is ${vertical ? "horizontal" : "vertical"}; a ${vertical ? "vertical" : "horizontal"} axis is needed here.`,
    );
  }
  return name;
}

function addTraces(
  state: DocState,
  graph: GraphSpec,
  y: readonly string[],
  x: string | null,
  vAxis: string,
  hAxis: string,
): GraphSpec {
  if (y.length === 0) throw new DocError("Give at least one wave to plot.");
  requireAxis(graph, vAxis, true);
  requireAxis(graph, hAxis, false);
  const xWave = x === null ? null : requireXWave(state, x);
  const traces = [...graph.traces];
  for (const name of y) {
    const wave = requireNumeric(state, name, 1, "plotted");
    if (xWave && xWave.shape[0] !== wave.data.length) {
      throw new DocError(
        `X wave ${JSON.stringify(xWave.name)} has ${xWave.shape[0]} points but ${JSON.stringify(wave.name)} has ${wave.data.length}.`,
      );
    }
    traces.push({
      ...defaultTraceStyle(traces.length),
      name: nextItemName(traces, leafName(wave.name)),
      y: wave.name,
      x: xWave?.name ?? null,
      vAxis,
      hAxis,
    });
  }
  return { ...graph, traces };
}

const errorSource =
  (what: string) =>
  (value: unknown): ErrorSource => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    throw new DocError(`${what} must be a wave name, a number that is not negative, or null.`);
  };

const TRACE_VALIDATORS: { [K in keyof TraceStyle]: (value: unknown) => TraceStyle[K] } = {
  mode: (value) => oneOf(value, TRACE_MODES, "mode"),
  color: normalizeColor,
  lineSize: (value) => positive(value, "lineSize"),
  lineStyle: (value) => oneOf(value, LINE_STYLES, "lineStyle"),
  marker: (value) => oneOf(value, MARKER_SHAPES, "marker"),
  markerSize: (value) => positive(value, "markerSize"),
  markerFill: (value) => bool(value, "markerFill"),
  hidden: (value) => bool(value, "hidden"),
  yError: errorSource("yError"),
  xError: errorSource("xError"),
  fill: (value) => oneOf(value, FILL_MODES, "fill"),
  fillColor: (value) => (value === null ? null : normalizeColor(value)),
  fillOpacity: (value) => {
    const opacity = finite(value, "fillOpacity");
    if (opacity < 0 || opacity > 1) throw new DocError("fillOpacity must be between 0 and 1.");
    return opacity;
  },
  xOffset: (value) => finite(value, "xOffset"),
  yOffset: (value) => finite(value, "yOffset"),
  colorWave: (value) => {
    if (value === null || typeof value === "string") return value;
    throw new DocError("colorWave must be a wave name or null.");
  },
  colorTable: (value) => oneOf(value, COLOR_TABLES, "colorTable"),
  colorMin: (value) => (value === null ? null : finite(value, "colorMin")),
  colorMax: (value) => (value === null ? null : finite(value, "colorMax")),
  part: (value) => oneOf(value, COMPLEX_PARTS, "part"),
};

const nullableNumber = (what: string) => (value: unknown) =>
  value === null ? null : finite(value, what);

function fontSize(value: unknown, what: string): number {
  const size = positive(value, what);
  if (size < 4 || size > 96) throw new DocError(`${what} must be between 4 and 96.`);
  return size;
}

const AXIS_VALIDATORS: { [K in Exclude<keyof AxisSpec, "side">]: (value: unknown) => AxisSpec[K] } =
  {
    label: (value) => {
      if (value === null || typeof value === "string") return value;
      throw new DocError("label must be text, or null for the automatic label.");
    },
    labelSize: (value) => (value === null ? null : fontSize(value, "labelSize")),
    labelStyle: (value) => oneOf(value, LABEL_STYLES, "labelStyle"),
    labelRotation: (value) => {
      const degrees = finite(value, "labelRotation");
      if (degrees < -360 || degrees > 360) {
        throw new DocError("labelRotation must be between -360 and 360 degrees.");
      }
      return degrees;
    },
    tickLabelSize: (value) => (value === null ? null : fontSize(value, "tickLabelSize")),
    labels: (value) => oneOf(value, AXIS_LABEL_MODES, "labels"),
    min: nullableNumber("min"),
    max: nullableNumber("max"),
    log: (value) => bool(value, "log"),
    mirror: (value) => oneOf(value, MIRROR_MODES, "mirror"),
    ticks: (value) => oneOf(value, TICK_MODES, "ticks"),
    minor: (value) => bool(value, "minor"),
    grid: (value) => oneOf(value, GRID_MODES, "grid"),
    reverse: (value) => bool(value, "reverse"),
    tickStep: (value) => (value === null ? null : positive(value, "tickStep")),
    tickFormat: (value) => {
      if (value === null || value === "") return null;
      if (typeof value === "string" && isTickFormat(value)) return value;
      throw new DocError(
        'tickFormat must be a format such as ".2f", "e", ".1e", "g", ",.0f" or "%", or null.',
      );
    },
    span: (value) => {
      if (Array.isArray(value) && value.length === 2) {
        const lo = finite(value[0], "span");
        const hi = finite(value[1], "span");
        if (lo >= 0 && hi <= 1 && hi - lo >= 0.02) return [lo, hi];
      }
      throw new DocError("span must be (low, high) with 0 <= low < high <= 1.");
    },
  };

/** A margin in points, from 0 to {@link MAX_MARGIN}, or null for automatic. */
function margin(value: unknown, what: string): number | null {
  if (value === null) return null;
  const points = typeof value === "number" ? value : NaN;
  if (!(points >= 0 && points <= MAX_MARGIN)) {
    throw new DocError(`${what} must be between 0 and ${MAX_MARGIN} points, or None for auto.`);
  }
  return points;
}

const GRAPH_VALIDATORS: { [K in keyof GraphStyle]: (value: unknown) => GraphStyle[K] } = {
  fontSize: (value) => fontSize(value, "fontSize"),
  fontFamily: (value) => {
    if (typeof value !== "string" || !value.trim()) throw new DocError("fontFamily must be text.");
    return value;
  },
  showInfo: (value) => bool(value, "showInfo"),
  marginLeft: (value) => margin(value, "marginLeft"),
  marginBottom: (value) => margin(value, "marginBottom"),
  marginRight: (value) => margin(value, "marginRight"),
  marginTop: (value) => margin(value, "marginTop"),
  magnification: (value) => {
    const factor = positive(value, "magnification");
    if (factor < MIN_MAGNIFICATION - 1e-9 || factor > MAX_MAGNIFICATION + 1e-9) {
      throw new DocError(
        `magnification must be between ${MIN_MAGNIFICATION} and ${MAX_MAGNIFICATION} (1 is none).`,
      );
    }
    return factor;
  },
};

/** The longest and the shortest a plot area can be given, in points. */
const MIN_PLOT_POINTS = MIN_PLOT_SIZE / SCREEN_UNITS_PER_POINT;
const MAX_PLOT_POINTS = MAX_PLOT_SIZE / SCREEN_UNITS_PER_POINT;

/** A factor of an aspect or a plan: from 1/100 to 100. */
function sizeFactor(value: unknown, what: string): number {
  const factor = positive(value, what);
  if (factor < 0.01 || factor > 100) throw new DocError(`${what} must be between 0.01 and 100.`);
  return factor;
}

/**
 * Checks how a side of the plot area is sized, given as data. The axes it
 * names are checked against the graph by {@link checkPlotSize}.
 */
export function checkPlotDimension(value: unknown, what: string): PlotDimension {
  const props = propsOf(value, what);
  const mode = oneOf(props.mode, PLOT_SIZE_MODES, `${what}'s mode`);
  const keys: Record<(typeof PLOT_SIZE_MODES)[number], readonly string[]> = {
    auto: [],
    absolute: ["value", "unit"],
    aspect: ["factor"],
    plan: ["factor", "hAxis", "vAxis"],
    perUnit: ["value", "unit", "axis"],
  };
  for (const key of Object.keys(props)) {
    if (key !== "mode" && !keys[mode].includes(key)) {
      throw new DocError(
        `A ${mode} ${what} has no property ${JSON.stringify(key)}. It takes: ${["mode", ...keys[mode]].join(", ")}.`,
      );
    }
  }
  const axisName = (key: string) => {
    if (typeof props[key] !== "string")
      throw new DocError(`A ${mode} ${what} needs ${key}, an axis name.`);
    return props[key];
  };
  switch (mode) {
    case "auto":
      return { mode };
    case "absolute": {
      const length = positive(props.value, `${what}'s value`);
      const unit = oneOf(props.unit ?? "pt", LENGTH_UNITS, `${what}'s unit`);
      const points = toPoints(length, unit);
      if (points < MIN_PLOT_POINTS - 1e-9 || points > MAX_PLOT_POINTS + 1e-9) {
        throw new DocError(
          `${what} must be between ${MIN_PLOT_POINTS} and ${MAX_PLOT_POINTS} points (${(MAX_PLOT_POINTS / 72).toFixed(1)} inches).`,
        );
      }
      return { mode, value: length, unit };
    }
    case "aspect":
      return { mode, factor: sizeFactor(props.factor, `${what}'s factor`) };
    case "plan":
      return {
        mode,
        factor: sizeFactor(props.factor, `${what}'s factor`),
        hAxis: axisName("hAxis"),
        vAxis: axisName("vAxis"),
      };
    case "perUnit":
      return {
        mode,
        value: positive(props.value, `${what}'s value`),
        unit: oneOf(props.unit ?? "pt", LENGTH_UNITS, `${what}'s unit`),
        axis: axisName("axis"),
      };
  }
}

/**
 * Checks the two sides of a plot area together, against the axes there are
 * (`sideOf` gives the side of an axis, or undefined if there is none):
 * plan takes a horizontal and a vertical axis, per unit an axis along its
 * own side, and the two sides cannot both be sized from each other.
 */
function checkPlotSize(
  width: PlotDimension,
  height: PlotDimension,
  sideOf: (axis: string) => AxisSide | undefined,
  owner: string,
): void {
  if (dependsOnOther(width) && dependsOnOther(height)) {
    throw new DocError(
      "The width and the height of the plot area cannot both be sized from each other (aspect or plan). Make one of them auto, absolute or per unit.",
    );
  }
  const axisOn = (axis: string, vertical: boolean, use: string) => {
    const side = sideOf(axis);
    if (side === undefined) {
      throw new DocError(`${owner} has no axis named ${JSON.stringify(axis)} for ${use}.`);
    }
    if (isVerticalSide(side) !== vertical) {
      throw new DocError(
        `${use[0]!.toUpperCase()}${use.slice(1)} needs a ${vertical ? "vertical" : "horizontal"} axis; ${axis} is ${vertical ? "horizontal" : "vertical"}.`,
      );
    }
  };
  for (const [dimension, what, vertical] of [
    [width, "the width", false],
    [height, "the height", true],
  ] as const) {
    if (dimension.mode === "plan") {
      axisOn(dimension.hAxis, false, `the plan of ${what}`);
      axisOn(dimension.vAxis, true, `the plan of ${what}`);
    } else if (dimension.mode === "perUnit") {
      axisOn(dimension.axis, vertical, `the per unit size of ${what}`);
    }
  }
}

/**
 * The plot size modes of a graph read from a file, checked against its
 * axes: a side that is missing (a file from before they existed) or that
 * cannot be used is auto.
 */
export function savedPlotSize(
  width: unknown,
  height: unknown,
  axes: Readonly<Record<string, AxisSpec>>,
): Pick<GraphSpec, "width" | "height"> {
  const read = (value: unknown, what: string): PlotDimension => {
    if (value === undefined || value === null) return AUTO_SIZE;
    try {
      return checkPlotDimension(value, what);
    } catch {
      return AUTO_SIZE;
    }
  };
  const sideOf = (axis: string) => (Object.hasOwn(axes, axis) ? axes[axis]!.side : undefined);
  let result = { width: read(width, "width"), height: read(height, "height") };
  for (const side of ["height", "width"] as const) {
    try {
      checkPlotSize(result.width, result.height, sideOf, "The graph");
    } catch {
      result = { ...result, [side]: AUTO_SIZE };
    }
  }
  return result;
}

type GraphProps = GraphStyle & Pick<GraphSpec, "width" | "height">;
const GRAPH_PROP_VALIDATORS: { [K in keyof GraphProps]: (value: unknown) => GraphProps[K] } = {
  ...GRAPH_VALIDATORS,
  width: (value) => checkPlotDimension(value, "width"),
  height: (value) => checkPlotDimension(value, "height"),
};

/** The axes a style's plot sizes may hold: none, since it holds no plan or per unit. */
function checkStylePlot(value: unknown): { width?: PlotDimension; height?: PlotDimension } {
  const parts = validateProps<{ width: PlotDimension; height: PlotDimension }>(
    propsOf(value, "plot"),
    {
      width: (item) => checkPlotDimension(item, "width"),
      height: (item) => checkPlotDimension(item, "height"),
    },
    "plot size",
  );
  for (const dimension of [parts.width, parts.height]) {
    if (
      dimension &&
      dimension.mode !== "auto" &&
      dimension.mode !== "absolute" &&
      dimension.mode !== "aspect"
    ) {
      throw new DocError(
        "A style sizes the plot area as auto, absolute or aspect only: plan and per unit follow the data.",
      );
    }
  }
  if (parts.width && parts.height)
    checkPlotSize(parts.width, parts.height, () => undefined, "A style");
  return ordered(parts, ["width", "height"]);
}

type Validators<T> = { [K in keyof T]: (value: unknown) => T[K] };

/** The validators of some properties, for the part of an object a style can hold. */
function someOf<T, K extends keyof T>(validators: Validators<T>, keys: readonly K[]) {
  const result = {} as Validators<Pick<T, K>>;
  for (const key of keys) result[key] = validators[key];
  return result;
}

const GRAPH_LOOK_VALIDATORS = someOf<GraphStyle, keyof GraphLook>(GRAPH_VALIDATORS, GRAPH_LOOK);
const AXIS_LOOK_VALIDATORS = someOf<Omit<AxisSpec, "side">, keyof AxisLook>(
  AXIS_VALIDATORS,
  AXIS_LOOK,
);
const TRACE_LOOK_VALIDATORS = someOf<TraceStyle, keyof TraceLook>(TRACE_VALIDATORS, TRACE_LOOK);

const figureSide = (what: string, least: number) => (value: unknown) => {
  const size = finite(value, what);
  if (size < least || size > 4000) {
    throw new DocError(`${what} must be between ${least} and 4000 pixels.`);
  }
  return size;
};
const SIZE_VALIDATORS = { width: figureSide("width", 160), height: figureSide("height", 100) };

/** A dict of properties, or an error naming what it should have been. */
function propsOf(value: unknown, what: string): Props {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocError(`${what} must be a dict of properties.`);
  }
  return value as Props;
}

/** The validated properties, in the order of `keys`, so equal parts are written alike. */
function ordered<T, K extends keyof T>(props: Partial<T>, keys: readonly K[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) if (props[key] !== undefined) result[key] = props[key];
  return result;
}

const STYLE_PARTS = ["graph", "size", "plot", "axes", "traces"] as const;

/**
 * Checks a style given as data (from Python, a file or the browser's
 * library) and returns it in its usual form. Unknown parts and properties
 * and bad values are refused; parts that hold nothing are left out.
 */
export function checkStyle(value: unknown): StyleSpec {
  const parts = validateProps<Required<StyleSpec>>(
    propsOf(value, "A style"),
    {
      graph: (item) =>
        ordered(
          validateProps<GraphLook>(propsOf(item, "graph"), GRAPH_LOOK_VALIDATORS, "graph style"),
          GRAPH_LOOK,
        ),
      size: (item): FigureSize => {
        const size = validateProps<FigureSize>(propsOf(item, "size"), SIZE_VALIDATORS, "size");
        if (size.width === undefined || size.height === undefined) {
          throw new DocError("size needs both width and height.");
        }
        return { width: size.width, height: size.height };
      },
      plot: checkStylePlot,
      axes: (item) => {
        const roles = validateProps<Record<AxisRole, unknown>>(
          propsOf(item, "axes"),
          Object.fromEntries(
            AXIS_ROLES.map((role) => [role, (look: unknown) => look]),
          ) as Validators<Record<AxisRole, unknown>>,
          "axes",
        );
        const axes: Partial<Record<AxisRole, Partial<AxisLook>>> = {};
        for (const role of AXIS_ROLES) {
          if (roles[role] === undefined) continue;
          const look = ordered(
            validateProps<AxisLook>(
              propsOf(roles[role], `axes.${role}`),
              AXIS_LOOK_VALIDATORS,
              "axis style",
            ),
            AXIS_LOOK,
          );
          if (Object.keys(look).length > 0) axes[role] = look;
        }
        return axes;
      },
      traces: (item) => {
        if (!Array.isArray(item) || item.length > 1000) {
          throw new DocError("traces must be a list of trace properties, one for each trace.");
        }
        // An empty entry is a place in the cycle that leaves its trace alone.
        return item.map((entry: unknown) =>
          ordered(
            validateProps<TraceLook>(
              propsOf(entry, "A trace in a style"),
              TRACE_LOOK_VALIDATORS,
              "trace style",
            ),
            TRACE_LOOK,
          ),
        );
      },
    },
    "style",
  );
  const style: Record<string, unknown> = {};
  for (const part of STYLE_PARTS) {
    const content = parts[part];
    const empty =
      content === undefined ||
      (Array.isArray(content) ? content : Object.keys(content)).length === 0;
    if (!empty) style[part] = content;
  }
  return style as StyleSpec;
}

function requireStyle(state: DocState, name: unknown): StyleSpec {
  const style = typeof name === "string" ? state.styles[name] : undefined;
  if (!style) throw new DocError(`No style named ${JSON.stringify(name)}.`);
  return style;
}

/** Gives a graph a style, and its window the style's size. */
function withStyle(state: DocState, graph: GraphSpec, name: string): DocState {
  const style = requireStyle(state, name);
  return {
    ...putGraph(state, styledGraph(graph, style, name)),
    windows: styledWindows(state.windows, graph, style),
  };
}

type ImageProps = Pick<
  ImageSpec,
  "colorTable" | "zMin" | "zMax" | "reverse" | "layer" | "chunk" | "part"
>;
const IMAGE_VALIDATORS: { [K in keyof ImageProps]: (value: unknown) => ImageProps[K] } = {
  colorTable: (value) => oneOf(value, COLOR_TABLES, "colorTable"),
  zMin: nullableNumber("zMin"),
  zMax: nullableNumber("zMax"),
  reverse: (value) => bool(value, "reverse"),
  layer: (value) => index(value, "layer"),
  chunk: (value) => index(value, "chunk"),
  part: (value) => oneOf(value, COMPLEX_PARTS, "part"),
};

type ContourProps = Pick<
  ContourSpec,
  "levels" | "color" | "lineSize" | "colorTable" | "labels" | "layer" | "chunk"
>;
const CONTOUR_VALIDATORS: { [K in keyof ContourProps]: (value: unknown) => ContourProps[K] } = {
  levels: (value) => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 200) {
      return value;
    }
    if (Array.isArray(value) && value.length > 0 && value.length <= 200) {
      return value.map((level) => finite(level, "A contour level"));
    }
    throw new DocError("levels must be a count from 1 to 200, or a list of level values.");
  },
  color: normalizeColor,
  lineSize: (value) => positive(value, "lineSize"),
  colorTable: (value) => (value === null ? null : oneOf(value, COLOR_TABLES, "colorTable")),
  labels: (value) => bool(value, "labels"),
  layer: (value) => index(value, "layer"),
  chunk: (value) => index(value, "chunk"),
};

type AnnotationProps = Pick<AnnotationSpec, "text" | "anchor" | "frame" | "x" | "y" | "point">;
const ANNOTATION_VALIDATORS: {
  [K in keyof AnnotationProps]: (value: unknown) => AnnotationProps[K];
} = {
  text: (value) => {
    if (typeof value !== "string") throw new DocError("text must be text.");
    return value;
  },
  anchor: (value) => oneOf(value, ANCHORS, "anchor"),
  frame: (value) => bool(value, "frame"),
  x: (value) => finite(value, "x"),
  y: (value) => finite(value, "y"),
  point: (value) => index(value, "point"),
};

const pageSide = (what: string) => (value: unknown) => {
  const size = positive(value, what);
  if (size < 72 || size > 5000) throw new DocError(`${what} must be between 72 and 5000 points.`);
  return size;
};
const PAGE_VALIDATORS = { width: pageSide("width"), height: pageSide("height") };

type ItemProps = Pick<PageItem, "x" | "y" | "w" | "h" | "size" | "text">;
const ITEM_VALIDATORS: { [K in keyof ItemProps]: (value: unknown) => ItemProps[K] } = {
  x: (value) => finite(value, "x"),
  y: (value) => finite(value, "y"),
  w: (value) => Math.max(40, positive(value, "w")),
  h: (value) => Math.max(40, positive(value, "h")),
  size: (value) => {
    const size = positive(value, "size");
    if (size < 4 || size > 200) throw new DocError("size must be between 4 and 200.");
    return size;
  },
  text: (value) => {
    if (typeof value !== "string") throw new DocError("text must be text.");
    return value;
  },
};

const TRACE_DATA_VALIDATORS = someOf<TraceStyle, (typeof TRACE_DATA)[number]>(
  TRACE_VALIDATORS,
  TRACE_DATA,
);
const AXIS_DATA_VALIDATORS = someOf<Omit<AxisSpec, "side">, (typeof AXIS_DATA)[number]>(
  AXIS_VALIDATORS,
  AXIS_DATA,
);

function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 1000) throw new DocError(`${what} must be a list.`);
  return value;
}

function textOf(value: unknown, what: string): string {
  if (typeof value !== "string") throw new DocError(`${what} must be text.`);
  return value;
}

/** The properties of an object (as read from data) besides some that are taken out. */
function restOf(props: Props, taken: readonly string[]): Props {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !taken.includes(key)));
}

/** A validator that lets anything through, for properties checked on their own. */
const anything = (value: unknown): unknown => value;

/**
 * Checks a graph template given as data (from Python, a file or the
 * browser's library) and returns it in its usual form, with its parts in one
 * order so that equal templates are written alike. What is left out takes
 * the value a new graph would have; unknown properties, bad values and
 * references to slots, axes or traces it does not have are refused.
 */
export function checkGraphTemplate(value: unknown): GraphTemplate {
  const parts = propsOf(value, "A graph template");
  validateProps(
    parts,
    {
      style: anything,
      slots: anything,
      traces: anything,
      images: anything,
      contours: anything,
      axes: anything,
      annotations: anything,
      plot: anything,
    },
    "graph template",
  );

  const slots = listOf(parts.slots ?? [], "slots").map((item): TemplateSlot => {
    const props = propsOf(item, "A slot");
    validateProps(
      props,
      { name: anything, role: anything, unit: anything, xUnit: anything, yUnit: anything },
      "slot",
    );
    const name = checkName(props.name, "slot");
    if (RESERVED_SLOT_NAMES.has(name)) {
      throw new DocError(`A slot cannot be called ${name}: Python uses that word.`);
    }
    const scaling = (unit: unknown, what: string) =>
      unit === undefined || unit === null ? null : textOf(unit, what);
    return {
      name,
      role: oneOf(props.role, SLOT_ROLES, "role"),
      unit: props.unit === undefined ? "" : textOf(props.unit, "unit"),
      xUnit: scaling(props.xUnit, "xUnit"),
      yUnit: scaling(props.yUnit, "yUnit"),
    };
  });
  const slotNames = slots.map((slot) => slot.name);
  const doubled = slotNames.find((name, at) => slotNames.indexOf(name) !== at);
  if (doubled !== undefined) throw new DocError(`Two slots are called ${doubled}.`);
  const slot = (name: unknown, what: string): string => {
    if (typeof name === "string" && slotNames.includes(name)) return name;
    throw new DocError(
      `${what} must be one of the template's slots (${slotNames.join(", ") || "it has none"}), not ${JSON.stringify(name)}.`,
    );
  };

  const axisOf = (name: string, side: TemplateAxis["side"], data: AxisSpec): TemplateAxis => ({
    name,
    side,
    label: data.label,
    min: data.min,
    max: data.max,
    log: data.log,
    reverse: data.reverse,
    tickStep: data.tickStep,
    tickFormat: data.tickFormat,
    span: data.span,
  });
  const given = listOf(parts.axes ?? [], "axes").map((item): TemplateAxis => {
    const props = propsOf(item, "An axis");
    const name = checkName(props.name, "axis");
    const isSide = (AXIS_SIDES as readonly string[]).includes(name);
    const side = oneOf(props.side ?? (isSide ? name : undefined), AXIS_SIDES, "side");
    if (isSide && side !== name) throw new DocError(`The ${name} axis is on the ${name} side.`);
    const axis = axisOf(name, side, {
      ...defaultAxis(side),
      ...validateProps(restOf(props, ["name", "side"]), AXIS_DATA_VALIDATORS, "template axis"),
    });
    if (axis.min !== null && axis.max !== null && axis.min === axis.max) {
      throw new DocError("The axis range must not be empty.");
    }
    return axis;
  });
  const axisNames = given.map((axis) => axis.name);
  const twice = axisNames.find((name, at) => axisNames.indexOf(name) !== at);
  if (twice !== undefined) throw new DocError(`Two axes are called ${twice}.`);
  // The four sides are always there, first, as in every graph.
  const axes: TemplateAxis[] = [
    ...AXIS_SIDES.map(
      (side) => given.find((axis) => axis.name === side) ?? axisOf(side, side, defaultAxis(side)),
    ),
    ...given.filter((axis) => !(AXIS_SIDES as readonly string[]).includes(axis.name)),
  ];
  const axisRef = (name: unknown, vertical: boolean): string => {
    const axis = axes.find((item) => item.name === name);
    if (!axis) {
      throw new DocError(
        `The template has no axis named ${JSON.stringify(name)}. Axes: ${axes.map((item) => item.name).join(", ")}.`,
      );
    }
    if (isVerticalSide(axis.side) !== vertical) {
      throw new DocError(
        `Axis ${axis.name} is ${vertical ? "horizontal" : "vertical"}; a ${vertical ? "vertical" : "horizontal"} axis is needed here.`,
      );
    }
    return axis.name;
  };

  const traces = listOf(parts.traces ?? [], "traces").map((item): TemplateTrace => {
    const props = propsOf(item, "A trace");
    const data = {
      ...defaultTraceStyle(0),
      ...validateProps(
        restOf(props, ["y", "x", "vAxis", "hAxis"]),
        TRACE_DATA_VALIDATORS,
        "template trace",
      ),
    };
    const source = (value: ErrorSource, what: string): ErrorSource =>
      typeof value === "string" ? slot(value, what) : value;
    return {
      y: slot(props.y, "A trace's y"),
      x: props.x === undefined || props.x === null ? null : slot(props.x, "A trace's x"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      yError: source(data.yError, "yError"),
      xError: source(data.xError, "xError"),
      fill: data.fill,
      fillColor: data.fillColor,
      fillOpacity: data.fillOpacity,
      xOffset: data.xOffset,
      yOffset: data.yOffset,
      colorWave: data.colorWave === null ? null : slot(data.colorWave, "colorWave"),
      colorTable: data.colorTable,
      colorMin: data.colorMin,
      colorMax: data.colorMax,
      part: data.part,
    };
  });

  const images = listOf(parts.images ?? [], "images").map((item): TemplateImage => {
    const props = propsOf(item, "An image");
    const data: ImageProps = {
      colorTable: "grays",
      zMin: null,
      zMax: null,
      reverse: false,
      layer: 0,
      chunk: 0,
      part: "real",
      ...validateProps<ImageProps>(
        restOf(props, ["wave", "vAxis", "hAxis"]),
        IMAGE_VALIDATORS,
        "image",
      ),
    };
    return {
      wave: slot(props.wave, "An image's wave"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      colorTable: data.colorTable,
      zMin: data.zMin,
      zMax: data.zMax,
      reverse: data.reverse,
      layer: data.layer,
      chunk: data.chunk,
      part: data.part,
    };
  });

  const contours = listOf(parts.contours ?? [], "contours").map((item): TemplateContour => {
    const props = propsOf(item, "A contour");
    const data: ContourProps = {
      levels: 10,
      color: "#000000",
      lineSize: 1,
      colorTable: null,
      labels: true,
      layer: 0,
      chunk: 0,
      ...validateProps<ContourProps>(
        restOf(props, ["wave", "vAxis", "hAxis"]),
        CONTOUR_VALIDATORS,
        "contour",
      ),
    };
    return {
      wave: slot(props.wave, "A contour's wave"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      levels: data.levels,
      color: data.color,
      lineSize: data.lineSize,
      colorTable: data.colorTable,
      labels: data.labels,
      layer: data.layer,
      chunk: data.chunk,
    };
  });

  const annotations = listOf(parts.annotations ?? [], "annotations").map(
    (item): TemplateAnnotation => {
      const props = propsOf(item, "An annotation");
      const kind = oneOf(props.kind, ANNOTATION_KINDS, "kind");
      const tag = kind === "tag";
      const data = validateProps<AnnotationProps>(
        restOf(props, ["kind", "trace"]),
        ANNOTATION_VALIDATORS,
        "annotation",
      );
      const trace = props.trace === undefined || props.trace === null ? null : props.trace;
      if (trace !== null && !tag) throw new DocError("Only a tag points at a trace.");
      if (tag && trace === null) throw new DocError("A tag needs the trace it points at.");
      const place = trace === null ? null : index(trace, "trace");
      if (place !== null && place >= traces.length) {
        throw new DocError(
          `A tag points at trace ${place}, but the template has ${traces.length} (counted from 0).`,
        );
      }
      return {
        kind,
        text: data.text ?? "",
        anchor: data.anchor ?? (kind === "colorscale" ? "RC" : "RT"),
        frame: data.frame ?? true,
        x: data.x ?? (tag ? TAG_OFFSET.x : 0),
        y: data.y ?? (tag ? TAG_OFFSET.y : 0),
        trace: place,
        point: data.point ?? 0,
      };
    },
  );

  let plot: GraphTemplate["plot"];
  if (parts.plot !== undefined && parts.plot !== null) {
    const given = validateProps<{ width: PlotDimension; height: PlotDimension }>(
      propsOf(parts.plot, "plot"),
      {
        width: (item) => checkPlotDimension(item, "width"),
        height: (item) => checkPlotDimension(item, "height"),
      },
      "plot size",
    );
    const width = given.width ?? AUTO_SIZE;
    const height = given.height ?? AUTO_SIZE;
    checkPlotSize(
      width,
      height,
      (name) => axes.find((axis) => axis.name === name)?.side,
      "The template",
    );
    if (width.mode !== "auto" || height.mode !== "auto") plot = { width, height };
  }

  return {
    style: checkStyle(parts.style ?? {}),
    slots,
    traces,
    images,
    contours,
    axes,
    annotations,
    ...(plot ? { plot } : {}),
  };
}

function requireTemplate(state: DocState, name: unknown): GraphTemplate {
  const template = typeof name === "string" ? state.graphTemplates[name] : undefined;
  if (!template) throw new DocError(`No graph template named ${JSON.stringify(name)}.`);
  return template;
}

const putTemplate = (state: DocState, name: string, template: GraphTemplate): DocState => ({
  ...state,
  graphTemplates: withEntry(state.graphTemplates, name, template),
});

function requireAnalysisTemplate(state: DocState, name: unknown): AnalysisTemplate {
  const template = typeof name === "string" ? state.templates[name] : undefined;
  if (!template) throw new DocError(`No template named ${JSON.stringify(name)}.`);
  return template;
}

const putAnalysisTemplate = (
  state: DocState,
  name: string,
  template: AnalysisTemplate,
): DocState => ({ ...state, templates: withEntry(state.templates, name, template) });

function requireRun(state: DocState, name: unknown): TemplateRun {
  const run = typeof name === "string" ? state.runs[name] : undefined;
  if (!run) throw new DocError(`No run named ${JSON.stringify(name)}.`);
  return run;
}

function requirePage(state: DocState, name: string): PageSpec {
  const page = state.pages[name];
  if (!page) throw new DocError(`No page layout named ${JSON.stringify(name)}.`);
  return page;
}

const putPage = (state: DocState, page: PageSpec): DocState => ({
  ...state,
  pages: withEntry(state.pages, page.name, page),
});

function validateProps<T>(
  props: Props,
  validators: { [K in keyof T]: (value: unknown) => T[K] },
  what: string,
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(props)) {
    // Own properties only: "constructor" is not a property, though every object has one.
    const validate = Object.hasOwn(validators, key)
      ? (validators as Record<string, (value: unknown) => unknown>)[key]
      : undefined;
    if (!validate) {
      throw new DocError(
        `Unknown ${what} property ${JSON.stringify(key)}. Known properties: ${Object.keys(validators).join(", ")}.`,
      );
    }
    (result as Record<string, unknown>)[key] = validate(value);
  }
  return result;
}

/**
 * Rewrites every reference to a wave after waves have been renamed or moved.
 * `previous` holds the waves as they were before: a formula that was up to
 * date with an input stays so when only the input's name changed.
 */
function renameReferences(
  state: DocState,
  rename: (name: string) => string,
  previous: DocState["waves"],
): DocState {
  const graphs = dict<GraphSpec>();
  for (const graph of Object.values(state.graphs)) {
    const traces: TraceSpec[] = [];
    const traceNames = new Map<string, string>();
    for (const trace of graph.traces) {
      const y = rename(trace.y);
      // A trace is named after its Y wave, so it follows a rename.
      const name = y === trace.y ? trace.name : nextItemName(traces, leafName(y));
      traceNames.set(trace.name, name);
      traces.push({
        ...trace,
        name,
        y,
        x: trace.x === null ? null : rename(trace.x),
        yError: typeof trace.yError === "string" ? rename(trace.yError) : trace.yError,
        xError: typeof trace.xError === "string" ? rename(trace.xError) : trace.xError,
        colorWave: trace.colorWave === null ? null : rename(trace.colorWave),
      });
    }
    const cursors: GraphSpec["cursors"] = dict(
      Object.entries(graph.cursors).map(([key, cursor]) => [
        key,
        { ...cursor, trace: traceNames.get(cursor.trace) ?? cursor.trace },
      ]),
    );
    graphs[graph.name] = {
      ...graph,
      traces,
      cursors,
      annotations: graph.annotations.map((item) =>
        item.trace === null ? item : { ...item, trace: traceNames.get(item.trace) ?? item.trace },
      ),
      images: graph.images.map((image) => ({ ...image, wave: rename(image.wave) })),
      contours: graph.contours.map((contour) => ({ ...contour, wave: rename(contour.wave) })),
    };
  }
  const tables = dict<TableSpec>();
  for (const table of Object.values(state.tables)) {
    tables[table.name] = {
      ...table,
      columns: table.columns.map(rename),
      widths: dict(Object.entries(table.widths).map(([wave, width]) => [rename(wave), width])),
    };
  }
  const results = dict<AnalysisResult>();
  for (const result of Object.values(state.results)) {
    results[result.name] = renameInResult(result, rename);
  }
  const runs = dict<TemplateRun>();
  for (const run of Object.values(state.runs)) runs[run.name] = renameInRun(run, rename);
  let waves = state.waves;
  for (const wave of Object.values(state.waves)) {
    const formula = wave.formula;
    if (!formula || !Object.keys(formula.inputs).some((input) => rename(input) !== input)) {
      continue;
    }
    const inputs = dict<number | null>();
    for (const [input, rev] of Object.entries(formula.inputs)) {
      const name = rename(input);
      inputs[name] =
        rev !== null && previous[input]?.rev === rev ? (state.waves[name]?.rev ?? null) : rev;
    }
    const expr = renameInFormula(formula.expr, rename);
    // Only where the values come from has changed, not the values: no new revision.
    waves = withEntry(waves, wave.name, { ...wave, formula: { ...formula, expr, inputs } });
  }
  const panels = renameInPanels(state.panels, rename);
  // A sample's attributes go where its wave or folder goes.
  const attributes = renameAttributeKeys(state.attributes, rename);
  return { ...state, waves, graphs, tables, results, panels, runs, attributes };
}

/** A wave under a new name; a formula that was up to date with it stays so. */
function moved(wave: Wave, name: string): Wave {
  const next = changed(wave, { name });
  const { formula } = wave;
  return formula && formula.rev === wave.rev
    ? { ...next, formula: { ...formula, rev: next.rev } }
    : next;
}

/** A wave without its formula, keeping its values. */
function withoutFormula(wave: Wave): Wave {
  const { formula: _formula, ...rest } = wave;
  return rest;
}

/** Writes what a formula computed into its wave, making the wave if it does not exist. */
function putFormulaResult(
  state: DocState,
  name: string,
  formula: Pick<Formula, "expr" | "auto">,
  outcome: FormulaOutcome,
): DocState {
  const existing = state.waves[name];
  const rev = nextRev();
  const content = {
    data: outcome.values,
    imag: null,
    type: "float64" as const,
    text: null,
    shape: [outcome.values.length],
    rev,
  };
  const wave: Wave = existing
    ? { ...existing, ...content }
    : {
        name,
        ...content,
        x0: outcome.x0,
        dx: outcome.dx,
        xUnit: outcome.xUnit,
        y0: 0,
        dy: 1,
        yUnit: "",
        unit: "",
        note: "",
      };
  return putWave(state, {
    ...wave,
    formula: {
      expr: formula.expr,
      auto: formula.auto,
      inputs: outcome.inputs,
      rev,
      error: null,
      zeroDivisions: outcome.zeroDivisions,
    },
  });
}

/**
 * Computes a wave's formula again. If that fails, the values stay as they
 * were and the formula keeps why, as of the inputs as they are now: it is
 * not tried again until one of them (or the wave) changes.
 */
function recompute(state: DocState, name: string): DocState {
  const wave = state.waves[name]!;
  const formula = wave.formula!;
  try {
    return putFormulaResult(state, name, formula, evaluateFormula(state, name, formula.expr));
  } catch (error) {
    if (!(error instanceof DocError)) throw error;
    const inputs = dict<number | null>(
      Object.keys(formula.inputs).map((input) => [input, state.waves[input]?.rev ?? null]),
    );
    const message = error instanceof FormulaError ? `${error.detail}.` : error.message;
    return putWave(state, {
      ...wave,
      formula: { ...formula, inputs, rev: wave.rev, error: message },
    });
  }
}

/**
 * Brings every automatic formula up to date with its inputs, inputs before
 * the waves computed from them. The document runs every change through
 * this, so that in every state it holds, automatic formulas are up to date
 * and their recomputation belongs to the change that made it necessary.
 */
export function settleFormulas(state: DocState): DocState {
  const outdated = Object.values(state.waves).some(
    (wave) => wave.formula?.auto && !formulaCurrent(state, wave.name, wave.formula),
  );
  if (!outdated) return state;
  let next = state;
  for (const name of formulaOrder(state)) {
    const formula = next.waves[name]?.formula;
    if (formula?.auto && !formulaCurrent(next, name, formula)) next = recompute(next, name);
  }
  return next;
}

function waveUsers(state: DocState, name: string): string[] {
  const users: string[] = [];
  for (const graph of Object.values(state.graphs)) {
    const used =
      graph.traces.some(
        (trace) =>
          trace.y === name ||
          trace.x === name ||
          trace.yError === name ||
          trace.xError === name ||
          trace.colorWave === name,
      ) ||
      graph.images.some((image) => image.wave === name) ||
      graph.contours.some((contour) => contour.wave === name);
    if (used) users.push(graph.name);
  }
  for (const table of Object.values(state.tables)) {
    if (table.columns.includes(name)) users.push(table.name);
  }
  return users;
}

function removeWaves(state: DocState, names: readonly string[]): DocState {
  for (const name of names) {
    const users = waveUsers(state, name);
    if (users.length > 0) {
      // A closed window still shows its waves when it is reopened, so it keeps them too.
      const closed = new Set(
        state.windows.filter((window) => window.hidden).map((window) => window.name),
      );
      const named = users.map((user) => (closed.has(user) ? `${user} (closed)` : user));
      throw new DocError(
        `Wave ${JSON.stringify(name)} is in use by ${named.join(", ")}. Remove it from there first${
          closed.size > 0 && users.some((user) => closed.has(user))
            ? ", or kill the closed window"
            : ""
        }.`,
      );
    }
  }
  const waves = withoutEntries(state.waves, names);
  return {
    ...state,
    waves,
    waveOrder: state.waveOrder.filter((name) => name in waves),
    attributes: dropAttributes(state.attributes, (key) => names.includes(key)),
  };
}

function changed(wave: Wave, change: Partial<Wave>): Wave {
  return { ...wave, ...change, rev: nextRev() };
}

function emptyGraph(name: string): GraphSpec {
  return {
    name,
    traces: [],
    images: [],
    contours: [],
    axes: dict(AXIS_SIDES.map((side) => [side, defaultAxis(side)])),
    annotations: [],
    cursors: dict(),
    fontSize: 12,
    fontFamily: DEFAULT_FONT_FAMILY,
    showInfo: false,
    marginLeft: null,
    marginBottom: null,
    marginRight: null,
    marginTop: null,
    magnification: 1,
    link: null,
    width: AUTO_SIZE,
    height: AUTO_SIZE,
    style: null,
  };
}

function requireItem<T extends { name: string }>(
  items: readonly T[],
  name: string,
  graph: string,
  what: string,
): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new DocError(`${graph} has no ${what} named ${JSON.stringify(name)}.`);
  return item;
}

/** Checks that an error-bar wave exists and matches its trace. */
function checkErrorWaves(state: DocState, trace: TraceSpec): void {
  const length = state.waves[trace.y]?.data.length;
  if (trace.colorWave !== null) {
    const wave = requireNumeric(state, trace.colorWave, 1, "used to color a trace");
    if (length !== undefined && wave.data.length !== length) {
      throw new DocError(
        `Color wave ${wave.name} has ${wave.data.length} points but ${trace.y} has ${length}.`,
      );
    }
  }
  for (const source of [trace.yError, trace.xError]) {
    if (typeof source !== "string") continue;
    const wave = requireNumeric(state, source, 1, "used for error bars");
    if (length !== undefined && wave.data.length !== length) {
      throw new DocError(
        `Error wave ${wave.name} has ${wave.data.length} points but ${trace.y} has ${length}.`,
      );
    }
  }
}

/** Applies one command. Pure: returns a new state, or throws {@link DocError}. */
export function applyCommand(state: DocState, command: Command): CommandOutcome {
  switch (command.op) {
    case "makeWave": {
      const name = checkPath(command.name, "wave");
      const existing = state.waves[name];
      if (existing && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(name)} already exists.`);
      }
      const wave: Wave = {
        name,
        ...contentOf(command),
        x0: finite(command.x0 ?? existing?.x0 ?? 0, "x0"),
        dx: step(command.dx ?? existing?.dx ?? 1, "dx"),
        xUnit: command.xUnit ?? existing?.xUnit ?? "",
        y0: finite(command.y0 ?? existing?.y0 ?? 0, "y0"),
        dy: step(command.dy ?? existing?.dy ?? 1, "dy"),
        yUnit: command.yUnit ?? existing?.yUnit ?? "",
        unit: command.unit ?? existing?.unit ?? "",
        note: command.note ?? existing?.note ?? "",
        rev: nextRev(),
      };
      return { state: putWave(state, wave), result: name };
    }
    case "setWaveData": {
      const wave = requireWave(state, command.name);
      // New values of the same total size keep the wave's shape.
      const sameSize = command.data !== undefined && command.data.length === wave.data.length;
      const content = contentOf({
        ...command,
        shape: command.shape ?? (sameSize && !wave.text ? wave.shape : undefined),
      });
      return { state: putWave(state, changed(wave, content)), result: null };
    }
    case "setWavePoints": {
      const wave = requireWave(state, command.name);
      if (wave.text) throw new DocError(`${wave.name} is a text wave.`);
      const { start, values } = command;
      if (command.imag && !wave.imag) {
        throw new DocError(`${wave.name} is not a complex wave.`);
      }
      if (command.imag && command.imag.length !== values.length) {
        throw new DocError("The real and imaginary parts have different lengths.");
      }
      const growable = wave.shape.length === 1;
      const limit = growable ? wave.data.length : wave.data.length - values.length;
      if (!Number.isInteger(start) || start < 0 || start > limit) {
        throw new DocError(
          `Point ${start} is out of range for ${JSON.stringify(wave.name)} (${wave.data.length} points).`,
        );
      }
      const grown = Math.max(0, start + values.length - wave.data.length);
      const data = resized(wave.data, wave.data.length, 0, grown, 0);
      storeValues(data, wave.type, values, start);
      let { imag } = wave;
      if (imag && (grown > 0 || command.imag)) {
        imag = resized(imag, imag.length, 0, grown, 0);
        if (command.imag) storeValues(imag, wave.type, command.imag, start);
      }
      const shape = growable ? [data.length] : wave.shape;
      return { state: putWave(state, changed(wave, { data, imag, shape })), result: null };
    }
    case "redimension": {
      const wave = requireWave(state, command.name);
      if (wave.text) throw new DocError(`${wave.name} is a text wave; it has no number type.`);
      const type = oneOf(command.type, WAVE_TYPES, "type");
      if (type === wave.type) return { state, result: null };
      const data = toWaveData(wave.data, type);
      // Becoming complex adds a zero imaginary part; becoming real keeps the real part.
      const imag = isComplexType(type)
        ? wave.imag
          ? toWaveData(wave.imag, type)
          : newWaveData(type, data.length)
        : null;
      return { state: putWave(state, changed(wave, { data, imag, type })), result: null };
    }
    case "setWaveText": {
      const wave = requireWave(state, command.name);
      if (!wave.text) throw new DocError(`${wave.name} is not a text wave.`);
      const { start, values } = command;
      if (!Number.isInteger(start) || start < 0 || start > wave.text.length) {
        throw new DocError(`Point ${start} is out of range for ${JSON.stringify(wave.name)}.`);
      }
      const text = [...wave.text];
      values.forEach((value, offset) => {
        text[start + offset] = String(value);
      });
      return { state: putWave(state, changed(wave, { text, shape: [text.length] })), result: null };
    }
    case "insertPoints":
    case "deletePoints": {
      const wave = requireWave(state, command.name);
      if (wave.shape.length !== 1) {
        throw new DocError("Points can be inserted or deleted only in a 1-D wave.");
      }
      const length = wave.shape[0]!;
      const { at, count } = command;
      const inserting = command.op === "insertPoints";
      if (!Number.isInteger(at) || at < 0 || (inserting ? at > length : at >= length)) {
        throw new DocError(`Point ${at} is out of range.`);
      }
      if (!Number.isInteger(count) || count < 1) throw new DocError("count must be at least 1.");
      const end = inserting ? at : Math.min(length, at + count);
      if (wave.text) {
        // Built by concatenation: a spread into splice() fails for very large counts.
        const text = [
          ...wave.text.slice(0, at),
          ...(inserting ? Array.from({ length: count }, () => "") : []),
          ...wave.text.slice(end),
        ];
        return {
          state: putWave(state, changed(wave, { text, shape: [text.length] })),
          result: null,
        };
      }
      const added = inserting ? count : 0;
      // New points are NaN (0 in an integer wave, which has no NaN).
      const data = resized(wave.data, at, end - at, added, Number.NaN);
      const imag = wave.imag ? resized(wave.imag, at, end - at, added, Number.NaN) : null;
      return {
        state: putWave(state, changed(wave, { data, imag, shape: [data.length] })),
        result: null,
      };
    }
    case "setWaveScale": {
      const wave = requireWave(state, command.name);
      return {
        state: putWave(
          state,
          changed(wave, {
            x0: finite(command.x0 ?? wave.x0, "x0"),
            dx: step(command.dx ?? wave.dx, "dx"),
            xUnit: command.xUnit ?? wave.xUnit,
            y0: finite(command.y0 ?? wave.y0, "y0"),
            dy: step(command.dy ?? wave.dy, "dy"),
            yUnit: command.yUnit ?? wave.yUnit,
          }),
        ),
        result: null,
      };
    }
    case "setWaveMeta": {
      const wave = requireWave(state, command.name);
      return {
        state: putWave(
          state,
          changed(wave, { unit: command.unit ?? wave.unit, note: command.note ?? wave.note }),
        ),
        result: null,
      };
    }
    case "renameWave": {
      const wave = requireWave(state, command.name);
      const newName = checkPath(command.newName, "wave");
      if (newName === wave.name) return { state, result: null };
      if (newName in state.waves) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`);
      }
      const waves = withEntry(
        withoutEntries(state.waves, [wave.name]),
        newName,
        moved(wave, newName),
      );
      const renamed = renameReferences(
        {
          ...withFolders(state, parentFolder(newName)),
          waves,
          waveOrder: state.waveOrder.map((name) => (name === wave.name ? newName : name)),
        },
        (name) => (name === wave.name ? newName : name),
        state.waves,
      );
      return { state: renamed, result: newName };
    }
    case "duplicateWave": {
      const wave = requireWave(state, command.name);
      const newName = checkPath(command.newName, "wave");
      if (newName in state.waves && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`);
      }
      return {
        // The copy has the values but not the formula, as in Igor.
        state: putWave(
          state,
          withoutFormula(
            changed(wave, {
              name: newName,
              data: wave.data.slice(),
              imag: wave.imag?.slice() ?? null,
            }),
          ),
        ),
        result: newName,
      };
    }
    case "killWaves": {
      const names = command.names.map((name) => requireWave(state, name).name);
      return { state: removeWaves(state, names), result: null };
    }
    case "setFormula": {
      const name = checkPath(command.name, "wave");
      if (command.expr === null) {
        const wave = requireWave(state, name);
        if (!wave.formula) return { state, result: null };
        return { state: putWave(state, withoutFormula(wave)), result: null };
      }
      if (typeof command.expr !== "string") throw new DocError("A formula must be text.");
      const auto = command.auto === undefined ? true : bool(command.auto, "auto");
      const expr = command.expr.trim();
      const parsed = parseFormula(expr);
      checkCycle(state, name, parsed);
      const outcome = evaluateFormula(state, name, parsed);
      return { state: putFormulaResult(state, name, { expr, auto }, outcome), result: name };
    }
    case "recalculate": {
      let names: Set<string> | null = null;
      if (command.names !== undefined) {
        names = new Set();
        for (const given of command.names) {
          const wave = requireWave(state, given);
          if (!wave.formula) throw new DocError(`${wave.name} has no formula.`);
          names.add(wave.name);
        }
      }
      let next = state;
      for (const name of formulaOrder(state)) {
        if (names && !names.has(name)) continue;
        const formula = next.waves[name]!.formula!;
        // What failed is tried again: the reason may lie outside its inputs (the wave's scaling).
        if (formula.error === null && formulaCurrent(next, name, formula)) continue;
        next = recompute(next, name);
      }
      return { state: next, result: null };
    }
    case "newFolder": {
      const path = checkPath(command.path, "data folder");
      if (state.folders.includes(path)) {
        throw new DocError(`Data folder ${JSON.stringify(path)} already exists.`);
      }
      return { state: withFolders(state, path), result: path };
    }
    case "renameFolder": {
      const path = checkPath(command.path, "data folder");
      const newPath = checkPath(command.newPath, "data folder");
      if (!state.folders.includes(path)) {
        throw new DocError(`No data folder named ${JSON.stringify(path)}.`);
      }
      if (newPath === path) return { state, result: null };
      if (state.folders.includes(newPath) || newPath.startsWith(`${path}:`)) {
        throw new DocError(`Cannot move ${path} to ${newPath}.`);
      }
      const move = (name: string) =>
        name === path || name.startsWith(`${path}:`) ? newPath + name.slice(path.length) : name;
      const waves = dict<Wave>();
      for (const wave of Object.values(state.waves)) {
        const name = move(wave.name);
        if (name !== wave.name && name in state.waves) {
          throw new DocError(`Wave ${JSON.stringify(name)} already exists.`);
        }
        waves[name] = name === wave.name ? wave : moved(wave, name);
      }
      const renamed = renameReferences(
        {
          ...state,
          waves,
          waveOrder: state.waveOrder.map(move),
          folders: state.folders.map(move),
        },
        move,
        state.waves,
      );
      return { state: withFolders(renamed, parentFolder(newPath)), result: newPath };
    }
    case "killFolder": {
      const path = checkPath(command.path, "data folder");
      if (!state.folders.includes(path)) {
        throw new DocError(`No data folder named ${JSON.stringify(path)}.`);
      }
      const inside = (name: string) => name === path || name.startsWith(`${path}:`);
      const emptied = removeWaves(state, state.waveOrder.filter(inside));
      return {
        state: {
          ...emptied,
          folders: state.folders.filter((folder) => !inside(folder)),
          attributes: dropAttributes(
            emptied.attributes,
            (key) => isFolderKey(key) && inside(key.slice(0, -1)),
          ),
        },
        result: null,
      };
    }
    case "display": {
      const name =
        command.name === undefined
          ? uniqueName("Graph", windowTaken(state))
          : checkName(command.name, "graph");
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      const style = command.style === undefined ? state.defaultStyle : command.style;
      if (style !== null) requireStyle(state, style);
      const empty = emptyGraph(name);
      const graph =
        command.y.length === 0
          ? empty
          : addTraces(state, empty, command.y, command.x ?? null, "left", "bottom");
      const made = {
        ...putGraph(state, graph),
        windows: [...state.windows, placeWindow(state, name, "graph")],
      };
      return { state: style === null ? made : withStyle(made, graph, style), result: name };
    }
    case "appendTraces": {
      const graph = requireGraph(state, command.graph);
      const next = addTraces(
        state,
        graph,
        command.y,
        command.x ?? null,
        command.vAxis ?? "left",
        command.hAxis ?? "bottom",
      );
      // New traces take their places in the cycle of the graph's style.
      const style = graph.style === null ? undefined : state.styles[graph.style];
      const traces = next.traces.map((trace, index) =>
        index < graph.traces.length ? trace : { ...trace, ...traceLook(style, index) },
      );
      return { state: putGraph(state, { ...next, traces }), result: next.traces.at(-1)!.name };
    }
    case "removeTraces": {
      const graph = requireGraph(state, command.graph);
      for (const name of command.traces) requireItem(graph.traces, name, graph.name, "trace");
      const traces = graph.traces.filter((trace) => !command.traces.includes(trace.name));
      const cursors = filterDict(graph.cursors, (cursor) => !command.traces.includes(cursor.trace));
      // A tag goes with the trace it points at.
      const annotations = graph.annotations.filter(
        (item) => item.trace === null || !command.traces.includes(item.trace),
      );
      return { state: putGraph(state, { ...graph, traces, cursors, annotations }), result: null };
    }
    case "modifyTrace": {
      const graph = requireGraph(state, command.graph);
      const trace = requireItem(graph.traces, command.trace, graph.name, "trace");
      const next = {
        ...trace,
        ...validateProps<TraceStyle>(command.props, TRACE_VALIDATORS, "trace"),
      };
      checkErrorWaves(state, next);
      const normalized: TraceSpec = {
        ...next,
        yError:
          typeof next.yError === "string" ? requireWave(state, next.yError).name : next.yError,
        xError:
          typeof next.xError === "string" ? requireWave(state, next.xError).name : next.xError,
        colorWave: next.colorWave === null ? null : requireWave(state, next.colorWave).name,
      };
      const traces = graph.traces.map((item) => (item === trace ? normalized : item));
      return { state: putGraph(state, { ...graph, traces }), result: null };
    }
    case "addAxis": {
      const graph = requireGraph(state, command.graph);
      const name = checkName(command.name, "axis");
      if (name in graph.axes) {
        throw new DocError(`${graph.name} already has an axis named ${JSON.stringify(name)}.`);
      }
      const plain = defaultAxis(oneOf(command.side, AXIS_SIDES, "side"));
      const style = graph.style === null ? undefined : state.styles[graph.style];
      const axis = { ...plain, ...axisLook(style, name, plain) };
      return {
        state: putGraph(state, { ...graph, axes: withEntry(graph.axes, name, axis) }),
        result: name,
      };
    }
    case "removeAxis": {
      const graph = requireGraph(state, command.graph);
      if (!(command.axis in graph.axes)) {
        throw new DocError(`${graph.name} has no axis named ${JSON.stringify(command.axis)}.`);
      }
      if ((AXIS_SIDES as readonly string[]).includes(command.axis)) {
        throw new DocError("The left, bottom, right and top axes cannot be removed.");
      }
      const users = [...graph.traces, ...graph.images, ...graph.contours].filter(
        (item) => item.vAxis === command.axis || item.hAxis === command.axis,
      );
      if (users.length > 0) {
        throw new DocError(
          `Axis ${command.axis} is in use by ${users.map((item) => item.name).join(", ")}.`,
        );
      }
      const sizing = (["width", "height"] as const).filter((side) =>
        sizeAxes(graph[side]).includes(command.axis),
      );
      if (sizing.length > 0) {
        throw new DocError(
          `Axis ${command.axis} sizes the ${sizing.join(" and the ")} of the plot area. Size it another way first.`,
        );
      }
      const axes = withoutEntries(graph.axes, [command.axis]);
      return { state: putGraph(state, { ...graph, axes }), result: null };
    }
    case "modifyAxis": {
      const graph = requireGraph(state, command.graph);
      const current = graph.axes[command.axis];
      if (!current) {
        throw new DocError(
          `${graph.name} has no axis named ${JSON.stringify(command.axis)}. Axes: ${Object.keys(graph.axes).join(", ")}.`,
        );
      }
      const axis = {
        ...current,
        ...validateProps<Omit<AxisSpec, "side">>(command.props, AXIS_VALIDATORS, "axis"),
      };
      if (axis.min !== null && axis.max !== null && axis.min === axis.max) {
        throw new DocError("The axis range must not be empty.");
      }
      if (axis.log && ((axis.min ?? 1) <= 0 || (axis.max ?? 1) <= 0)) {
        throw new DocError("A log axis needs a range greater than 0.");
      }
      const next = putGraph(state, { ...graph, axes: withEntry(graph.axes, command.axis, axis) });
      return { state: followRange(next, graph, command.axis, command.props), result: null };
    }
    case "modifyGraph": {
      const graph = requireGraph(state, command.graph);
      const props = validateProps<GraphProps>(command.props, GRAPH_PROP_VALIDATORS, "graph");
      const next = { ...graph, ...props };
      if (props.width !== undefined || props.height !== undefined) {
        checkPlotSize(next.width, next.height, (axis) => next.axes[axis]?.side, graph.name);
      }
      // Showing the cursor readout grows the window by its bar, and hiding it
      // shrinks the window back, so the figure keeps its size (as in Igor).
      // The window grows downwards, past the desktop if need be, as it does
      // when a style with a size is given; undo gives the old size back.
      // Magnifying the graph grows its window by as much, so the figure
      // keeps its size and is drawn bigger (as Igor's expand does).
      const windows =
        infoBarHeight(next) === infoBarHeight(graph) && next.magnification === graph.magnification
          ? state.windows
          : state.windows.map((window) =>
              window.name === graph.name
                ? { ...window, ...windowSizeFor(figureSize(window, graph), next) }
                : window,
            );
      return { state: { ...putGraph(state, next), windows }, result: null };
    }
    case "appendImage": {
      const graph = requireGraph(state, command.graph);
      const wave = requireNumeric(state, command.wave, 2, "shown as an image");
      const image: ImageSpec = {
        name: nextItemName(graph.images, leafName(wave.name)),
        wave: wave.name,
        vAxis: requireAxis(graph, command.vAxis ?? "left", true),
        hAxis: requireAxis(graph, command.hAxis ?? "bottom", false),
        colorTable: "grays",
        zMin: null,
        zMax: null,
        reverse: false,
        layer: 0,
        chunk: 0,
        part: "real",
        ...validateProps<ImageProps>(command.props ?? {}, IMAGE_VALIDATORS, "image"),
      };
      checkPlane(wave, image);
      return {
        state: putGraph(state, { ...graph, images: [...graph.images, image] }),
        result: image.name,
      };
    }
    case "modifyImage": {
      const graph = requireGraph(state, command.graph);
      const image = requireItem(graph.images, command.image, graph.name, "image");
      const next = {
        ...image,
        ...validateProps<ImageProps>(command.props, IMAGE_VALIDATORS, "image"),
      };
      checkPlane(requireWave(state, image.wave), next);
      const images = graph.images.map((item) => (item === image ? next : item));
      return { state: putGraph(state, { ...graph, images }), result: null };
    }
    case "removeImage": {
      const graph = requireGraph(state, command.graph);
      const image = requireItem(graph.images, command.image, graph.name, "image");
      const images = graph.images.filter((item) => item !== image);
      return { state: putGraph(state, { ...graph, images }), result: null };
    }
    case "appendContour": {
      const graph = requireGraph(state, command.graph);
      const wave = requireNumeric(state, command.wave, 2, "shown as contours");
      const contour: ContourSpec = {
        name: nextItemName(graph.contours, leafName(wave.name)),
        wave: wave.name,
        vAxis: requireAxis(graph, command.vAxis ?? "left", true),
        hAxis: requireAxis(graph, command.hAxis ?? "bottom", false),
        levels: 10,
        color: "#000000",
        lineSize: 1,
        colorTable: null,
        labels: true,
        layer: 0,
        chunk: 0,
        ...validateProps<ContourProps>(command.props ?? {}, CONTOUR_VALIDATORS, "contour"),
      };
      checkPlane(wave, contour);
      return {
        state: putGraph(state, { ...graph, contours: [...graph.contours, contour] }),
        result: contour.name,
      };
    }
    case "modifyContour": {
      const graph = requireGraph(state, command.graph);
      const contour = requireItem(graph.contours, command.contour, graph.name, "contour");
      const next = {
        ...contour,
        ...validateProps<ContourProps>(command.props, CONTOUR_VALIDATORS, "contour"),
      };
      checkPlane(requireWave(state, contour.wave), next);
      const contours = graph.contours.map((item) => (item === contour ? next : item));
      return { state: putGraph(state, { ...graph, contours }), result: null };
    }
    case "removeContour": {
      const graph = requireGraph(state, command.graph);
      const contour = requireItem(graph.contours, command.contour, graph.name, "contour");
      const contours = graph.contours.filter((item) => item !== contour);
      return { state: putGraph(state, { ...graph, contours }), result: null };
    }
    case "setCursor": {
      const graph = requireGraph(state, command.graph);
      const cursor: CursorName = oneOf(command.cursor, CURSOR_NAMES, "cursor");
      const trace = requireItem(graph.traces, command.trace, graph.name, "trace");
      const length = state.waves[trace.y]?.data.length ?? 0;
      if (!Number.isInteger(command.point) || command.point < 0 || command.point >= length) {
        throw new DocError(
          `Point ${command.point} is out of range for ${trace.name} (${length} points).`,
        );
      }
      const next = putGraph(state, {
        ...graph,
        cursors: withEntry(graph.cursors, cursor, { trace: trace.name, point: command.point }),
      });
      return {
        state: followCursor(next, graph, cursor, cursorX(state, trace, command.point)),
        result: null,
      };
    }
    case "removeCursor": {
      const graph = requireGraph(state, command.graph);
      const cursor: CursorName = oneOf(command.cursor, CURSOR_NAMES, "cursor");
      const cursors = withoutEntries(graph.cursors, [cursor]);
      return {
        state: followCursor(putGraph(state, { ...graph, cursors }), graph, cursor, null),
        result: null,
      };
    }
    case "addAnnotation": {
      const graph = requireGraph(state, command.graph);
      const kind = oneOf(command.kind, ANNOTATION_KINDS, "kind");
      const text = ANNOTATION_VALIDATORS.text(command.text ?? "");
      if (kind === "colorscale") {
        if (graph.images.length === 0) throw new DocError(`${graph.name} has no image.`);
        if (text !== "") requireItem(graph.images, text, graph.name, "image");
      }
      const tag = kind === "tag";
      if (tag) {
        const trace = requireItem(graph.traces, command.trace ?? "", graph.name, "trace");
        const length = state.waves[trace.y]?.data.length ?? 0;
        if (index(command.point, "point") >= length) {
          throw new DocError(`Point ${command.point} is past the end of ${trace.name}.`);
        }
      }
      const annotation: AnnotationSpec = {
        name: uniqueName(kind, (name) => graph.annotations.some((item) => item.name === name)),
        kind,
        text,
        anchor: ANNOTATION_VALIDATORS.anchor(
          command.anchor ?? (kind === "colorscale" ? "RC" : "RT"),
        ),
        frame: ANNOTATION_VALIDATORS.frame(command.frame ?? true),
        x: ANNOTATION_VALIDATORS.x(command.x ?? (tag ? TAG_OFFSET.x : 0)),
        y: ANNOTATION_VALIDATORS.y(command.y ?? (tag ? TAG_OFFSET.y : 0)),
        trace: tag ? command.trace! : null,
        point: tag ? command.point! : 0,
      };
      return {
        state: putGraph(state, { ...graph, annotations: [...graph.annotations, annotation] }),
        result: annotation.name,
      };
    }
    case "modifyAnnotation": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.annotations, command.annotation, graph.name, "annotation");
      const props = validateProps<AnnotationProps>(
        command.props,
        ANNOTATION_VALIDATORS,
        "annotation",
      );
      const annotations = graph.annotations.map((item) =>
        item === target ? { ...item, ...props } : item,
      );
      return { state: putGraph(state, { ...graph, annotations }), result: null };
    }
    case "removeAnnotation": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.annotations, command.annotation, graph.name, "annotation");
      const annotations = graph.annotations.filter((item) => item !== target);
      return { state: putGraph(state, { ...graph, annotations }), result: null };
    }
    case "edit": {
      const name =
        command.name === undefined
          ? uniqueName("Table", windowTaken(state))
          : checkName(command.name, "table");
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      const columns = [...new Set(command.waves.map((wave) => requireWave(state, wave).name))];
      return {
        state: {
          ...putTable(state, { name, columns, digits: DEFAULT_TABLE_DIGITS, widths: dict() }),
          windows: [...state.windows, placeWindow(state, name, "table")],
        },
        result: name,
      };
    }
    case "appendToTable": {
      const table = requireTable(state, command.table);
      const added = command.waves.map((wave) => requireWave(state, wave).name);
      const columns = [...new Set([...table.columns, ...added])];
      return { state: putTable(state, { ...table, columns }), result: null };
    }
    case "removeFromTable": {
      const table = requireTable(state, command.table);
      const columns = table.columns.filter((column) => !command.waves.includes(column));
      const widths = filterDict(table.widths, (_, wave) => columns.includes(wave));
      return { state: putTable(state, { ...table, columns, widths }), result: null };
    }
    case "modifyTable": {
      const table = requireTable(state, command.table);
      const props = validateProps<Pick<TableSpec, "digits">>(
        command.props,
        {
          digits: (value) => {
            if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 17) {
              throw new DocError("digits must be a whole number from 1 to 17.");
            }
            return value;
          },
        },
        "table",
      );
      return { state: putTable(state, { ...table, ...props }), result: null };
    }
    case "resizeColumn": {
      const table = requireTable(state, command.table);
      if (!table.columns.includes(command.wave)) return { state, result: null };
      const width = Math.round(Math.max(32, Math.min(800, command.width)));
      return {
        state: putTable(state, { ...table, widths: withEntry(table.widths, command.wave, width) }),
        result: null,
      };
    }
    case "setTimeZone": {
      if (!isTimeZone(command.zone)) {
        throw new DocError(
          `${JSON.stringify(command.zone)} is not a time zone. Use "UTC", "local" or a name such as "Asia/Tokyo".`,
        );
      }
      return { state: { ...state, timeZone: command.zone }, result: null };
    }
    case "newLayout": {
      const name =
        command.name === undefined
          ? uniqueName("Layout", windowTaken(state))
          : checkName(command.name, "layout");
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      const page: PageSpec = {
        name,
        width: PAGE_VALIDATORS.width(command.width ?? PAGE_SIZES.A4[0]),
        height: PAGE_VALIDATORS.height(command.height ?? PAGE_SIZES.A4[1]),
        items: [],
      };
      return {
        state: {
          ...state,
          pages: withEntry(state.pages, name, page),
          windows: [...state.windows, placeWindow(state, name, "page")],
        },
        result: name,
      };
    }
    case "modifyLayout": {
      const page = requirePage(state, command.layout);
      const props = validateProps<Pick<PageSpec, "width" | "height">>(
        command.props,
        PAGE_VALIDATORS,
        "layout",
      );
      return { state: putPage(state, { ...page, ...props }), result: null };
    }
    case "addLayoutItem": {
      const page = requirePage(state, command.layout);
      const kind = oneOf(command.kind, ["graph", "text"] as const, "kind");
      const margin = 36;
      // Below what is there already, or back at the top if that is off the page.
      let below = margin;
      for (const item of page.items) below = Math.max(below, item.y + item.h + 12);
      const base = { x: margin, y: below < page.height - 2 * margin ? below : margin };
      let item: PageItem;
      if (kind === "graph") {
        const graph = requireGraph(state, command.graph ?? "");
        const w = Math.min(page.width - 2 * margin, 440);
        item = {
          name: uniqueName("graph", (name) => page.items.some((other) => other.name === name)),
          kind,
          graph: graph.name,
          text: "",
          ...base,
          w,
          h: Math.round(w * 0.68),
          size: 12,
        };
      } else {
        if (typeof command.text !== "string" || command.text === "") {
          throw new DocError("Give the text to put on the page.");
        }
        item = {
          name: uniqueName("text", (name) => page.items.some((other) => other.name === name)),
          kind,
          graph: null,
          text: command.text,
          ...base,
          w: 0,
          h: 0,
          size: 12,
        };
      }
      const given: Record<string, unknown> = {};
      for (const key of ["x", "y", "w", "h", "size"] as const) {
        if (command[key] !== undefined) given[key] = command[key];
      }
      item = { ...item, ...validateProps<ItemProps>(given, ITEM_VALIDATORS, "item") };
      return {
        state: putPage(state, { ...page, items: [...page.items, item] }),
        result: item.name,
      };
    }
    case "modifyLayoutItem": {
      const page = requirePage(state, command.layout);
      const target = requireItem(page.items, command.item, page.name, "item");
      const props = validateProps<ItemProps>(command.props, ITEM_VALIDATORS, "item");
      const items = page.items.map((item) => (item === target ? { ...item, ...props } : item));
      return { state: putPage(state, { ...page, items }), result: null };
    }
    case "removeLayoutItem": {
      const page = requirePage(state, command.layout);
      const target = requireItem(page.items, command.item, page.name, "item");
      return {
        state: putPage(state, { ...page, items: page.items.filter((item) => item !== target) }),
        result: null,
      };
    }
    case "newPanel":
    case "setPanel":
    case "modifyPanel":
    case "addControl":
    case "modifyControl":
    case "removeControl":
    case "moveControl":
    case "setControlValue":
      return applyPanelCommand(state, command);
    case "newProcedure": {
      let name = "Procedure";
      if (command.name !== undefined) {
        name = procedureName(command.name);
      } else {
        // Procedure, Procedure1, Procedure2: the first is plain, like Igor's.
        for (let count = 1; windowTaken(state)(name); count += 1) name = `Procedure${count}`;
      }
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      if (command.code !== undefined && typeof command.code !== "string") {
        throw new DocError("code must be text.");
      }
      const procedure: ProcedureSpec = {
        name,
        code: command.code ?? "",
        autoRun: command.autoRun === undefined ? true : bool(command.autoRun, "autoRun"),
      };
      return {
        state: {
          ...state,
          procedures: withEntry(state.procedures, name, procedure),
          windows: [...state.windows, placeWindow(state, name, "procedure")],
        },
        result: name,
      };
    }
    case "setProcedure": {
      const procedure = state.procedures[command.name];
      if (!procedure) throw new DocError(`No procedure named ${JSON.stringify(command.name)}.`);
      if (command.code !== undefined && typeof command.code !== "string") {
        throw new DocError("code must be text.");
      }
      const next: ProcedureSpec = {
        ...procedure,
        code: command.code ?? procedure.code,
        autoRun:
          command.autoRun === undefined ? procedure.autoRun : bool(command.autoRun, "autoRun"),
      };
      if (next.code === procedure.code && next.autoRun === procedure.autoRun) {
        return { state, result: null };
      }
      return {
        state: { ...state, procedures: withEntry(state.procedures, command.name, next) },
        result: null,
      };
    }
    case "newNote": {
      let name = "Note0";
      if (command.name !== undefined) {
        name = checkName(command.name, "note");
      } else {
        // Note0, Note1, ...: numbered from zero as graphs and tables are.
        for (let count = 1; windowTaken(state)(name); count += 1) name = `Note${count}`;
      }
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      if (command.text !== undefined && typeof command.text !== "string") {
        throw new DocError("text must be text.");
      }
      return {
        state: {
          ...state,
          notes: withEntry(state.notes, name, { name, text: command.text ?? "" }),
          windows: [...state.windows, placeWindow(state, name, "note")],
        },
        result: name,
      };
    }
    case "setNote": {
      const note = state.notes[command.name];
      if (!note) throw new DocError(`No note named ${JSON.stringify(command.name)}.`);
      if (typeof command.text !== "string") throw new DocError("text must be text.");
      if (command.text === note.text) return { state, result: null };
      return {
        state: {
          ...state,
          notes: withEntry(state.notes, command.name, { ...note, text: command.text }),
        },
        result: null,
      };
    }
    case "saveStyle": {
      const name = checkName(command.name, "style");
      requireGraph(state, command.graph);
      const style = captureStyle(state, command.graph, command.size === true);
      return { state: { ...state, styles: withEntry(state.styles, name, style) }, result: name };
    }
    case "setStyle": {
      const name = checkName(command.name, "style");
      const style = checkStyle(command.style);
      return { state: { ...state, styles: withEntry(state.styles, name, style) }, result: name };
    }
    case "addResult": {
      const kind = RESULT_KINDS.find(
        (item) => item === (command.result as { kind?: unknown } | null)?.kind,
      );
      const taken = (name: string) => name in state.results;
      // A name that is given replaces the result of that name: the same analysis, run again.
      const name =
        command.name === undefined
          ? uniqueName(RESULT_BASE[kind ?? "fit"], taken)
          : checkName(command.name, "result");
      const result = checkResult(command.result, name, state);
      // The result run again under its name keeps what it makes now, not what it made before.
      const before = state.results[name];
      const { state: next, kept } = keepOutputs(
        before ? dropKept(state, before) : state,
        name,
        result.outputs,
      );
      return {
        state: { ...next, results: withEntry(next.results, name, { ...result, kept }) },
        result: name,
      };
    }
    case "removeResults": {
      let next = state;
      for (const name of command.names) {
        const result = state.results[name];
        if (!result) throw new DocError(`No result named ${JSON.stringify(name)}.`);
        next = dropKept(next, result);
      }
      return {
        state: { ...next, results: withoutEntries(next.results, command.names) },
        result: null,
      };
    }
    case "renameResult": {
      const result = state.results[command.name];
      if (!result) throw new DocError(`No result named ${JSON.stringify(command.name)}.`);
      const newName = checkName(command.newName, "result");
      if (newName === command.name) return { state, result: newName };
      if (newName in state.results) {
        throw new DocError(`A result named ${JSON.stringify(newName)} already exists.`);
      }
      // Its copies move with it, and whatever names them follows (graphs, the result itself).
      let moved = state;
      if (state.folders.includes(keptFolder(command.name))) {
        moved = applyCommand(state, {
          op: "renameFolder",
          path: keptFolder(command.name),
          newPath: keptFolder(newName),
        }).state;
      }
      const runs = dict<TemplateRun>();
      for (const run of Object.values(moved.runs)) {
        runs[run.name] = renameResultInRun(run, command.name, newName);
      }
      return {
        state: {
          ...moved,
          results: withEntry(withoutEntries(moved.results, [command.name]), newName, {
            ...moved.results[command.name]!,
            name: newName,
          }),
          runs,
        },
        result: newName,
      };
    }
    case "setTemplate": {
      const name = checkName(command.name, "template");
      const template = checkAnalysisTemplate(command.template);
      return { state: putAnalysisTemplate(state, name, template), result: name };
    }
    case "removeTemplate": {
      requireAnalysisTemplate(state, command.name);
      return {
        state: { ...state, templates: withoutEntries(state.templates, [command.name]) },
        result: null,
      };
    }
    case "renameTemplate": {
      const template = requireAnalysisTemplate(state, command.name);
      const newName = checkName(command.newName, "template");
      if (newName === command.name) return { state, result: newName };
      if (newName in state.templates) {
        throw new DocError(`Template ${JSON.stringify(newName)} already exists.`);
      }
      const templates = withEntry(
        withoutEntries(state.templates, [command.name]),
        newName,
        template,
      );
      return { state: { ...state, templates }, result: newName };
    }
    case "addRun": {
      const taken = (name: string) => name in state.runs;
      const name =
        command.name === undefined ? uniqueName(RUN_BASE, taken) : checkName(command.name, "run");
      if (taken(name)) throw new DocError(`A run named ${JSON.stringify(name)} already exists.`);
      const run = checkRun(command.run, name);
      return { state: { ...state, runs: withEntry(state.runs, name, run) }, result: name };
    }
    case "updateRunSample": {
      const run = requireRun(state, command.run);
      const { op: _op, run: _run, index, ...outcome } = command;
      const next = withSampleOutcome(state, run, index, outcome);
      return { state: { ...state, runs: withEntry(state.runs, run.name, next) }, result: null };
    }
    case "removeRuns": {
      for (const name of command.names) requireRun(state, name);
      return { state: { ...state, runs: withoutEntries(state.runs, command.names) }, result: null };
    }
    case "removeStyle": {
      requireStyle(state, command.name);
      const graphs = dict<GraphSpec>();
      for (const graph of Object.values(state.graphs)) {
        graphs[graph.name] = graph.style === command.name ? { ...graph, style: null } : graph;
      }
      return {
        state: {
          ...state,
          graphs,
          styles: withoutEntries(state.styles, [command.name]),
          defaultStyle: state.defaultStyle === command.name ? null : state.defaultStyle,
        },
        result: null,
      };
    }
    case "renameStyle": {
      const style = requireStyle(state, command.name);
      const newName = checkName(command.newName, "style");
      if (newName === command.name) return { state, result: null };
      if (newName in state.styles) {
        throw new DocError(`Style ${JSON.stringify(newName)} already exists.`);
      }
      const follow = (name: string | null) => (name === command.name ? newName : name);
      const graphs = dict<GraphSpec>();
      for (const graph of Object.values(state.graphs)) {
        graphs[graph.name] = graph.style === command.name ? { ...graph, style: newName } : graph;
      }
      return {
        state: {
          ...state,
          graphs,
          styles: withEntry(withoutEntries(state.styles, [command.name]), newName, style),
          defaultStyle: follow(state.defaultStyle),
        },
        result: newName,
      };
    }
    case "applyStyle": {
      requireStyle(state, command.style);
      if (!Array.isArray(command.graphs))
        throw new DocError("graphs must be a list of graph names.");
      let next = state;
      for (const name of new Set<string>(command.graphs)) {
        next = withStyle(next, requireGraph(next, name), command.style);
      }
      return { state: next, result: null };
    }
    case "setDefaultStyle": {
      if (command.name !== null) requireStyle(state, command.name);
      if (command.name === state.defaultStyle) return { state, result: null };
      return { state: { ...state, defaultStyle: command.name }, result: null };
    }
    case "saveGraphTemplate": {
      const name = checkName(command.name, "graph template");
      requireGraph(state, command.graph);
      const fixed = command.fixed ?? [];
      if (!Array.isArray(fixed) || fixed.some((axis) => typeof axis !== "string")) {
        throw new DocError("fixed must be a list of axis names.");
      }
      // Checked like a template given as data, which also puts it in the usual order.
      const template = checkGraphTemplate(captureTemplate(state, command.graph, fixed));
      return { state: putTemplate(state, name, template), result: name };
    }
    case "setGraphTemplate": {
      const name = checkName(command.name, "graph template");
      return {
        state: putTemplate(state, name, checkGraphTemplate(command.template)),
        result: name,
      };
    }
    case "removeGraphTemplate": {
      requireTemplate(state, command.name);
      return {
        state: { ...state, graphTemplates: withoutEntries(state.graphTemplates, [command.name]) },
        result: null,
      };
    }
    case "renameGraphTemplate": {
      const template = requireTemplate(state, command.name);
      const newName = checkName(command.newName, "graph template");
      if (newName === command.name) return { state, result: null };
      if (newName in state.graphTemplates) {
        throw new DocError(`Graph template ${JSON.stringify(newName)} already exists.`);
      }
      const graphTemplates = withEntry(
        withoutEntries(state.graphTemplates, [command.name]),
        newName,
        template,
      );
      return { state: { ...state, graphTemplates }, result: newName };
    }
    case "makeGraphs": {
      const template = requireTemplate(state, command.template);
      const { samples, names } = command;
      if (!Array.isArray(samples) || samples.length === 0) {
        throw new DocError("Give at least one sample: a dict of wave names by slot.");
      }
      if (names !== undefined && (!Array.isArray(names) || names.length !== samples.length)) {
        throw new DocError(
          `names must be a list of ${samples.length} graph names, one for each sample.`,
        );
      }
      // Each graph is made on the document the one before left, so the
      // reducer returns all of them or, if one cannot be made, none.
      let next = state;
      let made: string | null = null;
      samples.forEach((sample: unknown, at) => {
        const name = names?.[at] ?? uniqueName("Graph", windowTaken(next));
        try {
          next = makeFromTemplate(next, template, sample, name, applyCommand);
        } catch (error) {
          if (samples.length > 1 && error instanceof DocError) {
            throw new DocError(`Sample ${at + 1}: ${error.message}`);
          }
          throw error;
        }
        made = name;
      });
      return { state: next, result: made };
    }
    case "linkGraphs": {
      const names = [...new Set(command.graphs)];
      if (names.length < 2) throw new DocError("Link two graphs or more.");
      const graphs = names.map((name) => requireGraph(state, name));
      const axes = oneOf(command.axes ?? "x", ["x", "xy"] as const, "axes");
      const cursors = command.cursors === undefined ? true : bool(command.cursors, "cursors");
      const taken = new Set(Object.values(state.graphs).map((graph) => graph.link?.group));
      const group = uniqueName("Link", (name) => taken.has(name));
      let next = unlink(state, names);
      for (const graph of graphs) {
        next = putGraph(next, { ...next.graphs[graph.name]!, link: { group, axes, cursors } });
      }
      // They start where the first one is.
      const first = next.graphs[names[0]!]!;
      for (const axisName of axes === "xy" ? ["bottom", "left"] : ["bottom"]) {
        const from = first.axes[axisName]!;
        next = followRange(next, first, axisName, { min: from.min, max: from.max });
      }
      return { state: next, result: group };
    }
    case "unlinkGraphs": {
      for (const name of command.graphs) requireGraph(state, name);
      return { state: unlink(state, command.graphs), result: null };
    }
    case "setAttributes": {
      const target = command.target;
      if (typeof target !== "string") throw new DocError("target must be a wave or a data folder.");
      if (isFolderKey(target)) {
        if (!state.folders.includes(target.slice(0, -1))) {
          throw new DocError(`No data folder named ${JSON.stringify(target.slice(0, -1))}.`);
        }
      } else {
        requireWave(state, target);
      }
      if (typeof command.values !== "object" || command.values === null) {
        throw new DocError("values must be a dict of attribute names and values.");
      }
      const key = isFolderKey(target) ? target : requireWave(state, target).name;
      const next: Record<string, number | string> = { ...state.attributes[key] };
      for (const [name, value] of Object.entries(command.values)) {
        checkAttributeName(name);
        if (value === null) delete next[name];
        else next[name] = checkAttributeValue(value, name);
      }
      const attributes =
        Object.keys(next).length > 0
          ? withEntry(state.attributes, key, next)
          : withoutEntries(state.attributes, [key]);
      return { state: { ...state, attributes }, result: null };
    }
    case "recordPackages": {
      if (!Array.isArray(command.packages)) throw new DocError("packages must be a list.");
      const packages = command.packages.map(checkPackage);
      if (typeof command.pyodide !== "string") throw new DocError("pyodide must be a version.");
      return {
        state: { ...state, python: withPackages(state.python, packages, command.pyodide) },
        result: null,
      };
    }
    case "forgetPackages": {
      return {
        state: { ...state, python: withoutPackages(state.python, command.names) },
        result: null,
      };
    }
    case "killWindow": {
      if (!windowTaken(state)(command.name)) {
        throw new DocError(`No window named ${JSON.stringify(command.name)}.`);
      }
      const gone = [command.name];
      let pages = withoutEntries(state.pages, gone);
      // A graph that is closed leaves the pages it was on.
      if (command.name in state.graphs) {
        for (const [name, page] of Object.entries(pages)) {
          if (page.items.some((item) => item.graph === command.name)) {
            pages = withEntry(pages, name, {
              ...page,
              items: page.items.filter((item) => item.graph !== command.name),
            });
          }
        }
      }
      return {
        state: {
          ...state,
          graphs: withoutEntries(state.graphs, gone),
          tables: withoutEntries(state.tables, gone),
          procedures: withoutEntries(state.procedures, gone),
          pages,
          panels: withoutEntries(state.panels, gone),
          notes: withoutEntries(state.notes, gone),
          windows: state.windows.filter((window) => window.name !== command.name),
        },
        result: null,
      };
    }
    case "closeWindow": {
      const target = requireWindow(state, command.name);
      if (target.hidden) return { state, result: null };
      // To the back, so the window in front of the others is always an open one.
      return {
        state: {
          ...state,
          windows: [
            { ...target, hidden: true },
            ...state.windows.filter((window) => window !== target),
          ],
        },
        result: null,
      };
    }
    case "reopenWindow": {
      const target = requireWindow(state, command.name);
      const { hidden: _, ...open } = target;
      if (!target.hidden && state.windows.at(-1) === target) return { state, result: null };
      return {
        state: {
          ...state,
          windows: [...state.windows.filter((window) => window !== target), open],
        },
        result: null,
      };
    }
    case "renameWindow": {
      const target = requireWindow(state, command.name);
      const newName =
        target.kind === "procedure"
          ? procedureName(command.newName)
          : checkName(command.newName, target.kind === "page" ? "page layout" : target.kind);
      if (newName === target.name) return { state, result: newName };
      if (windowTaken(state)(newName)) {
        throw new DocError(`A window named ${JSON.stringify(newName)} already exists.`);
      }
      const { name } = target;
      let pages = renamedEntry(state.pages, name, newName);
      // Page layouts show graphs by name.
      if (target.kind === "graph") {
        pages = dict<PageSpec>(
          Object.entries(pages).map(([key, page]): [string, PageSpec] => [
            key,
            page.items.some((item) => item.graph === name)
              ? {
                  ...page,
                  items: page.items.map((item) =>
                    item.graph === name ? { ...item, graph: newName } : item,
                  ),
                }
              : page,
          ]),
        );
      }
      return {
        state: {
          ...state,
          graphs: renamedEntry(state.graphs, name, newName),
          tables: renamedEntry(state.tables, name, newName),
          procedures: renamedEntry(state.procedures, name, newName),
          pages,
          panels: renamedEntry(state.panels, name, newName),
          notes: renamedEntry(state.notes, name, newName),
          windows: state.windows.map((window) =>
            window === target ? { ...window, name: newName } : window,
          ),
        },
        result: newName,
      };
    }
    case "moveWindow": {
      const windows = state.windows.map((window) =>
        window.name === command.name
          ? {
              ...window,
              x: command.x ?? window.x,
              y: command.y ?? window.y,
              w: Math.max(MIN_WINDOW_WIDTH, command.w ?? window.w),
              h: Math.max(MIN_WINDOW_HEIGHT, command.h ?? window.h),
            }
          : window,
      );
      return { state: { ...state, windows }, result: null };
    }
    case "activateWindow": {
      const target = requireWindow(state, command.name);
      // A closed window comes back with reopenWindow, which can be undone.
      if (target.hidden) {
        throw new DocError(`${command.name} is closed. Reopen it to bring it to the front.`);
      }
      if (state.windows.at(-1) === target) return { state, result: null };
      return {
        state: {
          ...state,
          windows: [...state.windows.filter((window) => window !== target), target],
        },
        result: null,
      };
    }
  }
}

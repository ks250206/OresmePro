import { isTickFormat, isTimeZone } from "../plot/ticks";
import { normalizeColor } from "./colors";
import { dict, filterDict, withEntry, withoutEntries } from "./dict";
import {
  checkResult,
  renameInResult,
  RESULT_BASE,
  RESULT_KINDS,
  type AnalysisResult,
} from "./results";
import { axisLook, captureStyle, styledGraph, styledWindows, traceLook } from "./styles";
import {
  ANCHORS,
  ANNOTATION_KINDS,
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
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  PAGE_SIZES,
  TAG_OFFSET,
  TICK_MODES,
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
  isVerticalSide,
  leafName,
  parentFolder,
  type AnnotationSpec,
  type AxisLook,
  type AxisRole,
  type AxisSpec,
  type ContourSpec,
  type CursorName,
  type DocState,
  type ErrorSource,
  type FigureSize,
  type GraphLook,
  type GraphSpec,
  type GraphStyle,
  type ImageSpec,
  type TableSpec,
  type StyleSpec,
  type TraceLook,
  type TraceSpec,
  type TraceStyle,
  type Wave,
  type WindowState,
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
  | { op: "newProcedure"; name?: string; code?: string }
  | { op: "setProcedure"; name: string; code?: string; autoRun?: boolean }
  /** Keeps the look of a graph as a style; with `size`, the size it is drawn at too. */
  | { op: "saveStyle"; name: string; graph: string; size?: boolean }
  /** Defines a style from its parts (see StyleSpec), replacing one of that name. */
  | { op: "setStyle"; name: string; style: unknown }
  | { op: "removeStyle"; name: string }
  | { op: "renameStyle"; name: string; newName: string }
  | { op: "applyStyle"; style: string; graphs: readonly string[] }
  | { op: "setDefaultStyle"; name: string | null }
  /** Keeps the outcome of an analysis. `result` is as Python reports it (see checkResult). */
  | { op: "addResult"; result: unknown; name?: string }
  | { op: "removeResults"; names: readonly string[] }
  | { op: "renameResult"; name: string; newName: string }
  | { op: "killWindow"; name: string }
  | { op: "moveWindow"; name: string; x?: number; y?: number; w?: number; h?: number }
  | { op: "activateWindow"; name: string };

/**
 * Window geometry, focus and column widths are view state: not undoable and
 * not echoed. Neither is the text of a procedure: its editor has its own undo.
 */
export const isTransient = (command: Command): boolean =>
  command.op === "moveWindow" ||
  command.op === "activateWindow" ||
  command.op === "resizeColumn" ||
  command.op === "setProcedure";

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

/** Whether a window (graph, table, procedure or page layout) already has this name. */
export const windowTaken = (state: DocState) => (name: string) =>
  name in state.graphs || name in state.tables || name in state.procedures || name in state.pages;

function placeWindow(state: DocState, name: string, kind: WindowState["kind"]): WindowState {
  const slot = state.windows.length % 8;
  const size =
    kind === "graph"
      ? { w: 440, h: 300 }
      : kind === "table"
        ? { w: 360, h: 300 }
        : kind === "page"
          ? { w: 440, h: 560 }
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
    tickLabelSize: (value) => (value === null ? null : fontSize(value, "tickLabelSize")),
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

const GRAPH_VALIDATORS: { [K in keyof GraphStyle]: (value: unknown) => GraphStyle[K] } = {
  fontSize: (value) => fontSize(value, "fontSize"),
  fontFamily: (value) => {
    if (typeof value !== "string" || !value.trim()) throw new DocError("fontFamily must be text.");
    return value;
  },
  showInfo: (value) => bool(value, "showInfo"),
};

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

const STYLE_PARTS = ["graph", "size", "axes", "traces"] as const;

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

/** Rewrites every reference to a wave after waves have been renamed or moved. */
function renameReferences(state: DocState, rename: (name: string) => string): DocState {
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
  return { ...state, graphs, tables, results };
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
      throw new DocError(
        `Wave ${JSON.stringify(name)} is in use by ${users.join(", ")}. Remove it from there first.`,
      );
    }
  }
  const waves = withoutEntries(state.waves, names);
  return { ...state, waves, waveOrder: state.waveOrder.filter((name) => name in waves) };
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
        changed(wave, { name: newName }),
      );
      const renamed = renameReferences(
        {
          ...withFolders(state, parentFolder(newName)),
          waves,
          waveOrder: state.waveOrder.map((name) => (name === wave.name ? newName : name)),
        },
        (name) => (name === wave.name ? newName : name),
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
        state: putWave(
          state,
          changed(wave, {
            name: newName,
            data: wave.data.slice(),
            imag: wave.imag?.slice() ?? null,
          }),
        ),
        result: newName,
      };
    }
    case "killWaves": {
      const names = command.names.map((name) => requireWave(state, name).name);
      return { state: removeWaves(state, names), result: null };
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
        waves[name] = name === wave.name ? wave : changed(wave, { name });
      }
      const moved = renameReferences(
        {
          ...state,
          waves,
          waveOrder: state.waveOrder.map(move),
          folders: state.folders.map(move),
        },
        move,
      );
      return { state: withFolders(moved, parentFolder(newPath)), result: newPath };
    }
    case "killFolder": {
      const path = checkPath(command.path, "data folder");
      if (!state.folders.includes(path)) {
        throw new DocError(`No data folder named ${JSON.stringify(path)}.`);
      }
      const inside = (name: string) => name === path || name.startsWith(`${path}:`);
      const emptied = removeWaves(state, state.waveOrder.filter(inside));
      return {
        state: { ...emptied, folders: state.folders.filter((folder) => !inside(folder)) },
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
      return {
        state: putGraph(state, { ...graph, axes: withEntry(graph.axes, command.axis, axis) }),
        result: null,
      };
    }
    case "modifyGraph": {
      const graph = requireGraph(state, command.graph);
      const props = validateProps<GraphStyle>(command.props, GRAPH_VALIDATORS, "graph");
      return { state: putGraph(state, { ...graph, ...props }), result: null };
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
      return {
        state: putGraph(state, {
          ...graph,
          cursors: withEntry(graph.cursors, cursor, { trace: trace.name, point: command.point }),
        }),
        result: null,
      };
    }
    case "removeCursor": {
      const graph = requireGraph(state, command.graph);
      const cursor: CursorName = oneOf(command.cursor, CURSOR_NAMES, "cursor");
      const cursors = withoutEntries(graph.cursors, [cursor]);
      return { state: putGraph(state, { ...graph, cursors }), result: null };
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
    case "newProcedure": {
      let name = "Procedure";
      if (command.name !== undefined) {
        name = checkName(command.name, "procedure");
      } else {
        // Procedure, Procedure1, Procedure2: the first is plain, like Igor's.
        for (let count = 1; windowTaken(state)(name); count += 1) name = `Procedure${count}`;
      }
      // The procedure is a Python module of this name.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new DocError('A procedure name can have only ASCII letters, digits and "_".');
      }
      if (windowTaken(state)(name)) {
        throw new DocError(`A window named ${JSON.stringify(name)} already exists.`);
      }
      if (command.code !== undefined && typeof command.code !== "string") {
        throw new DocError("code must be text.");
      }
      const procedure: ProcedureSpec = { name, code: command.code ?? "", autoRun: true };
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
      return { state: { ...state, results: withEntry(state.results, name, result) }, result: name };
    }
    case "removeResults": {
      for (const name of command.names) {
        if (!(name in state.results))
          throw new DocError(`No result named ${JSON.stringify(name)}.`);
      }
      return {
        state: { ...state, results: withoutEntries(state.results, command.names) },
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
      return {
        state: {
          ...state,
          results: withEntry(withoutEntries(state.results, [command.name]), newName, {
            ...result,
            name: newName,
          }),
        },
        result: newName,
      };
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
          windows: state.windows.filter((window) => window.name !== command.name),
        },
        result: null,
      };
    }
    case "moveWindow": {
      const windows = state.windows.map((window) =>
        window.name === command.name
          ? {
              ...window,
              x: command.x ?? window.x,
              y: command.y ?? window.y,
              w: Math.max(160, command.w ?? window.w),
              h: Math.max(120, command.h ?? window.h),
            }
          : window,
      );
      return { state: { ...state, windows }, result: null };
    }
    case "activateWindow": {
      const target = state.windows.find((window) => window.name === command.name);
      if (!target) throw new DocError(`No window named ${JSON.stringify(command.name)}.`);
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

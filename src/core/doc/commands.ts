import { normalizeColor } from "./colors";
import {
  ANCHORS,
  AXIS_NAMES,
  DEFAULT_FONT_FAMILY,
  DocError,
  GRID_MODES,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  TICK_MODES,
  TRACE_MODES,
  defaultAxis,
  defaultTraceStyle,
  type AnnotationSpec,
  type AxisName,
  type AxisSpec,
  type DocState,
  type GraphSpec,
  type GraphStyle,
  type HorizontalAxis,
  type TableSpec,
  type TraceSpec,
  type TraceStyle,
  type VerticalAxis,
  type Wave,
  type WindowState,
} from "./types";

/**
 * Every change to the document is one of these. GUI actions and the Python
 * API both go through {@link applyCommand}, so they cannot disagree.
 */
export type Command =
  | {
      op: "makeWave";
      name: string;
      data: Float64Array;
      x0?: number;
      dx?: number;
      xUnit?: string;
      unit?: string;
      note?: string;
      /** Defaults to true, like Igor's Make/O. */
      overwrite?: boolean;
    }
  | { op: "setWaveData"; name: string; data: Float64Array }
  | { op: "setWavePoints"; name: string; start: number; values: ArrayLike<number> }
  | { op: "insertPoints"; name: string; at: number; count: number }
  | { op: "deletePoints"; name: string; at: number; count: number }
  | { op: "setWaveScale"; name: string; x0?: number; dx?: number; xUnit?: string }
  | { op: "setWaveMeta"; name: string; unit?: string; note?: string }
  | { op: "renameWave"; name: string; newName: string }
  | { op: "duplicateWave"; name: string; newName: string; overwrite?: boolean }
  | { op: "killWaves"; names: readonly string[] }
  | { op: "display"; y: readonly string[]; x?: string | null; name?: string }
  | {
      op: "appendTraces";
      graph: string;
      y: readonly string[];
      x?: string | null;
      vAxis?: VerticalAxis;
      hAxis?: HorizontalAxis;
    }
  | { op: "removeTraces"; graph: string; traces: readonly string[] }
  | { op: "modifyTrace"; graph: string; trace: string; props: Readonly<Record<string, unknown>> }
  | { op: "modifyAxis"; graph: string; axis: AxisName; props: Readonly<Record<string, unknown>> }
  | { op: "modifyGraph"; graph: string; props: Readonly<Record<string, unknown>> }
  | {
      op: "addAnnotation";
      graph: string;
      kind: "legend" | "text";
      text?: string;
      anchor?: string;
      frame?: boolean;
    }
  | {
      op: "modifyAnnotation";
      graph: string;
      annotation: string;
      props: Readonly<Record<string, unknown>>;
    }
  | { op: "removeAnnotation"; graph: string; annotation: string }
  | { op: "edit"; waves: readonly string[]; name?: string }
  | { op: "appendToTable"; table: string; waves: readonly string[] }
  | { op: "removeFromTable"; table: string; waves: readonly string[] }
  | { op: "killWindow"; name: string }
  | { op: "moveWindow"; name: string; x?: number; y?: number; w?: number; h?: number }
  | { op: "activateWindow"; name: string };

/** Window geometry and focus are view state: not undoable and not echoed. */
export const isTransient = (command: Command): boolean =>
  command.op === "moveWindow" || command.op === "activateWindow";

export interface CommandOutcome {
  state: DocState;
  /** Name of whatever the command created, when it created something. */
  result: string | null;
}

const NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_]*$/u;

export function checkName(name: unknown, what: string): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > 255) {
    throw new DocError(
      `${JSON.stringify(name)} is not a valid ${what} name. Names start with a letter and contain only letters, digits and "_".`,
    );
  }
  return name;
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
  const wave = state.waves[name];
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

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new DocError(`${what} must be true or false.`);
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], what: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new DocError(`${what} must be one of: ${choices.join(", ")}.`);
  }
  return value as T;
}

function putWave(state: DocState, wave: Wave): DocState {
  const known = wave.name in state.waves;
  return {
    ...state,
    waves: { ...state.waves, [wave.name]: wave },
    waveOrder: known ? state.waveOrder : [...state.waveOrder, wave.name],
  };
}

function putGraph(state: DocState, graph: GraphSpec): DocState {
  return { ...state, graphs: { ...state.graphs, [graph.name]: graph } };
}

function putTable(state: DocState, table: TableSpec): DocState {
  return { ...state, tables: { ...state.tables, [table.name]: table } };
}

const windowTaken = (state: DocState) => (name: string) =>
  name in state.graphs || name in state.tables;

function placeWindow(state: DocState, name: string, kind: WindowState["kind"]): WindowState {
  const slot = state.windows.length % 8;
  const size = kind === "graph" ? { w: 440, h: 300 } : { w: 360, h: 300 };
  return { name, kind, x: 24 + slot * 28, y: 16 + slot * 28, ...size };
}

function nextTraceName(traces: readonly TraceSpec[], y: string): string {
  const taken = new Set(traces.map((trace) => trace.name));
  if (!taken.has(y)) return y;
  for (let index = 1; ; index += 1) {
    const candidate = `${y}#${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function addTraces(
  state: DocState,
  graph: GraphSpec,
  y: readonly string[],
  x: string | null,
  vAxis: VerticalAxis,
  hAxis: HorizontalAxis,
): GraphSpec {
  if (y.length === 0) throw new DocError("Give at least one wave to plot.");
  if (x !== null) requireWave(state, x);
  const traces = [...graph.traces];
  for (const name of y) {
    const wave = requireWave(state, name);
    if (x !== null && state.waves[x]!.data.length !== wave.data.length) {
      throw new DocError(
        `X wave ${JSON.stringify(x)} has ${state.waves[x]!.data.length} points but ${JSON.stringify(name)} has ${wave.data.length}.`,
      );
    }
    traces.push({
      ...defaultTraceStyle(traces.length),
      name: nextTraceName(traces, name),
      y: name,
      x,
      vAxis,
      hAxis,
    });
  }
  return { ...graph, traces };
}

const TRACE_VALIDATORS: { [K in keyof TraceStyle]: (value: unknown) => TraceStyle[K] } = {
  mode: (value) => oneOf(value, TRACE_MODES, "mode"),
  color: normalizeColor,
  lineSize: (value) => positive(value, "lineSize"),
  lineStyle: (value) => oneOf(value, LINE_STYLES, "lineStyle"),
  marker: (value) => oneOf(value, MARKER_SHAPES, "marker"),
  markerSize: (value) => positive(value, "markerSize"),
  markerFill: (value) => bool(value, "markerFill"),
  hidden: (value) => bool(value, "hidden"),
};

const AXIS_VALIDATORS: { [K in keyof AxisSpec]: (value: unknown) => AxisSpec[K] } = {
  label: (value) => {
    if (value === null || typeof value === "string") return value;
    throw new DocError("label must be text, or null for the automatic label.");
  },
  min: (value) => (value === null ? null : finite(value, "min")),
  max: (value) => (value === null ? null : finite(value, "max")),
  log: (value) => bool(value, "log"),
  mirror: (value) => oneOf(value, MIRROR_MODES, "mirror"),
  ticks: (value) => oneOf(value, TICK_MODES, "ticks"),
  minor: (value) => bool(value, "minor"),
  grid: (value) => oneOf(value, GRID_MODES, "grid"),
};

const GRAPH_VALIDATORS: { [K in keyof GraphStyle]: (value: unknown) => GraphStyle[K] } = {
  fontSize: (value) => {
    const size = positive(value, "fontSize");
    if (size < 4 || size > 96) throw new DocError("fontSize must be between 4 and 96.");
    return size;
  },
  fontFamily: (value) => {
    if (typeof value !== "string" || !value.trim()) throw new DocError("fontFamily must be text.");
    return value;
  },
};

const ANNOTATION_VALIDATORS = {
  text: (value: unknown): string => {
    if (typeof value !== "string") throw new DocError("text must be text.");
    return value;
  },
  anchor: (value: unknown) => oneOf(value, ANCHORS, "anchor"),
  frame: (value: unknown) => bool(value, "frame"),
};

function validateProps<T>(
  props: Readonly<Record<string, unknown>>,
  validators: { [K in keyof T]: (value: unknown) => T[K] },
  what: string,
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(props)) {
    const validate = (validators as Record<string, ((value: unknown) => unknown) | undefined>)[key];
    if (!validate) {
      throw new DocError(
        `Unknown ${what} property ${JSON.stringify(key)}. Known properties: ${Object.keys(validators).join(", ")}.`,
      );
    }
    (result as Record<string, unknown>)[key] = validate(value);
  }
  return result;
}

function renameInGraphs(state: DocState, from: string, to: string): DocState["graphs"] {
  const graphs: Record<string, GraphSpec> = {};
  for (const graph of Object.values(state.graphs)) {
    if (!graph.traces.some((trace) => trace.y === from || trace.x === from)) {
      graphs[graph.name] = graph;
      continue;
    }
    const traces: TraceSpec[] = [];
    for (const trace of graph.traces) {
      const y = trace.y === from ? to : trace.y;
      const x = trace.x === from ? to : trace.x;
      // A trace is named after its Y wave, so it follows the rename.
      const name = trace.y === from ? nextTraceName(traces, to) : trace.name;
      traces.push({ ...trace, name, y, x });
    }
    graphs[graph.name] = { ...graph, traces };
  }
  return graphs;
}

function waveUsers(state: DocState, name: string): string[] {
  const users: string[] = [];
  for (const graph of Object.values(state.graphs)) {
    if (graph.traces.some((trace) => trace.y === name || trace.x === name)) users.push(graph.name);
  }
  for (const table of Object.values(state.tables)) {
    if (table.columns.includes(name)) users.push(table.name);
  }
  return users;
}

// Revisions are unique across all waves and never reused, so a (name, rev)
// pair identifies one exact state of a wave even after kill-and-remake or undo.
let lastRev = 0;
const nextRev = (): number => (lastRev += 1);

function resized(wave: Wave, data: Float64Array): Wave {
  return { ...wave, data, rev: nextRev() };
}

/** Applies one command. Pure: returns a new state, or throws {@link DocError}. */
export function applyCommand(state: DocState, command: Command): CommandOutcome {
  switch (command.op) {
    case "makeWave": {
      const name = checkName(command.name, "wave");
      const existing = state.waves[name];
      if (existing && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(name)} already exists.`);
      }
      const dx = command.dx ?? existing?.dx ?? 1;
      if (!Number.isFinite(dx) || dx === 0) throw new DocError("dx must be finite and non-zero.");
      const wave: Wave = {
        name,
        data: command.data,
        x0: finite(command.x0 ?? existing?.x0 ?? 0, "x0"),
        dx,
        xUnit: command.xUnit ?? existing?.xUnit ?? "",
        unit: command.unit ?? existing?.unit ?? "",
        note: command.note ?? existing?.note ?? "",
        rev: nextRev(),
      };
      return { state: putWave(state, wave), result: name };
    }
    case "setWaveData": {
      const wave = requireWave(state, command.name);
      return { state: putWave(state, resized(wave, command.data)), result: null };
    }
    case "setWavePoints": {
      const wave = requireWave(state, command.name);
      const { start, values } = command;
      if (!Number.isInteger(start) || start < 0 || start > wave.data.length) {
        throw new DocError(
          `Point ${start} is out of range for ${JSON.stringify(wave.name)} (${wave.data.length} points).`,
        );
      }
      const data = new Float64Array(Math.max(wave.data.length, start + values.length));
      data.set(wave.data);
      data.set(values, start);
      return { state: putWave(state, resized(wave, data)), result: null };
    }
    case "insertPoints": {
      const wave = requireWave(state, command.name);
      const { at, count } = command;
      if (!Number.isInteger(at) || at < 0 || at > wave.data.length) {
        throw new DocError(`Point ${at} is out of range.`);
      }
      if (!Number.isInteger(count) || count < 1) throw new DocError("count must be at least 1.");
      const data = new Float64Array(wave.data.length + count);
      data.set(wave.data.subarray(0, at));
      data.fill(Number.NaN, at, at + count);
      data.set(wave.data.subarray(at), at + count);
      return { state: putWave(state, resized(wave, data)), result: null };
    }
    case "deletePoints": {
      const wave = requireWave(state, command.name);
      const { at, count } = command;
      if (!Number.isInteger(at) || at < 0 || at >= wave.data.length) {
        throw new DocError(`Point ${at} is out of range.`);
      }
      if (!Number.isInteger(count) || count < 1) throw new DocError("count must be at least 1.");
      const end = Math.min(wave.data.length, at + count);
      const data = new Float64Array(wave.data.length - (end - at));
      data.set(wave.data.subarray(0, at));
      data.set(wave.data.subarray(end), at);
      return { state: putWave(state, resized(wave, data)), result: null };
    }
    case "setWaveScale": {
      const wave = requireWave(state, command.name);
      const dx = command.dx ?? wave.dx;
      if (!Number.isFinite(dx) || dx === 0) throw new DocError("dx must be finite and non-zero.");
      return {
        state: putWave(state, {
          ...wave,
          x0: finite(command.x0 ?? wave.x0, "x0"),
          dx,
          xUnit: command.xUnit ?? wave.xUnit,
          rev: nextRev(),
        }),
        result: null,
      };
    }
    case "setWaveMeta": {
      const wave = requireWave(state, command.name);
      return {
        state: putWave(state, {
          ...wave,
          unit: command.unit ?? wave.unit,
          note: command.note ?? wave.note,
          rev: nextRev(),
        }),
        result: null,
      };
    }
    case "renameWave": {
      const wave = requireWave(state, command.name);
      const newName = checkName(command.newName, "wave");
      if (newName === wave.name) return { state, result: null };
      if (newName in state.waves) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`);
      }
      const waves = { ...state.waves };
      delete waves[wave.name];
      waves[newName] = { ...wave, name: newName, rev: nextRev() };
      const tables: Record<string, TableSpec> = {};
      for (const table of Object.values(state.tables)) {
        tables[table.name] = {
          ...table,
          columns: table.columns.map((column) => (column === wave.name ? newName : column)),
        };
      }
      return {
        state: {
          ...state,
          waves,
          waveOrder: state.waveOrder.map((name) => (name === wave.name ? newName : name)),
          graphs: renameInGraphs(state, wave.name, newName),
          tables,
        },
        result: newName,
      };
    }
    case "duplicateWave": {
      const wave = requireWave(state, command.name);
      const newName = checkName(command.newName, "wave");
      const existing = state.waves[newName];
      if (existing && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`);
      }
      return {
        state: putWave(state, {
          ...wave,
          name: newName,
          data: wave.data.slice(),
          rev: nextRev(),
        }),
        result: newName,
      };
    }
    case "killWaves": {
      const waves = { ...state.waves };
      for (const name of command.names) {
        requireWave(state, name);
        const users = waveUsers(state, name);
        if (users.length > 0) {
          throw new DocError(
            `Wave ${JSON.stringify(name)} is in use by ${users.join(", ")}. Remove it from there first.`,
          );
        }
        delete waves[name];
      }
      return {
        state: {
          ...state,
          waves,
          waveOrder: state.waveOrder.filter((name) => name in waves),
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
      const empty: GraphSpec = {
        name,
        traces: [],
        axes: {
          left: defaultAxis(),
          bottom: defaultAxis(),
          right: defaultAxis(),
          top: defaultAxis(),
        },
        annotations: [],
        fontSize: 12,
        fontFamily: DEFAULT_FONT_FAMILY,
      };
      const graph =
        command.y.length === 0
          ? empty
          : addTraces(state, empty, command.y, command.x ?? null, "left", "bottom");
      return {
        state: {
          ...putGraph(state, graph),
          windows: [...state.windows, placeWindow(state, name, "graph")],
        },
        result: name,
      };
    }
    case "appendTraces": {
      const graph = requireGraph(state, command.graph);
      const next = addTraces(
        state,
        graph,
        command.y,
        command.x ?? null,
        oneOf(command.vAxis ?? "left", ["left", "right"], "vAxis"),
        oneOf(command.hAxis ?? "bottom", ["bottom", "top"], "hAxis"),
      );
      return { state: putGraph(state, next), result: next.traces.at(-1)!.name };
    }
    case "removeTraces": {
      const graph = requireGraph(state, command.graph);
      for (const name of command.traces) {
        if (!graph.traces.some((trace) => trace.name === name)) {
          throw new DocError(`${graph.name} has no trace named ${JSON.stringify(name)}.`);
        }
      }
      const traces = graph.traces.filter((trace) => !command.traces.includes(trace.name));
      return { state: putGraph(state, { ...graph, traces }), result: null };
    }
    case "modifyTrace": {
      const graph = requireGraph(state, command.graph);
      if (!graph.traces.some((trace) => trace.name === command.trace)) {
        throw new DocError(`${graph.name} has no trace named ${JSON.stringify(command.trace)}.`);
      }
      const props = validateProps<TraceStyle>(command.props, TRACE_VALIDATORS, "trace");
      const traces = graph.traces.map((trace) =>
        trace.name === command.trace ? { ...trace, ...props } : trace,
      );
      return { state: putGraph(state, { ...graph, traces }), result: null };
    }
    case "modifyAxis": {
      const graph = requireGraph(state, command.graph);
      const axisName = oneOf(command.axis, AXIS_NAMES, "axis");
      const axis = {
        ...graph.axes[axisName],
        ...validateProps<AxisSpec>(command.props, AXIS_VALIDATORS, "axis"),
      };
      if (axis.min !== null && axis.max !== null && axis.min === axis.max) {
        throw new DocError("The axis range must not be empty.");
      }
      if (
        axis.log &&
        ((axis.min !== null && axis.min <= 0) || (axis.max !== null && axis.max <= 0))
      ) {
        throw new DocError("A log axis needs a range greater than 0.");
      }
      return {
        state: putGraph(state, { ...graph, axes: { ...graph.axes, [axisName]: axis } }),
        result: null,
      };
    }
    case "modifyGraph": {
      const graph = requireGraph(state, command.graph);
      const props = validateProps<GraphStyle>(command.props, GRAPH_VALIDATORS, "graph");
      return { state: putGraph(state, { ...graph, ...props }), result: null };
    }
    case "addAnnotation": {
      const graph = requireGraph(state, command.graph);
      const kind = oneOf(command.kind, ["legend", "text"], "kind");
      const annotation: AnnotationSpec = {
        name: uniqueName(kind, (name) => graph.annotations.some((item) => item.name === name)),
        kind,
        text: ANNOTATION_VALIDATORS.text(command.text ?? ""),
        anchor: ANNOTATION_VALIDATORS.anchor(command.anchor ?? "RT"),
        frame: ANNOTATION_VALIDATORS.frame(command.frame ?? true),
      };
      return {
        state: putGraph(state, { ...graph, annotations: [...graph.annotations, annotation] }),
        result: annotation.name,
      };
    }
    case "modifyAnnotation": {
      const graph = requireGraph(state, command.graph);
      if (!graph.annotations.some((item) => item.name === command.annotation)) {
        throw new DocError(
          `${graph.name} has no annotation named ${JSON.stringify(command.annotation)}.`,
        );
      }
      const props = validateProps<Pick<AnnotationSpec, "text" | "anchor" | "frame">>(
        command.props,
        ANNOTATION_VALIDATORS,
        "annotation",
      );
      const annotations = graph.annotations.map((item) =>
        item.name === command.annotation ? { ...item, ...props } : item,
      );
      return { state: putGraph(state, { ...graph, annotations }), result: null };
    }
    case "removeAnnotation": {
      const graph = requireGraph(state, command.graph);
      if (!graph.annotations.some((item) => item.name === command.annotation)) {
        throw new DocError(
          `${graph.name} has no annotation named ${JSON.stringify(command.annotation)}.`,
        );
      }
      const annotations = graph.annotations.filter((item) => item.name !== command.annotation);
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
      for (const wave of command.waves) requireWave(state, wave);
      const table: TableSpec = { name, columns: [...new Set(command.waves)] };
      return {
        state: {
          ...putTable(state, table),
          windows: [...state.windows, placeWindow(state, name, "table")],
        },
        result: name,
      };
    }
    case "appendToTable": {
      const table = requireTable(state, command.table);
      for (const wave of command.waves) requireWave(state, wave);
      const columns = [...new Set([...table.columns, ...command.waves])];
      return { state: putTable(state, { ...table, columns }), result: null };
    }
    case "removeFromTable": {
      const table = requireTable(state, command.table);
      const columns = table.columns.filter((column) => !command.waves.includes(column));
      return { state: putTable(state, { ...table, columns }), result: null };
    }
    case "killWindow": {
      if (!windowTaken(state)(command.name)) {
        throw new DocError(`No window named ${JSON.stringify(command.name)}.`);
      }
      const graphs = { ...state.graphs };
      const tables = { ...state.tables };
      delete graphs[command.name];
      delete tables[command.name];
      return {
        state: {
          ...state,
          graphs,
          tables,
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

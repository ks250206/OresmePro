/** What the commands share: checking names and values, finding and putting things. (Applied through ./commands.) */
import { dict, withEntry, withoutEntries, type Dict } from "./dict";
import { keptFolder, type AnalysisResult } from "./results";
import {
  AXIS_SIDES,
  DEFAULT_FONT_FAMILY,
  DocError,
  WAVE_TYPES,
  isComplexType,
  newWaveData,
  toWaveData,
  typeOfData,
  type WaveData,
  defaultAxis,
  defaultTraceStyle,
  AUTO_SIZE,
  isVerticalSide,
  leafName,
  parentFolder,
  type AxisSpec,
  type CursorName,
  type DocState,
  type GraphSpec,
  type TableSpec,
  type TraceSpec,
  type Wave,
  type WindowState,
} from "./types";
import type { Props } from "./commandTypes";
import { dropAttributes } from "./attributes";

export const NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_]*$/u;
export const NO_DATA = new Float64Array(0);

export function checkName(name: unknown, what: string): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > 255) {
    throw new DocError(
      `${JSON.stringify(name)} is not a valid ${what} name. Names start with a letter and contain only letters, digits and "_".`,
      "INVALID_ARGUMENT",
      { field: "name", kind: what },
    );
  }
  return name;
}

/**
 * Checks a wave or folder path and returns it without the optional leading
 * "root:". Folders are separated by ":", as in Igor.
 */
export function checkPath(path: unknown, what: string): string {
  if (typeof path !== "string")
    throw new DocError(`A ${what} name must be text.`, "INVALID_ARGUMENT", {
      field: "name",
      kind: what,
    });
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

export function requireWave(state: DocState, name: string): Wave {
  const key = typeof name === "string" && name.startsWith("root:") ? name.slice(5) : name;
  const wave = state.waves[key];
  if (!wave)
    throw new DocError(`No wave named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "wave",
      name: name,
    });
  return wave;
}

export function requireGraph(state: DocState, name: string): GraphSpec {
  const graph = state.graphs[name];
  if (!graph)
    throw new DocError(`No graph named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "graph",
      name: name,
    });
  return graph;
}

export function requireTable(state: DocState, name: string): TableSpec {
  const table = state.tables[name];
  if (!table)
    throw new DocError(`No table named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "table",
      name: name,
    });
  return table;
}

export function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DocError(`${what} must be a finite number.`, "INVALID_ARGUMENT", { field: what });
  }
  return value;
}

export function positive(value: unknown, what: string): number {
  const number = finite(value, what);
  if (number <= 0)
    throw new DocError(`${what} must be greater than 0.`, "INVALID_ARGUMENT", { field: what });
  return number;
}

export function step(value: unknown, what: string): number {
  const number = finite(value, what);
  if (number === 0)
    throw new DocError(`${what} must not be 0.`, "INVALID_ARGUMENT", { field: what });
  return number;
}

export function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean")
    throw new DocError(`${what} must be true or false.`, "INVALID_ARGUMENT", { field: what });
  return value;
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[], what: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new DocError(`${what} must be one of: ${choices.join(", ")}.`, "INVALID_ARGUMENT", {
      field: what,
    });
  }
  return value as T;
}

// Revisions are unique across all waves and never reused, so a (name, rev)
// pair identifies one exact state of a wave even after kill-and-remake or undo.
let lastRev = 0;
export const nextRev = (): number => (lastRev += 1);

export function withFolders(state: DocState, folder: string): DocState {
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
export function linkedTo(state: DocState, graph: GraphSpec): GraphSpec[] {
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
export function followRange(
  state: DocState,
  graph: GraphSpec,
  axis: string,
  props: Props,
): DocState {
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
export function cursorX(state: DocState, trace: TraceSpec, point: number): number | null {
  const y = state.waves[trace.y];
  if (!y) return null;
  const x = trace.x === null ? undefined : state.waves[trace.x];
  const value = x ? (x.text ? point : Number(x.data[point])) : y.x0 + point * y.dx;
  return Number.isFinite(value) ? value + trace.xOffset : null;
}

/** The point of a trace nearest an X. */
export function nearestPointTo(state: DocState, trace: TraceSpec, target: number): number | null {
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
export function followCursor(
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
export function unlink(state: DocState, names: readonly string[]): DocState {
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
export function keepOutputs(
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
export function dropKept(state: DocState, result: AnalysisResult): DocState {
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

export function putWave(state: DocState, wave: Wave): DocState {
  const known = wave.name in state.waves;
  const next = withFolders(state, parentFolder(wave.name));
  return {
    ...next,
    waves: withEntry(next.waves, wave.name, wave),
    waveOrder: known ? next.waveOrder : [...next.waveOrder, wave.name],
  };
}

export function putGraph(state: DocState, graph: GraphSpec): DocState {
  return { ...state, graphs: withEntry(state.graphs, graph.name, graph) };
}

export function putTable(state: DocState, table: TableSpec): DocState {
  return { ...state, tables: withEntry(state.tables, table.name, table) };
}

export function checkShape(
  shape: readonly number[] | undefined,
  length: number,
): readonly number[] {
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
export const isWaveData = (value: unknown): value is WaveData =>
  ArrayBuffer.isView(value) &&
  !(value instanceof DataView) &&
  !(value instanceof Uint8ClampedArray);

export function contentOf(command: {
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
  if (given !== undefined && !isWaveData(given))
    throw new DocError("imag must be numbers.", "INVALID_ARGUMENT", { field: "imag" });
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
export function resized(
  source: WaveData,
  at: number,
  removed: number,
  added: number,
  fill: number,
) {
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
/** Python's keywords, which cannot be the name a module is bound to. */
export const PYTHON_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

/** Checks the name a procedure is imported as: a Python identifier, or null to run it in the namespace. */
export function importAsName(name: unknown): string | null {
  if (name === null || name === "") return null;
  if (
    typeof name !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    PYTHON_KEYWORDS.has(name)
  ) {
    throw new DocError(
      `${JSON.stringify(name)} cannot be the name a procedure is imported as: it must be a Python name.`,
    );
  }
  return name;
}

export function procedureName(name: unknown): string {
  const checked = checkName(name, "procedure");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(checked)) {
    throw new DocError('A procedure name can have only ASCII letters, digits and "_".');
  }
  return checked;
}

export function requireWindow(state: DocState, name: string): WindowState {
  const window = state.windows.find((item) => item.name === name);
  if (!window)
    throw new DocError(`No window named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "window",
      name: name,
    });
  return window;
}

/** A record kept by name, renamed: its key and its own `name`. */
export function renamedEntry<T extends { name: string }>(
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

export function nextItemName(taken: readonly { name: string }[], base: string): string {
  const names = new Set(taken.map((item) => item.name));
  if (!names.has(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}#${index}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** A numeric wave with exactly `dimensions` dimensions, or an error saying why not. */
export function requireNumeric(
  state: DocState,
  name: string,
  dimensions: 1 | 2,
  use: string,
): Wave {
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
export function requireXWave(state: DocState, name: string): Wave {
  const wave = requireWave(state, name);
  if (wave.shape.length !== 1)
    throw new DocError(`${wave.name} is not 1-D and cannot be an X wave.`);
  return wave;
}

/** Checks that an image's or contour's plane exists in its wave. */
export function checkPlane(wave: Wave, item: { layer: number; chunk: number }): void {
  const layers = wave.shape[2] ?? 1;
  const chunks = wave.shape[3] ?? 1;
  if (item.layer >= layers || item.chunk >= chunks) {
    throw new DocError(
      `${wave.name} has ${layers} layer${layers === 1 ? "" : "s"} and ${chunks} chunk${chunks === 1 ? "" : "s"}; layer ${item.layer}, chunk ${item.chunk} does not exist.`,
    );
  }
}

export function index(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DocError(`${what} must be a whole number, 0 or more.`, "INVALID_ARGUMENT", {
      field: what,
    });
  }
  return value;
}

export function requireAxis(graph: GraphSpec, name: string, vertical: boolean): string {
  const axis = graph.axes[name];
  if (!axis) {
    throw new DocError(
      `${graph.name} has no axis named ${JSON.stringify(name)}. Axes: ${Object.keys(graph.axes).join(", ")}.`,
      "NOT_FOUND",
      { kind: "axis", name },
    );
  }
  if (isVerticalSide(axis.side) !== vertical) {
    throw new DocError(
      `Axis ${JSON.stringify(name)} is ${vertical ? "horizontal" : "vertical"}; a ${vertical ? "vertical" : "horizontal"} axis is needed here.`,
    );
  }
  return name;
}

export function addTraces(
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

/** A graph with nothing in it, as a new graph starts. */
export function emptyGraph(name: string): GraphSpec {
  return {
    name,
    traces: [],
    images: [],
    contours: [],
    axes: dict(AXIS_SIDES.map((side) => [side, defaultAxis(side)])),
    annotations: [],
    drawings: [],
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

export function changed(wave: Wave, change: Partial<Wave>): Wave {
  return { ...wave, ...change, rev: nextRev() };
}

export function removeWaves(state: DocState, names: readonly string[]): DocState {
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
        "IN_USE",
        { kind: "wave", name, users: named },
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

export function waveUsers(state: DocState, name: string): string[] {
  const users: string[] = [];
  for (const graph of Object.values(state.graphs)) {
    const used =
      graph.traces.some(
        (trace) =>
          trace.y === name ||
          trace.x === name ||
          trace.yError === name ||
          trace.xError === name ||
          trace.colorWave === name ||
          trace.textMarker === name,
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

/** A wave without its formula, keeping its values. */
export function withoutFormula(wave: Wave): Wave {
  const { formula: _formula, ...rest } = wave;
  return rest;
}

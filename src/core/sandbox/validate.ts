import {
  AXIS_SIDES,
  DocError,
  type AxisSide,
  type ErrorCode,
  type WaveData,
  type WaveType,
} from "../doc/types";
import { SANDBOX_DTYPES, SANDBOX_LIMITS, type Json, type SandboxDtype } from "./protocol";

/**
 * Checks of what a sandbox sends. The sandbox runs code the app does not
 * trust, so nothing it sends is taken as it comes: every field is read
 * defensively, against fixed limits, and anything unexpected refuses the
 * whole message. Nothing here throws for bad input; it says why instead.
 */

/**
 * Where in a plugin's run it failed: starting its sandbox, loading its code,
 * running the action (the plugin raised), taking too long, being stopped, or
 * returning what is not allowed.
 */
export type PluginPhase = "start" | "load" | "run" | "timeout" | "stopped" | "invalid_output";

/** A plugin's sandbox failed: a PLUGIN_FAILED error (see ERROR_CODES), saying at which phase. */
export class SandboxError extends DocError {
  constructor(
    message: string,
    phase: PluginPhase = "invalid_output",
    code: ErrorCode = "PLUGIN_FAILED",
  ) {
    super(message, code, { phase });
    this.name = "SandboxError";
  }
}

const PHASES: readonly PluginPhase[] = [
  "start",
  "load",
  "run",
  "timeout",
  "stopped",
  "invalid_output",
];

/** The phase a plugin failed at (`details.phase`), or null for an error that does not say. */
export function pluginPhase(error: unknown): PluginPhase | null {
  if (!(error instanceof DocError)) return null;
  const phase = error.details.phase;
  return PHASES.includes(phase as PluginPhase) ? (phase as PluginPhase) : null;
}

/** Each phase in words: where a plugin's run was when it failed. */
export const PHASE_TITLES: Record<PluginPhase, string> = {
  start: "starting its sandbox",
  load: "loading the plugin",
  run: "running the action",
  timeout: "the time limit",
  stopped: "stopped",
  invalid_output: "checking what it returned",
};

/** A wave from a sandbox, checked, with its values in the typed array of its type. */
export interface CheckedWave {
  type: WaveType;
  shape: number[];
  /** Empty for a text wave. */
  data: WaveData;
  imag: WaveData | null;
  /** The values of a text wave, or null for a numeric one. */
  text: string[] | null;
  x0: number;
  dx: number;
  xUnit: string;
  y0: number;
  dy: number;
  yUnit: string;
  unit: string;
  note: string;
}

/**
 * A graph a plugin asks for, made of the waves it returned (named by role).
 * Its properties are checked here only as plain data in bounds: the
 * document checks them again, as it does whatever Python asks for, when
 * the graph is made.
 */
export interface PluginGraph {
  name: string | null;
  traces: PluginTrace[];
  /** Properties of the axes, by side, with camelCase names. */
  axes: Partial<Record<AxisSide, Record<string, Json>>>;
  /** Properties of the graph, with camelCase names. */
  graph: Record<string, Json>;
  annotations: PluginAnnotation[];
}

export interface PluginTrace {
  y: string;
  x: string | null;
  vAxis: AxisSide;
  hAxis: AxisSide;
  /** Its text in a legend that lists the traces given one. */
  legend: string | null;
  /** Trace properties, camelCase; those that name waves name roles. */
  props: Record<string, Json>;
}

export interface PluginAnnotation {
  kind: "legend" | "text";
  /** For a legend, null lists the traces given a `legend`. */
  text: string | null;
  props: Record<string, Json>;
}

export interface CheckedResult {
  /** By role, in the order the sandbox listed them. */
  waves: [string, CheckedWave][];
  values: Json;
  graph: PluginGraph | null;
  log: string;
}

const ARRAYS = {
  float64: Float64Array,
  float32: Float32Array,
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Own enumerable string keys only: a sandbox cannot slip anything in through a prototype. */
const entries = (value: Record<string, unknown>): [string, unknown][] =>
  Object.keys(value).map((key) => [key, value[key]]);

const ROLE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** The properties of a trace that name waves: in a plugin's graph, by role. */
export const WAVE_PROPS = ["textMarker", "colorWave", "yError", "xError"] as const;

function text(value: unknown, what: string, limit: number = SANDBOX_LIMITS.shortText): string {
  if (typeof value !== "string") throw new SandboxError(`${what} is not text.`);
  if (value.length > limit) throw new SandboxError(`${what} is longer than ${limit} characters.`);
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SandboxError(`${what} is not a finite number.`);
  }
  return value;
}

function wave(role: string, raw: unknown): CheckedWave {
  if (!isRecord(raw)) throw new SandboxError(`Wave ${role} is not described.`);
  const dtype = raw.dtype;
  if (dtype === "text") return textWave(role, raw);
  if (typeof dtype !== "string" || !(SANDBOX_DTYPES as readonly string[]).includes(dtype)) {
    throw new SandboxError(`Wave ${role} has an unknown number type.`);
  }
  const shape = raw.shape;
  if (
    !Array.isArray(shape) ||
    shape.length < 1 ||
    shape.length > 4 ||
    !shape.every((size) => Number.isSafeInteger(size) && (size as number) >= 0)
  ) {
    throw new SandboxError(`Wave ${role} has a shape that is not 1 to 4 whole sizes.`);
  }
  const points = (shape as number[]).reduce((product, size) => product * size, 1);
  if (points > SANDBOX_LIMITS.points) {
    throw new SandboxError(`Wave ${role} has more than ${SANDBOX_LIMITS.points} points.`);
  }
  const Array_ = ARRAYS[dtype as SandboxDtype];
  const part = (buffer: unknown, which: string): WaveData => {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new SandboxError(`The ${which} of wave ${role} are not binary data.`);
    }
    if (buffer.byteLength !== points * Array_.BYTES_PER_ELEMENT) {
      throw new SandboxError(`The ${which} of wave ${role} do not match its shape and type.`);
    }
    return new Array_(buffer);
  };
  const data = part(raw.data, "values");
  let imag: WaveData | null = null;
  if (raw.imag !== null && raw.imag !== undefined) {
    if (dtype !== "float64" && dtype !== "float32") {
      throw new SandboxError(`Wave ${role} is complex but its parts are not float32 or float64.`);
    }
    imag = part(raw.imag, "imaginary parts");
  }
  const dx = finite(raw.dx, `The X step of wave ${role}`);
  const dy = finite(raw.dy, `The Y step of wave ${role}`);
  if (dx === 0 || dy === 0) throw new SandboxError(`Wave ${role} has a step of zero.`);
  return {
    type: imag ? (dtype === "float32" ? "complex64" : "complex128") : (dtype as WaveType),
    shape: [...(shape as number[])],
    data,
    imag,
    text: null,
    x0: finite(raw.x0, `The X start of wave ${role}`),
    dx,
    xUnit: text(raw.xUnit, `The X unit of wave ${role}`),
    y0: finite(raw.y0, `The Y start of wave ${role}`),
    dy,
    yUnit: text(raw.yUnit, `The Y unit of wave ${role}`),
    unit: text(raw.unit, `The unit of wave ${role}`),
    note: text(raw.note, `The note of wave ${role}`, SANDBOX_LIMITS.note),
  };
}

/** A text wave: one dimension of strings, each no longer than a label needs. */
function textWave(role: string, raw: Record<string, unknown>): CheckedWave {
  const items = raw.text;
  if (
    !Array.isArray(items) ||
    items.length > SANDBOX_LIMITS.textPoints ||
    !items.every((item) => typeof item === "string" && item.length <= SANDBOX_LIMITS.label)
  ) {
    throw new SandboxError(
      `Wave ${role} is not a list of at most ${SANDBOX_LIMITS.textPoints} texts of at most ${SANDBOX_LIMITS.label} characters.`,
    );
  }
  const shape = raw.shape;
  if (!Array.isArray(shape) || shape.length !== 1 || shape[0] !== items.length) {
    throw new SandboxError(`Wave ${role} has a shape that does not match its text.`);
  }
  const dx = finite(raw.dx, `The X step of wave ${role}`);
  const dy = finite(raw.dy, `The Y step of wave ${role}`);
  if (dx === 0 || dy === 0) throw new SandboxError(`Wave ${role} has a step of zero.`);
  return {
    type: "float64",
    shape: [items.length],
    data: new Float64Array(0),
    imag: null,
    text: [...(items as string[])],
    x0: finite(raw.x0, `The X start of wave ${role}`),
    dx,
    xUnit: text(raw.xUnit, `The X unit of wave ${role}`),
    y0: finite(raw.y0, `The Y start of wave ${role}`),
    dy,
    yUnit: text(raw.yUnit, `The Y unit of wave ${role}`),
    unit: text(raw.unit, `The unit of wave ${role}`),
    note: text(raw.note, `The note of wave ${role}`, SANDBOX_LIMITS.note),
  };
}

/** snake_case as Python writes it, in the camelCase the document uses. */
const camel = (key: string): string =>
  key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Properties as plain data with camelCase names, nested ones too. */
function props(value: unknown, what: string, depth = 0): Record<string, Json> {
  if (value === undefined || value === null) return {};
  const prototype = isRecord(value) ? Object.getPrototypeOf(value) : undefined;
  // Plain objects, or those this function made (with no prototype).
  if (!isRecord(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new SandboxError(`${what} is not a dict.`);
  }
  const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const [key, item] of entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) {
      throw new SandboxError(`${what} has a property named ${JSON.stringify(key.slice(0, 40))}.`);
    }
    out[camel(key)] = isRecord(item) && depth < 2 ? props(item, what, depth + 1) : json(item, 2);
  }
  return out;
}

const side = (value: unknown, fallback: AxisSide, what: string): AxisSide => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (AXIS_SIDES as readonly string[]).includes(value)) {
    return value as AxisSide;
  }
  throw new SandboxError(`${what} must be one of ${AXIS_SIDES.join(", ")}.`);
};

const role = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !ROLE.test(value)) {
    throw new SandboxError(`${what} must be the role of a wave the action returned.`);
  }
  return value;
};

/** Checks the graph an action asks for: its shape and bounds, not yet its properties. */
export function checkGraph(raw: unknown): PluginGraph | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new SandboxError("The graph is not a dict.");
  const known = ["name", "traces", "axes", "graph", "annotations"];
  const unknown = Object.keys(raw).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new SandboxError(
      `The graph has ${JSON.stringify(unknown[0]!.slice(0, 40))}; it takes ${known.join(", ")}.`,
    );
  }
  const name =
    raw.name === undefined || raw.name === null ? null : text(raw.name, "The graph's name");
  const rawTraces = raw.traces ?? [];
  if (!Array.isArray(rawTraces) || rawTraces.length > SANDBOX_LIMITS.graphItems) {
    throw new SandboxError(
      `The graph's traces are not a list of at most ${SANDBOX_LIMITS.graphItems}.`,
    );
  }
  const traces = rawTraces.map((item, index): PluginTrace => {
    const what = `Trace ${index + 1} of the graph`;
    const all = props(item, what);
    const { y, x, axis, haxis, hAxis, vAxis, legend, ...rest } = all;
    return {
      y: role(y, `${what}'s y`),
      x: x === undefined || x === null ? null : role(x, `${what}'s x`),
      vAxis: side(axis ?? vAxis, "left", `${what}'s axis`),
      hAxis: side(haxis ?? hAxis, "bottom", `${what}'s haxis`),
      legend: legend === undefined || legend === null ? null : text(legend, `${what}'s legend`),
      props: rest,
    };
  });
  const rawAxes = props(raw.axes, "The graph's axes");
  const axes: PluginGraph["axes"] = {};
  for (const [key, value] of Object.entries(rawAxes)) {
    axes[side(key, "left", "An axis of the graph")] = props(value, `The ${key} axis`);
  }
  const rawAnnotations = raw.annotations ?? [];
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length > SANDBOX_LIMITS.graphItems) {
    throw new SandboxError(
      `The graph's annotations are not a list of at most ${SANDBOX_LIMITS.graphItems}.`,
    );
  }
  const annotations = rawAnnotations.map((item, index): PluginAnnotation => {
    const what = `Annotation ${index + 1} of the graph`;
    const { kind, text: words, ...rest } = props(item, what);
    if (kind !== "legend" && kind !== "text") {
      throw new SandboxError(`${what} must be of kind "legend" or "text".`);
    }
    return {
      kind,
      text:
        words === undefined || words === null
          ? null
          : text(words, `${what}'s text`, SANDBOX_LIMITS.label * 10),
      props: rest,
    };
  });
  return { name, traces, axes, graph: props(raw.graph, "The graph's properties"), annotations };
}

/** A copy of JSON-like values, refusing anything else and anything too large or deep. */
function json(value: unknown, depth = 0): Json {
  if (depth > SANDBOX_LIMITS.valuesDepth) throw new SandboxError("The values nest too deeply.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new SandboxError("The values hold a number that is not finite.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1));
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
    for (const [key, item] of entries(value)) copy[key] = json(item, depth + 1);
    return copy;
  }
  throw new SandboxError("The values hold something that is not plain data.");
}

/** Checks the outcome of a successful run. */
export function checkResult(message: Record<string, unknown>): CheckedResult {
  const rawWaves = message.waves;
  if (!isRecord(rawWaves)) throw new SandboxError("The result has no waves.");
  const waveEntries = entries(rawWaves);
  if (waveEntries.length > SANDBOX_LIMITS.waves) {
    throw new SandboxError(`The result has more than ${SANDBOX_LIMITS.waves} waves.`);
  }
  let points = 0;
  const waves: [string, CheckedWave][] = [];
  for (const [role, raw] of waveEntries) {
    if (!ROLE.test(role))
      throw new SandboxError(`${JSON.stringify(role.slice(0, 40))} is not a usable wave role.`);
    const checked = wave(role, raw);
    points += checked.data.length;
    if (points > SANDBOX_LIMITS.points) {
      throw new SandboxError(`The waves have more than ${SANDBOX_LIMITS.points} points together.`);
    }
    waves.push([role, checked]);
  }
  const values = json(message.values ?? null);
  if (JSON.stringify(values).length > SANDBOX_LIMITS.valuesBytes) {
    throw new SandboxError("The values are too large.");
  }
  const graph = checkGraph(message.graph);
  if (graph) {
    const roles = new Set(waves.map(([name]) => name));
    const named = graph.traces.flatMap((trace) => [
      trace.y,
      ...(trace.x === null ? [] : [trace.x]),
      ...WAVE_PROPS.flatMap((key) =>
        typeof trace.props[key] === "string" ? [trace.props[key] as string] : [],
      ),
    ]);
    const stray = named.find((name) => !roles.has(name));
    if (stray !== undefined) {
      throw new SandboxError(`The graph uses ${stray}, which is not a wave the action returned.`);
    }
  }
  return { waves, values, graph, log: checkLog(message.log) };
}

/** Output a sandbox reports: kept to the limit, never refused for its content. */
export function checkLog(value: unknown): string {
  return typeof value === "string" ? value.slice(0, SANDBOX_LIMITS.log) : "";
}

/** Checks the actions a plugin says it registered: exactly the names expected. */
export function checkLoaded(value: unknown, expected: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new SandboxError("The plugin did not list its actions.");
  }
  const names = [...(value as string[])].sort();
  const wanted = [...expected].sort();
  if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
    throw new SandboxError("The plugin registered other actions than its manifest lists.");
  }
  return names;
}

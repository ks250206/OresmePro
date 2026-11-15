import type { WaveData, WaveType } from "../doc/types";
import { SANDBOX_DTYPES, SANDBOX_LIMITS, type Json, type SandboxDtype } from "./protocol";

/**
 * Checks of what a sandbox sends. The sandbox runs code the app does not
 * trust, so nothing it sends is taken as it comes: every field is read
 * defensively, against fixed limits, and anything unexpected refuses the
 * whole message. Nothing here throws for bad input; it says why instead.
 */

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** A wave from a sandbox, checked, with its values in the typed array of its type. */
export interface CheckedWave {
  type: WaveType;
  shape: number[];
  data: WaveData;
  imag: WaveData | null;
  x0: number;
  dx: number;
  xUnit: string;
  y0: number;
  dy: number;
  yUnit: string;
  unit: string;
  note: string;
}

export interface CheckedResult {
  /** By role, in the order the sandbox listed them. */
  waves: [string, CheckedWave][];
  values: Json;
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
  return { waves, values, log: checkLog(message.log) };
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

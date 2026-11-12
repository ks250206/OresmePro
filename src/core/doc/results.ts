import { DocError, type DocState, type Wave } from "./types";

/**
 * The outcome of an analysis (a fit), kept in the experiment together with
 * what was asked for: enough to see under which conditions the numbers came
 * about, to compare them with others, and to run the analysis again.
 */
export interface AnalysisResult {
  name: string;
  /** What kind of analysis made it: a curve fit, a multi-peak fit, a fit of several waves at once. */
  kind: ResultKind;
  /** A short description, such as "gauss(signal)". */
  label: string;
  /** When it was made, in milliseconds since the epoch. */
  created: number;
  /**
   * What the analysis was told, as the keyword arguments of the Python call
   * that makes it again. Opaque here: only Python reads it.
   */
  settings: JsonObject;
  /** The waves it read, with a fingerprint of each as it was then. */
  inputs: ResultInput[];
  /** The parameters, their values and standard deviations (null where there is none). */
  names: string[];
  coef: (number | null)[];
  sigma: (number | null)[];
  /** The parameters that were kept fixed. */
  held: string[];
  /** The covariance of the parameters, row by row in the order of `names`, if it was worked out. */
  covariance: (number | null)[][] | null;
  chisq: number | null;
  /** How many points were fitted, and how many of them were free: points less fitted parameters. */
  points: number;
  freedom: number;
  converged: boolean;
  /** Why the fit stopped. */
  reason: string;
  /** The waves it made, by role: "fit", "residuals", ... */
  outputs: Record<string, string>;
}

export const RESULT_KINDS = ["fit", "peaks", "global"] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/** The first part of the name a result gets when none is given: Fit0, Peaks0, Global0. */
export const RESULT_BASE: Record<ResultKind, string> = {
  fit: "Fit",
  peaks: "Peaks",
  global: "Global",
};

export interface ResultInput {
  wave: string;
  fingerprint: string;
}

export type Json = string | number | boolean | null | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

const fingerprints = new WeakMap<Wave, string>();

/** FNV-1a over 32-bit words: fast enough for millions of points, and all that is asked of it. */
function mix(hash: number, words: Uint32Array): number {
  for (let index = 0; index < words.length; index += 1) {
    hash = Math.imul(hash ^ words[index]!, 0x01000193);
  }
  return hash >>> 0;
}

function hashBytes(hash: number, bytes: Uint8Array): number {
  const whole = bytes.byteLength >>> 2;
  // Only an aligned view can be read as words; a copy is made otherwise.
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  hash = mix(hash, new Uint32Array(aligned.buffer, aligned.byteOffset, whole));
  for (let index = whole * 4; index < bytes.byteLength; index += 1) {
    hash = Math.imul(hash ^ bytes[index]!, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * A short text that changes when the wave's values, shape or X scaling
 * change: what a fit of the wave depends on. Not a secure hash; two waves
 * differing in it differ, and equal waves agree.
 */
export function waveFingerprint(wave: Wave): string {
  const cached = fingerprints.get(wave);
  if (cached) return cached;
  let hash = 0x811c9dc5;
  const header = `${wave.type}|${wave.shape.join(",")}|${wave.x0}|${wave.dx}|${wave.y0}|${wave.dy}|`;
  hash = hashBytes(hash, new TextEncoder().encode(header));
  if (wave.text) {
    hash = hashBytes(hash, new TextEncoder().encode(wave.text.join("\u0000")));
  } else {
    for (const part of [wave.data, wave.imag]) {
      if (part)
        hash = hashBytes(hash, new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    }
  }
  const length = wave.text ? wave.text.length : wave.data.length;
  const fingerprint = `${hash.toString(16).padStart(8, "0")}-${length}`;
  fingerprints.set(wave, fingerprint);
  return fingerprint;
}

/** The inputs of a result that are no longer what they were: changed, or gone. */
export function changedInputs(state: DocState, result: AnalysisResult): string[] {
  return result.inputs
    .filter(({ wave, fingerprint }) => {
      const now = Object.hasOwn(state.waves, wave) ? state.waves[wave] : undefined;
      return !now || waveFingerprint(now) !== fingerprint;
    })
    .map((input) => input.wave);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function numbers(value: unknown, what: string): (number | null)[] {
  if (!Array.isArray(value) || value.some((item) => item !== null && typeof item !== "number")) {
    throw new DocError(`A result's ${what} must be a list of numbers.`);
  }
  return value.map((item: number | null) => (item !== null && Number.isFinite(item) ? item : null));
}

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DocError(`A result's ${what} must be a list of names.`);
  }
  return [...(value as string[])];
}

/**
 * A result as it comes from Python or from a file, checked and put in a
 * fixed shape. The waves it names as inputs are fingerprinted as they are in
 * `state`, unless fingerprints come with it (a result read from a file).
 */
export function checkResult(value: unknown, name: string, state: DocState | null): AnalysisResult {
  if (!isObject(value)) throw new DocError("A result must be an object.");
  const kind = RESULT_KINDS.find((item) => item === value.kind);
  if (!kind) throw new DocError(`A result's kind must be one of ${RESULT_KINDS.join(", ")}.`);
  const names = strings(value.names, "names");
  const coef = numbers(value.coef, "coef");
  const sigma = numbers(value.sigma, "sigma");
  if (coef.length !== names.length || sigma.length !== names.length) {
    throw new DocError("A result needs one value and one sigma for each parameter.");
  }
  let covariance: AnalysisResult["covariance"] = null;
  if (value.covariance !== null && value.covariance !== undefined) {
    if (!Array.isArray(value.covariance) || value.covariance.length !== names.length) {
      throw new DocError("A result's covariance must have a row for each parameter.");
    }
    covariance = value.covariance.map((row) => {
      const values = numbers(row, "covariance");
      if (values.length !== names.length) {
        throw new DocError("A result's covariance must have a column for each parameter.");
      }
      return values;
    });
  }
  const inputs: ResultInput[] = [];
  if (!Array.isArray(value.inputs)) throw new DocError("A result's inputs must be a list.");
  for (const input of value.inputs as unknown[]) {
    const wave = typeof input === "string" ? input : isObject(input) ? input.wave : undefined;
    if (typeof wave !== "string") throw new DocError("A result's inputs must be wave names.");
    if (inputs.some((other) => other.wave === wave)) continue;
    const given =
      isObject(input) && typeof input.fingerprint === "string" ? input.fingerprint : null;
    const now = state && Object.hasOwn(state.waves, wave) ? state.waves[wave] : undefined;
    if (given === null && !now) throw new DocError(`No wave named ${JSON.stringify(wave)}.`);
    inputs.push({ wave, fingerprint: given ?? waveFingerprint(now!) });
  }
  const outputs: Record<string, string> = {};
  if (isObject(value.outputs)) {
    for (const [role, wave] of Object.entries(value.outputs)) {
      if (typeof wave === "string") outputs[role] = wave;
    }
  }
  const count = (item: unknown) =>
    typeof item === "number" && Number.isFinite(item) ? Math.max(0, Math.round(item)) : 0;
  return {
    name,
    kind,
    label: typeof value.label === "string" ? value.label : kind,
    created:
      typeof value.created === "number" && Number.isFinite(value.created) ? value.created : 0,
    settings: isObject(value.settings) ? (value.settings as JsonObject) : {},
    inputs,
    names,
    coef,
    sigma,
    held: Array.isArray(value.held) ? strings(value.held, "held") : [],
    covariance,
    chisq: typeof value.chisq === "number" && Number.isFinite(value.chisq) ? value.chisq : null,
    points: count(value.points),
    freedom: count(value.freedom),
    converged: value.converged === true,
    reason: typeof value.reason === "string" ? value.reason : "",
    outputs,
  };
}

/** The settings and outputs of a result with a wave's name changed wherever it stands for the wave. */
export function renameInResult(
  result: AnalysisResult,
  rename: (name: string) => string,
): AnalysisResult {
  const renamed = (value: Json): Json => {
    if (typeof value === "string") return rename(value);
    if (Array.isArray(value)) return value.map(renamed);
    return value;
  };
  // Only the settings that name waves: a function called "signal" is not the wave "signal".
  const settings: JsonObject = { ...result.settings };
  for (const key of ["y", "x", "sigma", "mask", "ys", "xs"]) {
    if (key in settings) settings[key] = renamed(settings[key]!);
  }
  const inputs = result.inputs.map((input) => ({ ...input, wave: rename(input.wave) }));
  const outputs = Object.fromEntries(
    Object.entries(result.outputs).map(([role, wave]) => [role, rename(wave)]),
  );
  const same =
    JSON.stringify([settings, inputs, outputs]) ===
    JSON.stringify([result.settings, result.inputs, result.outputs]);
  return same ? result : { ...result, settings, inputs, outputs };
}

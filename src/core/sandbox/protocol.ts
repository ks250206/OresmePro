/**
 * The messages between the app and a sandbox (see src/sandbox/). What comes
 * from the sandbox is written by code the app does not trust: the types say
 * what a well-behaved sandbox sends, and src/core/sandbox/validate.ts checks
 * every message against them before anything uses it.
 */

/** The number types a wave can have, as the sandbox sends one part of them. */
export const SANDBOX_DTYPES = [
  "float64",
  "float32",
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
] as const;
export type SandboxDtype = (typeof SANDBOX_DTYPES)[number];

/**
 * A wave as it crosses into or out of the sandbox: one buffer per part, in C
 * order. A text wave has the dtype "text", one dimension, an empty buffer and
 * its values in `text`.
 */
export interface SandboxWave {
  name: string;
  dtype: SandboxDtype | "text";
  shape: number[];
  data: ArrayBuffer;
  /** The values of a text wave; left out for a numeric one. */
  text?: string[];
  /** The imaginary parts of a complex wave (dtype float64 or float32), or null. */
  imag: ArrayBuffer | null;
  x0: number;
  dx: number;
  xUnit: string;
  y0: number;
  dy: number;
  yUnit: string;
  unit: string;
  note: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type HostToSandbox =
  | {
      type: "boot";
      /** The text of pyodide.mjs and pyodide.asm.mjs. */
      pyodide: string;
      asm: string;
      /** pyodide-lock.json as text. */
      lock: string;
      /** Files Pyodide asks for by name (or URL): the wasm, the standard library, packages. */
      files: Record<string, ArrayBuffer>;
      /** Packages to load before any plugin code runs. */
      packages: string[];
      /** The text of oresme_plugin.py. */
      sdk: string;
    }
  | {
      type: "load";
      /** A short name for the plugin's folder in the sandbox. */
      key: string;
      files: Record<string, ArrayBuffer>;
      /** The module to import, which registers the actions. */
      entry: string;
      /** The names of the actions it must register: those of its manifest, no more and no fewer. */
      actions: string[];
    }
  | {
      type: "run";
      runId: number;
      action: string;
      inputs: Record<string, SandboxWave | SandboxWave[]>;
      params: Record<string, Json>;
    };

export type SandboxToHost =
  | { type: "ready" }
  | { type: "booted" }
  | { type: "unsupported"; reason: string }
  | { type: "boot-failed"; error: string }
  | { type: "loaded"; actions: string[]; log: string }
  | { type: "load-failed"; error: string; log: string }
  | {
      type: "result";
      runId: number;
      ok: true;
      waves: Record<string, Omit<SandboxWave, "name">>;
      values: Json;
      log: string;
    }
  | { type: "result"; runId: number; ok: false; error: string; log: string };

/** What the app accepts from a sandbox at most. Past these, a result is refused, not cut. */
export const SANDBOX_LIMITS = {
  /** Waves one run may return. */
  waves: 64,
  /** Points of all the waves of one run together. */
  points: 50_000_000,
  /** Characters of a unit or other short text. */
  shortText: 200,
  /** Characters of a wave's note. */
  note: 100_000,
  /** The values of one run, as JSON. */
  valuesBytes: 1024 * 1024,
  /** How deeply values may nest. */
  valuesDepth: 16,
  /** Points of a text wave. */
  textPoints: 100_000,
  /** Characters of one value of a text wave. */
  label: 400,
  /** Traces, or annotations, of a graph a run asks for. */
  graphItems: 64,
  /** Characters of output kept from one run. */
  log: 64 * 1024,
} as const;

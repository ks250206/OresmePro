/**
 * The Igor files written by scripts/igor-fixtures.py, for tests, and what
 * that script says each holds (expected.json).
 */
import expectedText from "./expected.json?raw";

const urls = import.meta.glob<string>("./*.{ibw,pxp}", {
  query: "?inline",
  import: "default",
  eager: true,
});

/** The bytes of one of the files, by its name ("v5-be-3d.ibw"); a fresh copy each time. */
export function igorFixture(name: string): Uint8Array {
  const url = urls[`./${name}`];
  if (!url) throw new Error(`No Igor fixture named ${name}.`);
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
}

export interface ExpectedWave {
  name: string;
  version: number;
  littleEndian: boolean;
  igorType: string;
  type: string;
  shape: number[];
  dims: { size: number; start: number; delta: number; unit: string }[];
  unit: string;
  note: string;
  formula: string;
  missingValues: boolean;
  /** Real parts in C order; what is not finite is written "NaN", "Infinity" or "-Infinity". */
  values?: (number | string)[];
  imag: (number | string)[] | null;
  text: string[] | null;
}

export interface ExpectedExperiment {
  littleEndian: boolean;
  folders: string[][];
  rest: Record<string, unknown>;
  waves: (ExpectedWave & { folder: string[] })[];
}

export const expectedIgor = JSON.parse(expectedText) as Record<
  string,
  ExpectedWave | ExpectedExperiment
>;

/** A value of expected.json as a number. */
export const expectedNumber = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

import { describe, expect, it } from "vite-plus/test";
import { Doc } from "./doc";
import { echoMake } from "./echo";
import {
  MAX_POINTS,
  nameProblems,
  parseShape,
  planMakeWaves,
  splitNames,
  type MakeWavesRequest,
} from "./makeWaves";
import { DocError } from "./types";

const request = (change: Partial<MakeWavesRequest> = {}): MakeWavesRequest => ({
  names: ["a"],
  folder: "",
  shape: [128],
  type: "float64",
  x0: 0,
  dx: 1,
  xUnit: "",
  unit: "",
  overwrite: false,
  edit: false,
  ...change,
});

function sample(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "newFolder", path: "run1" });
  doc.dispatch({
    op: "makeWave",
    name: "taken",
    data: new Float64Array([1, 2]),
    x0: 5,
    dx: 0.5,
    xUnit: "s",
    unit: "V",
  });
  return doc;
}

/** Makes waves as the dialog does: one undo step, and returns the echo. */
function make(doc: Doc, change: Partial<MakeWavesRequest>): string {
  const plan = planMakeWaves(doc.getState(), request(change));
  for (const command of plan.commands) doc.dispatch(command, { group: "dialog" });
  return plan.echo;
}

describe("names", () => {
  it("are split on commas, semicolons and spaces", () => {
    expect(splitNames(" a, b  c;d,,")).toEqual(["a", "b", "c", "d"]);
    expect(splitNames("  ")).toEqual([]);
  });

  it("are checked with the document's rule, for repeats, and against waves there", () => {
    const state = sample().getState();
    const problems = nameProblems(state, ["ok", "2x", "ok", "taken"], "", false);
    expect(problems[0]).toBeNull();
    expect(problems[1]).toMatch(/"2x" is not a valid wave name/);
    expect(problems[2]).toBe("ok is named twice.");
    expect(problems[3]).toMatch(/A wave named taken already exists/);
    // Taken names are fine when they are to be overwritten, or in another folder.
    expect(nameProblems(state, ["taken"], "", true)).toEqual([null]);
    expect(nameProblems(state, ["taken"], "run1", false)).toEqual([null]);
  });
});

describe("shape", () => {
  it("uses columns, layers and chunks when they are given and not 0", () => {
    expect(parseShape(["100", "", "", ""])).toEqual([100]);
    expect(parseShape(["10", "20", "0", ""])).toEqual([10, 20]);
    expect(parseShape(["2", "3", "4", "5"])).toEqual([2, 3, 4, 5]);
    expect(parseShape(["0", "", "", ""])).toEqual([0]);
  });

  it("says what is wrong", () => {
    expect(parseShape(["", "", "", ""])).toMatch(/^Rows must be a whole number/);
    expect(parseShape(["1.5", "", "", ""])).toMatch(/^Rows/);
    expect(parseShape(["4", "x", "", ""])).toMatch(/^Columns must be a whole number/);
    expect(parseShape(["4", "", "3", ""])).toBe("Layers need a number of columns too.");
    expect(parseShape([String(MAX_POINTS + 1), "", "", ""])).toMatch(/at most/);
  });
});

describe("making waves", () => {
  it("makes zeros with the scaling and units asked for, in one undo step", () => {
    const doc = sample();
    const echo = make(doc, {
      names: ["v1", "v2"],
      shape: [100],
      type: "float32",
      x0: 1,
      dx: 0.01,
      xUnit: "s",
      unit: "V",
    });
    const v2 = doc.getState().waves.v2!;
    expect(v2).toMatchObject({ type: "float32", shape: [100], x0: 1, dx: 0.01, xUnit: "s" });
    expect(v2.unit).toBe("V");
    expect([...v2.data].every((value) => value === 0)).toBe(true);
    expect(echo).toBe(
      'op.make("v1", n=100, dtype="float32", x0=1, dx=0.01, x_unit="s", unit="V")\n' +
        'op.make("v2", n=100, dtype="float32", x0=1, dx=0.01, x_unit="s", unit="V")',
    );
    doc.undo();
    expect(Object.keys(doc.getState().waves)).toEqual(["taken"]);
  });

  it("leaves the defaults out of the echo, and writes a matrix's sizes", () => {
    expect(make(new Doc(), {})).toBe('op.make("a")');
    expect(make(new Doc(), { shape: [10, 20, 3], type: "complex128" })).toBe(
      'op.make("a", n=(10, 20, 3), dtype="complex128")',
    );
    const doc = new Doc();
    make(doc, { shape: [2, 3], type: "complex64" });
    const wave = doc.getState().waves.a!;
    expect(wave.shape).toEqual([2, 3]);
    expect(wave.imag?.length).toBe(6);
  });

  it("makes waves in a data folder and opens a table of them", () => {
    const doc = sample();
    const echo = make(doc, { names: ["x", "y"], folder: "run1", edit: true });
    expect(doc.getState().waveOrder).toEqual(["taken", "run1:x", "run1:y"]);
    expect(doc.getState().tables.Table0!.columns).toEqual(["run1:x", "run1:y"]);
    expect(echo).toBe('op.make("run1:x")\nop.make("run1:y")\nop.edit("run1:x", "run1:y")');
  });

  it("refuses a taken name before making anything, unless told to overwrite", () => {
    const doc = sample();
    expect(() => make(doc, { names: ["fresh", "taken"] })).toThrow(DocError);
    expect(() => make(doc, { names: ["fresh", "taken"] })).toThrow(/taken already exists/);
    expect(doc.getState().waves.fresh).toBeUndefined();
    expect(() => make(doc, { folder: "nowhere" })).toThrow(/no data folder/);
    expect(() => make(doc, { names: [] })).toThrow(/at least one name/);
  });

  it("writes what an overwritten wave would otherwise keep", () => {
    const doc = sample();
    // Back to the defaults: op.make would keep the old scaling and units, so they are written.
    expect(make(doc, { names: ["taken"], overwrite: true, shape: [3] })).toBe(
      'op.make("taken", n=3, x0=0, dx=1, x_unit="", unit="")',
    );
    expect(doc.getState().waves.taken).toMatchObject({ x0: 0, dx: 1, xUnit: "", unit: "" });
  });

  it("echoes a command on its own, with the size its shape gives", () => {
    expect(
      echoMake({ op: "makeWave", name: "w", data: new Float64Array(5), shape: [5], x0: -0.5 }),
    ).toBe('op.make("w", n=5, x0=-0.5)');
  });
});

import { describe, expect, it } from "vite-plus/test";
import { findAction, invokeCode, validateArgs, type ActionSpec } from "./actions";

const smooth: ActionSpec = {
  id: "core.smooth",
  version: 1,
  title: "Smooth",
  description: null,
  params: {
    wave: { type: "wave", title: "Wave", optional: false },
    n: { type: "integer", optional: true, default: 5, min: 1 },
    name: { type: "string", optional: true },
  },
};

const every: ActionSpec = {
  id: "lab.every",
  version: 2,
  title: "Every type",
  description: "One argument of each type.",
  params: {
    wave: { type: "wave", optional: true },
    waves: { type: "waves", optional: true, length: 2 },
    number: { type: "number", optional: true, min: 0, max: 1 },
    numbers: { type: "numbers", optional: true, min: 0 },
    string: { type: "string", optional: true },
    boolean: { type: "boolean", optional: true },
    choice: { type: "choice", optional: true, choices: ["a", "b", 3] },
    samples: { type: "samples", optional: true },
  },
};

describe("findAction", () => {
  const older: ActionSpec = { ...every, version: 1 };
  const catalog = [smooth, older, every];

  it("finds the highest version unless one is asked for", () => {
    expect(findAction(catalog, "lab.every")).toBe(every);
    expect(findAction(catalog, "lab.every", 1)).toBe(older);
    expect(findAction(catalog, "lab.every", 3)).toBeUndefined();
    expect(findAction(catalog, "lab.none")).toBeUndefined();
  });
});

describe("validateArgs", () => {
  it("accepts a call that Python would", () => {
    expect(validateArgs(smooth, { wave: "signal" })).toEqual([]);
    expect(validateArgs(smooth, { wave: "signal", n: 7, name: "out" })).toEqual([]);
    expect(
      validateArgs(every, {
        wave: "a",
        waves: ["a", "root:b"],
        number: 0.5,
        numbers: [1, 2, 3],
        string: "",
        boolean: false,
        choice: 3,
      }),
    ).toEqual([]);
  });

  it("refuses extra, missing and badly typed arguments", () => {
    expect(validateArgs(smooth, { wave: "signal", colour: "red" })).toEqual([
      'core.smooth takes no argument "colour".',
    ]);
    expect(validateArgs(smooth, {})).toEqual(['core.smooth needs "wave".']);
    expect(validateArgs(smooth, ["signal"])).toEqual([
      "The arguments of core.smooth are an object of name: value.",
    ]);
    expect(validateArgs(smooth, { wave: 3 })).toEqual([
      "core.smooth: wave must be the name of a wave.",
    ]);
    expect(validateArgs(smooth, { wave: "signal", n: 2.5 })).toEqual([
      "core.smooth: n must be a whole number.",
    ]);
    expect(validateArgs(smooth, { wave: "signal", n: 0 })).toEqual([
      "core.smooth: n must be at least 1.",
    ]);
    expect(validateArgs(smooth, { wave: "signal", name: null })).toEqual([
      "core.smooth: name cannot be null: leave it out instead.",
    ]);
  });

  it("checks each type", () => {
    const problem = (args: Record<string, unknown>) => validateArgs(every, args);
    expect(problem({ waves: ["a"] })).toEqual(["lab.every: waves must have 2 items, not 1."]);
    expect(problem({ waves: "a" })).toEqual(["lab.every: waves must be a list."]);
    expect(problem({ number: 2 })).toEqual(["lab.every: number must be at most 1."]);
    expect(problem({ number: Number.NaN })).toEqual(["lab.every: number must be a finite number."]);
    expect(problem({ number: "0.5" })).toEqual(["lab.every: number must be a finite number."]);
    expect(problem({ numbers: [1, -1] })).toEqual(["lab.every: numbers[1] must be at least 0."]);
    expect(problem({ string: 1 })).toEqual(["lab.every: string must be a string."]);
    expect(problem({ boolean: "yes" })).toEqual(["lab.every: boolean must be true or false."]);
    expect(problem({ choice: "c" })).toEqual(['lab.every: choice must be one of "a", "b", 3.']);
    expect(problem({ choice: true })).toHaveLength(1);
    expect(problem({ samples: [{ y: "a", x: "b" }, { y: "c" }] })).toEqual([]);
    expect(problem({ samples: ["a"] })).toEqual([
      "lab.every: samples[0] must give a wave name for each input.",
    ]);
    expect(problem({ samples: [{ y: "" }] })).toEqual([
      "lab.every: samples[0]: y must be the name of a wave.",
    ]);
  });

  it("checks that waves exist when it is told how", () => {
    const waveExists = (name: string) => name === "signal" || name === "run1:raw";
    expect(validateArgs(smooth, { wave: "signal" }, { waveExists })).toEqual([]);
    expect(validateArgs(every, { waves: ["root:signal", "run1:raw"] }, { waveExists })).toEqual([]);
    expect(validateArgs(smooth, { wave: "other" }, { waveExists })).toEqual([
      'core.smooth: wave: there is no wave named "other".',
    ]);
  });

  it("lists every problem at once", () => {
    expect(validateArgs(smooth, { n: "x", colour: 1 })).toHaveLength(3);
  });
});

describe("invokeCode", () => {
  it("writes the call as op.invoke with Python literals", () => {
    expect(
      invokeCode("core.fit", { function: "gauss", y: "sig", quiet: true, guess: [1, 2.5] }),
    ).toBe(
      'op.invoke("core.fit", {"function": "gauss", "y": "sig", "quiet": True, "guess": [1, 2.5]})',
    );
    expect(invokeCode("lab.x", {}, 2)).toBe('op.invoke("lab.x", {}, version=2)');
  });
});

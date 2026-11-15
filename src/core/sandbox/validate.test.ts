import { describe, expect, it } from "vite-plus/test";
import { packageClosure } from "./packages";
import { checkLoaded, checkLog, checkResult, SandboxError } from "./validate";

const goodWave = (points = 3) => ({
  dtype: "float64",
  shape: [points],
  data: new Float64Array(points).fill(1).buffer,
  imag: null,
  x0: 0,
  dx: 0.5,
  xUnit: "s",
  y0: 0,
  dy: 1,
  yUnit: "",
  unit: "V",
  note: "",
});

describe("results from a sandbox", () => {
  it("accepts waves and plain values, in the typed array of their type", () => {
    const result = checkResult({
      waves: {
        fit: goodWave(),
        counts: { ...goodWave(2), dtype: "int16", data: new Int16Array([4, 5]).buffer },
      },
      values: { coef: [1, 2], ok: true, name: "R1", nested: { depth: null } },
      log: "done\n",
    });
    expect(result.waves.map(([role, wave]) => [role, wave.type, Array.from(wave.data)])).toEqual([
      ["fit", "float64", [1, 1, 1]],
      ["counts", "int16", [4, 5]],
    ]);
    expect(result.values).toEqual({ coef: [1, 2], ok: true, name: "R1", nested: { depth: null } });
    expect(result.log).toBe("done\n");
  });

  it("makes a wave with imaginary parts complex", () => {
    const result = checkResult({
      waves: { z: { ...goodWave(2), imag: new Float64Array([1, -1]).buffer } },
      values: null,
    });
    expect(result.waves[0]![1].type).toBe("complex128");
    expect(Array.from(result.waves[0]![1].imag!)).toEqual([1, -1]);
  });

  it.each([
    [
      "data that does not match the shape",
      { big: { ...goodWave(), shape: [1_000_000] } },
      /do not match/,
    ],
    ["an unknown number type", { w: { ...goodWave(), dtype: "float16" } }, /unknown number type/],
    ["a shape of five dimensions", { w: { ...goodWave(), shape: [1, 1, 1, 1, 3] } }, /shape/],
    ["a negative size", { w: { ...goodWave(), shape: [-3] } }, /shape/],
    ["data that is not binary", { w: { ...goodWave(), data: [1, 2, 3] } }, /not binary/],
    ["a step of zero", { w: { ...goodWave(), dx: 0 } }, /step of zero/],
    ["a start that is not finite", { w: { ...goodWave(), x0: Number.NaN } }, /not a finite/],
    ["a unit that is not text", { w: { ...goodWave(), unit: 5 } }, /not text/],
    ["a very long unit", { w: { ...goodWave(), unit: "x".repeat(1000) } }, /longer than/],
    [
      "imaginary parts of an integer wave",
      {
        w: {
          ...goodWave(),
          dtype: "int32",
          data: new Int32Array(3).buffer,
          imag: new Int32Array(3).buffer,
        },
      },
      /complex/,
    ],
    ["a role that is not a name", { "../escape": goodWave() }, /not a usable wave role/],
    [
      "too many points",
      { w: { ...goodWave(), shape: [60_000_000], data: new ArrayBuffer(8) } },
      /more than/,
    ],
  ])("refuses %s", (_, waves, message) => {
    expect(() => checkResult({ waves, values: null })).toThrow(message);
  });

  it("refuses values that are not plain data", () => {
    expect(() => checkResult({ waves: {}, values: { when: new Date() } })).toThrow(SandboxError);
    expect(() => checkResult({ waves: {}, values: { x: Number.POSITIVE_INFINITY } })).toThrow(
      /not finite/,
    );
    let deep: unknown = 1;
    for (let level = 0; level < 40; level += 1) deep = [deep];
    expect(() => checkResult({ waves: {}, values: deep })).toThrow(/nest too deeply/);
    expect(() => checkResult({ waves: {}, values: "x".repeat(2 * 1024 * 1024) })).toThrow(
      /too large/,
    );
  });

  it("copies values onto objects without a prototype", () => {
    const values = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown;
    const result = checkResult({ waves: {}, values });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.values)).toBeNull();
  });

  it("keeps output to the limit without refusing it", () => {
    expect(checkLog("x".repeat(100_000)).length).toBe(64 * 1024);
    expect(checkLog(42)).toBe("");
  });
});

describe("actions a plugin says it registered", () => {
  it("are taken when they are those of its manifest", () => {
    expect(checkLoaded(["tafel", "eis_fit"], ["eis_fit", "tafel"])).toEqual(["eis_fit", "tafel"]);
  });

  it.each([
    ["one more", ["eis_fit", "tafel", "extra"]],
    ["one fewer", ["eis_fit"]],
    ["another", ["eis_fit", "other"]],
    ["no list", { name: "eis_fit" }],
  ])("are refused when there is %s", (_, actions) => {
    expect(() => checkLoaded(actions, ["eis_fit", "tafel"])).toThrow(SandboxError);
  });
});

describe("the packages a sandbox loads", () => {
  const lock = {
    packages: {
      numpy: { file_name: "numpy.whl", depends: [] },
      scipy: { file_name: "scipy.whl", depends: ["numpy"] },
      lmfit: { file_name: "lmfit.whl", depends: ["scipy", "numpy", "asteval"] },
      asteval: { file_name: "asteval.whl", depends: [] },
    },
  };

  it("include what the packages asked for depend on, once each", () => {
    expect(packageClosure(lock, ["lmfit", "numpy"]).sort()).toEqual([
      "asteval",
      "lmfit",
      "numpy",
      "scipy",
    ]);
  });

  it("refuse a package Python does not have", () => {
    expect(() => packageClosure(lock, ["tensorflow"])).toThrow(/no package tensorflow/);
  });
});

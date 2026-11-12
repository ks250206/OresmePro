import { describe, expect, it } from "vite-plus/test";
import { History } from "../history/history";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { changedInputs, waveFingerprint } from "./results";

const fit = (extra: Record<string, unknown> = {}) => ({
  kind: "fit",
  label: "line(signal)",
  created: 1000,
  settings: { function: "line", y: "signal", x: "time", hold: { a: 0 }, guess: null },
  inputs: ["signal", "time"],
  names: ["a", "b"],
  coef: [0, 2],
  sigma: [0, 0.1],
  held: ["a"],
  covariance: [
    [0, 0],
    [0, 0.01],
  ],
  chisq: 1.5,
  points: 4,
  freedom: 3,
  converged: true,
  reason: "converged",
  outputs: { fit: "fit_signal" },
  ...extra,
});

function sample() {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "signal", data: Float64Array.of(0, 2, 4, 6) });
  doc.dispatch({ op: "makeWave", name: "time", data: Float64Array.of(0, 1, 2, 3) });
  doc.dispatch({ op: "makeWave", name: "fit_signal", data: Float64Array.of(0, 6) });
  return doc;
}

describe("analysis results", () => {
  it("are kept by name, numbered by kind, and replaced when the name is given again", () => {
    const doc = sample();
    expect(doc.dispatch({ op: "addResult", result: fit() })).toBe("Fit0");
    expect(doc.dispatch({ op: "addResult", result: fit({ kind: "peaks" }) })).toBe("Peaks0");
    expect(doc.dispatch({ op: "addResult", result: fit({ chisq: 9 }) })).toBe("Fit1");
    expect(doc.dispatch({ op: "addResult", result: fit({ chisq: 3 }), name: "Fit0" })).toBe("Fit0");
    const { results } = doc.getState();
    expect(Object.keys(results)).toEqual(["Fit0", "Peaks0", "Fit1"]);
    expect(results.Fit0).toMatchObject({ name: "Fit0", chisq: 3, coef: [0, 2], held: ["a"] });
    expect(results.Fit0!.inputs.map((input) => input.wave)).toEqual(["signal", "time"]);
    doc.undo();
    expect(doc.getState().results.Fit0!.chisq).toBe(1.5);
  });

  it("tell when the waves they read have changed since", () => {
    const doc = sample();
    doc.dispatch({ op: "addResult", result: fit() });
    const result = () => doc.getState().results.Fit0!;
    expect(changedInputs(doc.getState(), result())).toEqual([]);
    // Other waves, and notes and units of the inputs, do not count.
    doc.dispatch({ op: "setWavePoints", name: "fit_signal", start: 0, values: Float64Array.of(9) });
    doc.dispatch({ op: "setWaveMeta", name: "signal", note: "seen", unit: "V" });
    expect(changedInputs(doc.getState(), result())).toEqual([]);
    // A value, the scaling, or the wave being gone do.
    doc.dispatch({ op: "setWavePoints", name: "signal", start: 1, values: Float64Array.of(2.5) });
    expect(changedInputs(doc.getState(), result())).toEqual(["signal"]);
    doc.undo();
    expect(changedInputs(doc.getState(), result())).toEqual([]);
    doc.dispatch({ op: "setWaveScale", name: "time", dx: 2 });
    expect(changedInputs(doc.getState(), result())).toEqual(["time"]);
    doc.dispatch({ op: "killWaves", names: ["signal"] });
    expect(changedInputs(doc.getState(), result())).toEqual(["signal", "time"]);
  });

  it("fingerprint waves by their values, type, shape and scaling", () => {
    const doc = new Doc();
    const print = (name: string) => waveFingerprint(doc.getState().waves[name]!);
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3) });
    doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(1, 2, 3) });
    doc.dispatch({ op: "makeWave", name: "c", data: Float32Array.of(1, 2, 3) });
    doc.dispatch({ op: "makeWave", name: "d", data: Float64Array.of(1, 2, 3.0000000001) });
    doc.dispatch({ op: "makeWave", name: "t", text: ["x", "y"] });
    doc.dispatch({ op: "makeWave", name: "u", text: ["xy", ""] });
    expect(print("a")).toBe(print("b"));
    expect(new Set(["a", "c", "d", "t", "u"].map(print)).size).toBe(5);
    // Odd lengths in bytes, and complex waves, are covered too.
    doc.dispatch({ op: "makeWave", name: "e", data: Int8Array.of(1, 2, 3, 4, 5) });
    doc.dispatch({ op: "makeWave", name: "f", data: Int8Array.of(1, 2, 3, 4, 6) });
    doc.dispatch({ op: "makeWave", name: "g", data: Float64Array.of(1), imag: Float64Array.of(2) });
    doc.dispatch({ op: "makeWave", name: "h", data: Float64Array.of(1), imag: Float64Array.of(3) });
    expect(print("e")).not.toBe(print("f"));
    expect(print("g")).not.toBe(print("h"));
  });

  it("follow a wave that is renamed, are renamed and removed, and echo as Python", () => {
    const doc = sample();
    doc.dispatch({ op: "addResult", result: fit() });
    doc.dispatch({ op: "renameWave", name: "signal", newName: "raw" });
    const result = doc.getState().results.Fit0!;
    expect(result.settings).toMatchObject({ y: "raw", x: "time", function: "line" });
    expect(result.inputs.map((input) => input.wave)).toEqual(["raw", "time"]);
    expect(changedInputs(doc.getState(), result)).toEqual([]);

    const rename = { op: "renameResult", name: "Fit0", newName: "sampleA" } as const;
    expect(echoPython(rename)).toBe('op.result("Fit0").rename("sampleA")');
    expect(doc.dispatch(rename)).toBe("sampleA");
    expect(doc.getState().results.sampleA!.name).toBe("sampleA");
    expect(() => doc.dispatch({ ...rename, name: "nope" })).toThrow(/No result named "nope"/);
    doc.dispatch({ op: "addResult", result: fit({ inputs: ["raw"] }) });
    expect(() => doc.dispatch({ op: "renameResult", name: "Fit0", newName: "sampleA" })).toThrow(
      /already exists/,
    );
    const remove = { op: "removeResults", names: ["sampleA", "Fit0"] } as const;
    expect(echoPython(remove)).toBe('op.result("sampleA").remove()\nop.result("Fit0").remove()');
    doc.dispatch(remove);
    expect(Object.keys(doc.getState().results)).toEqual([]);
    expect(echoPython({ op: "addResult", result: fit() })).toBeNull();
  });

  it("are checked as they come in", () => {
    const doc = sample();
    const add = (result: unknown, name?: string) => () =>
      doc.dispatch({ op: "addResult", result, ...(name ? { name } : {}) });
    expect(add({ ...fit(), kind: "guess" })).toThrow(/kind must be one of/);
    expect(add(fit({ coef: [1] }))).toThrow(/one value and one sigma/);
    expect(add(fit({ inputs: ["missing"] }))).toThrow(/No wave named "missing"/);
    expect(add(fit({ covariance: [[1, 2]] }))).toThrow(/a row for each parameter/);
    expect(add(fit(), "not a name")).toThrow(/not a valid result name/);
    expect(add(fit(), "constructor")).not.toThrow();
    // Values that are not finite are kept as "none" rather than refused.
    add(fit({ sigma: [null, Number.NaN], chisq: Number.POSITIVE_INFINITY, covariance: null }))();
    expect(doc.getState().results.Fit0).toMatchObject({
      sigma: [null, null],
      chisq: null,
      covariance: null,
    });
  });

  it("are saved with the experiment, and an experiment from before them opens", () => {
    const doc = sample();
    doc.dispatch({ op: "addResult", result: fit() });
    doc.dispatch({ op: "setWavePoints", name: "signal", start: 0, values: Float64Array.of(1) });
    const opened = unzipExperiment(zipExperiment(doc.getState(), new History().getEntries(), []));
    const restored = new Doc();
    restored.load(opened.state);
    const result = restored.getState().results.Fit0!;
    expect(result).toEqual(doc.getState().results.Fit0);
    // The fingerprints are those of the fit, not of the waves as saved.
    expect(changedInputs(restored.getState(), result)).toEqual(["signal"]);

    const old = unzipExperiment(zipExperiment(sample().getState(), [], []));
    expect(Object.keys(old.state.results)).toEqual([]);
  });
});

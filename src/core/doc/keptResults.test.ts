import { describe, expect, it } from "vite-plus/test";
import { FileStore, sourcePath } from "../files/files";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";

/** A result as Python records a fit, of `y` making `fit_y`. */
const fitResult = (outputs: Record<string, string>) => ({
  kind: "fit",
  label: "line(y)",
  settings: { function: "line", y: "y" },
  inputs: [{ wave: "y" }],
  names: ["a", "b"],
  coef: [1, 2],
  sigma: [0.1, 0.2],
  points: 3,
  freedom: 1,
  converged: true,
  outputs,
});

function setup(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: new Float64Array([1, 3, 5]) });
  doc.dispatch({ op: "makeWave", name: "fit_y", data: new Float64Array([1, 3, 5]) });
  return doc;
}

const values = (doc: Doc, name: string) => Array.from(doc.getState().waves[name]?.data ?? []);

describe("a result's own copies of what it made", () => {
  it("stay as they were when the wave is fitted again", () => {
    const doc = setup();
    const first = doc.dispatch({ op: "addResult", result: fitResult({ fit: "fit_y" }) })!;
    expect(doc.getState().results[first]!.kept).toEqual({ fit: `results:${first}:fit` });
    expect(doc.getState().folders).toEqual(["results", `results:${first}`]);
    // Fitted again: fit_y is made anew and a second result is kept.
    doc.dispatch({ op: "makeWave", name: "fit_y", data: new Float64Array([2, 4, 6]) });
    const second = doc.dispatch({ op: "addResult", result: fitResult({ fit: "fit_y" }) })!;
    expect(values(doc, `results:${first}:fit`)).toEqual([1, 3, 5]);
    expect(values(doc, `results:${second}:fit`)).toEqual([2, 4, 6]);
    expect(doc.getState().results[first]!.outputs).toEqual({ fit: "fit_y" });
  });

  it("are replaced when a result is made again under its name", () => {
    const doc = setup();
    doc.dispatch({ op: "addResult", name: "Run", result: fitResult({ fit: "fit_y" }) });
    doc.dispatch({ op: "makeWave", name: "fit_y", data: new Float64Array([9, 9, 9]) });
    doc.dispatch({ op: "addResult", name: "Run", result: fitResult({ fit: "fit_y" }) });
    expect(values(doc, "results:Run:fit")).toEqual([9, 9, 9]);
  });

  it("go with the result, unless something shows them, and follow its new name", () => {
    const doc = setup();
    const name = doc.dispatch({ op: "addResult", result: fitResult({ fit: "fit_y" }) })!;
    doc.dispatch({ op: "renameResult", name, newName: "Best" });
    expect(doc.getState().results.Best!.kept).toEqual({ fit: "results:Best:fit" });
    expect(values(doc, "results:Best:fit")).toEqual([1, 3, 5]);
    expect(doc.getState().waves[`results:${name}:fit`]).toBeUndefined();

    doc.dispatch({ op: "removeResults", names: ["Best"] });
    expect(doc.getState().waves["results:Best:fit"]).toBeUndefined();
    expect(doc.getState().folders).toEqual([]);
    doc.undo();
    expect(values(doc, "results:Best:fit")).toEqual([1, 3, 5]);

    // Shown in a graph, the copy stays when the result goes.
    doc.dispatch({ op: "display", y: ["results:Best:fit"], name: "G" });
    doc.dispatch({ op: "removeResults", names: ["Best"] });
    expect(values(doc, "results:Best:fit")).toEqual([1, 3, 5]);
  });

  it("leave out what is gone, and are saved with the experiment", () => {
    const doc = setup();
    const name = doc.dispatch({
      op: "addResult",
      result: fitResult({ fit: "fit_y", residuals: "nowhere" }),
    })!;
    expect(doc.getState().results[name]!.kept).toEqual({ fit: `results:${name}:fit` });
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.results[name]!.kept).toEqual({ fit: `results:${name}:fit` });
    expect(Array.from(back.waves[`results:${name}:fit`]!.data)).toEqual([1, 3, 5]);
  });
});

describe("where a loaded file is kept", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("under its name, unless a different file of that name is there", () => {
    const store = new FileStore();
    expect(sourcePath(store, "data.csv", bytes("1,2"), "1a2b3c4d5e")).toBe("data.csv");
    store.put("data.csv", bytes("1,2"));
    // The same file again keeps its place.
    expect(sourcePath(store, "data.csv", bytes("1,2"), "1a2b3c4d5e")).toBe("data.csv");
    expect(sourcePath(store, "data.csv", bytes("3,4"), "9f8e7d6c5b")).toBe("data-9f8e7d6c.csv");
    store.put("run/scan.h5", bytes("a"));
    expect(sourcePath(store, "run/scan.h5", bytes("b"), "abcdef0123")).toBe("run/scan-abcdef01.h5");
    store.put("README", bytes("a"));
    expect(sourcePath(store, "README", bytes("b"), "abcdef0123")).toBe("README-abcdef01");
  });
});

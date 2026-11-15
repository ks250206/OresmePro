import { describe, expect, it } from "vite-plus/test";
import { History } from "../history/history";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import {
  argText,
  changedSampleInputs,
  checkAnalysisTemplate,
  retryable,
  runCounts,
} from "./analysisTemplates";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { waveFingerprint } from "./results";

/** Background, then a fit of what is left: the shape of most templates. */
const xps = () => ({
  description: "Shirley background, then peaks",
  inputs: [{ name: "spectrum", title: "Spectrum" }],
  steps: [
    {
      id: "bg",
      action: "core.background",
      version: 1,
      args: { wave: { $input: "spectrum" }, subtract: true, range: [280, 295] },
    },
    {
      id: "fit",
      action: "core.fit_peaks",
      version: 1,
      args: { y: { $step: "bg", output: "subtracted" }, shape: "voigt", quiet: true },
    },
  ],
});

function sample() {
  const doc = new Doc();
  for (const name of ["s1", "s2", "s3"]) {
    doc.dispatch({ op: "makeWave", name, data: Float64Array.of(1, 2, 3) });
  }
  return doc;
}

const refused = (template: unknown, message: RegExp) =>
  expect(() => checkAnalysisTemplate(template)).toThrow(message);

describe("analysis templates", () => {
  it("are checked into a fixed shape", () => {
    const template = checkAnalysisTemplate({ ...xps(), inputs: ["spectrum"] });
    expect(template.inputs).toEqual([{ name: "spectrum", title: "", kind: "wave" }]);
    expect(template.steps[1]!.args.y).toEqual({ $step: "bg", output: "subtracted" });
  });

  it("refuse references that point nowhere or forward, and values that are not values", () => {
    const step = (args: unknown, id = "a") => ({ id, action: "core.smooth", version: 1, args });
    const one = (args: unknown) => ({ inputs: ["y"], steps: [step(args)] });
    refused(one({ wave: { $input: "z" } }), /refers to "z", which is not an input/);
    refused(one({ wave: { $step: "a", output: "wave" } }), /"a", which is not an earlier step/);
    refused(
      { inputs: ["y"], steps: [step({ wave: { $step: "b", output: "wave" } }), step({}, "b")] },
      /"b", which is not an earlier step/,
    );
    refused(one({ wave: { $step: "a" } }), /an object must be/);
    refused(one({ wave: { $input: "y", extra: 1 } }), /an object must be/);
    refused(one({ wave: { expr: "y * 2" } }), /actions take no other objects/);
    refused(one({ n: null }), /cannot be null/);
    refused(one({ n: Number.NaN }), /finite number/);
    refused(one({ n: [[1, 2]] }), /lists inside lists/);
    refused(one({ __proto__x: 1 }), /not a parameter name/);
    refused({ inputs: [], steps: [step({})] }, /at least one input/);
    refused({ inputs: ["y"], steps: [] }, /at least one step/);
    refused({ inputs: ["y", "y"], steps: [step({})] }, /Two inputs are named y/);
    refused({ inputs: ["y"], steps: [step({}), step({})] }, /Two steps are named a/);
    refused({ inputs: ["y"], steps: [{ ...step({}), action: "Smooth" }] }, /not an action id/);
    refused({ inputs: ["y"], steps: [{ ...step({}), version: 0 }] }, /whole number from 1/);
    refused({ inputs: ["y"], steps: [{ ...step({}), when: "now" }] }, /has no "when"/);
    refused({ inputs: ["2y"], steps: [step({})] }, /not a valid input name/);
    refused({ inputs: [{ name: "y", kind: "number" }], steps: [step({})] }, /kind of an input/);
    refused({ inputs: ["y"], steps: [step({})], colour: 1 }, /has no "colour"/);
    // A list may hold references, as a list of waves does.
    expect(
      checkAnalysisTemplate(one({ ys: [{ $input: "y" }, "fixed"] })).steps[0]!.args.ys,
    ).toEqual([{ $input: "y" }, "fixed"]);
  });

  it("are set, renamed and removed by commands, written as Python, and undone", () => {
    const doc = sample();
    const set = { op: "setTemplate", name: "XPS", template: xps() } as const;
    expect(doc.dispatch(set)).toBe("XPS");
    expect(echoPython(set)).toMatch(
      /^op\.set_template\("XPS", \{"description": .*"args": \{"wave": \{"\$input": "spectrum"\}, "subtract": True/,
    );
    expect(() => doc.dispatch({ op: "setTemplate", name: "1x", template: xps() })).toThrow(
      /not a valid template name/,
    );
    doc.dispatch({ op: "setTemplate", name: "Other", template: xps() });
    expect(() => doc.dispatch({ op: "renameTemplate", name: "XPS", newName: "Other" })).toThrow(
      /already exists/,
    );
    const rename = { op: "renameTemplate", name: "XPS", newName: "XPS2" } as const;
    doc.dispatch(rename);
    expect(echoPython(rename)).toBe('op.template("XPS").rename("XPS2")');
    expect(Object.keys(doc.getState().templates)).toEqual(["Other", "XPS2"]);
    const remove = { op: "removeTemplate", name: "XPS2" } as const;
    doc.dispatch(remove);
    expect(echoPython(remove)).toBe('op.template("XPS2").remove()');
    expect(() => doc.dispatch(remove)).toThrow(/No template named "XPS2"/);
    doc.undo();
    expect(doc.getState().templates.XPS2!.steps).toHaveLength(2);
  });

  it("show their arguments as a list of steps reads them", () => {
    expect(argText({ $input: "spectrum" })).toBe("$spectrum");
    expect(argText({ $step: "bg", output: "subtracted" })).toBe("bg.subtracted");
    expect(argText([{ $input: "a" }, 2])).toBe("[$a, 2]");
    expect(argText("gauss")).toBe('"gauss"');
  });
});

describe("runs", () => {
  const start = (doc: Doc, onError = "continue") =>
    doc.dispatch({
      op: "addRun",
      run: {
        template: "XPS",
        copy: xps(),
        onError,
        created: 5,
        samples: ["s1", "s2", "s3"].map((spectrum) => ({ inputs: { spectrum } })),
      },
    });

  it("start with every sample pending, numbered Run0, Run1, ...", () => {
    const doc = sample();
    expect(start(doc)).toBe("Run0");
    expect(start(doc, "stop")).toBe("Run1");
    const run = doc.getState().runs.Run0!;
    expect(run).toMatchObject({ template: "XPS", onError: "continue", created: 5 });
    expect(run.samples[0]).toEqual({
      inputs: { spectrum: "s1" },
      fingerprints: {},
      state: "pending",
      error: "",
      results: [],
      waves: [],
      attempts: 0,
      finished: null,
    });
    expect(runCounts(run)).toEqual({ pending: 3, succeeded: 0, failed: 0, cancelled: 0 });
    // Not echoed: the Python that runs the template is what the history shows.
    expect(echoPython({ op: "addRun", run: {} })).toBeNull();
    expect(() =>
      doc.dispatch({ op: "addRun", run: { copy: xps(), samples: [{ inputs: {} }] } }),
    ).toThrow(/Sample 1 needs a wave for spectrum/);
    expect(() =>
      doc.dispatch({
        op: "addRun",
        run: { copy: xps(), samples: [{ inputs: { spectrum: "s1", other: "s2" } }] },
      }),
    ).toThrow(/no input "other"/);
    expect(() => doc.dispatch({ op: "addRun", run: { copy: xps(), samples: [] } })).toThrow(
      /at least one sample/,
    );
    expect(() =>
      doc.dispatch({ op: "addRun", name: "Run0", run: { copy: xps(), samples: ["s1"] } }),
    ).toThrow(/already exists/);
  });

  it("record each sample as it finishes, with fingerprints of its inputs as used", () => {
    const doc = sample();
    start(doc);
    doc.dispatch({
      op: "updateRunSample",
      run: "Run0",
      index: 0,
      state: "succeeded",
      results: ["Peaks0"],
      waves: ["s1_bg", "s1_sub"],
      attempted: true,
      finished: 10,
    });
    doc.dispatch({
      op: "updateRunSample",
      run: "Run0",
      index: 1,
      state: "failed",
      error: "No points are left to fit.",
      attempted: true,
      finished: 11,
    });
    doc.dispatch({
      op: "updateRunSample",
      run: "Run0",
      index: 2,
      state: "cancelled",
      error: "Not done: the run was interrupted.",
    });
    const run = () => doc.getState().runs.Run0!;
    expect(run().samples[0]).toMatchObject({
      state: "succeeded",
      results: ["Peaks0"],
      waves: ["s1_bg", "s1_sub"],
      attempts: 1,
      finished: 10,
      fingerprints: { spectrum: waveFingerprint(doc.getState().waves.s1!) },
    });
    expect(run().samples[1]).toMatchObject({ state: "failed", attempts: 1, results: [] });
    expect(run().samples[2]).toMatchObject({ state: "cancelled", attempts: 0, fingerprints: {} });
    expect(retryable(run())).toEqual([1, 2]);
    expect(changedSampleInputs(doc.getState(), run().samples[0]!)).toEqual([]);
    doc.dispatch({ op: "setWavePoints", name: "s1", start: 0, values: Float64Array.of(9) });
    expect(changedSampleInputs(doc.getState(), run().samples[0]!)).toEqual(["s1"]);
    expect(() =>
      doc.dispatch({ op: "updateRunSample", run: "Run0", index: 3, state: "failed" }),
    ).toThrow(/Run0 has no sample 4/);
    expect(() =>
      doc.dispatch({ op: "updateRunSample", run: "Run9", index: 0, state: "failed" }),
    ).toThrow(/No run named "Run9"/);
  });

  it("keep their copy of the template when the template changes or goes", () => {
    const doc = sample();
    doc.dispatch({ op: "setTemplate", name: "XPS", template: xps() });
    start(doc);
    const changed = xps();
    changed.steps[1]!.args.shape = "gauss";
    doc.dispatch({ op: "setTemplate", name: "XPS", template: changed });
    doc.dispatch({ op: "removeTemplate", name: "XPS" });
    expect(doc.getState().runs.Run0!.copy.steps[1]!.args.shape).toBe("voigt");
  });

  it("follow waves and results that are renamed", () => {
    const doc = sample();
    start(doc);
    doc.dispatch({ op: "makeWave", name: "s1_bg", data: Float64Array.of(0) });
    doc.dispatch({
      op: "addResult",
      result: {
        kind: "peaks",
        settings: {},
        inputs: ["s1"],
        names: [],
        coef: [],
        sigma: [],
      },
    });
    doc.dispatch({
      op: "updateRunSample",
      run: "Run0",
      index: 0,
      state: "succeeded",
      results: ["Peaks0"],
      waves: ["s1_bg"],
      attempted: true,
    });
    doc.dispatch({ op: "renameWave", name: "s1", newName: "first" });
    doc.dispatch({ op: "renameWave", name: "s1_bg", newName: "first_bg" });
    doc.dispatch({ op: "renameResult", name: "Peaks0", newName: "FirstPeaks" });
    const first = doc.getState().runs.Run0!.samples[0]!;
    expect(first.inputs).toEqual({ spectrum: "first" });
    expect(first.waves).toEqual(["first_bg"]);
    expect(first.results).toEqual(["FirstPeaks"]);
    // Still the same data: the fingerprint is the wave's, not its name's.
    expect(changedSampleInputs(doc.getState(), first)).toEqual([]);
  });

  it("are removed by name, written as Python", () => {
    const doc = sample();
    start(doc);
    start(doc);
    const remove = { op: "removeRuns", names: ["Run0", "Run1"] } as const;
    doc.dispatch(remove);
    expect(echoPython(remove)).toBe('op.run("Run0").remove()\nop.run("Run1").remove()');
    expect(doc.getState().runs).toEqual({});
    expect(() => doc.dispatch(remove)).toThrow(/No run named "Run0"/);
  });

  it("are saved with the experiment, with templates", () => {
    const doc = sample();
    doc.dispatch({ op: "setTemplate", name: "XPS", template: xps() });
    start(doc);
    doc.dispatch({
      op: "updateRunSample",
      run: "Run0",
      index: 1,
      state: "failed",
      error: "Bad data.",
      attempted: true,
      finished: 3,
    });
    const opened = unzipExperiment(zipExperiment(doc.getState(), new History().getEntries(), []));
    const restored = new Doc();
    restored.load(opened.state);
    expect(restored.getState().templates.XPS).toEqual(doc.getState().templates.XPS);
    expect(restored.getState().runs.Run0).toEqual(doc.getState().runs.Run0);
    const old = unzipExperiment(zipExperiment(sample().getState(), [], []));
    expect(Object.keys(old.state.templates)).toEqual([]);
    expect(Object.keys(old.state.runs)).toEqual([]);
  });
});

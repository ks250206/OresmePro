import { describe, expect, it } from "vite-plus/test";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";

const keep = (state: unknown, editor = "eis") => ({
  op: "keepEditorState" as const,
  plugin: "electrochem",
  editor,
  version: "0.2.0",
  state,
});

describe("what plugins' editors hold, kept with the experiment", () => {
  it("is saved and read back with it, by plugin and editor", () => {
    const doc = new Doc();
    doc.dispatch(keep({ circuit: "R0-p(R1,C1)", params: [{ name: "R0", value: 10 }] }));
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.editors["electrochem/eis"]).toEqual({
      plugin: "electrochem",
      editor: "eis",
      version: "0.2.0",
      state: { circuit: "R0-p(R1,C1)", params: [{ name: "R0", value: 10 }] },
    });
    doc.dispatch(keep(null));
    expect(doc.getState().editors).toEqual({});
  });

  it("is not undone with the experiment, nor recorded as Python", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: new Float64Array([1]) });
    doc.dispatch(keep({ step: 1 }));
    expect(echoPython(keep({ step: 1 }))).toBeNull();
    doc.dispatch(keep({ step: 2 }));
    doc.undo();
    expect(doc.getState().waves.a).toBeUndefined();
    expect(doc.getState().editors["electrochem/eis"]!.state).toEqual({ step: 2 });
  });

  it("is plain JSON of a bounded size, under names a plugin can have", () => {
    const doc = new Doc();
    expect(() => doc.dispatch({ ...keep({}), plugin: "../x" })).toThrow(/not a plugin's name/);
    expect(() => doc.dispatch(keep({}, "a/b"))).toThrow(/not an editor's name/);
    expect(() => doc.dispatch(keep(() => 1))).toThrow(/plain JSON/);
    expect(() => doc.dispatch(keep("x".repeat(1024 * 1024 + 1)))).toThrow(/larger than 1024 KiB/);
    // One that cannot be read is left out of a file, not the rest of it.
    doc.dispatch(keep({ ok: true }));
    const saved = zipExperiment(doc.getState(), []);
    const back = unzipExperiment(saved).state;
    expect(Object.keys(back.editors)).toEqual(["electrochem/eis"]);
  });
});

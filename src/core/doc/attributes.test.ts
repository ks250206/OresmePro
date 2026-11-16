import { describe, expect, it } from "vite-plus/test";
import { attributeFromText, sampleRows } from "../../ui/AttributesDialog";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { folderAttributes, waveAttributes } from "./attributes";
import { Doc } from "./doc";
import { echoPython } from "./echo";

function setup(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "newFolder", path: "run1:sub" });
  doc.dispatch({ op: "makeWave", name: "run1:sub:y", data: new Float64Array([1, 2]) });
  doc.dispatch({ op: "makeWave", name: "run1:x", data: new Float64Array([1, 2]) });
  doc.dispatch({ op: "setAttributes", target: "run1:", values: { thickness: 10, site: "A" } });
  doc.dispatch({ op: "setAttributes", target: "run1:sub:", values: { site: "B" } });
  doc.dispatch({ op: "setAttributes", target: "run1:sub:y", values: { cycle: 3 } });
  return doc;
}

describe("the attributes of samples", () => {
  it("are a wave's folders' from root down, then its own", () => {
    const state = setup().getState();
    expect(waveAttributes(state, "run1:sub:y")).toEqual({ thickness: 10, site: "B", cycle: 3 });
    expect(waveAttributes(state, "run1:x")).toEqual({ thickness: 10, site: "A" });
    expect(folderAttributes(state, "run1:sub")).toEqual({ thickness: 10, site: "B" });
  });

  it("are set and removed, checked, and undone", () => {
    const doc = setup();
    doc.dispatch({ op: "setAttributes", target: "run1:", values: { site: null, Mg: 0.3 } });
    expect(doc.getState().attributes["run1:"]).toEqual({ thickness: 10, Mg: 0.3 });
    doc.undo();
    expect(doc.getState().attributes["run1:"]).toEqual({ thickness: 10, site: "A" });
    const refused = (values: Record<string, unknown>, target = "run1:", message: RegExp) =>
      expect(() => doc.dispatch({ op: "setAttributes", target, values })).toThrow(message);
    refused({ "2nd": 1 }, "run1:", /not an attribute name/);
    refused({ t: Number.NaN }, "run1:", /finite number or text/);
    refused({ t: [1] }, "run1:", /finite number or text/);
    refused({ t: 1 }, "nowhere:", /No data folder named "nowhere"/);
    refused({ t: 1 }, "nowhere", /No wave named "nowhere"/);
    // Removing the last one leaves nothing behind.
    doc.dispatch({ op: "setAttributes", target: "run1:sub:y", values: { cycle: null } });
    expect("run1:sub:y" in doc.getState().attributes).toBe(false);
  });

  it("go where their wave or folder goes, and with it", () => {
    const doc = setup();
    doc.dispatch({ op: "renameFolder", path: "run1", newPath: "sampleA" });
    const state = doc.getState();
    expect(Object.keys(state.attributes).sort()).toEqual([
      "sampleA:",
      "sampleA:sub:",
      "sampleA:sub:y",
    ]);
    doc.dispatch({ op: "renameWave", name: "sampleA:sub:y", newName: "sampleA:y2" });
    expect(waveAttributes(doc.getState(), "sampleA:y2")).toEqual({
      thickness: 10,
      site: "A",
      cycle: 3,
    });
    doc.dispatch({ op: "killWaves", names: ["sampleA:y2"] });
    expect("sampleA:y2" in doc.getState().attributes).toBe(false);
    doc.dispatch({ op: "killFolder", path: "sampleA" });
    expect(doc.getState().attributes).toEqual({});
  });

  it("are saved with the experiment, and written as Python", () => {
    const back = unzipExperiment(zipExperiment(setup().getState(), [])).state;
    expect(waveAttributes(back, "run1:sub:y")).toEqual({ thickness: 10, site: "B", cycle: 3 });
    expect(
      echoPython({ op: "setAttributes", target: "run1:", values: { thickness: 12.5, site: null } }),
    ).toBe('op.set_attributes("run1:", {"thickness": 12.5, "site": None})');
  });
});

describe("the Sample Attributes table", () => {
  it("has a row for each folder with waves, or the waves of root", () => {
    const doc = setup();
    expect(sampleRows(doc.getState())).toEqual(["run1:", "run1:sub:"]);
    expect(sampleRows(doc.getState(), ["run1:x"])).toEqual(["run1:x"]);
    const flat = new Doc();
    flat.dispatch({ op: "makeWave", name: "a", data: new Float64Array([1]) });
    expect(sampleRows(flat.getState())).toEqual(["a"]);
  });

  it("reads numbers as numbers and the rest as text", () => {
    expect(attributeFromText(" 12.5 ")).toBe(12.5);
    expect(attributeFromText("-3e2")).toBe(-300);
    expect(attributeFromText("XPS-2")).toBe("XPS-2");
    expect(attributeFromText("0x10")).toBe("0x10");
    expect(attributeFromText("  ")).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";
import { Doc } from "./doc";
import { valuesId } from "./values";

function docWithA() {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "a", data: new Float64Array([1, 2, 3, 4]) });
  return doc;
}

const idOf = (doc: Doc, name = "a") => valuesId(doc.getState().waves[name]!);

describe("the id of a wave's values", () => {
  it("stays the same when its note, units, scaling or name change", () => {
    const doc = docWithA();
    const before = idOf(doc);
    doc.dispatch({ op: "setWaveMeta", name: "a", note: "n", unit: "V" });
    doc.dispatch({ op: "setWaveScale", name: "a", x0: 2, dx: 3, xUnit: "s" });
    doc.dispatch({ op: "renameWave", name: "a", newName: "b" });
    expect(idOf(doc, "b")).toBe(before);
  });

  it("changes with its numbers, and comes back with undo", () => {
    const doc = docWithA();
    const first = idOf(doc);
    doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([1, 2, 3, 5]) });
    const second = idOf(doc);
    expect(second).not.toBe(first);
    doc.dispatch({ op: "setWavePoints", name: "a", start: 0, values: [9] });
    expect(idOf(doc)).not.toBe(second);
    doc.undo();
    expect(idOf(doc)).toBe(second);
    doc.undo();
    expect(idOf(doc)).toBe(first);
  });

  it("changes with the shape or the type the same numbers are read with", () => {
    const wave = docWithA().getState().waves.a!;
    const id = valuesId(wave);
    expect(valuesId({ ...wave })).toBe(id);
    expect(valuesId({ ...wave, shape: [2, 2] })).not.toBe(id);
    expect(valuesId({ ...wave, type: "float32" })).not.toBe(id);
    expect(valuesId({ ...wave, imag: new Float64Array(4) })).not.toBe(id);
  });

  it("differs between a wave and its duplicate", () => {
    const doc = docWithA();
    doc.dispatch({ op: "duplicateWave", name: "a", newName: "c" });
    expect(idOf(doc, "c")).not.toBe(idOf(doc));
  });
});

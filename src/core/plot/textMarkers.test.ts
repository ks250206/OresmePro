import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import type { MeasureText, Prim } from "./displayList";
import { layoutGraph } from "./layout";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

function labelled(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: Float64Array.of(0, 1, 2) });
  doc.dispatch({ op: "makeWave", name: "x", data: Float64Array.of(0, 1, 2) });
  doc.dispatch({ op: "makeWave", name: "names", text: ["A", "B", "C"] });
  doc.dispatch({ op: "makeWave", name: "values", data: Float64Array.of(10, 20.5, Number.NaN) });
  doc.dispatch({ op: "display", y: ["y"], x: "x", name: "G" });
  doc.dispatch({
    op: "modifyTrace",
    graph: "G",
    trace: "y",
    props: { mode: "markers", textMarker: "names", color: "#0000ff" },
  });
  return doc;
}

function drawn(doc: Doc, name = "G") {
  const state = doc.getState();
  return layoutGraph(state.graphs[name]!, state.waves, 400, 300, measure);
}

/** Every text drawn, at any depth (traces are drawn inside clips). */
function texts(prims: readonly Prim[]): Extract<Prim, { kind: "text" }>[] {
  return prims.flatMap((prim) =>
    prim.kind === "text" ? [prim] : prim.kind === "clip" ? texts(prim.children) : [],
  );
}

describe("text markers", () => {
  it("draw a wave's values at the points instead of markers, placed by their anchor", () => {
    const doc = labelled();
    const layout = drawn(doc);
    const points = layout.traces[0]!.markers!;
    const labels = texts(layout.prims).filter((prim) => ["A", "B", "C"].includes(prim.text));
    expect(labels.map((prim) => [prim.text, prim.fill])).toEqual([
      ["A", "#0000ff"],
      ["B", "#0000ff"],
      ["C", "#0000ff"],
    ]);
    // Centred: half the width to the left, and the middle of the capitals on the point.
    const size = 12;
    const width = size * 0.55;
    expect(labels[1]!.x).toBeCloseTo(points[2]! - width / 2);
    const middle = labels[1]!.y - (size * 0.7) / 2;
    expect(Math.abs(middle - points[3]!)).toBeLessThan(2);
    expect(
      layout.prims.some(
        (prim) => prim.kind === "clip" && prim.children.some((child) => child.kind === "markers"),
      ),
    ).toBe(false);

    // "LB": the label's bottom left corner on the point; turned, and its own size.
    doc.dispatch({
      op: "modifyTrace",
      graph: "G",
      trace: "y",
      props: { textAnchor: "LB", textRotation: 90, textSize: 20 },
    });
    const turned = texts(drawn(doc).prims).find((prim) => prim.text === "B")!;
    expect(turned).toMatchObject({ size: 20, rotate: 90 });
  });

  it("write numbers out, and leave out what is not a number", () => {
    const doc = labelled();
    doc.dispatch({ op: "modifyTrace", graph: "G", trace: "y", props: { textMarker: "values" } });
    const shown = texts(drawn(doc).prims).map((prim) => prim.text);
    expect(shown).toContain("10");
    expect(shown).toContain("20.5");
    expect(shown).not.toContain("NaN");
  });

  it("need a wave of one value per point, which follows renames and stays in use", () => {
    const doc = labelled();
    doc.dispatch({ op: "makeWave", name: "short", text: ["only"] });
    expect(() =>
      doc.dispatch({ op: "modifyTrace", graph: "G", trace: "y", props: { textMarker: "short" } }),
    ).toThrow("Text marker wave short has 1 points but y has 3.");
    expect(() =>
      doc.dispatch({ op: "modifyTrace", graph: "G", trace: "y", props: { textAnchor: "XX" } }),
    ).toThrow(/textAnchor/);
    doc.dispatch({ op: "renameWave", name: "names", newName: "corners" });
    expect(doc.getState().graphs.G!.traces[0]!.textMarker).toBe("corners");
    expect(() => doc.dispatch({ op: "killWaves", names: ["corners"] })).toThrow(/in use by G/);
  });

  it("are kept by graph templates, with a slot for the labels", () => {
    const doc = labelled();
    doc.dispatch({ op: "saveGraphTemplate", name: "T", graph: "G" });
    const template = doc.getState().graphTemplates.T!;
    expect(template.slots.map((slot) => [slot.name, slot.role])).toEqual([
      ["y", "y"],
      ["x", "x"],
      ["labels", "text"],
    ]);
    expect(template.traces[0]).toMatchObject({ textMarker: "labels", textAnchor: "MC" });
    doc.dispatch({
      op: "makeGraphs",
      template: "T",
      samples: [{ y: "y", x: "x", labels: "values" }],
      names: ["H"],
    });
    expect(doc.getState().graphs.H!.traces[0]!.textMarker).toBe("values");
  });
});

describe("an axis without its line", () => {
  it("draws only what else it has, and nothing at all when that is nothing", () => {
    const doc = labelled();
    const segments = () =>
      drawn(doc).prims.filter((prim) => prim.kind === "segments" && prim.stroke === "#000000")
        .length;
    const before = segments();
    doc.dispatch({ op: "modifyAxis", graph: "G", axis: "left", props: { line: false } });
    // The ticks are drawn on their own still.
    expect(segments()).toBe(before);
    doc.dispatch({
      op: "modifyAxis",
      graph: "G",
      axis: "left",
      props: { ticks: "none", labels: "off" },
    });
    expect(segments()).toBe(before - 1);
    // Only the bottom axis's numbers are left, each once.
    const numbers = texts(drawn(doc).prims)
      .map((prim) => prim.text)
      .filter((text) => !["A", "B", "C"].includes(text));
    expect(numbers.filter((text) => text === "1.0")).toHaveLength(1);
    expect(() =>
      doc.dispatch({ op: "modifyAxis", graph: "G", axis: "left", props: { line: "no" } }),
    ).toThrow(/line/);
  });
});

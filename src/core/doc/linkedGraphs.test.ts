import { describe, expect, it } from "vite-plus/test";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { graphScript } from "./recreate";

function setup(): Doc {
  const doc = new Doc();
  // Charge, current and temperature against time, at different rates.
  doc.dispatch({ op: "makeWave", name: "charge", data: new Float64Array(11), dx: 1 });
  doc.dispatch({ op: "makeWave", name: "current", data: new Float64Array(21), dx: 0.5 });
  doc.dispatch({ op: "makeWave", name: "t", data: Float64Array.from([0, 2, 4, 6, 8, 10]) });
  doc.dispatch({ op: "makeWave", name: "temp", data: new Float64Array(6) });
  doc.dispatch({ op: "display", y: ["charge"], name: "A" });
  doc.dispatch({ op: "display", y: ["current"], name: "B" });
  doc.dispatch({ op: "display", y: ["temp"], x: "t", name: "C" });
  return doc;
}

const range = (doc: Doc, graph: string, axis = "bottom") => {
  const spec = doc.getState().graphs[graph]!.axes[axis]!;
  return [spec.min, spec.max];
};

describe("linked graphs", () => {
  it("zoom together, from the first graph's range, and undo together", () => {
    const doc = setup();
    doc.dispatch({ op: "modifyAxis", graph: "A", axis: "bottom", props: { min: 1, max: 9 } });
    expect(doc.dispatch({ op: "linkGraphs", graphs: ["A", "B", "C"] })).toBe("Link0");
    expect([range(doc, "B"), range(doc, "C")]).toEqual([
      [1, 9],
      [1, 9],
    ]);
    doc.dispatch({ op: "modifyAxis", graph: "B", axis: "bottom", props: { min: 2, max: 4 } });
    expect([range(doc, "A"), range(doc, "C")]).toEqual([
      [2, 4],
      [2, 4],
    ]);
    // Only the bottom axis: the left ones stay their own.
    doc.dispatch({ op: "modifyAxis", graph: "B", axis: "left", props: { min: -1, max: 1 } });
    expect(range(doc, "A", "left")).toEqual([null, null]);
    doc.undo();
    doc.undo();
    expect(range(doc, "A")).toEqual([1, 9]);
  });

  it("link the left axes too with xy", () => {
    const doc = setup();
    doc.dispatch({ op: "linkGraphs", graphs: ["A", "B"], axes: "xy" });
    doc.dispatch({ op: "modifyAxis", graph: "A", axis: "left", props: { min: -1, max: 1 } });
    expect(range(doc, "B", "left")).toEqual([-1, 1]);
  });

  it("set cursors at the same X on each graph, and take them away together", () => {
    const doc = setup();
    doc.dispatch({ op: "linkGraphs", graphs: ["A", "B", "C"] });
    doc.dispatch({ op: "setCursor", graph: "A", cursor: "A", trace: "charge", point: 6 });
    const cursors = () => {
      const { graphs } = doc.getState();
      return ["A", "B", "C"].map((name) => graphs[name]!.cursors.A?.point ?? null);
    };
    // X = 6: point 12 of current (dx 0.5), point 3 of temp against t.
    expect(cursors()).toEqual([6, 12, 3]);
    doc.dispatch({ op: "removeCursor", graph: "C", cursor: "A" });
    expect(cursors()).toEqual([null, null, null]);

    doc.dispatch({ op: "linkGraphs", graphs: ["A", "B"], cursors: false });
    doc.dispatch({ op: "setCursor", graph: "A", cursor: "B", trace: "charge", point: 2 });
    expect(doc.getState().graphs.B!.cursors.B).toBeUndefined();
  });

  it("are unlinked, a graph left alone too, and a new link takes graphs from the old", () => {
    const doc = setup();
    doc.dispatch({ op: "linkGraphs", graphs: ["A", "B", "C"] });
    doc.dispatch({ op: "linkGraphs", graphs: ["B", "C"] });
    // A was left alone in the first group: it is unlinked.
    expect(doc.getState().graphs.A!.link).toBeNull();
    expect(doc.getState().graphs.B!.link).toEqual({ group: "Link1", axes: "x", cursors: true });
    doc.dispatch({ op: "unlinkGraphs", graphs: ["B"] });
    expect(doc.getState().graphs.C!.link).toBeNull();
    expect(() => doc.dispatch({ op: "linkGraphs", graphs: ["A"] })).toThrow(/two graphs or more/);
    expect(() => doc.dispatch({ op: "linkGraphs", graphs: ["A", "B"], axes: "y" })).toThrow(
      /axes must be one of/,
    );
  });

  it("are saved, written as Python, and not in a graph's recreation script", () => {
    const doc = setup();
    doc.dispatch({ op: "linkGraphs", graphs: ["A", "B"], axes: "xy", cursors: false });
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.graphs.A!.link).toEqual({ group: "Link0", axes: "xy", cursors: false });
    expect(echoPython({ op: "linkGraphs", graphs: ["A", "B"], axes: "xy", cursors: false })).toBe(
      'op.link_graphs("A", "B", axes="xy", cursors=False)',
    );
    expect(echoPython({ op: "linkGraphs", graphs: ["A", "B"] })).toBe('op.link_graphs("A", "B")');
    expect(echoPython({ op: "unlinkGraphs", graphs: ["A"] })).toBe('op.unlink_graphs("A")');
    expect(graphScript(doc.getState(), "A")).not.toContain("link");
  });
});

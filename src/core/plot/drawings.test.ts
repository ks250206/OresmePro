import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import { echoPython } from "../doc/echo";
import { graphScript } from "../doc/recreate";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import type { MeasureText, Prim } from "./displayList";
import { pixelToDrawing } from "./drawings";
import { layoutGraph } from "./layout";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

function graph(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: Float64Array.of(0, 10, 0), x0: 0, dx: 1 });
  doc.dispatch({ op: "display", y: ["y"], name: "G" });
  return doc;
}

const drawn = (doc: Doc) => {
  const state = doc.getState();
  return layoutGraph(state.graphs.G!, state.waves, 400, 300, measure);
};

/** Every primitive, at any depth. */
const flat = (prims: readonly Prim[]): Prim[] =>
  prims.flatMap((prim) => (prim.kind === "clip" ? flat(prim.children) : [prim]));

describe("drawings on a graph", () => {
  it("are made, changed, ordered and removed, and each is checked", () => {
    const doc = graph();
    expect(
      doc.dispatch({ op: "addDrawing", graph: "G", kind: "arrow", points: [0.1, 0.1, 0.5, 0.5] }),
    ).toBe("draw0");
    expect(
      doc.dispatch({
        op: "addDrawing",
        graph: "G",
        kind: "rect",
        points: [0, 0, 1, 1],
        props: { fill: "yellow", layer: "back" },
      }),
    ).toBe("draw1");
    const [arrow, rect] = doc.getState().graphs.G!.drawings;
    expect(arrow).toMatchObject({
      kind: "arrow",
      arrow: "end",
      coords: "plot",
      color: "#000000",
      layer: "front",
    });
    expect(rect).toMatchObject({ fill: "#e6c800", fillOpacity: 1, layer: "back" });

    doc.dispatch({
      op: "modifyDrawing",
      graph: "G",
      drawing: "draw0",
      props: { color: "red", lineSize: 2 },
    });
    expect(doc.getState().graphs.G!.drawings[0]).toMatchObject({ color: "#ff0000", lineSize: 2 });
    doc.dispatch({ op: "orderDrawing", graph: "G", drawing: "draw0", place: "back" });
    expect(doc.getState().graphs.G!.drawings.map((item) => item.name)).toEqual(["draw0", "draw1"]);
    doc.dispatch({ op: "orderDrawing", graph: "G", drawing: "draw0", place: "front" });
    expect(doc.getState().graphs.G!.drawings.map((item) => item.name)).toEqual(["draw1", "draw0"]);

    expect(() =>
      doc.dispatch({ op: "addDrawing", graph: "G", kind: "line", points: [0, 0, 1] }),
    ).toThrow("A line has 2 points: 4 numbers, not 3.");
    expect(() =>
      doc.dispatch({ op: "addDrawing", graph: "G", kind: "polygon", points: [0, 0] }),
    ).toThrow(/at least 2 points/);
    expect(() =>
      doc.dispatch({ op: "addDrawing", graph: "G", kind: "star", points: [0, 0] }),
    ).toThrow(/kind/);
    expect(() =>
      doc.dispatch({
        op: "addDrawing",
        graph: "G",
        kind: "line",
        points: [0, 0, 1, 1],
        props: { coords: "axes", hAxis: "left" },
      }),
    ).toThrow("Axis left is vertical; a drawing needs a horizontal one there.");
    expect(() =>
      doc.dispatch({ op: "modifyDrawing", graph: "G", drawing: "draw0", props: { shape: 1 } }),
    ).toThrow(/Unknown drawing property "shape"/);
    doc.dispatch({ op: "removeDrawing", graph: "G", drawing: "draw1" });
    expect(doc.getState().graphs.G!.drawings.map((item) => item.name)).toEqual(["draw0"]);
    doc.undo();
    expect(doc.getState().graphs.G!.drawings).toHaveLength(2);
  });

  it("are drawn in their layer, at their place in the plot area or on the axes", () => {
    const doc = graph();
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "rect",
      points: [0, 0, 0.5, 0.5],
      props: { fill: "#00ff00", layer: "back" },
    });
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "line",
      points: [1, 0, 1, 10],
      props: { coords: "axes", color: "#0000ff", arrow: "end" },
    });
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "text",
      points: [0.5, 0.5],
      props: { text: "Peak", textSize: 20 },
    });
    const layout = drawn(doc);
    const prims = flat(layout.prims);
    const back = prims.findIndex((prim) => prim.kind === "polygon" && prim.fill === "#00ff00");
    const trace = prims.findIndex((prim) => prim.kind === "polyline" && prim.stroke === "#ff0000");
    const line = prims.findIndex((prim) => prim.kind === "polyline" && prim.stroke === "#0000ff");
    expect(back).toBeGreaterThan(-1);
    // Behind the trace, and the line (in front) after it.
    expect(back).toBeLessThan(trace);
    expect(line).toBeGreaterThan(trace);
    // An arrowhead at the end, in the line's color.
    expect(prims.some((prim) => prim.kind === "polygon" && prim.fill === "#0000ff")).toBe(true);
    expect(prims.find((prim) => prim.kind === "text" && prim.text === "Peak")).toMatchObject({
      size: 20,
    });

    const { plot } = layout;
    const [rect, axisLine, text] = layout.drawings;
    expect(rect!.box).toMatchObject({ x: plot.x, y: plot.y, w: plot.w / 2, h: plot.h / 2 });
    // On the axes: x = 1 is the middle point of the trace, y = 10 its top.
    const bottom = layout.axes.bottom!.scale;
    const left = layout.axes.left!.scale;
    expect(axisLine!.points).toEqual([
      bottom.toPixel(1),
      left.toPixel(0),
      bottom.toPixel(1),
      left.toPixel(10),
    ]);
    expect(text!.box.x).toBe(plot.x + plot.w / 2);

    // A pixel back in the drawing's own terms, either way.
    const scaleOf = (axis: string) => layout.axes[axis]?.scale;
    expect(
      pixelToDrawing(
        { coords: "plot", hAxis: "bottom", vAxis: "left" },
        plot.x + plot.w / 4,
        plot.y,
        plot,
        scaleOf,
      ),
    ).toEqual([0.25, 0]);
    const [x, y] = pixelToDrawing(
      { coords: "axes", hAxis: "bottom", vAxis: "left" },
      bottom.toPixel(1.5),
      left.toPixel(5),
      plot,
      scaleOf,
    )!;
    expect(x).toBeCloseTo(1.5);
    expect(y).toBeCloseTo(5);
  });

  it("are written as Python, kept in recreation scripts, saved files and graph templates", () => {
    expect(
      echoPython({
        op: "addDrawing",
        graph: "G",
        kind: "arrow",
        points: [0.1, 0.2, 0.3, 0.4],
        props: { color: "#ff0000", lineSize: 2 },
      }),
    ).toBe('op.graph("G").draw("arrow", [0.1, 0.2, 0.3, 0.4], color="#ff0000", line_size=2)');
    expect(
      echoPython({ op: "modifyDrawing", graph: "G", drawing: "draw0", props: { hAxis: "top" } }),
    ).toBe('op.graph("G").drawing("draw0").set(h_axis="top")');
    expect(echoPython({ op: "orderDrawing", graph: "G", drawing: "draw0", place: "back" })).toBe(
      'op.graph("G").drawing("draw0").to_back()',
    );
    expect(echoPython({ op: "removeDrawing", graph: "G", drawing: "draw0" })).toBe(
      'op.graph("G").drawing("draw0").remove()',
    );

    const doc = graph();
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "oval",
      points: [0.1, 0.1, 0.3, 0.2],
      props: { fill: "#ffee88", fillOpacity: 0.5 },
    });
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "polygon",
      points: [0, 0, 1, 1, 2, 0],
      props: { coords: "axes", closed: false },
    });
    expect(graphScript(doc.getState(), "G")).toContain(
      'g.draw("oval", [0.1, 0.1, 0.3, 0.2], fill="#ffee88", fill_opacity=0.5)',
    );
    expect(graphScript(doc.getState(), "G")).toContain(
      'g.draw("polygon", [0, 0, 1, 1, 2, 0], coords="axes", closed=False)',
    );

    const restored = unzipExperiment(zipExperiment(doc.getState(), [], [])).state;
    expect(restored.graphs.G!.drawings).toEqual(doc.getState().graphs.G!.drawings);

    doc.dispatch({ op: "saveGraphTemplate", name: "T", graph: "G" });
    expect(doc.getState().graphTemplates.T!.drawings).toHaveLength(2);
    doc.dispatch({ op: "makeGraphs", template: "T", samples: [{ y: "y" }], names: ["H"] });
    expect(doc.getState().graphs.H!.drawings.map((item) => item.kind)).toEqual(["oval", "polygon"]);
  });

  it("keep an axis they are on from being removed", () => {
    const doc = graph();
    doc.dispatch({ op: "addAxis", graph: "G", name: "R2", side: "right" });
    doc.dispatch({
      op: "addDrawing",
      graph: "G",
      kind: "line",
      points: [0, 0, 1, 1],
      props: { coords: "axes", vAxis: "R2" },
    });
    expect(() => doc.dispatch({ op: "removeAxis", graph: "G", axis: "R2" })).toThrow(
      /in use by draw0/,
    );
  });
});

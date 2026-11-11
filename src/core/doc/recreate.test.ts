import { describe, expect, it } from "vite-plus/test";
import type { Command } from "./commands";
import { Doc } from "./doc";
import { graphScript, recreationCommands } from "./recreate";

function waves(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "t", data: Float64Array.of(1, 2, 3) });
  doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 4, 9) });
  doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(2, 3, 5) });
  doc.dispatch({ op: "makeWave", name: "err", data: Float64Array.of(0.1, 0.1, 0.2) });
  doc.dispatch({
    op: "makeWave",
    name: "labels",
    data: new Float64Array(0),
    text: ["x", "y", "z"],
  });
  doc.dispatch({ op: "makeWave", name: "m", data: new Float64Array(24), shape: [2, 3, 4] });
  return doc;
}

/** Builds the graph again under another name and checks it is the same. */
function expectSame(doc: Doc, graph: string): Command[] {
  const commands = recreationCommands(doc.getState(), graph, "Copy");
  for (const command of commands) doc.dispatch(command);
  const { graphs } = doc.getState();
  expect({ ...graphs.Copy, name: graph }).toEqual(graphs[graph]);
  return commands;
}

describe("recreating a graph", () => {
  it("needs one command for a plain graph", () => {
    const doc = waves();
    doc.dispatch({ op: "display", y: ["a", "b"], x: "t" });
    expect(expectSame(doc, "Graph0")).toEqual([
      { op: "display", y: ["a", "b"], x: "t", name: "Copy" },
    ]);
    expect(graphScript(doc.getState(), "Graph0")).toBe('g = op.display("a", "b", x="t")');
  });

  it("restores traces, axes, annotations, cursors and the graph's style", () => {
    const doc = waves();
    const g = "Graph0";
    doc.dispatch({ op: "display", y: ["a"], x: "t" });
    doc.dispatch({ op: "addAxis", graph: g, name: "R2", side: "right" });
    doc.dispatch({ op: "addAxis", graph: g, name: "T2", side: "top" });
    doc.dispatch({ op: "appendTraces", graph: g, y: ["b", "a"], vAxis: "R2", hAxis: "T2" });
    doc.dispatch({ op: "appendTraces", graph: g, y: ["b"], x: "labels" });
    doc.dispatch({
      op: "modifyTrace",
      graph: g,
      trace: "a",
      props: { mode: "markers", marker: "square", markerFill: false, yError: "err", xError: 0.5 },
    });
    doc.dispatch({
      op: "modifyTrace",
      graph: g,
      trace: "b#1",
      props: { mode: "bars", color: "#123456" },
    });
    doc.dispatch({
      op: "modifyAxis",
      graph: g,
      axis: "left",
      props: { min: 0.5, max: 20, log: true, label: "Counts", mirror: "ticks", span: [0, 0.6] },
    });
    doc.dispatch({
      op: "modifyAxis",
      graph: g,
      axis: "R2",
      props: { span: [0.65, 1], grid: "all" },
    });
    doc.dispatch({ op: "addAnnotation", graph: g, kind: "legend", anchor: "LB" });
    doc.dispatch({
      op: "addAnnotation",
      graph: g,
      kind: "text",
      text: "A to B",
      frame: false,
    });
    doc.dispatch({ op: "setCursor", graph: g, cursor: "A", trace: "a", point: 2 });
    doc.dispatch({ op: "setCursor", graph: g, cursor: "B", trace: "a#1", point: 0 });
    doc.dispatch({ op: "modifyGraph", graph: g, props: { fontSize: 16, showInfo: true } });
    expectSame(doc, g);

    const script = graphScript(doc.getState(), g);
    expect(script.split("\n")[0]).toBe('g = op.display("a", x="t")');
    expect(script).toContain('g.append("b", "a", axis="R2", haxis="T2")');
    expect(script).toContain('g.cursor("B", "a#1", 0)');
    expect(script).not.toContain("op.graph(");
  });

  it("restores images and contours with their planes", () => {
    const doc = waves();
    doc.dispatch({ op: "display", y: [] });
    doc.dispatch({
      op: "appendImage",
      graph: "Graph0",
      wave: "m",
      props: { layer: 2, colorTable: "viridis", zMin: -1, zMax: 1, reverse: true },
    });
    doc.dispatch({
      op: "appendContour",
      graph: "Graph0",
      wave: "m",
      props: { levels: [0.1, 0.2], labels: true, colorTable: "hot", layer: 1 },
    });
    doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "colorscale" });
    const commands = expectSame(doc, "Graph0");
    expect(commands[0]).toEqual({ op: "display", y: [], name: "Copy" });
    expect(graphScript(doc.getState(), "Graph0")).toContain(
      'g.append_image("m", color_table="viridis", z_min=-1, z_max=1, reverse=True, layer=2)',
    );
  });

  it("follows trace names that differ after traces were removed", () => {
    const doc = waves();
    doc.dispatch({ op: "display", y: ["a", "a", "a"] });
    doc.dispatch({ op: "removeTraces", graph: "Graph0", traces: ["a", "a#1"] });
    doc.dispatch({ op: "modifyTrace", graph: "Graph0", trace: "a#2", props: { lineSize: 3 } });
    doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "A", trace: "a#2", point: 1 });
    const commands = recreationCommands(doc.getState(), "Graph0", "Copy");
    for (const command of commands) doc.dispatch(command);
    const copy = doc.getState().graphs.Copy!;
    expect(copy.traces.map((trace) => [trace.name, trace.lineSize])).toEqual([["a", 3]]);
    expect(copy.cursors.A).toEqual({ trace: "a", point: 1 });
  });
});

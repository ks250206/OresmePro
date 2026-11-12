import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { checkStyle, type Command } from "./commands";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { graphScript } from "./recreate";
import {
  AXIS_LOOK,
  AXIS_SIDES,
  GRAPH_LOOK,
  TRACE_LOOK,
  type DocState,
  type GraphSpec,
  type StyleSpec,
} from "./types";

/** A document with four waves to plot, and a graph A of two of them in a look of its own. */
function setup(): Doc {
  const doc = new Doc();
  for (const [name, values] of [
    ["a", [1, 2, 3]],
    ["b", [3, 1, 2]],
    ["c", [5, 6, 4]],
    ["d", [0, 1, 0]],
    ["e", [2, 2, 2]],
  ] as const) {
    doc.dispatch({ op: "makeWave", name, data: Float64Array.from(values) });
  }
  doc.dispatch({ op: "display", y: ["a", "b"], name: "A" });
  doc.dispatch({ op: "modifyGraph", graph: "A", props: { fontSize: 16, fontFamily: "Times" } });
  doc.dispatch({
    op: "modifyTrace",
    graph: "A",
    trace: "a",
    props: { color: "#123456", lineSize: 2.5, mode: "lines+markers", marker: "square" },
  });
  doc.dispatch({
    op: "modifyTrace",
    graph: "A",
    trace: "b",
    props: { color: "#654321", lineStyle: "dash", markerFill: false },
  });
  doc.dispatch({
    op: "modifyAxis",
    graph: "A",
    axis: "left",
    props: {
      ticks: "inside",
      mirror: "ticks",
      grid: "major",
      minor: true,
      labelSize: 20,
      labelStyle: "italic",
    },
  });
  doc.dispatch({
    op: "modifyAxis",
    graph: "A",
    axis: "bottom",
    props: { ticks: "inside", tickLabelSize: 10 },
  });
  return doc;
}

/** Everything a style can hold of a graph: what two graphs of one look share. */
function look(state: DocState, name: string) {
  const graph = state.graphs[name]!;
  const pick = (source: object, keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, (source as Record<string, unknown>)[key]]));
  return {
    graph: pick(graph, GRAPH_LOOK),
    axes: AXIS_SIDES.map((side) => pick(graph.axes[side]!, AXIS_LOOK)),
    traces: graph.traces.map((trace) => pick(trace, TRACE_LOOK)),
  };
}

/** What a style must leave alone: the data of a graph. */
const data = (graph: GraphSpec) => ({
  traces: graph.traces.map(({ name, y, x, vAxis, hAxis, yError, hidden, fill }) => ({
    name,
    y,
    x,
    vAxis,
    hAxis,
    yError,
    hidden,
    fill,
  })),
  axes: Object.entries(graph.axes).map(([name, axis]) => ({
    name,
    side: axis.side,
    label: axis.label,
    min: axis.min,
    max: axis.max,
    log: axis.log,
    reverse: axis.reverse,
  })),
  annotations: graph.annotations,
});

describe("graph styles", () => {
  it("give a second graph the look of the first, and leave its data alone", () => {
    const doc = setup();
    doc.dispatch({ op: "display", y: ["c", "d"], name: "B" });
    doc.dispatch({
      op: "modifyAxis",
      graph: "B",
      axis: "left",
      props: { min: -1, max: 9, label: "Volts", log: false },
    });
    doc.dispatch({ op: "modifyTrace", graph: "B", trace: "d", props: { yError: 0.5 } });
    doc.dispatch({ op: "addAnnotation", graph: "B", kind: "legend" });
    const before = doc.getState().graphs.B!;

    expect(doc.dispatch({ op: "saveStyle", name: "paper", graph: "A" })).toBe("paper");
    doc.dispatch({ op: "applyStyle", style: "paper", graphs: ["B"] });
    const state = doc.getState();
    expect(look(state, "B")).toEqual(look(state, "A"));
    expect(data(state.graphs.B!)).toEqual(data(before));
    expect(state.graphs.B!.traces[1]!.yError).toBe(0.5);
    expect(state.graphs.B!.style).toBe("paper");
    // Saving a style does not tie the graph it came from to it.
    expect(state.graphs.A!.style).toBeNull();
    // Without size, the window keeps its size.
    expect(state.windows.find((window) => window.name === "B")).toMatchObject({ w: 440, h: 300 });
  });

  it("hold what was captured, in a fixed order", () => {
    const doc = setup();
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "A" });
    const style = doc.getState().styles.paper!;
    expect(Object.keys(style)).toEqual(["graph", "axes", "traces"]);
    expect(style.graph).toEqual({ fontSize: 16, fontFamily: "Times" });
    expect(style.axes?.left).toEqual({
      mirror: "ticks",
      ticks: "inside",
      minor: true,
      grid: "major",
      labelSize: 20,
      labelStyle: "italic",
      tickLabelSize: null,
    });
    expect(style.axes?.bottom).toMatchObject({ labelSize: null, tickLabelSize: 10 });
    expect(style.axes?.other).toBeUndefined();
    expect(style.traces).toEqual([
      {
        mode: "lines+markers",
        color: "#123456",
        lineSize: 2.5,
        lineStyle: "solid",
        marker: "square",
        markerSize: 3,
        markerFill: true,
      },
      {
        mode: "lines",
        color: "#654321",
        lineSize: 1,
        lineStyle: "dash",
        marker: "circle",
        markerSize: 3,
        markerFill: false,
      },
    ]);
    // What was captured can be defined again from data, unchanged.
    expect(checkStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
  });

  it("change only what they hold", () => {
    const doc = setup();
    doc.dispatch({ op: "setStyle", name: "big", style: { graph: { fontSize: 20 } } });
    const before = doc.getState().graphs.A!;
    doc.dispatch({ op: "applyStyle", style: "big", graphs: ["A"] });
    expect(doc.getState().graphs.A).toEqual({ ...before, fontSize: 20, style: "big" });

    doc.dispatch({
      op: "setStyle",
      name: "thick",
      style: { axes: { bottom: { grid: "all" } }, traces: [{ lineSize: 4 }] },
    });
    doc.dispatch({ op: "applyStyle", style: "thick", graphs: ["A"] });
    const after = doc.getState().graphs.A!;
    expect(after.axes.bottom).toEqual({ ...before.axes.bottom, grid: "all" });
    expect(after.axes.left).toEqual(before.axes.left);
    expect(after.traces.map((trace) => [trace.lineSize, trace.color])).toEqual([
      [4, "#123456"],
      [4, "#654321"],
    ]);
  });

  it("give traces the looks of their cycle in turn, starting again at the end", () => {
    const doc = setup();
    doc.dispatch({ op: "display", y: ["a", "b", "c", "d", "e"], name: "Many" });
    doc.dispatch({
      op: "setStyle",
      name: "pair",
      style: { traces: [{ color: "#000000" }, { color: "#ff0000", lineStyle: "dot" }] },
    });
    doc.dispatch({ op: "applyStyle", style: "pair", graphs: ["Many"] });
    const traces = doc.getState().graphs.Many!.traces;
    expect(traces.map((trace) => trace.color)).toEqual([
      "#000000",
      "#ff0000",
      "#000000",
      "#ff0000",
      "#000000",
    ]);
    expect(traces.map((trace) => trace.lineStyle)).toEqual([
      "solid",
      "dot",
      "solid",
      "dot",
      "solid",
    ]);
    // A trace added later takes its place in the cycle of the graph's style.
    doc.dispatch({ op: "appendTraces", graph: "Many", y: ["a"] });
    expect(doc.getState().graphs.Many!.traces.at(-1)).toMatchObject({
      color: "#ff0000",
      lineStyle: "dot",
    });
  });

  it("style an axis that was added like its side, or like 'other' when the style has it", () => {
    const doc = setup();
    doc.dispatch({
      op: "setStyle",
      name: "boxed",
      style: { axes: { left: { mirror: "on", ticks: "inside" } } },
    });
    doc.dispatch({ op: "addAxis", graph: "A", name: "L2", side: "left" });
    doc.dispatch({ op: "applyStyle", style: "boxed", graphs: ["A"] });
    expect(doc.getState().graphs.A!.axes.L2).toMatchObject({ mirror: "on", ticks: "inside" });
    doc.dispatch({ op: "addAxis", graph: "A", name: "L3", side: "left" });
    expect(doc.getState().graphs.A!.axes.L3).toMatchObject({ mirror: "on", ticks: "inside" });

    doc.dispatch({
      op: "setStyle",
      name: "boxed",
      style: { axes: { left: { ticks: "inside" }, other: { ticks: "none" } } },
    });
    doc.dispatch({ op: "applyStyle", style: "boxed", graphs: ["A"] });
    const { axes } = doc.getState().graphs.A!;
    expect([axes.left!.ticks, axes.L2!.ticks, axes.L3!.ticks]).toEqual(["inside", "none", "none"]);
  });

  it("give new graphs the default style, unless told otherwise", () => {
    const doc = setup();
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "A" });
    doc.dispatch({ op: "setDefaultStyle", name: "paper" });
    expect(doc.getState().defaultStyle).toBe("paper");
    doc.dispatch({ op: "display", y: ["c", "d", "e"], name: "New" });
    const state = doc.getState();
    expect(state.graphs.New!.style).toBe("paper");
    expect(look(state, "New").graph).toEqual(look(state, "A").graph);
    expect(state.graphs.New!.traces.map((trace) => trace.color)).toEqual([
      "#123456",
      "#654321",
      "#123456",
    ]);

    doc.dispatch({ op: "display", y: ["c"], name: "Plain", style: null });
    expect(doc.getState().graphs.Plain).toMatchObject({ fontSize: 12, style: null });
    doc.dispatch({ op: "setStyle", name: "big", style: { graph: { fontSize: 30 } } });
    doc.dispatch({ op: "display", y: ["c"], name: "Big", style: "big" });
    expect(doc.getState().graphs.Big).toMatchObject({ fontSize: 30, style: "big" });
    expect(() => doc.dispatch({ op: "display", y: ["c"], style: "none" })).toThrow(
      'No style named "none".',
    );

    doc.dispatch({ op: "setDefaultStyle", name: null });
    doc.dispatch({ op: "display", y: ["c"], name: "Later" });
    expect(doc.getState().graphs.Later).toMatchObject({ fontSize: 12, style: null });
    expect(() => doc.dispatch({ op: "setDefaultStyle", name: "gone" })).toThrow(/No style/);
  });

  it("keep the default and the graphs' styles pointing at them when renamed or removed", () => {
    const doc = setup();
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "A" });
    doc.dispatch({ op: "saveStyle", name: "talk", graph: "A" });
    doc.dispatch({ op: "setDefaultStyle", name: "paper" });
    doc.dispatch({ op: "display", y: ["c"], name: "B" });

    expect(() => doc.dispatch({ op: "renameStyle", name: "paper", newName: "talk" })).toThrow(
      'Style "talk" already exists.',
    );
    expect(() => doc.dispatch({ op: "renameStyle", name: "paper", newName: "2x" })).toThrow(
      /not a valid style name/,
    );
    expect(doc.dispatch({ op: "renameStyle", name: "paper", newName: "journal" })).toBe("journal");
    let state = doc.getState();
    expect(Object.keys(state.styles)).toEqual(["talk", "journal"]);
    expect(state.defaultStyle).toBe("journal");
    expect(state.graphs.B!.style).toBe("journal");

    doc.dispatch({ op: "removeStyle", name: "journal" });
    state = doc.getState();
    expect(Object.keys(state.styles)).toEqual(["talk"]);
    expect(state.defaultStyle).toBeNull();
    // The graph keeps the look it was given.
    expect(state.graphs.B).toMatchObject({ style: null, fontSize: 16 });
    expect(() => doc.dispatch({ op: "removeStyle", name: "journal" })).toThrow(/No style/);

    doc.undo();
    expect(doc.getState()).toMatchObject({ defaultStyle: "journal" });
    expect(doc.getState().graphs.B!.style).toBe("journal");
  });

  it("refuse unknown parts and properties and bad values", () => {
    const cases: [unknown, RegExp][] = [
      ["paper", /A style must be a dict/],
      [{ colour: {} }, /Unknown style property "colour"/],
      [{ graph: { fontSize: 2 } }, /fontSize must be between 4 and 96/],
      [{ graph: { showInfo: true } }, /Unknown graph style property "showInfo"/],
      [{ axes: { left2: {} } }, /Unknown axes property "left2"/],
      [{ axes: { left: { min: 0 } } }, /Unknown axis style property "min"/],
      [{ axes: { left: { ticks: "sideways" } } }, /ticks must be one of/],
      [{ axes: { left: 3 } }, /axes.left must be a dict/],
      [{ traces: { color: "red" } }, /traces must be a list/],
      [{ traces: [{ color: "nope" }] }, /color/],
      [{ traces: [{ lineSize: -1 }] }, /lineSize must be greater than 0/],
      [{ traces: [{ yError: 0.1 }] }, /Unknown trace style property "yError"/],
      [{ size: { width: 400 } }, /size needs both width and height/],
      [{ size: { width: 10, height: 300 } }, /width must be between 160 and 4000/],
      [JSON.parse('{"__proto__": {"graph": {}}}'), /Unknown style property "__proto__"/],
      [{ constructor: {} }, /Unknown style property "constructor"/],
    ];
    for (const [style, message] of cases) expect(() => checkStyle(style)).toThrow(message);

    const doc = setup();
    const before = doc.getState();
    expect(() =>
      doc.dispatch({ op: "setStyle", name: "bad", style: { traces: [{ wave: "a" }] } }),
    ).toThrow(/Unknown trace style property "wave"/);
    expect(() => doc.dispatch({ op: "setStyle", name: "__proto__", style: {} })).toThrow(
      /not a valid style name/,
    );
    expect(() => doc.dispatch({ op: "applyStyle", style: "nothing", graphs: ["A"] })).toThrow(
      /No style named/,
    );
    expect(doc.getState()).toBe(before);

    // Parts that hold nothing are left out; colors are written one way.
    expect(
      checkStyle({
        traces: [{ color: "red", lineSize: 2 }, {}],
        axes: { top: {} },
        graph: {},
      }),
    ).toEqual({ traces: [{ color: "#ff0000", lineSize: 2 }, {}] });
    expect(checkStyle({ traces: [] })).toEqual({});
  });

  it("resize the window to the style's size, and undo an apply to many graphs in one step", () => {
    const doc = setup();
    doc.dispatch({ op: "moveWindow", name: "A", w: 600, h: 424 });
    doc.dispatch({ op: "saveStyle", name: "figure", graph: "A", size: true });
    expect(doc.getState().styles.figure!.size).toEqual({ width: 600, height: 400 });

    doc.dispatch({ op: "display", y: ["c"], name: "B" });
    doc.dispatch({ op: "display", y: ["d"], name: "C" });
    doc.dispatch({ op: "modifyGraph", graph: "C", props: { showInfo: true } });
    const before = doc.getState();
    doc.dispatch({ op: "applyStyle", style: "figure", graphs: ["B", "C", "B"] });
    const windows = () =>
      doc
        .getState()
        .windows.filter((window) => window.name !== "A")
        .map(({ name, w, h }) => [name, w, h]);
    // The graph is drawn at the size, below the title bar and the cursor bar.
    expect(windows()).toEqual([
      ["B", 600, 424],
      ["C", 600, 480],
    ]);
    expect(doc.getState().graphs.C!.fontSize).toBe(16);

    expect(doc.undo()).toBe(true);
    expect(doc.getState().graphs).toEqual(before.graphs);
    expect(windows()).toEqual([
      ["B", 440, 300],
      ["C", 440, 300],
    ]);
    expect(doc.redo()).toBe(true);
    expect(windows()).toEqual([
      ["B", 600, 424],
      ["C", 600, 480],
    ]);

    // A window resized by hand since keeps the size it was given.
    doc.dispatch({ op: "moveWindow", name: "B", w: 500, h: 350 });
    doc.undo();
    expect(windows()).toEqual([
      ["B", 500, 350],
      ["C", 440, 300],
    ]);
  });

  it("are written in the history as the Python that does the same", () => {
    const echo = (command: Command) => echoPython(command);
    expect(echo({ op: "saveStyle", name: "paper", graph: "Graph0" })).toBe(
      'op.graph("Graph0").save_style("paper")',
    );
    expect(echo({ op: "saveStyle", name: "paper", graph: "Graph0", size: true })).toBe(
      'op.graph("Graph0").save_style("paper", size=True)',
    );
    expect(
      echo({
        op: "setStyle",
        name: "paper",
        style: {
          graph: { fontSize: 14 },
          size: { width: 400, height: 300 },
          axes: { left: { ticks: "inside", minor: true } },
          traces: [{ lineSize: 2, markerFill: false }, {}],
        },
      }),
    ).toBe(
      'op.set_style("paper", {"graph": {"font_size": 14}, "size": {"width": 400, "height": 300}, "axes": {"left": {"ticks": "inside", "minor": True}}, "traces": [{"line_size": 2, "marker_fill": False}, {}]})',
    );
    expect(echo({ op: "removeStyle", name: "paper" })).toBe('op.style("paper").remove()');
    expect(echo({ op: "renameStyle", name: "paper", newName: "talk" })).toBe(
      'op.style("paper").rename("talk")',
    );
    expect(echo({ op: "applyStyle", style: "paper", graphs: ["Graph0"] })).toBe(
      'op.graph("Graph0").apply_style("paper")',
    );
    expect(echo({ op: "applyStyle", style: "paper", graphs: ["Graph0", "Graph1"] })).toBe(
      'op.apply_style("paper", graphs=["Graph0", "Graph1"])',
    );
    expect(echo({ op: "setDefaultStyle", name: "paper" })).toBe('op.set_default_style("paper")');
    expect(echo({ op: "setDefaultStyle", name: null })).toBe("op.set_default_style(None)");
    expect(echo({ op: "display", y: ["a"], style: null })).toBe('op.display("a", style=None)');
    expect(echo({ op: "display", y: ["a"], name: "G", style: "paper" })).toBe(
      'op.display("a", name="G", style="paper")',
    );
  });

  it("do not leave their mark on the script that draws a graph again", () => {
    const doc = setup();
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "A" });
    doc.dispatch({ op: "display", y: ["c"], name: "B" });
    expect(graphScript(doc.getState(), "B")).toBe('g = op.display("c")');
    // With a default style, the copy has to start plain to look the same.
    doc.dispatch({ op: "setDefaultStyle", name: "paper" });
    expect(graphScript(doc.getState(), "B")).toBe('g = op.display("c", style=None)');
    const styled = graphScript(doc.getState(), "A").split("\n");
    expect(styled[0]).toBe('g = op.display("a", "b", style=None)');
    expect(styled).toContain('g.set(font_size=16, font_family="Times")');
  });
});

describe("styles in a saved experiment", () => {
  it("are kept, with the default and the style each graph was given", () => {
    const doc = setup();
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "A", size: true });
    doc.dispatch({ op: "setStyle", name: "talk", style: { graph: { fontSize: 24 } } });
    doc.dispatch({ op: "setDefaultStyle", name: "talk" });
    doc.dispatch({ op: "display", y: ["c"], name: "B" });
    const before = doc.getState();
    const restored = unzipExperiment(zipExperiment(before, [])).state;
    expect(restored.styles).toEqual(before.styles);
    expect(Object.getPrototypeOf(restored.styles)).toBeNull();
    expect(restored.defaultStyle).toBe("talk");
    expect(restored.graphs).toEqual(before.graphs);
    expect(restored.graphs.B!.style).toBe("talk");
  });

  it("open from a file of a version without styles, and skip a style that cannot be read", () => {
    const old = {
      version: 2,
      waves: [],
      graphs: { G: { name: "G", traces: [], axes: {}, fontSize: 12, fontFamily: "Arial" } },
      tables: {},
      windows: [{ name: "G", kind: "graph", x: 0, y: 0, w: 440, h: 300 }],
    };
    const state = unzipExperiment(
      zipSync({ "experiment.json": strToU8(JSON.stringify(old)) }),
    ).state;
    expect(Object.keys(state.styles)).toEqual([]);
    expect(state.defaultStyle).toBeNull();
    expect(state.graphs.G!.style).toBeNull();

    const later = {
      ...old,
      graphs: { G: { ...old.graphs.G, style: "future" } },
      styles: {
        good: { graph: { fontSize: 9 } },
        future: { graph: { glow: true } },
      } as Record<string, StyleSpec>,
      defaultStyle: "future",
    };
    const opened = unzipExperiment(
      zipSync({ "experiment.json": strToU8(JSON.stringify(later)) }),
    ).state;
    expect(Object.keys(opened.styles)).toEqual(["good"]);
    expect(opened.defaultStyle).toBeNull();
    expect(opened.graphs.G!.style).toBeNull();
  });
});

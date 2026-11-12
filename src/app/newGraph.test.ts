import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { DATE_UNIT } from "../core/doc/types";
import {
  CALCULATED,
  appendPlan,
  graphNameProblem,
  graphTraces,
  groupTraces,
  inListOrder,
  newGraphPlan,
  nextGraphName,
  pairSelection,
  targetWaves,
  traceColors,
  traceInfo,
  waveDetails,
  type PlannedTrace,
} from "./newGraph";

const values = (...items: number[]) => new Float64Array(items);
const plain = { vAxis: "left", hAxis: "bottom" };

function sample(): Doc {
  const doc = new Doc();
  doc.dispatch({
    op: "makeWave",
    name: "a",
    data: values(1, 2, 3),
    dx: 0.5,
    xUnit: "s",
    unit: "V",
  });
  doc.dispatch({ op: "makeWave", name: "b", data: values(4, 5, 6) });
  doc.dispatch({ op: "makeWave", name: "c", data: values(1, 2) });
  doc.dispatch({ op: "makeWave", name: "t", data: values(10, 30, 20), unit: "ms" });
  doc.dispatch({ op: "makeWave", name: "u", data: values(0, 1, 2) });
  doc.dispatch({ op: "makeWave", name: "short", data: values(0, 1) });
  doc.dispatch({ op: "makeWave", name: "labels", text: ["x", "y", "z"] });
  doc.dispatch({ op: "makeWave", name: "m", data: values(1, 2, 3, 4), shape: [2, 2] });
  return doc;
}

const trace = (y: string, x: string | null = null, vAxis = "left", hAxis = "bottom") => ({
  y,
  x,
  vAxis,
  hAxis,
});

describe("pairing the selection", () => {
  const { waves } = sample().getState();

  it("plots every Y against one X, or against its own scaling", () => {
    expect(pairSelection(waves, ["a", "b"], [CALCULATED], plain)).toEqual({
      traces: [trace("a"), trace("b")],
      problem: null,
      summary: "Each of the 2 Y waves against its own X scaling.",
    });
    // Nothing selected on the right is the same as _calculated_.
    expect(pairSelection(waves, ["a"], [], plain).traces).toEqual([trace("a")]);
    const against = pairSelection(waves, ["a", "b"], ["t"], { vAxis: "right", hAxis: "top" });
    expect(against.traces).toEqual([
      trace("a", "t", "right", "top"),
      trace("b", "t", "right", "top"),
    ]);
    expect(against.summary).toBe("Each of the 2 Y waves against t.");
    expect(pairSelection(waves, ["a"], ["t"], plain).summary).toBe("a against t.");
  });

  it("pairs as many X as Y in order", () => {
    const pairs = pairSelection(waves, ["a", "b"], ["t", CALCULATED], plain);
    expect(pairs.problem).toBeNull();
    expect(pairs.traces).toEqual([trace("a", "t"), trace("b")]);
    expect(pairs.summary).toMatch(/^2 pairs, in list order/);
  });

  it("refuses other counts and pairs of different lengths, and says why", () => {
    expect(pairSelection(waves, ["a", "b", "c"], ["t", "u"], plain)).toMatchObject({
      traces: [],
      problem:
        "2 X waves for 3 Y waves: select one X wave for all of them, or as many X waves as Y waves to pair them in order.",
    });
    expect(pairSelection(waves, ["a"], ["short"], plain).problem).toBe(
      "a has 3 points but short has 2: a Y and an X wave must have as many points.",
    );
    expect(pairSelection(waves, ["a", "b"], ["short"], plain).problem).toMatch(
      /^a has 3 points but short has 2: .* \(and 1 more pair\)$/,
    );
    expect(pairSelection(waves, ["m"], [], plain).problem).toMatch(/not a 1-D numeric wave/);
    expect(pairSelection(waves, ["labels"], [], plain).problem).toMatch(/cannot be plotted/);
  });

  it("takes a text wave as X for categories", () => {
    expect(pairSelection(waves, ["a"], ["labels"], plain).traces).toEqual([trace("a", "labels")]);
  });

  it("says nothing is wrong when nothing is selected", () => {
    expect(pairSelection(waves, [], ["t"], plain)).toMatchObject({ traces: [], problem: null });
  });

  it("puts a selection in list order", () => {
    expect(inListOrder(["t", "a"], ["a", "b", "t"])).toEqual(["a", "t"]);
  });
});

describe("what the dialog shows about traces and waves", () => {
  const doc = sample();
  const { waves } = doc.getState();

  it("describes a trace before it is made", () => {
    expect(traceInfo(waves, trace("a"))).toEqual({
      label: "a",
      points: "3",
      type: "float64",
      xRange: "0 to 1 s",
      unit: "V",
      axes: "left, bottom",
    });
    expect(traceInfo(waves, trace("b", "t", "right", "top"))).toMatchObject({
      label: "b vs t",
      xRange: "10 to 30 ms",
      unit: "",
      axes: "right, top",
    });
    expect(traceInfo(waves, trace("a", "labels")).xRange).toBe("3 categories");
  });

  it("writes dates as dates", () => {
    const dated = new Doc();
    dated.dispatch({
      op: "makeWave",
      name: "when",
      data: values(1),
      x0: 1_767_225_600,
      dx: 86_400,
      xUnit: DATE_UNIT,
    });
    dated.dispatch({ op: "makeWave", name: "y", data: values(1, 2) });
    dated.dispatch({
      op: "setWaveScale",
      name: "y",
      x0: 1_767_225_600,
      dx: 86_400,
      xUnit: DATE_UNIT,
    });
    expect(traceInfo(dated.getState().waves, trace("y")).xRange).toBe("2026-01-01 to 2026-01-02");
  });

  it("sums up a wave in one line", () => {
    doc.dispatch({ op: "setWaveMeta", name: "a", note: "first run\nsecond line" });
    expect(waveDetails(doc.getState().waves.a!)).toBe(
      "a: 3 points · float64 · X 0 to 1 s (step 0.5) · unit V · note: first run",
    );
    expect(waveDetails(waves.labels!)).toBe("labels: 3 points · text");
    expect(waveDetails(waves.m!)).toMatch(/^m: 2×2 points · float64/);
  });

  it("knows the colors the traces will get", () => {
    expect(traceColors(undefined, 0, 3)).toEqual(["#ff0000", "#0000ff", "#009900"]);
    expect(traceColors({ traces: [{ color: "#123456" }, {}] }, 1, 2)).toEqual([
      "#0000ff",
      "#123456",
    ]);
  });
});

describe("the commands and their Python", () => {
  it("groups runs of traces with the same X and axes, in order", () => {
    expect(
      groupTraces([trace("a"), trace("b"), trace("a", "t"), trace("b"), trace("c", null, "right")]),
    ).toEqual([
      { y: ["a", "b"], x: null, vAxis: "left", hAxis: "bottom" },
      { y: ["a"], x: "t", vAxis: "left", hAxis: "bottom" },
      { y: ["b"], x: null, vAxis: "left", hAxis: "bottom" },
      { y: ["c"], x: null, vAxis: "right", hAxis: "bottom" },
    ]);
  });

  it("makes a graph of one group with one display call", () => {
    expect(newGraphPlan([trace("a", "u"), trace("b", "u")], null, "Graph0")).toEqual({
      commands: [{ op: "display", y: ["a", "b"], x: "u" }],
      echo: 'op.display("a", "b", x="u")',
    });
    expect(newGraphPlan([trace("a")], "Mine", "Graph0")).toEqual({
      commands: [{ op: "display", y: ["a"], name: "Mine" }],
      echo: 'op.display("a", name="Mine")',
    });
  });

  it("appends further groups to g, naming the graph only in the commands", () => {
    const traces: PlannedTrace[] = [trace("a", "u"), trace("b"), trace("c", null, "right", "top")];
    const plan = newGraphPlan(traces, null, "Graph3");
    expect(plan.commands).toEqual([
      { op: "display", y: ["a"], x: "u", name: "Graph3" },
      { op: "appendTraces", graph: "Graph3", y: ["b"] },
      { op: "appendTraces", graph: "Graph3", y: ["c"], vAxis: "right", hAxis: "top" },
    ]);
    expect(plan.echo).toBe(
      [
        'g = op.display("a", x="u")',
        'g.append("b")',
        'g.append("c", axis="right", haxis="top")',
      ].join("\n"),
    );
    // Run, they make one graph in one undo step.
    const doc = sample();
    for (const command of plan.commands) doc.dispatch(command, { group: "dialog" });
    const graph = doc.getState().graphs.Graph3!;
    expect(graphTraces(graph)).toEqual(traces);
    expect(graph.traces.map((item) => item.color)).toEqual(traceColors(undefined, 0, 3));
    doc.undo();
    expect(doc.getState().graphs.Graph3).toBeUndefined();
  });

  it("starts with an empty display when the first traces are on other axes", () => {
    const plan = newGraphPlan([trace("a", null, "right")], "G", "Graph0");
    expect(plan.commands).toEqual([
      { op: "display", y: [], name: "G" },
      { op: "appendTraces", graph: "G", y: ["a"], vAxis: "right" },
    ]);
    expect(plan.echo).toBe('g = op.display(name="G")\ng.append("a", axis="right")');
  });

  it("appends to a graph with one call per group", () => {
    expect(appendPlan("Graph0", [trace("a"), trace("b")])).toEqual({
      commands: [{ op: "appendTraces", graph: "Graph0", y: ["a", "b"] }],
      echo: 'op.graph("Graph0").append("a", "b")',
    });
    expect(appendPlan("Graph0", [trace("a", "u"), trace("b", null, "right")]).echo).toBe(
      ['g = op.graph("Graph0")', 'g.append("a", x="u")', 'g.append("b", axis="right")'].join("\n"),
    );
  });
});

describe("names and targets", () => {
  it("checks a typed graph name and finds the next free one", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["a"] });
    const state = doc.getState();
    expect(nextGraphName(state)).toBe("Graph1");
    expect(graphNameProblem(state, "")).toBeNull();
    expect(graphNameProblem(state, "Fresh")).toBeNull();
    expect(graphNameProblem(state, "Graph0")).toBe("A window named Graph0 already exists.");
    expect(graphNameProblem(state, "1st")).toMatch(/not a valid graph name/);
  });

  it("lists the waves of the frontmost graph or table", () => {
    const doc = sample();
    expect(targetWaves(doc.getState())).toBeNull();
    doc.dispatch({ op: "display", y: ["a", "b"], x: "u" });
    expect(targetWaves(doc.getState())).toEqual({ window: "Graph0", waves: ["a", "u", "b"] });
    doc.dispatch({ op: "edit", waves: ["c", "t"] });
    expect(targetWaves(doc.getState())).toEqual({ window: "Table0", waves: ["c", "t"] });
  });
});

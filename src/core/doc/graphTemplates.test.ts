import { describe, expect, it } from "vite-plus/test";
import {
  buildState,
  describeExperiment,
  unzipExperiment,
  zipExperiment,
  type SavedExperiment,
} from "../io/experiment";
import { applyCommand, checkGraphTemplate, type Command } from "./commands";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { fillTemplateText, templateWarnings } from "./graphTemplates";
import { graphScript } from "./recreate";
import { emptyDoc, figureSize, type GraphTemplate } from "./types";

const wave = (name: string, values: number[], unit = "", xUnit = ""): Command => ({
  op: "makeWave",
  name,
  data: Float64Array.from(values),
  unit,
  xUnit,
});

/**
 * Three samples, each a current measured against a voltage, and a graph IV
 * of the first with a legend, a text box naming the sample, a label, a
 * range on the bottom axis and a look of its own.
 */
function setup(): Doc {
  const doc = new Doc();
  for (const sample of ["s1", "s2", "s3"]) {
    const n = sample === "s3" ? 4 : 3;
    doc.dispatch(wave(`${sample}_V`, [...Array(n).keys()], "V"));
    doc.dispatch(
      wave(
        `${sample}_I`,
        [...Array(n).keys()].map((i) => i * i),
        "A",
      ),
    );
  }
  doc.dispatch({ op: "display", y: ["s1_I"], x: "s1_V", name: "IV" });
  doc.dispatch({
    op: "modifyTrace",
    graph: "IV",
    trace: "s1_I",
    props: { color: "#123456", mode: "lines+markers", yOffset: 1 },
  });
  doc.dispatch({ op: "modifyGraph", graph: "IV", props: { fontSize: 15 } });
  doc.dispatch({ op: "modifyAxis", graph: "IV", axis: "bottom", props: { min: -1, max: 3 } });
  doc.dispatch({ op: "modifyAxis", graph: "IV", axis: "left", props: { min: 0, max: 10 } });
  doc.dispatch({
    op: "modifyAxis",
    graph: "IV",
    axis: "left",
    props: { label: "Current of s1_I (\\u)" },
  });
  doc.dispatch({ op: "addAnnotation", graph: "IV", kind: "legend", text: "\\s(s1_I) s1_I" });
  doc.dispatch({ op: "addAnnotation", graph: "IV", kind: "text", text: "Sample s1_I, \\f01s1_V" });
  doc.dispatch({ op: "addAnnotation", graph: "IV", kind: "tag", trace: "s1_I", point: 2 });
  doc.dispatch({ op: "moveWindow", name: "IV", w: 500, h: 400 });
  return doc;
}

function saved(doc: Doc, fixed?: readonly string[]): GraphTemplate {
  doc.dispatch({ op: "saveGraphTemplate", name: "IV", graph: "IV", ...(fixed ? { fixed } : {}) });
  return doc.getState().graphTemplates.IV!;
}

describe("saving a graph as a template", () => {
  it("puts slots where the graph has waves, with their units", () => {
    const template = saved(setup());
    expect(template.slots).toEqual([
      { name: "y", role: "y", unit: "A", xUnit: null, yUnit: null },
      { name: "x", role: "x", unit: "V", xUnit: null, yUnit: null },
    ]);
    expect(template.traces).toHaveLength(1);
    expect(template.traces[0]).toMatchObject({ y: "y", x: "x", yOffset: 1 });
    expect(JSON.stringify(template)).not.toContain("s1_");
  });

  it("makes wave names in text into references, but not codes", () => {
    const template = saved(setup());
    expect(template.annotations.map((item) => item.text)).toEqual([
      "\\s({trace1}) {y.name}",
      "Sample {y.name}, \\f01{x.name}",
      "",
    ]);
    expect(template.annotations[2]).toMatchObject({ kind: "tag", trace: 0, point: 2 });
    expect(template.axes.find((axis) => axis.name === "left")!.label).toBe(
      "Current of {y.name} (\\u)",
    );
  });

  it("keeps the ranges of the axes it is told to, and no others", () => {
    const auto = saved(setup());
    expect(auto.axes.map((axis) => [axis.name, axis.min, axis.max])).toEqual([
      ["left", null, null],
      ["bottom", null, null],
      ["right", null, null],
      ["top", null, null],
    ]);
    const fixed = saved(setup(), ["bottom"]);
    expect(fixed.axes.find((axis) => axis.name === "bottom")).toMatchObject({ min: -1, max: 3 });
    expect(fixed.axes.find((axis) => axis.name === "left")).toMatchObject({ min: null });
    expect(() => saved(setup(), ["nowhere"])).toThrow(/no axis named "nowhere"/);
  });

  it("keeps the look and the size as a style holds them", () => {
    const doc = setup();
    const template = saved(doc);
    expect(template.style.graph?.fontSize).toBe(15);
    expect(template.style.traces?.[0]).toMatchObject({ color: "#123456", mode: "lines+markers" });
    expect(template.style.size).toEqual({ width: 500, height: 376 });
  });

  it("numbers the slots of several traces by trace and shares a wave they share", () => {
    const doc = new Doc();
    for (const name of ["t", "a", "b", "ea"]) doc.dispatch(wave(name, [1, 2, 3]));
    doc.dispatch({ op: "display", y: ["a", "b"], x: "t", name: "G" });
    doc.dispatch({ op: "modifyTrace", graph: "G", trace: "a", props: { yError: "ea" } });
    doc.dispatch({ op: "modifyTrace", graph: "G", trace: "b", props: { xError: 0.5 } });
    doc.dispatch({ op: "saveGraphTemplate", name: "two", graph: "G" });
    const two = doc.getState().graphTemplates.two!;
    expect(two.slots.map((slot) => slot.name)).toEqual(["y1", "x", "yerr", "y2"]);
    expect(two.traces.map((trace) => [trace.y, trace.x, trace.yError, trace.xError])).toEqual([
      ["y1", "x", "yerr", null],
      ["y2", "x", null, 0.5],
    ]);
  });

  it("leaves a name in text alone when two waves of the graph have it", () => {
    const doc = new Doc();
    doc.dispatch(wave("run1:I", [1, 2]));
    doc.dispatch(wave("run2:I", [2, 1]));
    doc.dispatch({ op: "display", y: ["run1:I", "run2:I"], name: "G" });
    doc.dispatch({ op: "addAnnotation", graph: "G", kind: "text", text: "I of both" });
    doc.dispatch({ op: "saveGraphTemplate", name: "T", graph: "G" });
    const template = doc.getState().graphTemplates.T!;
    expect(template.annotations[0]!.text).toBe("I of both");
  });

  it("puts a wave shown as an image and as contours in one slot with its scaling's units", () => {
    const doc = new Doc();
    doc.dispatch({
      op: "makeWave",
      name: "m",
      data: new Float64Array(6),
      shape: [3, 2],
      unit: "K",
      xUnit: "m",
      yUnit: "s",
    });
    doc.dispatch({ op: "display", y: [], name: "G" });
    doc.dispatch({ op: "appendImage", graph: "G", wave: "m", props: { colorTable: "hot" } });
    doc.dispatch({ op: "appendContour", graph: "G", wave: "m" });
    doc.dispatch({ op: "addAnnotation", graph: "G", kind: "colorscale", text: "m" });
    doc.dispatch({ op: "saveGraphTemplate", name: "T", graph: "G" });
    const template = doc.getState().graphTemplates.T!;
    expect(template.slots).toEqual([{ name: "z", role: "z", unit: "K", xUnit: "m", yUnit: "s" }]);
    expect(template.images[0]).toMatchObject({ wave: "z", colorTable: "hot" });
    expect(template.annotations[0]!.text).toBe("{image1}");

    doc.dispatch({
      op: "makeWave",
      name: "n",
      data: new Float64Array(4),
      shape: [2, 2],
      unit: "K",
      xUnit: "m",
      yUnit: "s",
    });
    doc.dispatch({ op: "makeGraphs", template: "T", samples: [{ z: "n" }], names: ["H"] });
    const graph = doc.getState().graphs.H!;
    expect(graph.images.map((image) => [image.wave, image.colorTable])).toEqual([["n", "hot"]]);
    expect(graph.contours.map((contour) => contour.wave)).toEqual(["n"]);
    expect(graph.annotations[0]!.text).toBe("n");
  });
});

describe("making graphs from a template", () => {
  it("makes one graph for each sample, with that sample's names and units", () => {
    const doc = setup();
    saved(doc, ["bottom"]);
    doc.dispatch({ op: "setWaveMeta", name: "s3_I", unit: "mA" });
    const samples = ["s1", "s2", "s3"].map((sample) => ({ y: `${sample}_I`, x: `${sample}_V` }));
    const made = doc.dispatch({ op: "makeGraphs", template: "IV", samples });
    expect(made).toBe("Graph2");
    const state = doc.getState();
    for (const [index, sample] of ["s1", "s2", "s3"].entries()) {
      const graph = state.graphs[`Graph${index}`]!;
      expect(graph.traces.map((trace) => [trace.name, trace.y, trace.x])).toEqual([
        [`${sample}_I`, `${sample}_I`, `${sample}_V`],
      ]);
      expect(graph.annotations.map((item) => item.text)).toEqual([
        `\\s(${sample}_I) ${sample}_I`,
        `Sample ${sample}_I, \\f01${sample}_V`,
        "",
      ]);
      expect(graph.axes.left!.label).toBe(`Current of ${sample}_I (\\u)`);
      expect(graph.axes.bottom).toMatchObject({ min: -1, max: 3 });
      expect(graph.axes.left).toMatchObject({ min: null, max: null });
      expect(graph.traces[0]).toMatchObject({
        color: "#123456",
        mode: "lines+markers",
        yOffset: 1,
      });
      expect(graph.fontSize).toBe(15);
      expect(graph.style).toBeNull();
      const window = state.windows.find((item) => item.name === graph.name)!;
      expect(figureSize(window, graph)).toEqual({ width: 500, height: 376 });
    }
    expect(state.graphs.Graph2!.annotations[2]).toMatchObject({ trace: "s3_I", point: 2 });
    // On a shorter wave the tag holds on to its last point.
    doc.dispatch(wave("short", [1, 2], "A"));
    doc.dispatch({ op: "makeGraphs", template: "IV", samples: [{ y: "short" }], names: ["S"] });
    expect(doc.getState().graphs.S!.annotations[2]).toMatchObject({ trace: "short", point: 1 });
  });

  it("is one step to undo, however many graphs it makes", () => {
    const doc = setup();
    saved(doc);
    const before = doc.getState();
    doc.dispatch({
      op: "makeGraphs",
      template: "IV",
      samples: [
        { y: "s1_I", x: "s1_V" },
        { y: "s2_I", x: "s2_V" },
      ],
    });
    expect(Object.keys(doc.getState().graphs)).toEqual(["IV", "Graph0", "Graph1"]);
    doc.undo();
    expect(doc.getState().graphs).toBe(before.graphs);
  });

  it("makes none when one sample cannot be made, and says which", () => {
    const doc = setup();
    saved(doc);
    const state = doc.getState();
    const make = (samples: unknown[], names?: string[]) => () =>
      applyCommand(state, {
        op: "makeGraphs",
        template: "IV",
        samples: samples as Record<string, string>[],
        ...(names ? { names } : {}),
      });
    expect(make([{ y: "s1_I", x: "s1_V" }, { x: "s2_V" }])).toThrow(
      "Sample 2: No wave for slot y, which is plotted.",
    );
    expect(make([{ y: "s1_I", z: "s1_V" }])).toThrow(
      'The template has no slot "z". Its slots: y, x.',
    );
    expect(make([{ y: "s1_I", x: "s3_V" }])).toThrow("x (s3_V) has 4 points but y (s1_I) has 3.");
    expect(make([{ y: "s1_I", x: "nothing" }])).toThrow('No wave named "nothing" for slot x.');
    expect(make([])).toThrow("Give at least one sample");
    expect(make([{ y: "s1_I" }], ["IV"])).toThrow('A window named "IV" already exists.');
    expect(make([{ y: "s1_I" }, { y: "s2_I" }], ["A"])).toThrow("names must be a list of 2");
    expect(() =>
      applyCommand(state, { op: "makeGraphs", template: "none", samples: [{ y: "s1_I" }] }),
    ).toThrow('No graph template named "none".');
  });

  it("leaves out what an empty slot that is not plotted was for", () => {
    const doc = setup();
    saved(doc);
    doc.dispatch({ op: "makeGraphs", template: "IV", samples: [{ y: "s2_I" }], names: ["G"] });
    const graph = doc.getState().graphs.G!;
    expect(graph.traces[0]).toMatchObject({ y: "s2_I", x: null });
    expect(graph.annotations[1]!.text).toBe("Sample s2_I, \\f01");
  });

  it("warns of units that differ from those the template was made with", () => {
    const doc = setup();
    const template = saved(doc);
    doc.dispatch({ op: "setWaveMeta", name: "s2_I", unit: "mA" });
    const state = doc.getState();
    expect(templateWarnings(state, template, [{ y: "s1_I", x: "s1_V" }])).toEqual([]);
    expect(
      templateWarnings(state, template, [
        { y: "s1_I", x: "s1_V" },
        { y: "s2_I", x: "s2_V" },
      ]),
    ).toEqual(['Sample 2: s2_I in slot y has values in "mA"; the template was made with "A".']);
    doc.dispatch({ op: "setWaveMeta", name: "s2_V", unit: "" });
    expect(templateWarnings(doc.getState(), template, [{ y: "s1_I", x: "s2_V" }])).toEqual([
      's2_V in slot x has values in no unit; the template was made with "V".',
    ]);
  });

  it("compares the X unit of a Y wave that is plotted against its scaling", () => {
    const doc = new Doc();
    doc.dispatch(wave("a", [1, 2], "V", "s"));
    doc.dispatch(wave("b", [1, 2], "V", "ms"));
    doc.dispatch({ op: "display", y: ["a"], name: "G" });
    doc.dispatch({ op: "saveGraphTemplate", name: "T", graph: "G" });
    const template = doc.getState().graphTemplates.T!;
    expect(template.slots[0]).toMatchObject({ unit: "V", xUnit: "s" });
    expect(templateWarnings(doc.getState(), template, [{ y: "b" }])).toEqual([
      'b in slot y has X in "ms"; the template was made with "s".',
    ]);
  });

  it("fills references in text, leaving alone what it does not know", () => {
    const doc = setup();
    const template = saved(doc);
    const state = doc.getState();
    const waves = new Map([["y", state.waves.s2_I!]]);
    expect(
      fillTemplateText(
        "{y.name} in {y.unit}, {x.name}, {q.name}, {y}, {trace1} {trace2}",
        template,
        waves,
        ["t"],
      ),
    ).toBe("s2_I in A, , {q.name}, {y}, t {trace2}");
  });
});

describe("keeping templates", () => {
  it("is not touched by renaming or killing the waves it was made from", () => {
    const doc = setup();
    const template = saved(doc);
    doc.dispatch({ op: "renameWave", name: "s2_I", newName: "other" });
    expect(doc.getState().graphTemplates.IV).toBe(template);
  });

  it("renames and removes templates, and refuses names that are taken", () => {
    const doc = setup();
    const template = saved(doc);
    doc.dispatch({ op: "setGraphTemplate", name: "B", template });
    expect(() => doc.dispatch({ op: "renameGraphTemplate", name: "IV", newName: "B" })).toThrow(
      'Graph template "B" already exists.',
    );
    doc.dispatch({ op: "renameGraphTemplate", name: "IV", newName: "C" });
    expect(Object.keys(doc.getState().graphTemplates)).toEqual(["B", "C"]);
    doc.dispatch({ op: "removeGraphTemplate", name: "B" });
    expect(Object.keys(doc.getState().graphTemplates)).toEqual(["C"]);
    expect(() => doc.dispatch({ op: "removeGraphTemplate", name: "B" })).toThrow(
      'No graph template named "B".',
    );
  });

  it("checks a template given as data, filling in what is left out", () => {
    const template = checkGraphTemplate({
      slots: [{ name: "y", role: "y" }],
      traces: [{ y: "y" }],
      annotations: [{ kind: "text", text: "{y.name}" }],
    });
    expect(template.axes.map((axis) => axis.name)).toEqual(["left", "bottom", "right", "top"]);
    expect(template.traces[0]).toMatchObject({ vAxis: "left", hAxis: "bottom", fill: "none" });
    expect(template.slots[0]).toEqual({ name: "y", role: "y", unit: "", xUnit: null, yUnit: null });
    expect(template.annotations[0]).toMatchObject({ anchor: "RT", frame: true, trace: null });
    // Checking it again changes nothing: it is in its usual form.
    expect(checkGraphTemplate(template)).toEqual(template);
  });

  it("refuses a template that refers to what it does not have", () => {
    const base = { slots: [{ name: "y", role: "y" }] };
    expect(() => checkGraphTemplate({ ...base, traces: [{ y: "q" }] })).toThrow(
      "A trace's y must be one of the template's slots (y), not \"q\".",
    );
    expect(() => checkGraphTemplate({ ...base, traces: [{ y: "y", vAxis: "bottom" }] })).toThrow(
      "Axis bottom is horizontal",
    );
    expect(() => checkGraphTemplate({ slots: [{ name: "name", role: "y" }] })).toThrow(
      "A slot cannot be called name",
    );
    expect(() => checkGraphTemplate({ slots: [{ name: "in", role: "y" }] })).toThrow(
      "A slot cannot be called in",
    );
    expect(() => checkGraphTemplate({ ...base, colour: 1 })).toThrow(
      'Unknown graph template property "colour"',
    );
    expect(() =>
      checkGraphTemplate({ ...base, traces: [{ y: "y" }], annotations: [{ kind: "tag" }] }),
    ).toThrow("A tag needs the trace it points at.");
    expect(() =>
      checkGraphTemplate({
        ...base,
        traces: [{ y: "y" }],
        annotations: [{ kind: "tag", trace: 1 }],
      }),
    ).toThrow("A tag points at trace 1");
  });

  it("is saved with the experiment, and older experiments open without templates", () => {
    const doc = setup();
    const template = saved(doc);
    const restored = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(restored.graphTemplates.IV).toEqual(template);
    expect(Object.getPrototypeOf(restored.graphTemplates)).toBeNull();

    const { graphTemplates: _, ...older } = describeExperiment(emptyDoc(), () => "");
    const opened = buildState(older as SavedExperiment, new Map());
    expect(Object.keys(opened.graphTemplates)).toEqual([]);
    expect(Object.getPrototypeOf(opened.graphTemplates)).toBeNull();
  });

  it("leaves the recreation script and styles as they were", () => {
    const doc = setup();
    const script = graphScript(doc.getState(), "IV");
    saved(doc);
    expect(graphScript(doc.getState(), "IV")).toBe(script);
    expect(doc.getState().styles).toEqual({});
  });
});

describe("echoes", () => {
  it("writes the Python that does the same", () => {
    expect(echoPython({ op: "saveGraphTemplate", name: "IV", graph: "Graph0" })).toBe(
      'op.graph("Graph0").save_template("IV")',
    );
    expect(
      echoPython({ op: "saveGraphTemplate", name: "IV", graph: "Graph0", fixed: ["bottom"] }),
    ).toBe('op.graph("Graph0").save_template("IV", fixed=["bottom"])');
    expect(echoPython({ op: "removeGraphTemplate", name: "IV" })).toBe(
      'op.graph_template("IV").remove()',
    );
    expect(echoPython({ op: "renameGraphTemplate", name: "IV", newName: "B" })).toBe(
      'op.graph_template("IV").rename("B")',
    );
    expect(
      echoPython({
        op: "setGraphTemplate",
        name: "T",
        template: { slots: [{ name: "y", role: "y", xUnit: null }] },
      }),
    ).toBe('op.set_graph_template("T", {"slots": [{"name": "y", "role": "y", "x_unit": None}]})');
  });

  it("writes a wave for each slot, or a list with one for each graph", () => {
    const make = (samples: Record<string, string | null>[], names?: string[]) =>
      echoPython({ op: "makeGraphs", template: "IV", samples, ...(names ? { names } : {}) });
    expect(make([{ y: "s1_I", x: "s1_V" }])).toBe(
      'op.graph_template("IV").make(y="s1_I", x="s1_V")',
    );
    expect(make([{ y: "s1_I", x: null }])).toBe('op.graph_template("IV").make(y="s1_I")');
    expect(
      make([
        { y: "s1_I", x: "V" },
        { y: "s2_I", x: "V" },
      ]),
    ).toBe('op.graph_template("IV").make(y=["s1_I", "s2_I"], x="V")');
    expect(
      make([
        { y: "a", x: "V" },
        { y: "a", x: "V" },
      ]),
    ).toBe('op.graph_template("IV").make(y=["a", "a"], x=["V", "V"])');
    expect(make([{ y: "a" }, { y: "a" }], ["G1", "G2"])).toBe(
      'op.graph_template("IV").make(y="a", name=["G1", "G2"])',
    );
  });
});

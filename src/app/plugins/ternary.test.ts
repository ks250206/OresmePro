import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../../core/doc/doc";
import type { Prim } from "../../core/plot/displayList";
import { layoutGraph } from "../../core/plot/layout";
import { makePluginGraph, planOutcome } from "../../core/plugins/outcome";
import { checkResult } from "../../core/sandbox/validate";
import sdk from "../../sandbox/python/oresme_plugin.py?raw";
import { contributionCommands } from "./contributions";
import { sandboxWave } from "./host";
import { readLocalPackage } from "./sources";

/**
 * The example plugin in examples/plugins/ternary, run as the sandbox runs
 * it (its SDK in Pyodide), and what it returns taken in as the app takes a
 * run's outcome: checked, made into waves, and into the graph it asks for.
 */

const FILES = import.meta.glob<string>(
  ["../../../examples/plugins/ternary/**/*.{py,json,md}", "!**/__pycache__/**"],
  { query: "?raw", import: "default", eager: true },
);
const PREFIX = "../../../examples/plugins/";
const encode = (text: string) => new TextEncoder().encode(text);
const measure = (text: string, size: number) => text.length * size * 0.55;
const HEIGHT = Math.sqrt(3) / 2;

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide({
    packageCacheDir: "public/pyodide",
    lockFileURL: "public/pyodide/pyodide-lock.json",
  });
  await pyodide.loadPackage(["numpy"], { messageCallback: () => {} });
  const copies: [string, string][] = [
    ...Object.entries(FILES).map(([path, text]): [string, string] => [
      `/sandbox/plugins/${path.slice(PREFIX.length)}`,
      text,
    ]),
    ["/sandbox/sdk/oresme_plugin.py", sdk],
  ];
  for (const [path, text] of copies) {
    pyodide.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    pyodide.FS.writeFile(path, encode(text));
  }
  pyodide.runPython(
    "import sys; sys.dont_write_bytecode = True; sys.path.insert(0, '/sandbox/sdk')",
  );
  const runtime = pyodide.pyimport("oresme_plugin");
  runtime._load("/sandbox/plugins/ternary", "ternary", JSON.stringify(["ternary"]));
}, 300_000);

/** Runs the action as sandboxWorker.js does, and returns its message to the app. */
function runAction(doc: Doc, params: Record<string, unknown> = {}): Record<string, unknown> {
  const state = doc.getState();
  // The waves go in as inputs, by role: A, B, C, and the group if there is one.
  const { group, ...rest } = params;
  const named: Record<string, string> = { a: "a", b: "b", c: "c" };
  if (typeof group === "string") named.group = group;
  const inputs = Object.fromEntries(
    Object.entries(named).map(([role, name]) => [role, sandboxWave(state.waves[name]!)]),
  );
  const runtime = pyodide.pyimport("oresme_plugin");
  const outcome = runtime._run("ternary", inputs, JSON.stringify(rest));
  const result = outcome.toJs({ dict_converter: Object.fromEntries }) as {
    waves: Record<string, { dtype: string; data?: Uint8Array | ArrayBuffer; text?: unknown }>;
    values: string;
    graph: string;
  };
  outcome.destroy();
  for (const wave of Object.values(result.waves)) {
    if (wave.dtype === "text") {
      wave.text = JSON.parse(wave.text as string);
      continue;
    }
    wave.data = (wave.data as Uint8Array).slice().buffer;
  }
  return {
    waves: result.waves,
    values: JSON.parse(result.values),
    graph: JSON.parse(result.graph),
    log: "",
  };
}

const source = {
  action: "plugin.ternary.ternary",
  plugin: "ternary",
  version: "0.1.0",
  origin: "folder",
  commit: null,
  digest: "0".repeat(64),
};

function compositions(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(50, 100, 0, 1) });
  doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(25, 0, 0, 1) });
  doc.dispatch({ op: "makeWave", name: "c", data: Float64Array.of(25, 0, 100, 1) });
  return doc;
}

/** Runs it and takes in what came back, as the plugin host does; returns the graph's name. */
function make(doc: Doc, params: Record<string, unknown> = {}): string {
  const outcome = checkResult(runAction(doc, params));
  const plan = planOutcome(
    doc.getState(),
    {
      name: "ternary",
      title: "Ternary Diagram",
      description: "",
      params: {
        a: { type: "wave" },
        b: { type: "wave" },
        c: { type: "wave" },
        group: { type: "wave", optional: true, text: true },
      },
    } as never,
    { a: "a", b: "b", c: "c", ...params } as never,
    outcome,
    source,
    0,
  );
  for (const command of plan.commands) doc.dispatch(command);
  return makePluginGraph(doc, plan.graph!, plan.waves, "ternary");
}

function texts(prims: readonly Prim[]): Extract<Prim, { kind: "text" }>[] {
  return prims.flatMap((prim) =>
    prim.kind === "text" ? [prim] : prim.kind === "clip" ? texts(prim.children) : [],
  );
}

describe("the example plugin ternary", () => {
  it("is a package the app installs", async () => {
    const picked = Object.entries(FILES).map(([path, text]) => ({
      path: path.slice(PREFIX.length),
      bytes: () => Promise.resolve(encode(text)),
    }));
    const pkg = await readLocalPackage(picked);
    expect(pkg.manifest.name).toBe("ternary");
    expect(pkg.manifest.actions.map((action) => action.name)).toEqual(["ternary"]);
    expect([...pkg.files.keys()].sort()).toEqual(pkg.manifest.files.map((f) => f.path).sort());

    // Its panel goes into an experiment, with a field for every argument of the action.
    const doc = new Doc();
    const [path] = pkg.manifest.contributes.panels;
    for (const command of contributionCommands("panels", path!, pkg.files.get(path!)!)) {
      doc.dispatch(command);
    }
    const panel = doc.getState().panels.TernaryDiagram!;
    const button = panel.controls.find((control) => control.kind === "button")!;
    expect(button).toMatchObject({ label: "Draw", action: "plugin.ternary.ternary" });
    const params = Object.keys(pkg.manifest.actions[0]!.params).sort();
    expect(Object.keys((button as { args: object }).args).sort()).toEqual(params);
    const names = panel.controls.map((control) => control.name);
    for (const param of params) expect(names).toContain(param);
  });

  it("makes a ternary diagram of traces, with equal sides and no axes drawn", () => {
    const doc = compositions();
    const name = make(doc, { names: "SiO2, Al2O3, CaO", legend: "Samples" });
    expect(name).toBe("Ternary0");
    const state = doc.getState();
    const graph = state.graphs[name]!;
    // Grid, frame, three sides of labels, tick marks, corner names, points.
    expect(graph.traces.map((trace) => [trace.y, trace.mode, trace.textMarker])).toEqual([
      ["a_grid_y", "lines", null],
      ["a_frame_y", "lines", null],
      ["a_a_y", "markers", "a_a_label"],
      ["a_b_y", "markers", "a_b_label"],
      ["a_c_y", "markers", "a_c_label"],
      ["a_tick_y", "lines", null],
      ["a_corner_y", "markers", "a_corner_text"],
      ["a_y", "markers", null],
    ]);
    expect(state.waves.a_corner_text!.text).toEqual(["SiO2", "Al2O3", "CaO"]);
    // (50, 25, 25) is halfway up, in the middle; (1, 1, 1) at the centre; A and C at their corners.
    const x = [...state.waves.a_x!.data];
    const y = [...state.waves.a_y!.data];
    expect(x[0]).toBeCloseTo(0.5);
    expect(y[0]).toBeCloseTo(HEIGHT / 2);
    expect([x[1], y[1]]).toEqual([0.5, expect.closeTo(HEIGHT)]);
    expect([x[2], y[2]]).toEqual([0, 0]);
    expect(x[3]).toBeCloseTo(0.5);
    expect(y[3]).toBeCloseTo(HEIGHT / 3);
    expect(graph.annotations.map((item) => [item.kind, item.anchor, item.text])).toEqual([
      ["legend", "RT", "\\s(a_y) Samples"],
    ]);
    expect(graph.axes.left).toMatchObject({ line: false, ticks: "none", labels: "off" });

    const layout = layoutGraph(graph, state.waves, 600, 600, measure);
    expect(layout.missing).toEqual([]);
    const bottom = layout.axes.bottom!.scale;
    const left = layout.axes.left!.scale;
    const at = (px: number, py: number) => [bottom.toPixel(px), left.toPixel(py)] as const;
    const [cx, cy] = at(0, 0);
    const [bx, by] = at(1, 0);
    const [ax, ay] = at(0.5, HEIGHT);
    const length = (x0: number, y0: number, x1: number, y1: number) => Math.hypot(x1 - x0, y1 - y0);
    expect(length(cx, cy, bx, by) / length(cx, cy, ax, ay)).toBeCloseTo(1, 2);
    expect(length(bx, by, ax, ay) / length(cx, cy, ax, ay)).toBeCloseTo(1, 2);
    const shown = texts(layout.prims).map((prim) => prim.text);
    for (const word of ["SiO2", "Al2O3", "CaO", "0", "50", "100", "Samples"]) {
      expect(shown).toContain(word);
    }
    // Only the frame and the tick marks are drawn as lines in black or gray: no axis lines.
    expect(
      layout.prims.filter((prim) => prim.kind === "segments" && prim.stroke === "#000000"),
    ).toEqual([]);
  });

  it("writes the values on the other sides counterclockwise, and leaves out what is not asked for", () => {
    const doc = compositions();
    const name = make(doc, { ticks: "counterclockwise", grid: false });
    const state = doc.getState();
    const traces = state.graphs[name]!.traces;
    expect(traces.map((trace) => trace.y)).not.toContain("a_grid_y");
    // A's values go up the right side now: 0 at B, at the right.
    expect(state.waves.a_a_x!.data[0]).toBeGreaterThan(1);
    expect(traces.find((trace) => trace.y === "a_a_y")!.textAnchor).toBe("LC");

    const plain = compositions();
    const bare = make(plain, { ticks: "none", legend: "" });
    const kept = plain.getState().graphs[bare]!;
    expect(kept.traces.map((trace) => trace.y)).toEqual([
      "a_grid_y",
      "a_frame_y",
      "a_corner_y",
      "a_y",
    ]);
    expect(kept.annotations).toEqual([]);
  });

  it("draws the points with the marker, color, size and fill asked for", () => {
    const doc = compositions();
    const made = make(doc);
    const plain = doc.getState().graphs[made]!;
    expect(plain.traces.find((trace) => trace.y === "a_y")).toMatchObject({
      marker: "square",
      markerSize: 4,
      markerFill: true,
      color: "#4a90d9",
    });

    const styled = compositions();
    const name = make(styled, {
      marker: "triangle",
      marker_color: "red",
      marker_size: 7,
      marker_fill: false,
    });
    const points = styled.getState().graphs[name]!.traces.find((trace) => trace.y === "a_y")!;
    expect(points).toMatchObject({
      marker: "triangle",
      markerSize: 7,
      markerFill: false,
      color: "#ff0000",
    });
    // Only the points change: the frame keeps its gray.
    const frame = styled.getState().graphs[name]!.traces.find((trace) => trace.y === "a_frame_y")!;
    expect(frame.color).toBe("#808080");
  });

  it("refuses a marker it does not know, and a color the app does not", () => {
    expect(() => make(compositions(), { marker: "star" })).toThrow(/marker is one of/);
    expect(() => make(compositions(), { marker_size: 0 })).toThrow(/more than 0/);
    expect(() => make(compositions(), { marker_color: "not a color" })).toThrow(/color/i);
  });

  it("draws each group named in a text wave with a marker and a color of its own", () => {
    const doc = compositions();
    doc.dispatch({
      op: "makeWave",
      name: "phase",
      text: ["Li6PS5Cl", "Li3PS4", "Li6PS5Cl", ""],
    });
    const name = make(doc, {
      group: "phase",
      group_markers: "circle, square",
      group_colors: "red, blue",
      marker_size: 6,
    });
    const state = doc.getState();
    const graph = state.graphs[name]!;
    const points = graph.traces.filter((trace) => /^a_g\d_y$/.test(trace.y));
    expect(points.map((trace) => [trace.y, trace.marker, trace.color, trace.markerSize])).toEqual([
      ["a_g0_y", "circle", "#ff0000", 6],
      ["a_g1_y", "square", "#0000ff", 6],
    ]);
    // Points 0 and 2 are Li6PS5Cl, point 1 Li3PS4; point 3 is in no group, and left out.
    expect([...state.waves.a_g0_x!.data]).toEqual([expect.closeTo(0.5), expect.closeTo(0)]);
    expect([...state.waves.a_g1_y!.data]).toEqual([expect.closeTo(HEIGHT)]);
    expect(graph.traces.map((trace) => trace.y)).not.toContain("a_y");
    expect(graph.annotations.map((item) => item.text)).toEqual([
      "\\s(a_g0_y) Li6PS5Cl\n\\s(a_g1_y) Li3PS4",
    ]);
    const layout = layoutGraph(graph, state.waves, 600, 600, measure);
    const shown = texts(layout.prims).map((prim) => prim.text);
    expect(shown).toContain("Li6PS5Cl");
    expect(shown).toContain("Li3PS4");
  });

  it("takes numbers as groups too, and gives groups not listed markers and colors in turn", () => {
    const doc = compositions();
    doc.dispatch({ op: "makeWave", name: "kind", data: Float64Array.of(2, 1, 2, NaN) });
    const name = make(doc, { group: "kind", group_colors: "green" });
    const graph = doc.getState().graphs[name]!;
    const points = graph.traces.filter((trace) => /^a_g\d_y$/.test(trace.y));
    expect(points.map((trace) => [trace.marker, trace.color])).toEqual([
      ["circle", "#009900"],
      ["square", "#1f77b4"],
    ]);
    expect(graph.annotations.map((item) => item.text)).toEqual(["\\s(a_g0_y) 2\n\\s(a_g1_y) 1"]);
  });

  it("refuses a group of another length, and a group marker it does not know", () => {
    const doc = compositions();
    doc.dispatch({ op: "makeWave", name: "short", text: ["x", "y"] });
    doc.dispatch({ op: "makeWave", name: "phase", text: ["x", "y", "x", "y"] });
    expect(() => make(doc, { group: "short" })).toThrow(/needs as many/);
    expect(() => make(doc, { group: "phase", group_markers: "circle, star" })).toThrow(
      /not 'star'/,
    );
  });

  it("refuses names that are not three", () => {
    expect(() => make(compositions(), { names: "A, B" })).toThrow(/three names/);
  });
});

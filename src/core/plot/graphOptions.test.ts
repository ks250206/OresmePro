import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import { echoPython } from "../doc/echo";
import { graphScript } from "../doc/recreate";
import {
  figureSize,
  INFO_BAR_HEIGHT,
  TITLE_BAR_HEIGHT,
  type DocState,
  type GraphSpec,
} from "../doc/types";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import type { MeasureText, Prim } from "./displayList";
import { layoutGraph } from "./layout";
import { SCREEN_UNITS_PER_POINT } from "./plotSize";
import { fittedWindowSize } from "./windowFit";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

function graphDoc(): Doc {
  const doc = new Doc();
  const data = new Float64Array(50).map((_, index) => Math.sin(index / 5) * 1000);
  doc.dispatch({ op: "makeWave", name: "signal", data, dx: 0.1, xUnit: "s", unit: "V" });
  doc.dispatch({ op: "display", y: ["signal"], name: "G" });
  return doc;
}

const graphOf = (doc: Doc): GraphSpec => doc.getState().graphs.G!;
const windowOf = (doc: Doc) => doc.getState().windows.find((item) => item.name === "G")!;
const modify = (doc: Doc, props: Record<string, unknown>) =>
  doc.dispatch({ op: "modifyGraph", graph: "G", props });
const modifyAxis = (doc: Doc, axis: string, props: Record<string, unknown>) =>
  doc.dispatch({ op: "modifyAxis", graph: "G", axis, props });
const layoutOf = (state: DocState, width = 500, height = 400) =>
  layoutGraph(state.graphs.G!, state.waves, width, height, measure);

const texts = (prims: readonly Prim[]): string[] =>
  prims.flatMap((prim) =>
    prim.kind === "text" ? [prim.text] : prim.kind === "clip" ? texts(prim.children) : [],
  );

/** A saved file of the graph without the properties named. */
function savedWithout(state: DocState, keys: readonly string[]): DocState {
  const graph = Object.fromEntries(
    Object.entries(state.graphs.G!).filter(([key]) => !keys.includes(key)),
  ) as unknown as GraphSpec;
  const axes = Object.fromEntries(
    Object.entries(graph.axes).map(([name, axis]) => [
      name,
      Object.fromEntries(Object.entries(axis).filter(([key]) => !keys.includes(key))),
    ]),
  ) as GraphSpec["axes"];
  return unzipExperiment(
    zipExperiment({ ...state, graphs: { ...state.graphs, G: { ...graph, axes } } }, []),
  ).state;
}

describe("which labels an axis shows", () => {
  it("is on in a new axis, and set and checked by modifyAxis", () => {
    const doc = graphDoc();
    expect(graphOf(doc).axes.left!.labels).toBe("on");
    modifyAxis(doc, "left", { labels: "axis only" });
    expect(graphOf(doc).axes.left!.labels).toBe("axis only");
    expect(() => modifyAxis(doc, "left", { labels: "none" })).toThrow(/labels must be one of/);
  });

  it("draws the axis label without tick labels for axis only, and neither for off", () => {
    const doc = graphDoc();
    const on = layoutOf(doc.getState());
    expect(texts(on.prims)).toContain("V");
    expect(texts(on.prims)).toContain("s");
    const tickLabels = (prims: readonly Prim[]) =>
      texts(prims).filter((text) => /^[-−]?\d/.test(text));
    const before = tickLabels(on.prims).length;
    expect(before).toBeGreaterThan(4);

    modifyAxis(doc, "left", { labels: "axis only" });
    const axisOnly = layoutOf(doc.getState());
    expect(texts(axisOnly.prims)).toContain("V");
    // Only the bottom axis writes numbers now.
    expect(tickLabels(axisOnly.prims).length).toBeLessThan(before);
    expect(axisOnly.plot.x).toBeLessThan(on.plot.x);

    modifyAxis(doc, "left", { labels: "off" });
    const off = layoutOf(doc.getState());
    expect(texts(off.prims)).not.toContain("V");
    expect(off.plot.x).toBeLessThan(axisOnly.plot.x);
    // The axis line and its ticks are still drawn.
    const segments = (prims: readonly Prim[]) => prims.filter((p) => p.kind === "segments").length;
    expect(segments(off.prims)).toBe(segments(on.prims));

    modifyAxis(doc, "bottom", { labels: "off" });
    const bare = layoutOf(doc.getState());
    expect(tickLabels(bare.prims)).toEqual([]);
    expect(texts(bare.prims)).not.toContain("s");
  });

  it("leaves a mirror axis without tick labels too", () => {
    const doc = graphDoc();
    modifyAxis(doc, "left", { mirror: "labels" });
    const both = layoutOf(doc.getState());
    modifyAxis(doc, "left", { labels: "axis only" });
    const none = layoutOf(doc.getState());
    expect(none.width - none.plot.x - none.plot.w).toBeLessThan(
      both.width - both.plot.x - both.plot.w,
    );
  });

  it("is written as Python, kept by styles, saved, and on in files from before", () => {
    expect(
      echoPython({ op: "modifyAxis", graph: "G", axis: "left", props: { labels: "axis only" } }),
    ).toBe('op.graph("G").axis("left").set(labels="axis only")');
    const doc = graphDoc();
    modifyAxis(doc, "left", { labels: "off" });
    expect(graphScript(doc.getState(), "G")).toContain('labels="off"');

    doc.dispatch({ op: "saveStyle", name: "bare", graph: "G" });
    expect(doc.getState().styles.bare!.axes?.left?.labels).toBe("off");
    doc.dispatch({ op: "display", y: ["signal"], name: "H" });
    doc.dispatch({ op: "applyStyle", style: "bare", graphs: ["H"] });
    expect(doc.getState().graphs.H!.axes.left!.labels).toBe("off");

    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.graphs.G!.axes.left!.labels).toBe("off");
    expect(savedWithout(doc.getState(), ["labels"]).graphs.G!.axes.left!.labels).toBe("on");
  });
});

describe("graph margins", () => {
  it("are auto in a new graph, and set and checked by modifyGraph", () => {
    const doc = graphDoc();
    const graph = graphOf(doc);
    expect([graph.marginLeft, graph.marginBottom, graph.marginRight, graph.marginTop]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    modify(doc, { marginLeft: 72, marginTop: 0 });
    expect([graphOf(doc).marginLeft, graphOf(doc).marginTop]).toEqual([72, 0]);
    expect(() => modify(doc, { marginLeft: -1 })).toThrow(/between 0 and 360 points/);
    expect(() => modify(doc, { marginRight: 1000 })).toThrow(/between 0 and 360 points/);
    expect(() => modify(doc, { marginRight: "auto" })).toThrow(
      /marginRight must be between 0 and 360 points, or None for auto/,
    );
    modify(doc, { marginLeft: null });
    expect(graphOf(doc).marginLeft).toBeNull();
  });

  it("hold a side at the points given, and leave the others automatic", () => {
    const doc = graphDoc();
    const auto = layoutOf(doc.getState());
    modify(doc, { marginLeft: 72, marginRight: 36 });
    const fixed = layoutOf(doc.getState());
    expect(fixed.plot.x).toBe(Math.round(72 * SCREEN_UNITS_PER_POINT));
    expect(fixed.width - fixed.plot.x - fixed.plot.w).toBe(Math.round(36 * SCREEN_UNITS_PER_POINT));
    expect(fixed.plot.y).toBe(auto.plot.y);
    expect(fixed.height - fixed.plot.y - fixed.plot.h).toBe(
      auto.height - auto.plot.y - auto.plot.h,
    );

    // A margin of nothing puts the plot area at the edge, labels or not.
    modify(doc, { marginLeft: 0, marginBottom: 0, marginRight: 0, marginTop: 0 });
    const edge = layoutOf(doc.getState());
    expect(edge.plot).toEqual({ x: 0, y: 0, w: 500, h: 400 });
  });

  it("are points on paper in a page layout too", () => {
    const doc = graphDoc();
    modify(doc, { marginLeft: 50 });
    const state = doc.getState();
    const page = layoutGraph(state.graphs.G!, state.waves, 300, 200, measure, { unitsPerPoint: 1 });
    expect(page.plot.x).toBe(50);
  });

  it("frame a fixed plot area, whose figure and window fit them", () => {
    const doc = graphDoc();
    modify(doc, {
      width: { mode: "absolute", value: 200, unit: "pt" },
      marginLeft: 30,
      marginRight: 10,
    });
    const layout = layoutOf(doc.getState());
    const units = (points: number) => Math.round(points * SCREEN_UNITS_PER_POINT);
    expect(layout.width).toBe(units(30) + units(200) + units(10));
    expect(fittedWindowSize(doc.getState(), windowOf(doc), measure)?.w).toBe(layout.width);
  });

  it("are written as Python, kept by styles, saved, and auto in files from before", () => {
    expect(
      echoPython({ op: "modifyGraph", graph: "G", props: { marginLeft: 72, marginTop: null } }),
    ).toBe('op.graph("G").set(margin_left=72, margin_top=None)');
    const doc = graphDoc();
    modify(doc, { marginLeft: 72, marginBottom: 40 });
    expect(graphScript(doc.getState(), "G")).toContain("margin_left=72, margin_bottom=40");

    doc.dispatch({ op: "saveStyle", name: "framed", graph: "G" });
    expect(doc.getState().styles.framed!.graph).toMatchObject({ marginLeft: 72, marginTop: null });
    doc.dispatch({ op: "display", y: ["signal"], name: "H" });
    doc.dispatch({ op: "applyStyle", style: "framed", graphs: ["H"] });
    expect(doc.getState().graphs.H!.marginBottom).toBe(40);

    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.graphs.G!.marginLeft).toBe(72);
    const before = savedWithout(doc.getState(), ["marginLeft", "marginBottom"]).graphs.G!;
    expect([before.marginLeft, before.marginBottom]).toEqual([null, null]);
  });
});

describe("graph magnification", () => {
  it("is none in a new graph, and set and checked by modifyGraph", () => {
    const doc = graphDoc();
    expect(graphOf(doc).magnification).toBe(1);
    modify(doc, { magnification: 0.125 });
    modify(doc, { magnification: 8 });
    expect(() => modify(doc, { magnification: 0.1 })).toThrow(/between 0.125 and 8/);
    expect(() => modify(doc, { magnification: 10 })).toThrow(/between 0.125 and 8/);
    expect(() => modify(doc, { magnification: 0 })).toThrow(/greater than 0/);
  });

  it("grows the window by as much and keeps the figure's size, and undo gives it back", () => {
    const doc = graphDoc();
    const window = windowOf(doc);
    const figure = figureSize(window, graphOf(doc));
    modify(doc, { magnification: 2 });
    expect(windowOf(doc).w).toBe(window.w * 2);
    expect(windowOf(doc).h).toBe((window.h - TITLE_BAR_HEIGHT) * 2 + TITLE_BAR_HEIGHT);
    expect(figureSize(windowOf(doc), graphOf(doc))).toEqual(figure);

    // The cursor bar is not magnified.
    modify(doc, { showInfo: true });
    expect(windowOf(doc).h).toBe(
      (window.h - TITLE_BAR_HEIGHT) * 2 + TITLE_BAR_HEIGHT + INFO_BAR_HEIGHT,
    );
    modify(doc, { magnification: 1, showInfo: false });
    expect([windowOf(doc).w, windowOf(doc).h]).toEqual([window.w, window.h]);

    modify(doc, { magnification: 0.5 });
    doc.undo();
    expect([windowOf(doc).w, windowOf(doc).h]).toEqual([window.w, window.h]);
  });

  it("fits the window of a fixed plot area to the figure magnified", () => {
    const doc = graphDoc();
    modify(doc, {
      width: { mode: "absolute", value: 200, unit: "pt" },
      height: { mode: "absolute", value: 150, unit: "pt" },
      magnification: 1.5,
    });
    const available = figureSize(windowOf(doc), graphOf(doc));
    const state = doc.getState();
    const figure = layoutGraph(
      state.graphs.G!,
      state.waves,
      available.width,
      available.height,
      measure,
    );
    expect(fittedWindowSize(state, windowOf(doc), measure)).toEqual({
      w: Math.round(figure.width * 1.5),
      h: Math.round(figure.height * 1.5) + TITLE_BAR_HEIGHT,
    });
  });

  it("is written as Python, not kept by styles, saved, and none in files from before", () => {
    expect(echoPython({ op: "modifyGraph", graph: "G", props: { magnification: 1.5 } })).toBe(
      'op.graph("G").set(magnification=1.5)',
    );
    const doc = graphDoc();
    modify(doc, { magnification: 2 });
    expect(graphScript(doc.getState(), "G")).toContain("magnification=2");
    doc.dispatch({ op: "saveStyle", name: "look", graph: "G", size: true });
    const style = doc.getState().styles.look!;
    expect(style.graph).not.toHaveProperty("magnification");
    // The style keeps the figure's own size, not the window's.
    expect(style.size).toEqual(figureSize(windowOf(doc), graphOf(doc)));

    // A magnified graph given a style with a size gets a window that shows it so.
    doc.dispatch({ op: "display", y: ["signal"], name: "H" });
    doc.dispatch({ op: "modifyGraph", graph: "H", props: { magnification: 2 } });
    doc.dispatch({ op: "applyStyle", style: "look", graphs: ["H"] });
    const h = doc.getState().windows.find((item) => item.name === "H")!;
    expect(figureSize(h, doc.getState().graphs.H)).toEqual(style.size);
    expect(h.w).toBe(style.size!.width * 2);

    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.graphs.G!.magnification).toBe(2);
    expect(savedWithout(doc.getState(), ["magnification"]).graphs.G!.magnification).toBe(1);
  });
});

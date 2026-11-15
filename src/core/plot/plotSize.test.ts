import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import { echoPython } from "../doc/echo";
import { graphScript } from "../doc/recreate";
import { INFO_BAR_HEIGHT, TITLE_BAR_HEIGHT, type DocState, type PlotDimension } from "../doc/types";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import type { MeasureText } from "./displayList";
import { layoutGraph } from "./layout";
import { layoutPage } from "./page";
import {
  MAX_PLOT_SIZE,
  MIN_PLOT_SIZE,
  plotAreaSize,
  SCREEN_UNITS_PER_POINT,
  type AxisExtent,
  type PlotSizeInput,
} from "./plotSize";
import { fittedWindowSize, windowFitCommands } from "./windowFit";

const measure: MeasureText = (text, size) => text.length * size * 0.55;
const AUTO: PlotDimension = { mode: "auto" };
const cm = (value: number): PlotDimension => ({ mode: "absolute", value, unit: "cm" });
/** Layout units in a centimetre on screen. */
const UNITS_PER_CM = (SCREEN_UNITS_PER_POINT * 72) / 2.54;

const extents: Record<string, AxisExtent> = {
  bottom: { units: 10, span: 1 },
  left: { units: 5, span: 1 },
  half: { units: 4, span: 0.5 },
};

const size = (width: PlotDimension, height: PlotDimension, extra: Partial<PlotSizeInput> = {}) =>
  plotAreaSize({
    width,
    height,
    available: { width: 500, height: 400 },
    margins: { left: 50, right: 10, top: 12, bottom: 40 },
    axis: (name) => extents[name] ?? null,
    unitsPerPoint: SCREEN_UNITS_PER_POINT,
    ...extra,
  });

describe("plot area size", () => {
  it("fills what the window leaves when both sides are auto", () => {
    expect(size(AUTO, AUTO)).toEqual({
      plotWidth: 440,
      plotHeight: 348,
      width: 500,
      height: 400,
      fixedWidth: false,
      fixedHeight: false,
    });
    // At least 16 units, as before.
    expect(size(AUTO, AUTO, { available: { width: 30, height: 30 } }).plotWidth).toBe(16);
  });

  it("gives an absolute side its length, and the figure the margins around it", () => {
    const result = size(cm(8), { mode: "absolute", value: 3, unit: "inch" });
    expect(result.plotWidth).toBe(Math.round(8 * UNITS_PER_CM));
    expect(result.plotWidth).toBe(302);
    expect(result.plotHeight).toBe(288);
    expect(result.width).toBe(50 + 302 + 10);
    expect(result.height).toBe(12 + 288 + 40);
    expect([result.fixedWidth, result.fixedHeight]).toEqual([true, true]);
    expect(size({ mode: "absolute", value: 72, unit: "pt" }, AUTO).plotWidth).toBe(96);
  });

  it("sizes an aspect side from the other, whichever it is", () => {
    // A width of 1.5 heights, the height following the window.
    const wide = size({ mode: "aspect", factor: 1.5 }, AUTO);
    expect(wide.plotHeight).toBe(348);
    expect(wide.plotWidth).toBe(522);
    expect([wide.fixedWidth, wide.fixedHeight]).toEqual([true, false]);
    expect(wide.height).toBe(400);
    const square = size(cm(5), { mode: "aspect", factor: 1 });
    expect(square.plotHeight).toBe(square.plotWidth);
  });

  it("makes the units of a plan the lengths asked for", () => {
    // Height 200: one unit of left is 40 long, so one of bottom is 40 and the width 400.
    const plan = size(
      { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
      {
        mode: "absolute",
        value: 150,
        unit: "pt",
      },
    );
    expect(plan.plotHeight).toBe(200);
    expect(plan.plotWidth).toBe(400);
    // The height's plan is the other way round: a unit of left is 2 units of bottom.
    const tall = size(
      { mode: "absolute", value: 150, unit: "pt" },
      { mode: "plan", factor: 2, hAxis: "bottom", vAxis: "left" },
    );
    expect(tall.plotWidth).toBe(200);
    expect(tall.plotHeight).toBe(2 * (200 / 10) * 5);
    // An axis over half the side needs a side twice as long for its units.
    const spanned = size(
      { mode: "absolute", value: 150, unit: "pt" },
      { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "half" },
    );
    expect(spanned.plotHeight).toBe(((20 * 4) / 0.5) | 0);
  });

  it("gives per unit a length for each unit of its axis", () => {
    const result = size({ mode: "perUnit", value: 1, unit: "cm", axis: "bottom" }, AUTO);
    expect(result.plotWidth).toBe(Math.round(10 * UNITS_PER_CM));
    expect(result.fixedWidth).toBe(true);
  });

  it("holds sizes beyond the limits at the limits", () => {
    const huge = size({ mode: "perUnit", value: 10, unit: "inch", axis: "bottom" }, AUTO);
    expect(huge.plotWidth).toBe(MAX_PLOT_SIZE);
    const tiny = size({ mode: "aspect", factor: 0.01 }, AUTO);
    expect(tiny.plotWidth).toBe(MIN_PLOT_SIZE);
  });

  it("takes the width as auto when both sides depend on each other, or an axis is missing", () => {
    const both = size({ mode: "aspect", factor: 2 }, { mode: "aspect", factor: 2 });
    expect(both.fixedWidth).toBe(false);
    expect(both.plotHeight).toBe(880);
    const missing = size({ mode: "perUnit", value: 1, unit: "cm", axis: "nothing" }, AUTO);
    expect(missing).toMatchObject({ plotWidth: 440, fixedWidth: false, width: 500 });
  });

  it("works in points on a page", () => {
    expect(size(cm(2.54), AUTO, { unitsPerPoint: 1 }).plotWidth).toBe(72);
  });
});

function graphDoc(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "re", data: new Float64Array([0, 10, 20, 30, 40]) });
  doc.dispatch({ op: "makeWave", name: "im", data: new Float64Array([0, 5, 8, 9, 10]) });
  doc.dispatch({ op: "display", y: ["im"], x: "re", name: "G" });
  return doc;
}

const modify = (doc: Doc, props: Record<string, unknown>) =>
  doc.dispatch({ op: "modifyGraph", graph: "G", props });

const layoutOf = (state: DocState, width = 500, height = 400) =>
  layoutGraph(state.graphs.G!, state.waves, width, height, measure);

describe("graphs with a fixed plot area", () => {
  it("lay out an auto graph as before, at the size given", () => {
    const layout = layoutOf(graphDoc().getState());
    expect([layout.width, layout.height]).toEqual([500, 400]);
  });

  it("draw the plot area at exactly 8 cm by 6 cm, the figure fitted around it", () => {
    const doc = graphDoc();
    modify(doc, { width: cm(8), height: cm(6) });
    for (const [width, height] of [
      [500, 400],
      [200, 900],
    ]) {
      const layout = layoutOf(doc.getState(), width, height);
      expect(layout.plot.w).toBe(302);
      expect(layout.plot.h).toBe(227);
      expect(layout.width).toBeGreaterThan(layout.plot.x + 302);
      expect(layout.height).toBeGreaterThan(layout.plot.y + 227);
      // The axes run the whole plot area.
      const bottom = layout.axes.bottom!.scale;
      expect(Math.abs(bottom.p1 - bottom.p0)).toBe(302);
    }
    const one = layoutOf(doc.getState(), 500, 400);
    const other = layoutOf(doc.getState(), 200, 900);
    expect([one.width, one.height]).toEqual([other.width, other.height]);
  });

  it("make aspect 1 square and plan 1 scale both axes alike", () => {
    const doc = graphDoc();
    modify(doc, { width: cm(8), height: { mode: "aspect", factor: 1 } });
    const square = layoutOf(doc.getState());
    expect(square.plot.h).toBe(square.plot.w);

    modify(doc, {
      width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
      height: cm(6),
    });
    const plan = layoutOf(doc.getState());
    const unit = (name: string) => {
      const scale = plan.axes[name]!.scale;
      return Math.abs(scale.toPixel(1) - scale.toPixel(0));
    };
    expect(Math.abs(unit("bottom") - unit("left"))).toBeLessThan(0.1);
  });

  it("follow the axis range with per unit", () => {
    const doc = graphDoc();
    modify(doc, { width: { mode: "perUnit", value: 0.25, unit: "cm", axis: "bottom" } });
    const before = layoutOf(doc.getState()).plot.w;
    expect(before).toBe(Math.round(40 * 0.25 * UNITS_PER_CM));
    doc.dispatch({ op: "modifyAxis", graph: "G", axis: "bottom", props: { min: 0, max: 20 } });
    expect(layoutOf(doc.getState()).plot.w).toBe(Math.round(before / 2));
  });

  it("have their true size on paper in a page layout", () => {
    const doc = graphDoc();
    modify(doc, { width: cm(2.54), height: cm(2.54) });
    doc.dispatch({ op: "newLayout", name: "P" });
    doc.dispatch({
      op: "addLayoutItem",
      layout: "P",
      kind: "graph",
      graph: "G",
      x: 40,
      y: 40,
      w: 300,
      h: 300,
    });
    const layout = layoutGraph(doc.getState().graphs.G!, doc.getState().waves, 300, 300, measure, {
      unitsPerPoint: 1,
    });
    expect([layout.plot.w, layout.plot.h]).toEqual([72, 72]);
    // The page draws the graph at that size, from the top left of its box.
    const page = layoutPage(doc.getState().pages.P!, doc.getState(), measure);
    const clip = page.prims.find((prim) => prim.kind === "clip");
    expect(clip?.kind === "clip" && clip.children[0]).toMatchObject({
      kind: "rect",
      x: 40,
      y: 40,
      w: layout.width,
      h: layout.height,
    });
    expect(layout.width).toBeLessThan(300);
  });

  it("lay out only the size when asked", () => {
    const doc = graphDoc();
    modify(doc, { width: cm(8) });
    const full = layoutOf(doc.getState());
    const sized = layoutGraph(doc.getState().graphs.G!, doc.getState().waves, 500, 400, measure, {
      sizeOnly: true,
    });
    expect(sized.prims).toEqual([]);
    expect([sized.width, sized.height, sized.plot]).toEqual([full.width, full.height, full.plot]);
  });
});

describe("plot size in the document", () => {
  it("is auto in a new graph, and set and checked by modifyGraph", () => {
    const doc = graphDoc();
    expect(doc.getState().graphs.G!.width).toEqual(AUTO);
    modify(doc, { width: cm(8), height: { mode: "aspect", factor: 0.75 } });
    expect(doc.getState().graphs.G!.height).toEqual({ mode: "aspect", factor: 0.75 });
    const refused = (props: Record<string, unknown>, message: RegExp) =>
      expect(() => modify(doc, props)).toThrow(message);
    refused({ width: { mode: "aspect", factor: 2 } }, /cannot both/);
    modify(doc, { height: cm(6) });
    refused({ width: { mode: "plan", factor: 1, hAxis: "x", vAxis: "left" } }, /no axis named "x"/);
    refused(
      { width: { mode: "plan", factor: 1, hAxis: "left", vAxis: "bottom" } },
      /horizontal axis; left is vertical/,
    );
    refused(
      { height: { mode: "perUnit", value: 1, unit: "cm", axis: "bottom" } },
      /vertical axis; bottom is horizontal/,
    );
    refused({ width: cm(0) }, /greater than 0/);
    refused({ width: cm(-3) }, /greater than 0/);
    refused({ width: cm(200) }, /between 12 and 3000 points/);
    refused({ width: { mode: "aspect", factor: 0 } }, /greater than 0/);
    refused({ width: { mode: "aspect", factor: 1000 } }, /between 0.01 and 100/);
    refused({ width: { mode: "huge" } }, /mode must be one of/);
    refused({ width: { mode: "absolute", value: 3, unit: "mm" } }, /unit must be one of/);
    refused({ width: { mode: "aspect", factor: 1, value: 2 } }, /has no property "value"/);
    refused({ width: "8cm" }, /must be a dict/);
  });

  it("keeps an axis that sizes the plot area from being removed", () => {
    const doc = graphDoc();
    doc.dispatch({ op: "addAxis", graph: "G", name: "volts", side: "right" });
    modify(doc, { height: { mode: "perUnit", value: 1, unit: "cm", axis: "volts" } });
    expect(() => doc.dispatch({ op: "removeAxis", graph: "G", axis: "volts" })).toThrow(
      /sizes the height of the plot area/,
    );
    modify(doc, { height: AUTO });
    doc.dispatch({ op: "removeAxis", graph: "G", axis: "volts" });
  });

  it("is written as Python, and recreated by the graph's script", () => {
    const set = (props: Record<string, unknown>) =>
      echoPython({ op: "modifyGraph", graph: "G", props });
    expect(set({ width: cm(8), height: { mode: "aspect", factor: 0.75 } })).toBe(
      'op.graph("G").set(width=op.cm(8), height=("aspect", 0.75))',
    );
    expect(
      set({
        width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
        height: { mode: "perUnit", value: 2, unit: "inch", axis: "left" },
      }),
    ).toBe(
      'op.graph("G").set(width=("plan", 1, "bottom", "left"), height=("per_unit", 2, "inch", "left"))',
    );
    expect(set({ width: AUTO, height: { mode: "absolute", value: 200, unit: "pt" } })).toBe(
      'op.graph("G").set(width="auto", height=op.pt(200))',
    );
    const doc = graphDoc();
    modify(doc, {
      width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
      height: cm(6),
    });
    expect(graphScript(doc.getState(), "G")).toContain(
      'g.set(width=("plan", 1, "bottom", "left"), height=op.cm(6))',
    );
  });

  it("is saved and read back, and auto in files from before", () => {
    const doc = graphDoc();
    modify(doc, {
      width: cm(8),
      height: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
    });
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.graphs.G!.width).toEqual(cm(8));
    expect(back.graphs.G!.height).toEqual({
      mode: "plan",
      factor: 1,
      hAxis: "bottom",
      vAxis: "left",
    });

    const old = graphDoc().getState();
    const { width: _w, height: _h, ...before } = old.graphs.G!;
    const saved = unzipExperiment(
      zipExperiment({ ...old, graphs: { ...old.graphs, G: before as typeof old.graphs.G } }, []),
    ).state;
    expect([saved.graphs.G!.width, saved.graphs.G!.height]).toEqual([AUTO, AUTO]);

    const broken = unzipExperiment(
      zipExperiment(
        {
          ...old,
          graphs: {
            ...old.graphs,
            G: { ...old.graphs.G!, width: { mode: "perUnit", value: 1, unit: "cm", axis: "gone" } },
          },
        },
        [],
      ),
    ).state;
    expect(broken.graphs.G!.width).toEqual(AUTO);
  });
});

describe("plot size in styles and graph templates", () => {
  it("is kept by a style with its size where it is look, and given by it", () => {
    const doc = graphDoc();
    modify(doc, { width: cm(8), height: { mode: "aspect", factor: 0.5 } });
    doc.dispatch({ op: "saveStyle", name: "paper", graph: "G", size: true });
    expect(doc.getState().styles.paper!.plot).toEqual({
      width: cm(8),
      height: { mode: "aspect", factor: 0.5 },
    });
    doc.dispatch({ op: "saveStyle", name: "plain", graph: "G" });
    expect(doc.getState().styles.plain!.plot).toBeUndefined();

    // A plan is data: the style keeps the size it gave instead.
    modify(doc, {
      width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
      height: cm(5),
    });
    doc.dispatch({ op: "saveStyle", name: "nyquist", graph: "G", size: true });
    expect(doc.getState().styles.nyquist!.plot).toEqual({ height: cm(5) });

    doc.dispatch({ op: "applyStyle", style: "paper", graphs: ["G"] });
    expect(doc.getState().graphs.G!.width).toEqual(cm(8));
    expect(doc.getState().graphs.G!.height).toEqual({ mode: "aspect", factor: 0.5 });

    expect(() =>
      doc.dispatch({
        op: "setStyle",
        name: "bad",
        style: { plot: { width: { mode: "perUnit", value: 1, unit: "cm", axis: "bottom" } } },
      }),
    ).toThrow(/auto, absolute or aspect only/);
  });

  it("lets a style's aspect give way where the graph's other side is a plan", () => {
    const doc = graphDoc();
    doc.dispatch({
      op: "setStyle",
      name: "half",
      style: { plot: { height: { mode: "aspect", factor: 0.5 } } },
    });
    modify(doc, { width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" } });
    doc.dispatch({ op: "applyStyle", style: "half", graphs: ["G"] });
    expect(doc.getState().graphs.G!.width).toEqual(AUTO);
    expect(doc.getState().graphs.G!.height).toEqual({ mode: "aspect", factor: 0.5 });
  });

  it("is kept whole by a graph template, plans and all", () => {
    const doc = graphDoc();
    modify(doc, {
      width: { mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" },
      height: cm(6),
    });
    doc.dispatch({ op: "saveGraphTemplate", name: "Nyquist", graph: "G" });
    const template = doc.getState().graphTemplates.Nyquist!;
    expect(template.plot?.width).toEqual({
      mode: "plan",
      factor: 1,
      hAxis: "bottom",
      vAxis: "left",
    });
    expect(template.style.plot).toBeUndefined();
    doc.dispatch({
      op: "makeGraphs",
      template: "Nyquist",
      samples: [{ y: "im", x: "re" }],
      names: ["H"],
    });
    expect(doc.getState().graphs.H!.width).toEqual(template.plot!.width);
    expect(doc.getState().graphs.H!.height).toEqual(cm(6));

    expect(() =>
      doc.dispatch({
        op: "setGraphTemplate",
        name: "Bad",
        template: { plot: { width: { mode: "perUnit", value: 1, unit: "cm", axis: "x2" } } },
      }),
    ).toThrow(/no axis named "x2"/);
  });
});

describe("fitting windows to fixed plot areas", () => {
  it("sizes a fixed side of the window to the figure, with its title and cursor bars", () => {
    const doc = graphDoc();
    const window = () => doc.getState().windows.find((item) => item.name === "G")!;
    expect(fittedWindowSize(doc.getState(), window(), measure)).toBeNull();
    modify(doc, { height: cm(6), showInfo: true });
    const fit = fittedWindowSize(doc.getState(), window(), measure)!;
    expect(fit.w).toBe(window().w);
    const layout = layoutGraph(
      doc.getState().graphs.G!,
      doc.getState().waves,
      window().w,
      window().h - TITLE_BAR_HEIGHT - INFO_BAR_HEIGHT,
      measure,
    );
    expect(fit.h).toBe(TITLE_BAR_HEIGHT + layout.height + INFO_BAR_HEIGHT);
    expect(layout.plot.h).toBe(227);
    for (const command of windowFitCommands(doc.getState(), measure)) doc.dispatch(command);
    expect(window().h).toBe(fit.h);
    expect(windowFitCommands(doc.getState(), measure)).toEqual([]);
  });
});

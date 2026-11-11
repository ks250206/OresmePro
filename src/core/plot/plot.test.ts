import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import type { Wave } from "../doc/types";
import { tracePixels, visibleRange, xExtentOf } from "./decimate";
import type { MeasureText, Prim } from "./displayList";
import { axisRange, layoutGraph } from "./layout";
import { parseRichText } from "./richText";
import { makeScale } from "./scale";
import { toSvg } from "./svg";
import { axisLabelText, formatNumber, linearTicks, logTicks, niceStep } from "./ticks";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

const makeWave = (data: number[], extra: Partial<Wave> = {}): Wave => ({
  name: "w",
  data: new Float64Array(data),
  text: null,
  shape: [data.length],
  x0: 0,
  dx: 1,
  xUnit: "",
  y0: 0,
  dy: 1,
  yUnit: "",
  unit: "",
  note: "",
  rev: 1,
  ...extra,
});

const labels = (ticks: { major: { label: string }[] }) => ticks.major.map((tick) => tick.label);

describe("linear ticks", () => {
  it("uses 1-2-5 steps", () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(1, 5)).toBe(0.2);
    expect(niceStep(7, 3)).toBe(5);
  });

  it("stays inside the range and keeps decimals consistent", () => {
    const ticks = linearTicks(-0.3, 1.2, 5, false);
    expect(labels(ticks)).toEqual(["0.0", "0.5", "1.0"]);
    expect(ticks.exponent).toBe(0);
  });

  it("uses a real minus sign and never prints -0", () => {
    expect(labels(linearTicks(-1, 1, 4, false))).toEqual(["−1.0", "−0.5", "0.0", "0.5", "1.0"]);
  });

  it("factors a power of 1000 out of large and small values", () => {
    const large = linearTicks(0, 250000, 5, false);
    expect(large.exponent).toBe(3);
    expect(labels(large)).toEqual(["0", "50", "100", "150", "200", "250"]);
    const small = linearTicks(0, 0.004, 4, false);
    expect(small.exponent).toBe(-3);
    expect(labels(small)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("places minor ticks between majors", () => {
    const ticks = linearTicks(0, 2, 2, true);
    expect(ticks.major.map((tick) => tick.value)).toEqual([0, 1, 2]);
    expect(ticks.minor).toHaveLength(8);
    expect(ticks.minor[0]).toBeCloseTo(0.2);
  });

  it("handles reversed and empty ranges", () => {
    expect(labels(linearTicks(10, 0, 5, false))).toEqual(["0", "2", "4", "6", "8", "10"]);
    expect(linearTicks(1, 1, 5, false).major).toEqual([]);
  });
});

describe("log ticks", () => {
  it("labels decades and marks 2-9 as minor", () => {
    const ticks = logTicks(1, 1000, 6);
    expect(labels(ticks)).toEqual(["10^{0}", "10^{1}", "10^{2}", "10^{3}"]);
    expect(ticks.minor).toContain(20);
    expect(ticks.minor).toHaveLength(24);
  });

  it("falls back to plain ticks within one decade", () => {
    expect(labels(logTicks(2, 8, 4))).toEqual(["2", "4", "6", "8"]);
  });
});

describe("axis labels", () => {
  it("prefixes units, or shows the factor when there is no unit", () => {
    expect(axisLabelText(null, -3, "V")).toBe("mV");
    expect(axisLabelText(null, 3, "")).toBe("×10^{3}");
    expect(axisLabelText(null, 0, "s")).toBe("s");
    expect(axisLabelText("Current", -6, "A")).toBe("Current (µA)");
    expect(axisLabelText("Current (A)", 0, "A")).toBe("Current (A)");
    expect(axisLabelText(null, 3, "%")).toBe("×10^{3} %");
  });
});

describe("formatNumber", () => {
  it("is compact", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1234567)).toBe("1.23457e6");
    expect(formatNumber(0.00001234)).toBe("1.234e-5");
    expect(formatNumber(Number.NaN)).toBe("NaN");
  });
});

describe("rich text", () => {
  it("parses superscripts and subscripts", () => {
    expect(parseRichText("cm^{-1} V_{out}")).toEqual([
      { text: "cm", shift: 0 },
      { text: "-1", shift: 1 },
      { text: " V", shift: 0 },
      { text: "out", shift: -1 },
    ]);
    expect(parseRichText("a^b")).toEqual([{ text: "a^b", shift: 0 }]);
  });
});

describe("decimation", () => {
  it("finds the visible index range from X scaling", () => {
    const wave = makeWave(
      Array.from({ length: 100 }, (_, index) => index),
      { x0: 10, dx: 0.5 },
    );
    expect(visibleRange(wave, null, 20, 30)).toEqual({ first: 19, last: 41, ordered: true });
  });

  it("uses binary search on a monotonic X wave and gives up on an unordered one", () => {
    const y = makeWave([0, 0, 0, 0, 0]);
    expect(visibleRange(y, makeWave([0, 1, 2, 3, 4]), 1.5, 2.5)).toMatchObject({
      first: 1,
      last: 4,
    });
    expect(visibleRange(y, makeWave([0, 3, 1, 4, 2]), 1.5, 2.5)).toMatchObject({ ordered: false });
  });

  it("preserves each pixel column's extremes", () => {
    const count = 100_000;
    const data = Array.from({ length: count }, (_, index) => Math.sin(index / 50));
    data[40_000] = 25;
    data[70_000] = -25;
    const wave = makeWave(data);
    const xs = makeScale(0, count - 1, false, 0, 200);
    const ys = makeScale(-25, 25, false, 100, 0);
    const { runs, decimated } = tracePixels(wave, null, xs, ys);
    expect(decimated).toBe(true);
    expect(runs).toHaveLength(1);
    const points = runs[0]!;
    expect(points.length / 2).toBeLessThanOrEqual(4 * 202);
    let top = Infinity;
    let bottom = -Infinity;
    for (let index = 1; index < points.length; index += 2) {
      top = Math.min(top, points[index]!);
      bottom = Math.max(bottom, points[index]!);
    }
    expect(top).toBe(0);
    expect(bottom).toBe(100);
  });

  it("breaks the line at NaN", () => {
    const { runs } = tracePixels(
      makeWave([1, 2, Number.NaN, 4, 5]),
      null,
      makeScale(0, 4, false, 0, 100),
      makeScale(0, 5, false, 100, 0),
    );
    expect(runs.map((run) => run.length / 2)).toEqual([2, 2]);
  });

  it("computes the X extent from scaling, including the smallest positive X", () => {
    expect(xExtentOf(makeWave([0, 0, 0, 0], { x0: -1, dx: 1 }), null)).toEqual({
      min: -1,
      max: 2,
      minPositive: 1,
    });
  });
});

describe("axisRange", () => {
  const axis = {
    side: "left",
    span: [0, 1],
    label: null,
    min: null,
    max: null,
    log: false,
    mirror: "off",
    ticks: "outside",
    minor: false,
    grid: "off",
  } as const;
  it("autoscales to the data exactly", () => {
    expect(axisRange(axis, { min: -2, max: 7, minPositive: 1 })).toEqual([-2, 7]);
  });
  it("pads a flat range and survives missing data", () => {
    expect(axisRange(axis, { min: 4, max: 4, minPositive: 4 })).toEqual([3.8, 4.2]);
    expect(axisRange(axis, { min: Infinity, max: -Infinity, minPositive: Infinity })).toEqual([
      0, 1,
    ]);
  });
  it("uses the smallest positive value on a log axis", () => {
    expect(axisRange({ ...axis, log: true }, { min: -5, max: 100, minPositive: 0.1 })).toEqual([
      0.1, 100,
    ]);
  });
});

describe("layoutGraph", () => {
  const lines = (prims: readonly Prim[]): Extract<Prim, { kind: "segments" }>[] =>
    prims.flatMap((prim) =>
      prim.kind === "segments" ? [prim] : prim.kind === "clip" ? lines(prim.children) : [],
    );

  function graphDoc() {
    const doc = new Doc();
    const data = new Float64Array(200).map((_, index) => Math.sin(index / 10) * 0.002);
    doc.dispatch({ op: "makeWave", name: "signal", data, dx: 0.01, xUnit: "s", unit: "V" });
    doc.dispatch({ op: "display", y: ["signal"] });
    return doc;
  }
  const texts = (prims: readonly Prim[]): string[] =>
    prims.flatMap((prim) =>
      prim.kind === "text" ? [prim.text] : prim.kind === "clip" ? texts(prim.children) : [],
    );

  it("derives axis labels from units and keeps everything inside the window", () => {
    const state = graphDoc().getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 400, 300, measure);
    const all = texts(layout.prims);
    expect(all).toContain("mV");
    expect(all).toContain("s");
    expect(layout.plot.x).toBeGreaterThan(20);
    expect(layout.plot.x + layout.plot.w).toBeLessThanOrEqual(400);
    expect(layout.plot.y + layout.plot.h).toBeLessThan(300);
    expect(layout.axes.left?.scale.max).toBeCloseTo(0.002, 3);
    expect(layout.axes.right).toBeUndefined();
    expect(layout.traces[0]!.runs[0]!.length).toBe(400);
  });

  it("widens the left margin for wider tick labels", () => {
    const doc = graphDoc();
    const narrow = layoutGraph(
      doc.getState().graphs.Graph0!,
      doc.getState().waves,
      400,
      300,
      measure,
    );
    doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "left", props: { label: "Voltage" } });
    doc.dispatch({ op: "modifyGraph", graph: "Graph0", props: { fontSize: 24 } });
    const wide = layoutGraph(
      doc.getState().graphs.Graph0!,
      doc.getState().waves,
      400,
      300,
      measure,
    );
    expect(wide.plot.x).toBeGreaterThan(narrow.plot.x);
    expect(texts(wide.prims)).toContain("Voltage (mV)");
  });

  it("reports missing waves instead of failing", () => {
    const state = graphDoc().getState();
    const layout = layoutGraph(state.graphs.Graph0!, {}, 400, 300, measure);
    expect(layout.missing).toEqual(["signal"]);
    expect(layout.traces).toEqual([]);
  });

  it("renders to SVG", () => {
    const doc = graphDoc();
    doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "legend" });
    const state = doc.getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 400, 300, measure);
    const svg = toSvg(layout.prims, 400, 300);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="400" height="300"/);
    expect(svg).toContain("<polyline");
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain(">signal</text>");
    expect(svg).toContain("clip-path");
  });

  it("stacks axes with separate spans in one lane and overlapping ones side by side", () => {
    const doc = graphDoc();
    doc.dispatch({ op: "makeWave", name: "other", data: new Float64Array([1, 2, 3]) });
    doc.dispatch({ op: "addAxis", graph: "Graph0", name: "L2", side: "left" });
    doc.dispatch({ op: "appendTraces", graph: "Graph0", y: ["other"], vAxis: "L2" });
    const overlapping = layoutGraph(
      doc.getState().graphs.Graph0!,
      doc.getState().waves,
      400,
      300,
      measure,
    );
    expect(overlapping.axes.L2!.hit.x).toBeLessThan(overlapping.axes.left!.hit.x);

    doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "left", props: { span: [0, 0.45] } });
    doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "L2", props: { span: [0.55, 1] } });
    const stacked = layoutGraph(
      doc.getState().graphs.Graph0!,
      doc.getState().waves,
      400,
      300,
      measure,
    );
    const left = stacked.axes.left!.scale;
    const upper = stacked.axes.L2!.scale;
    // Same lane: both axis lines are at the same X.
    const lineOf = (name: string) => stacked.axes[name]!.hit.x + stacked.axes[name]!.hit.w;
    expect(lineOf("L2")).toBe(lineOf("left"));
    expect(upper.p0).toBeLessThan(left.p1);
    expect(stacked.plot.x).toBeLessThan(overlapping.plot.x);
  });

  it("draws an image covering its pixels, and contour lines", () => {
    const doc = new Doc();
    const data = new Float64Array(12).map((_, index) => index);
    doc.dispatch({ op: "makeWave", name: "m", data, shape: [4, 3], x0: 10, dx: 2 });
    doc.dispatch({ op: "display", y: [] });
    doc.dispatch({
      op: "appendImage",
      graph: "Graph0",
      wave: "m",
      props: { colorTable: "viridis" },
    });
    doc.dispatch({ op: "appendContour", graph: "Graph0", wave: "m", props: { levels: [5.5] } });
    doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "colorscale" });
    const state = doc.getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 400, 300, measure);
    // Pixels are centred on their X values: 10, 12, 14, 16 -> 9..17.
    expect([layout.axes.bottom!.scale.min, layout.axes.bottom!.scale.max]).toEqual([9, 17]);
    expect([layout.axes.left!.scale.min, layout.axes.left!.scale.max]).toEqual([-0.5, 2.5]);
    const image = layout.prims
      .flatMap((prim) => (prim.kind === "clip" ? prim.children : []))
      .find((prim) => prim.kind === "image");
    expect(image).toMatchObject({ cols: 4, rows: 3, x: layout.plot.x, w: layout.plot.w });
    // The bottom-left pixel is element [0][0], the lowest value: the dark end of viridis.
    const rgba = (image as Extract<Prim, { kind: "image" }>).rgba;
    expect(Array.from(rgba.slice(2 * 4 * 4, 2 * 4 * 4 + 4))).toEqual([68, 1, 84, 255]);
    expect(
      lines(layout.prims).some(
        (prim) => prim.stroke === "#000000" && prim.crisp !== true && prim.points.length >= 4,
      ),
    ).toBe(true);
    expect(toSvg(layout.prims, 400, 300)).toContain("data:image/png;base64,");
  });

  it("draws error bars and cursors, and leaves cursors out when asked", () => {
    const doc = graphDoc();
    doc.dispatch({ op: "modifyTrace", graph: "Graph0", trace: "signal", props: { yError: 0.001 } });
    doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "A", trace: "signal", point: 50 });
    const state = doc.getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 400, 300, measure);
    expect(layout.cursors).toHaveLength(1);
    expect(layout.cursors[0]).toMatchObject({ name: "A", point: 50 });
    expect(layout.cursors[0]!.x).toBeCloseTo(layout.axes.bottom!.scale.toPixel(0.5));
    const bars = lines(layout.prims).find((prim) => prim.points.length === 200 * 12);
    expect(bars).toBeDefined();
    const exported = layoutGraph(state.graphs.Graph0!, state.waves, 400, 300, measure, {
      cursors: false,
    });
    expect(exported.cursors).toEqual([]);
  });
});

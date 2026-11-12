import { strToU8, unzlibSync, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { checkStyle } from "../doc/commands";
import { Doc } from "../doc/doc";
import { echoPython } from "../doc/echo";
import { graphScript } from "../doc/recreate";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { drawPrims } from "./canvas";
import type { FontStyle, MeasureText, Prim, Rect } from "./displayList";
import { layoutGraph } from "./layout";
import { layoutPage } from "./page";
import { toPdf } from "./pdf";
import { CAP_HEIGHT, emitText, layoutText, parseRichText, type TextRun } from "./richText";
import { toSvg } from "./svg";
import { axisLabelText } from "./ticks";

const measure: MeasureText = (text, size) => text.length * size * 0.55;
/** Bold is wider, and a named font narrower, so tests can tell what was measured. */
const styled: MeasureText = (text, size, family, style?: FontStyle) =>
  text.length * size * (style?.bold ? 0.65 : 0.55) * (family.startsWith('"Narrow"') ? 0.5 : 1);

/** A short fingerprint of a drawing: two mixed FNV-1a hashes. */
function digest(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x01000193) >>> 0;
    b = (b ^ (a >>> 7)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Every kind of text a graph has, written without any of the formatting codes. */
function plainDoc(): Doc {
  const doc = new Doc();
  const data = new Float64Array(120).map((_, index) => Math.sin(index / 9) * 0.002);
  doc.dispatch({ op: "makeWave", name: "signal", data, dx: 0.01, xUnit: "s", unit: "V" });
  doc.dispatch({ op: "makeWave", name: "other", data: Float64Array.of(3, 1, 4, 1, 5) });
  const n = 20;
  const map = new Float64Array(n * n).map((_, index) => Math.hypot((index % n) - 9, index / n - 9));
  doc.dispatch({ op: "makeWave", name: "map", data: map, shape: [n, n] });
  doc.dispatch({ op: "display", y: ["signal"] });
  doc.dispatch({ op: "addAxis", graph: "Graph0", name: "L2", side: "left" });
  doc.dispatch({ op: "appendTraces", graph: "Graph0", y: ["other"], vAxis: "L2", hAxis: "top" });
  doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "left", props: { span: [0, 0.45] } });
  doc.dispatch({
    op: "modifyAxis",
    graph: "Graph0",
    axis: "L2",
    props: { span: [0.55, 1], label: "Count_{n} (cm^{-1})" },
  });
  doc.dispatch({
    op: "modifyAxis",
    graph: "Graph0",
    axis: "bottom",
    props: { label: "Time", mirror: "labels" },
  });
  doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "top", props: { label: "Index" } });
  doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "legend" });
  doc.dispatch({
    op: "addAnnotation",
    graph: "Graph0",
    kind: "text",
    text: "T = 300 K\nE_{F} = 2 eV^{2}",
    anchor: "LB",
  });
  doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "tag", trace: "other", point: 2 });
  doc.dispatch({ op: "display", y: [] });
  doc.dispatch({ op: "appendImage", graph: "Graph1", wave: "map" });
  doc.dispatch({
    op: "appendContour",
    graph: "Graph1",
    wave: "map",
    props: { levels: [4, 8], labels: true },
  });
  doc.dispatch({ op: "addAnnotation", graph: "Graph1", kind: "colorscale" });
  doc.dispatch({ op: "newLayout" });
  doc.dispatch({
    op: "addLayoutItem",
    layout: "Layout0",
    kind: "graph",
    graph: "Graph0",
    x: 50,
    y: 60,
    w: 300,
    h: 220,
  });
  doc.dispatch({
    op: "addLayoutItem",
    layout: "Layout0",
    kind: "text",
    text: "Figure 1\nv_{x} in m s^{-1}",
    x: 50,
    y: 300,
    size: 10,
  });
  return doc;
}

describe("text written before formatting codes existed", () => {
  // Taken from the drawing code as it was before sizes and styles were added
  // to text: a graph that uses none of them must come out byte for byte the same.
  it("draws graphs and pages exactly as before", () => {
    const state = plainDoc().getState();
    const drawn = (prims: Prim[], width: number, height: number, scale?: number) => ({
      svg: digest(toSvg(prims, width, height)),
      pdf: digest(toPdf(prims, width, height, scale ? { scale } : {})),
    });
    const graph0 = layoutGraph(state.graphs.Graph0!, state.waves, 520, 380, measure);
    const graph1 = layoutGraph(state.graphs.Graph1!, state.waves, 400, 300, measure);
    const page = layoutPage(state.pages.Layout0!, state, measure);
    const result = {
      plot0: graph0.plot,
      plot1: graph1.plot,
      graph0: drawn(graph0.prims, 520, 380),
      graph1: drawn(graph1.prims, 400, 300),
      page: drawn(page.prims, page.width, page.height, 1),
    };
    expect(result).toEqual({
      plot0: { x: 50, y: 45, w: 462, h: 290 },
      plot1: { x: 33, y: 8, w: 359, h: 264 },
      graph0: { svg: "453acf831cca2afc", pdf: "1476a34c0495021c" },
      graph1: { svg: "3fc88884010b1345", pdf: "b926e7266e49fc63" },
      page: { svg: "6da203c518981ca3", pdf: "cb01c8e078321faa" },
    });
  });
});

/** Runs with sizes and offsets rounded, so expectations can be written plainly. */
const runsOf = (markup: string, size = 10, style: FontStyle = {}): TextRun[] =>
  parseRichText(markup, { size, ...style }).map((run) => ({
    ...run,
    size: Math.round(run.size * 1000) / 1000,
    dy: Math.round(run.dy * 1000) / 1000 || 0,
  }));

describe("markup in text", () => {
  it("keeps plain text as one run, and the old superscripts and subscripts", () => {
    expect(runsOf("T = 300 K")).toEqual([{ text: "T = 300 K", size: 10, dy: 0 }]);
    expect(runsOf("cm^{-1}")).toEqual([
      { text: "cm", size: 10, dy: 0 },
      { text: "-1", size: 7, dy: -4 },
    ]);
    expect(runsOf("V_{out}")).toEqual([
      { text: "V", size: 10, dy: 0 },
      { text: "out", size: 7, dy: 1.8 },
    ]);
  });

  it("nests scripts, which scale with the text they are in", () => {
    expect(runsOf("e^{x^{2}}")).toEqual([
      { text: "e", size: 10, dy: 0 },
      { text: "x", size: 7, dy: -4 },
      { text: "2", size: 4.9, dy: -6.8 },
    ]);
    // A script of large text is large, and rises with it.
    expect(runsOf("\\Z20m^{2}")).toEqual([
      { text: "m", size: 20, dy: 0 },
      { text: "2", size: 14, dy: -8 },
    ]);
    // Igor's \S and \B hold until \M; they nest too.
    expect(runsOf("a\\Sb\\Sc\\Md\\Be")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b", size: 7, dy: -4 },
      { text: "c", size: 4.9, dy: -6.8 },
      { text: "d", size: 10, dy: 0 },
      { text: "e", size: 7, dy: 1.8 },
    ]);
  });

  it("sets sizes absolutely and relatively", () => {
    expect(runsOf("a\\Z14b\\Zr150c\\Md")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b", size: 14, dy: 0 },
      { text: "c", size: 21, dy: 0 },
      { text: "d", size: 10, dy: 0 },
    ]);
    // \Zr is relative to the size in effect, inside a superscript too.
    expect(runsOf("x^{\\Zr050n}")).toEqual([
      { text: "x", size: 10, dy: 0 },
      { text: "n", size: 3.5, dy: -4 },
    ]);
  });

  it("sets bold, italic and underline by Igor's bits, until changed", () => {
    expect(runsOf("a\\f01b\\f02c\\f03d\\f04e\\f00f")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b", size: 10, dy: 0, bold: true },
      { text: "c", size: 10, dy: 0, italic: true },
      { text: "d", size: 10, dy: 0, bold: true, italic: true },
      { text: "e", size: 10, dy: 0, underline: true },
      { text: "f", size: 10, dy: 0 },
    ]);
    // \M goes back to the size and baseline, and leaves the style alone.
    expect(runsOf("\\f02\\Z20a\\Mb")).toEqual([
      { text: "a", size: 20, dy: 0, italic: true },
      { text: "b", size: 10, dy: 0, italic: true },
    ]);
    // Text that starts italic (an italic axis label) is set plain by \f00.
    expect(runsOf("Voltage (\\f00V\\f02)", 10, { italic: true })).toEqual([
      { text: "Voltage (", size: 10, dy: 0, italic: true },
      { text: "V", size: 10, dy: 0 },
      { text: ")", size: 10, dy: 0, italic: true },
    ]);
  });

  it("ends what changes inside braces with them", () => {
    expect(runsOf("a^{\\f02\\Z20b}c")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b", size: 20, dy: -4, italic: true },
      { text: "c", size: 10, dy: 0 },
    ]);
    // Braces inside a script are its own; a script holds an Igor code too.
    expect(runsOf("a^{b{c}d}e")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b{c}d", size: 7, dy: -4 },
      { text: "e", size: 10, dy: 0 },
    ]);
  });

  it("names fonts and colors, and remembers and restores a look", () => {
    expect(runsOf("a\\F'Times New Roman'b\\K(65535,0,32768)c\\Md")).toEqual([
      { text: "a", size: 10, dy: 0 },
      { text: "b", size: 10, dy: 0, font: "Times New Roman" },
      { text: "c", size: 10, dy: 0, font: "Times New Roman", color: "#ff0080" },
      { text: "d", size: 10, dy: 0, color: "#ff0080" },
    ]);
    expect(runsOf("\\f01\\[0a\\f02\\Z20b\\]0c\\]5d")).toEqual([
      { text: "a", size: 10, dy: 0, bold: true },
      { text: "b", size: 20, dy: 0, italic: true },
      { text: "c", size: 10, dy: 0, bold: true },
      // Nothing was kept under 5: back to how the text started.
      { text: "d", size: 10, dy: 0 },
    ]);
  });

  it("writes a backslash for \\\\, and shows codes that are not whole as they are", () => {
    expect(runsOf("C:\\\\data")).toEqual([{ text: "C:\\data", size: 10, dy: 0 }]);
    for (const text of [
      "\\x",
      "\\Z1",
      "\\Z",
      "\\Z00",
      "\\Zr15",
      "\\Zr000",
      "\\f1",
      "\\F'Times",
      "\\F''",
      "\\K(1,2)",
      "\\K(70000,0,0)",
      "\\[",
      "\\]",
      "a^b",
      "x^{y",
      "a}b",
      "\\",
      "\\s(trace)",
      "\\u",
    ]) {
      expect(
        parseRichText(text)
          .map((run) => run.text)
          .join(""),
        text,
      ).toBe(text);
    }
    // A code cannot reach past the brace that ends its group.
    expect(runsOf("x^{\\Z1}4")).toEqual([
      { text: "x", size: 10, dy: 0 },
      { text: "\\Z1", size: 7, dy: -4 },
      { text: "4", size: 10, dy: 0 },
    ]);
    // A lone closing brace is text, and an unbalanced group ends at the first one, as it always did.
    expect(runsOf("^{a{b}c")).toEqual([
      { text: "a{b", size: 7, dy: -4 },
      { text: "c", size: 10, dy: 0 },
    ]);
  });

  it("puts the axis' units where a label says, and writes the scale after a label in its own look", () => {
    expect(axisLabelText("Voltage / \\u", 3, "V")).toBe("Voltage / kV");
    expect(axisLabelText("Voltage (\\U)", 0, "V")).toBe("Voltage (V)");
    expect(axisLabelText("Count \\u", 3, "")).toBe("Count ×10^{3}");
    expect(axisLabelText("a\\\\u", 0, "V")).toBe("a\\\\u");
    expect(axisLabelText("Voltage", 3, "V")).toBe("Voltage (kV)");
    expect(axisLabelText("\\f02Voltage", 3, "V")).toBe("\\[9\\f02Voltage\\]9 (kV)");
    const runs = runsOf(axisLabelText("\\f02Voltage", 3, "V"));
    expect(runs).toEqual([
      { text: "Voltage", size: 10, dy: 0, italic: true },
      { text: " (kV)", size: 10, dy: 0 },
    ]);
  });
});

describe("laying out mixed text", () => {
  it("measures each run in its own size, style and font, on one baseline", () => {
    const block = layoutText("a\\Z20b\\f01c^{2}\\F'Narrow'd", 10, "Arial", styled);
    expect(block.parts.map(({ text, dx, dy, size }) => [text, dx, dy, size])).toEqual([
      ["a", 0, 0, 10],
      ["b", 5.5, 0, 20],
      ["c", 16.5, 0, 20],
      ["2", 29.5, -8, 14],
      ["d", 38.6, 0, 20],
    ]);
    expect(block.parts[2]).toMatchObject({ bold: true, width: 13 });
    expect(block.parts[4]).toMatchObject({ family: '"Narrow", Arial', bold: true, width: 6.5 });
    expect(block.width).toBeCloseTo(45.1);
    expect(block.lineSize).toBe(20);
    // The superscript of the large text reaches highest.
    expect(block.ascent).toBeCloseTo(8 + 14 * CAP_HEIGHT);
    expect(block.descent).toBeCloseTo(20 * 0.22);

    const prims: Prim[] = [];
    emitText(prims, block, 100, 50, { family: "Arial", fill: "#000000", align: 0.5 });
    const drawn = prims.flatMap((prim) => (prim.kind === "text" ? [prim] : []));
    expect(drawn.map((prim) => prim.y)).toEqual([50, 50, 50, 42, 50]);
    expect(drawn[0]!.x).toBeCloseTo(100 - 45.1 / 2);
    expect(drawn[2]).toMatchObject({ bold: true, family: "Arial" });
    expect(drawn[4]).toMatchObject({ family: '"Narrow", Arial', bold: true });
    expect(drawn[0]).not.toHaveProperty("bold");
    expect(drawn[0]).not.toHaveProperty("italic");
  });

  it("starts an axis label in its own style, and underlines and colors runs", () => {
    const block = layoutText("x\\f04y\\K(0,0,65535)z", 10, "Arial", styled, { bold: true });
    expect(block.parts.map((part) => part.bold)).toEqual([true, undefined, undefined]);
    const prims: Prim[] = [];
    emitText(prims, block, 0, 20, { family: "Arial", fill: "#000000", rotate: -90 });
    const lines = prims.filter((prim) => prim.kind === "segments");
    expect(lines).toHaveLength(2);
    // Under the baseline, turned with the text: a vertical line just right of it.
    const [line] = lines;
    if (line?.kind !== "segments") throw new Error("no underline");
    expect(line.points[0]).toBeCloseTo(1);
    expect(line.points[2]).toBeCloseTo(1);
    expect(line.points[1]! - line.points[3]!).toBeCloseTo(5.5);
    const blue = prims.filter((prim) => "stroke" in prim || "fill" in prim).at(-1)!;
    expect(blue).toMatchObject({ kind: "segments", stroke: "#0000ff" });
    expect(prims.find((prim) => prim.kind === "text" && prim.text === "z")).toMatchObject({
      fill: "#0000ff",
      rotate: -90,
    });
  });

  it("gives a row of a text box the height of its largest text", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3) });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({
      op: "addAnnotation",
      graph: "Graph0",
      kind: "text",
      text: "\\Z30Big \\f02text\nsmall",
      anchor: "LT",
    });
    const state = doc.getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 500, 400, measure);
    const box = layout.annotations[0]!.box;
    expect(box.h).toBe(6 * 2 + Math.round(30 * 1.35) + Math.round(12 * 1.35));
    const texts = textPrims(layout.prims);
    const big = texts.find((prim) => prim.text === "Big ")!;
    const italic = texts.find((prim) => prim.text === "text")!;
    const small = texts.find((prim) => prim.text === "small")!;
    expect(italic).toMatchObject({ size: 30, italic: true, y: big.y });
    expect(big.y).toBeCloseTo(box.y + 6 + Math.round(30 * 1.35) / 2 + (30 * CAP_HEIGHT) / 2);
    expect(small.y - small.size * CAP_HEIGHT).toBeGreaterThan(big.y + 30 * 0.22);
    expect(box.w).toBe(Math.ceil(12 + measure("Big text", 30, "")));
  });

  it("spaces page text lines by their largest text", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newLayout" });
    doc.dispatch({
      op: "addLayoutItem",
      layout: "Layout0",
      kind: "text",
      text: "\\Z20Title\nbody",
      x: 10,
      y: 10,
      size: 10,
    });
    const state = doc.getState();
    const page = layoutPage(state.pages.Layout0!, state, measure);
    expect(page.items[0]!.box.h).toBeCloseTo(20 * 1.3 + 10 * 1.3);
    const [title, body] = textPrims(page.prims);
    expect(title).toMatchObject({ text: "Title", size: 20 });
    expect(title!.y).toBeCloseTo(10 + 20 * (0.15 + CAP_HEIGHT));
    expect(body!.y).toBeCloseTo(10 + 26 + 10 * (0.15 + CAP_HEIGHT));
  });
});

/** Where a text instruction's ink can be, from its size and the test measure. */
function inkBox(prim: Extract<Prim, { kind: "text" }>): Rect {
  const w = measure(prim.text, prim.size, prim.family);
  const up = prim.size * CAP_HEIGHT;
  const down = prim.size * 0.22;
  if (prim.rotate === -90) return { x: prim.x - up, y: prim.y - w, w: up + down, h: w };
  return { x: prim.x, y: prim.y - up, w, h: up + down };
}

const meets = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const textPrims = (prims: readonly Prim[]): Extract<Prim, { kind: "text" }>[] =>
  prims.flatMap((prim) =>
    prim.kind === "text" ? [prim] : prim.kind === "clip" ? textPrims(prim.children) : [],
  );

describe("room for large axis labels", () => {
  /** A graph with an axis on every side, each labelled with its side's name. */
  function fourSides(props: Record<string, unknown>) {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 250, 30), unit: "V" });
    doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(1000, 2, 3) });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({
      op: "appendTraces",
      graph: "Graph0",
      y: ["b"],
      vAxis: "right",
      hAxis: "top",
    });
    for (const side of ["left", "bottom", "right", "top"]) {
      const label = `${side[0]!.toUpperCase()}${side.slice(1)}side`;
      doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: side, props: { label, ...props } });
    }
    return doc;
  }

  it("keeps big labels inside the graph and clear of the tick labels on every side", () => {
    const small = fourSides({});
    const big = fourSides({ labelSize: 30, labelStyle: "bold italic", tickLabelSize: 18 });
    const lay = (doc: Doc) =>
      layoutGraph(doc.getState().graphs.Graph0!, doc.getState().waves, 600, 450, measure);
    const before = lay(small);
    const after = lay(big);
    expect(after.plot.x).toBeGreaterThan(before.plot.x + 20);
    expect(after.plot.y).toBeGreaterThan(before.plot.y + 20);
    expect(600 - after.plot.x - after.plot.w).toBeGreaterThan(600 - before.plot.x - before.plot.w);
    expect(450 - after.plot.y - after.plot.h).toBeGreaterThan(450 - before.plot.y - before.plot.h);

    const texts = textPrims(after.prims);
    const titles = texts.filter((prim) => prim.text.endsWith("side"));
    expect(titles).toHaveLength(4);
    const graph = { x: 0, y: 0, w: 600, h: 450 };
    for (const title of titles) {
      expect(title).toMatchObject({ size: 30, bold: true, italic: true });
      const box = inkBox(title);
      expect(box.x, title.text).toBeGreaterThanOrEqual(graph.x);
      expect(box.y, title.text).toBeGreaterThanOrEqual(graph.y);
      expect(box.x + box.w, title.text).toBeLessThanOrEqual(graph.w);
      expect(box.y + box.h, title.text).toBeLessThanOrEqual(graph.h);
      expect(meets(box, after.plot), title.text).toBe(false);
    }
    const ticks = texts.filter((prim) => !prim.text.endsWith("side"));
    expect(ticks.length).toBeGreaterThan(8);
    for (const tick of ticks) {
      expect(tick.size).toBe(18);
      expect(tick).not.toHaveProperty("italic");
      for (const title of titles) {
        expect(meets(inkBox(tick), inkBox(title)), `${tick.text} / ${title.text}`).toBe(false);
      }
      expect(meets(inkBox(tick), after.plot), tick.text).toBe(false);
    }
    // Left and right labels read upwards, as before.
    expect(titles.filter((prim) => prim.rotate === -90).map((prim) => prim.text)).toEqual([
      "Leftside",
      "Rightside",
    ]);
  });

  it("makes room for large tick labels on a mirrored axis and on stacked axes", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 250, 30) });
    doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(5, 7, 6) });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({ op: "addAxis", graph: "Graph0", name: "L2", side: "left" });
    doc.dispatch({ op: "appendTraces", graph: "Graph0", y: ["b"], vAxis: "L2" });
    doc.dispatch({
      op: "modifyAxis",
      graph: "Graph0",
      axis: "left",
      props: { label: "Inner", labelSize: 26, tickLabelSize: 20 },
    });
    doc.dispatch({
      op: "modifyAxis",
      graph: "Graph0",
      axis: "L2",
      props: { label: "Outer", labelSize: 26, tickLabelSize: 20 },
    });
    doc.dispatch({
      op: "modifyAxis",
      graph: "Graph0",
      axis: "bottom",
      props: { mirror: "labels", tickLabelSize: 24 },
    });
    const state = doc.getState();
    const layout = layoutGraph(state.graphs.Graph0!, state.waves, 600, 450, measure);
    const texts = textPrims(layout.prims);
    const boxes = texts.map((prim) => ({ text: prim.text, box: inkBox(prim) }));
    for (const one of boxes) {
      expect(one.box.x, one.text).toBeGreaterThanOrEqual(0);
      expect(one.box.y, one.text).toBeGreaterThanOrEqual(0);
      expect(meets(one.box, layout.plot), one.text).toBe(false);
    }
    // The labels of the stacked axes clear every tick label, the outer axis' included.
    for (const title of boxes.filter((one) => one.text === "Inner" || one.text === "Outer")) {
      for (const other of boxes.filter((one) => one !== title)) {
        expect(meets(title.box, other.box), `${title.text} / ${other.text}`).toBe(false);
      }
    }
    // Neighbouring tick labels of one axis clear each other.
    const sameAxis = (one: (typeof boxes)[number], other: (typeof boxes)[number]) =>
      Math.abs(one.box.y - other.box.y) < 0.01 ||
      Math.abs(one.box.x + one.box.w - other.box.x - other.box.w) < 0.01;
    for (const [index, one] of boxes.entries()) {
      for (const other of boxes.slice(index + 1).filter((item) => sameAxis(one, item))) {
        expect(meets(one.box, other.box), `${one.text} / ${other.text}`).toBe(false);
      }
    }
    // The mirrored labels on top are as large as those at the bottom.
    const bottomTicks = texts.filter((prim) => prim.size === 24);
    const above = bottomTicks.filter((prim) => prim.y < layout.plot.y);
    expect(above.length).toBeGreaterThan(2);
    expect(above.length * 2).toBe(bottomTicks.length);
  });
});

describe("bold and italic in each backend", () => {
  const prims: Prim[] = [
    { kind: "text", x: 1, y: 20, text: "plain", family: "Arial", size: 12, fill: "#000000" },
    {
      kind: "text",
      x: 1,
      y: 40,
      text: "both",
      family: "Arial",
      size: 20,
      fill: "#000000",
      bold: true,
      italic: true,
    },
    {
      kind: "text",
      x: 1,
      y: 60,
      text: "times α",
      family: '"Times New Roman", Times, serif',
      size: 12,
      fill: "#000000",
      italic: true,
    },
    {
      kind: "text",
      x: 1,
      y: 80,
      text: "mono",
      family: '"Courier New", monospace',
      size: 12,
      fill: "#000000",
      bold: true,
    },
    {
      kind: "text",
      x: 1,
      y: 100,
      text: "named",
      family: '"Arial", "Times New Roman", serif',
      size: 12,
      fill: "#000000",
      italic: true,
    },
  ];

  it("writes real font-style and font-weight in SVG, and keeps the text as text", () => {
    const svg = toSvg(prims, 200, 120);
    expect(svg).toContain(
      '<text x="1" y="20" font-family="Arial" font-size="12" fill="#000000" xml:space="preserve">plain</text>',
    );
    expect(svg).toContain(
      '<text x="1" y="40" font-family="Arial" font-size="20" font-style="italic" font-weight="bold" fill="#000000" xml:space="preserve">both</text>',
    );
    expect(svg).toContain('font-family="&quot;Times New Roman&quot;, Times, serif"');
    expect(svg.match(/font-style="italic"/g)).toHaveLength(3);
    expect(svg.match(/font-weight="bold"/g)).toHaveLength(2);
  });

  it("uses the bold and italic cuts of the built-in PDF fonts, and keeps Greek upright", () => {
    const pdf = toPdf(prims, 200, 120);
    const text = new TextDecoder("latin1").decode(pdf);
    const fonts = Object.fromEntries(
      [...text.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(([, name, id]) => {
        const body = new RegExp(`\\n${id} 0 obj\\n([^]*?)\\nendobj`).exec(text)![1]!;
        return [name, /\/BaseFont \/(\S+)/.exec(body)![1]];
      }),
    );
    expect(Object.values(fonts).sort()).toEqual([
      "Courier-Bold",
      "Helvetica",
      "Helvetica-BoldOblique",
      "Helvetica-Oblique",
      "Symbol",
      "Times-Italic",
    ]);
    // The content stream selects them where each piece of text is drawn.
    const start = text.indexOf("stream\n") + 7;
    const end = text.indexOf("\nendstream");
    const content = new TextDecoder("latin1").decode(unzlibSync(pdf.subarray(start, end)));
    const fontOf = (base: string) => Object.keys(fonts).find((name) => fonts[name] === base)!;
    const hex = (value: string) =>
      Array.from(strToU8(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(content).toContain(`/${fontOf("Helvetica-BoldOblique")} 20 Tf <${hex("both")}> Tj`);
    expect(content).toContain(`/${fontOf("Times-Italic")} 12 Tf <${hex("times ")}> Tj`);
    expect(content).toContain(`/${fontOf("Symbol")} 12 Tf <61> Tj`);
    expect(content).toContain(`/${fontOf("Courier-Bold")} 12 Tf <${hex("mono")}> Tj`);
    // A font named in the text comes first, ahead of the graph's own.
    expect(content).toContain(`/${fontOf("Helvetica-Oblique")} 12 Tf <${hex("named")}> Tj`);
  });

  it("draws other scripts as a picture in their style", () => {
    const styles: FontStyle[] = [];
    toPdf([{ ...prims[1]!, text: "時間" } as Prim], 100, 100, {
      rasterizeText: (_text, _family, _size, _fill, style) => {
        styles.push(style);
        return null;
      },
    });
    expect(styles).toEqual([{ bold: true, italic: true }]);
  });

  it("sets the canvas font with style, size and family", () => {
    const fonts: string[] = [];
    let font = "";
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "font" ? font : key === "fillText" ? () => fonts.push(font) : () => undefined,
        set: (_target, key, value) => {
          if (key === "font") font = value as string;
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    drawPrims(ctx, prims, 1);
    expect(fonts).toEqual([
      "12px Arial",
      "italic bold 20px Arial",
      'italic 12px "Times New Roman", Times, serif',
      'bold 12px "Courier New", monospace',
      'italic 12px "Arial", "Times New Roman", serif',
    ]);
  });
});

describe("label sizes and styles in the document", () => {
  function labelled() {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3), unit: "V" });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({
      op: "modifyAxis",
      graph: "Graph0",
      axis: "left",
      props: { label: "Voltage (\\f02V\\f00)", labelSize: 20, labelStyle: "bold" },
    });
    doc.dispatch({
      op: "modifyAxis",
      graph: "Graph0",
      axis: "bottom",
      props: { tickLabelSize: 9 },
    });
    return doc;
  }

  it("checks the values", () => {
    const doc = labelled();
    const axis = doc.getState().graphs.Graph0!.axes.left!;
    expect(axis).toMatchObject({ labelSize: 20, labelStyle: "bold", tickLabelSize: null });
    const modify = (props: Record<string, unknown>) =>
      doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "left", props });
    expect(() => modify({ labelSize: 3 })).toThrow(/labelSize must be between 4 and 96/);
    expect(() => modify({ tickLabelSize: "big" })).toThrow(/tickLabelSize/);
    expect(() => modify({ labelStyle: "oblique" })).toThrow(/labelStyle/);
    modify({ labelSize: null, labelStyle: "bold italic" });
    expect(doc.getState().graphs.Graph0!.axes.left).toMatchObject({
      labelSize: null,
      labelStyle: "bold italic",
    });
  });

  it("writes them as Python, in the history and in the recreation script", () => {
    expect(
      echoPython({
        op: "modifyAxis",
        graph: "Graph0",
        axis: "left",
        props: { labelSize: 20, labelStyle: "italic", label: "\\f02t\\f00 (s)" },
      }),
    ).toBe(
      'op.graph("Graph0").axis("left").set(label_size=20, label_style="italic", label="\\\\f02t\\\\f00 (s)")',
    );
    const script = graphScript(labelled().getState(), "Graph0");
    expect(script).toContain(
      'g.axis("left").set(label="Voltage (\\\\f02V\\\\f00)", label_size=20, label_style="bold")',
    );
    expect(script).toContain('g.axis("bottom").set(tick_label_size=9)');
  });

  it("are part of a graph's style", () => {
    const doc = labelled();
    doc.dispatch({ op: "saveStyle", name: "big", graph: "Graph0" });
    const style = doc.getState().styles.big!;
    expect(style.axes?.left).toMatchObject({ labelSize: 20, labelStyle: "bold" });
    expect(style.axes?.bottom).toMatchObject({ tickLabelSize: 9 });
    expect(checkStyle({ axes: { left: { labelStyle: "italic", tickLabelSize: 8 } } })).toEqual({
      axes: { left: { labelStyle: "italic", tickLabelSize: 8 } },
    });
    expect(() => checkStyle({ axes: { left: { labelStyle: "slanted" } } })).toThrow(/labelStyle/);
    doc.dispatch({ op: "display", y: ["a"], style: null });
    doc.dispatch({ op: "applyStyle", style: "big", graphs: ["Graph1"] });
    // The size and style travel; the words of the label are data and stay.
    expect(doc.getState().graphs.Graph1!.axes.left).toMatchObject({
      label: null,
      labelSize: 20,
      labelStyle: "bold",
    });
  });

  it("are saved with the experiment, and older experiments open with the graph's sizes", () => {
    const state = labelled().getState();
    const restored = unzipExperiment(zipExperiment(state, [])).state;
    expect(restored.graphs.Graph0!.axes).toEqual(state.graphs.Graph0!.axes);

    const old = {
      version: 2,
      waves: [],
      graphs: {
        G: {
          name: "G",
          traces: [],
          axes: { left: { side: "left", label: "Old", min: null, max: null } },
          fontSize: 12,
          fontFamily: "Arial",
        },
      },
      tables: {},
      windows: [{ name: "G", kind: "graph", x: 0, y: 0, w: 440, h: 300 }],
    };
    const opened = unzipExperiment(zipSync({ "experiment.json": strToU8(JSON.stringify(old)) }))
      .state.graphs.G!;
    expect(opened.axes.left).toMatchObject({
      label: "Old",
      labelSize: null,
      labelStyle: "plain",
      tickLabelSize: null,
    });
  });
});

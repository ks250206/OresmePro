import {
  AXIS_SIDES,
  isVerticalSide,
  type Anchor,
  type AnnotationSpec,
  type AxisSide,
  type AxisSpec,
  type CursorName,
  type GraphSpec,
  type ImageSpec,
  type TraceSpec,
  type Wave,
} from "../doc/types";
import { colorAt, renderMatrix } from "./colorTables";
import { contourLevels, contourSegments } from "./contour";
import {
  extentOf,
  markerPixels,
  tracePixels,
  visibleRange,
  xExtentOf,
  type Extent,
} from "./decimate";
import { DASHES, type MeasureText, type Prim, type Rect } from "./displayList";
import { emitText, layoutText, CAP_HEIGHT, type TextBlock } from "./richText";
import { makeScale, type Scale } from "./scale";
import { axisLabelText, linearTicks, logTicks, type TickSet } from "./ticks";

const INK = "#000000";
const PAPER = "#ffffff";
const GRID_MAJOR = "#c4c4c4";
const GRID_MINOR = "#e6e6e6";

const OUTER_PAD = 8;
const MAJOR_TICK = 5;
const MINOR_TICK = 3;
const TICK_LABEL_GAP = 4;
const AXIS_LABEL_GAP = 6;
/** Space between two axes stacked outward on the same side. */
const LANE_GAP = 10;
const ERROR_CAP = 3;
/** Images are resampled to at most this many pixels per side. */
const IMAGE_LIMIT = 2048;

export interface AxisGeometry {
  side: AxisSide;
  scale: Scale;
  /** Where clicks count as "on this axis". */
  hit: Rect;
  unit: string;
}

export interface TraceGeometry {
  name: string;
  /** Pixel-space polylines and marker centers, for hit-testing. */
  runs: Float32Array[];
  markers: Float32Array | null;
}

export interface CursorGeometry {
  name: CursorName;
  trace: string;
  point: number;
  x: number;
  y: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  prims: Prim[];
  /** The data area. */
  plot: Rect;
  /** The axes that carry something, by name. */
  axes: Record<string, AxisGeometry>;
  traces: TraceGeometry[];
  cursors: CursorGeometry[];
  /** Waves referenced by the graph that are missing or of the wrong kind. */
  missing: string[];
}

export interface LayoutOptions {
  /** Draw cursors. Off for exported files, as in Igor. */
  cursors?: boolean;
}

const OPPOSITE: Record<AxisSide, AxisSide> = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom",
};

interface AxisInfo {
  name: string;
  spec: AxisSpec;
  vertical: boolean;
  range: [number, number];
  unit: string;
  /** 0 for the axis nearest the plot; higher lanes sit further out. */
  lane: number;
  scale: Scale;
  ticks: TickSet;
  labels: TextBlock[];
  title: TextBlock;
  /** Room the axis needs outward from its line. */
  depth: number;
  /** Pixel position of the axis line, across its direction. */
  line: number;
}

function mergeExtent(a: Extent, b: Extent): Extent {
  return {
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
    minPositive: Math.min(a.minPositive, b.minPositive),
  };
}

const spanExtent = (a: number, b: number): Extent => {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return { min, max, minPositive: min > 0 ? min : max > 0 ? max : Infinity };
};

/** The range an axis shows: manual limits where given, otherwise the data's. */
export function axisRange(spec: AxisSpec, data: Extent): [number, number] {
  let min = spec.min ?? (spec.log ? data.minPositive : data.min);
  let max = spec.max ?? data.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    // No usable data: fall back to something drawable around what is known.
    if (Number.isFinite(min)) max = spec.log ? min * 10 : min + 1;
    else if (Number.isFinite(max)) min = spec.log ? max / 10 : max - 1;
    else [min, max] = spec.log ? [1, 10] : [0, 1];
  }
  if (spec.log) {
    if (max <= 0) max = 10;
    if (min <= 0) min = max / 1000;
  }
  if (min === max) {
    if (spec.log) {
      min /= 2;
      max *= 2;
    } else {
      const pad = Math.abs(min) * 0.05 || 0.5;
      min -= pad;
      max += pad;
    }
  }
  return [min, max];
}

function commonUnit(units: string[]): string {
  const first = units[0] ?? "";
  return units.every((unit) => unit === first) ? first : "";
}

function ticksFor(spec: AxisSpec, scale: Scale, maxCount: number): TickSet {
  return spec.log
    ? logTicks(scale.min, scale.max, maxCount)
    : linearTicks(scale.min, scale.max, maxCount, spec.minor);
}

/** How far a trace reaches beyond its data points, in pixels. */
function traceReach(trace: TraceSpec): number {
  const line = trace.lineSize / 2;
  return trace.mode === "markers" || trace.mode === "lines+markers"
    ? trace.markerSize + line
    : line;
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]): boolean =>
  a[0] < b[1] - 1e-9 && b[0] < a[1] - 1e-9;

function anchorBox(anchor: Anchor, area: Rect, w: number, h: number, inset: number): Rect {
  const x =
    anchor[0] === "L"
      ? area.x + inset
      : anchor[0] === "R"
        ? area.x + area.w - inset - w
        : area.x + (area.w - w) / 2;
  const y =
    anchor[1] === "T"
      ? area.y + inset
      : anchor[1] === "B"
        ? area.y + area.h - inset - h
        : area.y + (area.h - h) / 2;
  return { x: Math.round(x), y: Math.round(y), w, h };
}

function emitSymbol(out: Prim[], trace: TraceSpec, x: number, y: number, w: number): void {
  const hasLine = trace.mode !== "markers" && trace.mode !== "dots";
  if (hasLine) {
    out.push({
      kind: "segments",
      points: [x, y, x + w, y],
      stroke: trace.color,
      width: trace.lineSize,
      dash: DASHES[trace.lineStyle],
    });
  }
  if (trace.mode === "markers" || trace.mode === "lines+markers") {
    out.push({
      kind: "markers",
      points: [x + w / 2, y],
      shape: trace.marker,
      size: trace.markerSize,
      fill: trace.markerFill ? trace.color : null,
      stroke: trace.color,
      width: Math.max(1, trace.lineSize),
    });
  } else if (trace.mode === "dots") {
    out.push({
      kind: "markers",
      points: [x + w / 2, y],
      shape: "square",
      size: Math.max(1, trace.lineSize),
      fill: trace.color,
      stroke: trace.color,
      width: 0,
    });
  }
}

interface ImageInfo {
  spec: ImageSpec;
  zMin: number;
  zMax: number;
}

const imageCache = new WeakMap<Float64Array, Map<string, Uint8ClampedArray<ArrayBuffer>>>();
const contourCache = new WeakMap<Float64Array, Map<number, Float64Array>>();

function cachedMatrix(
  data: Float64Array,
  nx: number,
  ny: number,
  cols: number,
  rows: number,
  options: Parameters<typeof renderMatrix>[5],
): Uint8ClampedArray<ArrayBuffer> {
  let entries = imageCache.get(data);
  if (!entries) imageCache.set(data, (entries = new Map()));
  const key = [cols, rows, ...Object.values(options)].join("|");
  let rgba = entries.get(key);
  if (!rgba) {
    if (entries.size >= 4) entries.clear();
    rgba = renderMatrix(data, nx, ny, cols, rows, options);
    entries.set(key, rgba);
  }
  return rgba;
}

function cachedContour(data: Float64Array, nx: number, ny: number, level: number): Float64Array {
  let entries = contourCache.get(data);
  if (!entries) contourCache.set(data, (entries = new Map()));
  let segments = entries.get(level);
  if (!segments) {
    if (entries.size >= 256) entries.clear();
    segments = contourSegments(data, nx, ny, level);
    entries.set(level, segments);
  }
  return segments;
}

function emitColorScale(
  out: Prim[],
  annotation: AnnotationSpec,
  graph: GraphSpec,
  images: readonly ImageInfo[],
  plot: Rect,
  measure: MeasureText,
): void {
  const image = images.find((item) => annotation.text === "" || item.spec.name === annotation.text);
  if (!image) return;
  const size = graph.fontSize;
  const family = graph.fontFamily;
  const barWidth = 14;
  const barHeight = Math.max(40, Math.min(160, plot.h - 40));
  const padding = 6;
  const scale = makeScale(image.zMin, image.zMax, false, barHeight, 0);
  const ticks = linearTicks(image.zMin, image.zMax, Math.max(2, Math.floor(barHeight / 28)), false);
  const labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
  const suffix = layoutText(axisLabelText(null, ticks.exponent, ""), size, family, measure);
  const labelWidth = Math.max(suffix.width, ...labels.map((label) => label.width));
  const top = padding + (suffix.width > 0 ? size * 1.3 : size * 0.4);
  const width = Math.ceil(padding * 2 + barWidth + 4 + TICK_LABEL_GAP + labelWidth);
  const height = Math.ceil(top + barHeight + padding + size * 0.4);
  const box = anchorBox(annotation.anchor, plot, width, height, 8);
  out.push({
    kind: "rect",
    ...box,
    fill: PAPER,
    ...(annotation.frame ? { stroke: INK, width: 1 } : {}),
  });

  const barX = box.x + padding;
  const barY = box.y + Math.round(top);
  const rows = 128;
  const ramp = new Float64Array(rows);
  for (let index = 0; index < rows; index += 1) ramp[index] = index;
  out.push({
    kind: "image",
    x: barX,
    y: barY,
    w: barWidth,
    h: barHeight,
    cols: 1,
    rows,
    rgba: renderMatrix(ramp, 1, rows, 1, rows, {
      table: image.spec.colorTable,
      zMin: 0,
      zMax: rows - 1,
      reverse: image.spec.reverse,
      flipX: false,
      flipY: false,
    }),
  });
  const lines: number[] = [
    barX,
    barY,
    barX + barWidth,
    barY,
    barX + barWidth,
    barY,
    barX + barWidth,
    barY + barHeight,
    barX,
    barY + barHeight,
    barX + barWidth,
    barY + barHeight,
    barX,
    barY,
    barX,
    barY + barHeight,
  ];
  ticks.major.forEach((tick, index) => {
    const y = barY + Math.round(scale.toPixel(tick.value));
    lines.push(barX + barWidth, y, barX + barWidth + 4, y);
    emitText(
      out,
      labels[index]!,
      barX + barWidth + 4 + TICK_LABEL_GAP,
      y + (size * CAP_HEIGHT) / 2,
      {
        family,
        fill: INK,
      },
    );
  });
  out.push({ kind: "segments", points: lines, stroke: INK, width: 1, crisp: true });
  if (suffix.width > 0) {
    emitText(out, suffix, barX, box.y + padding + size * CAP_HEIGHT, { family, fill: INK });
  }
}

function emitAnnotation(
  out: Prim[],
  annotation: AnnotationSpec,
  graph: GraphSpec,
  plot: Rect,
  measure: MeasureText,
): void {
  const size = graph.fontSize;
  const family = graph.fontFamily;
  const visible = graph.traces.filter((trace) => !trace.hidden);
  const byName = new Map(graph.traces.map((trace) => [trace.name, trace]));

  // A legend line is `\s(traceName) text`; with no text at all it lists every trace.
  const source =
    annotation.kind === "legend" && annotation.text === ""
      ? visible.map((trace) => `\\s(${trace.name}) ${trace.name}`)
      : annotation.text.split("\n");
  const rows = source.map((line) => {
    const match = /^\\s\(([^)]*)\)\s?/.exec(line);
    const trace = match ? (byName.get(match[1]!) ?? null) : null;
    const block = layoutText(match ? line.slice(match[0].length) : line, size, family, measure);
    return { trace, block };
  });
  if (rows.length === 0) return;

  const symbolWidth = 26;
  const symbolGap = 6;
  const padding = 6;
  const rowHeight = Math.round(size * 1.35);
  const hasSymbols = rows.some((row) => row.trace);
  const textX = hasSymbols ? symbolWidth + symbolGap : 0;
  const width = Math.ceil(padding * 2 + textX + Math.max(...rows.map((row) => row.block.width)));
  const height = padding * 2 + rowHeight * rows.length;
  const box = anchorBox(annotation.anchor, plot, width, height, 8);

  out.push({
    kind: "rect",
    ...box,
    fill: PAPER,
    ...(annotation.frame ? { stroke: INK, width: 1 } : {}),
  });
  rows.forEach((row, index) => {
    const middle = box.y + padding + rowHeight * (index + 0.5);
    if (row.trace) emitSymbol(out, row.trace, box.x + padding, middle, symbolWidth);
    emitText(out, row.block, box.x + padding + textX, middle + (size * CAP_HEIGHT) / 2, {
      family,
      fill: INK,
    });
  });
}

/** The size of an error bar at one point: from a wave, or constant. */
function errorAt(source: string | number | null, waves: Readonly<Record<string, Wave>>) {
  if (source === null) return null;
  if (typeof source === "number") return () => source;
  const data = waves[source]?.data;
  return data ? (index: number) => data[index] ?? Number.NaN : null;
}

/** X value of a point of a trace: from its X wave, or its Y wave's scaling. */
export const traceX = (y: Wave, x: Wave | null, index: number): number =>
  x ? x.data[index]! : y.x0 + index * y.dx;

/**
 * Lays a graph out at a given size and returns the instructions to draw it,
 * plus the geometry the UI needs for hit-testing and zooming.
 *
 * Pure: the result depends only on the arguments, so the same call serves the
 * screen, exported files and tests.
 */
export function layoutGraph(
  graph: GraphSpec,
  waves: Readonly<Record<string, Wave>>,
  width: number,
  height: number,
  measure: MeasureText,
  options: LayoutOptions = {},
): GraphLayout {
  const size = graph.fontSize;
  const family = graph.fontFamily;
  const cap = size * CAP_HEIGHT;

  // Resolve what can be drawn; anything else is reported as missing.
  const missing = new Set<string>();
  const numeric = (name: string, dimensions: number): Wave | null => {
    const wave = waves[name];
    if (!wave || wave.text || wave.shape.length !== dimensions) {
      missing.add(name);
      return null;
    }
    return wave;
  };
  const axisOk = (item: { vAxis: string; hAxis: string }) =>
    item.vAxis in graph.axes && item.hAxis in graph.axes;

  const traces: { spec: TraceSpec; y: Wave; x: Wave | null }[] = [];
  for (const spec of graph.traces) {
    const y = numeric(spec.y, 1);
    const x = spec.x === null ? null : numeric(spec.x, 1);
    if (y && (spec.x === null || x) && axisOk(spec) && !spec.hidden) traces.push({ spec, y, x });
  }
  const matrices = <T extends { wave: string; vAxis: string; hAxis: string }>(
    items: readonly T[],
  ) =>
    items.flatMap((spec) => {
      const wave = numeric(spec.wave, 2);
      return wave && axisOk(spec) ? [{ spec, wave }] : [];
    });
  const images = matrices(graph.images);
  const contours = matrices(graph.contours);

  // Data extent and unit per axis in use.
  const extents = new Map<string, Extent>();
  const unitLists = new Map<string, string[]>();
  const feed = (axis: string, extent: Extent, unit: string) => {
    const current = extents.get(axis);
    extents.set(axis, current ? mergeExtent(current, extent) : extent);
    unitLists.set(axis, [...(unitLists.get(axis) ?? []), unit]);
  };
  for (const { spec, y, x } of traces) {
    feed(spec.vAxis, extentOf(y.data), y.unit);
    feed(spec.hAxis, xExtentOf(y, x), x ? x.unit : y.xUnit);
  }
  for (const { spec, wave } of images) {
    // An image pixel is centred on its scaled position and half a step wide each way.
    const [nx, ny] = wave.shape as [number, number];
    feed(spec.hAxis, spanExtent(wave.x0 - wave.dx / 2, wave.x0 + (nx - 0.5) * wave.dx), wave.xUnit);
    feed(spec.vAxis, spanExtent(wave.y0 - wave.dy / 2, wave.y0 + (ny - 0.5) * wave.dy), wave.yUnit);
  }
  for (const { spec, wave } of contours) {
    const [nx, ny] = wave.shape as [number, number];
    feed(spec.hAxis, spanExtent(wave.x0, wave.x0 + (nx - 1) * wave.dx), wave.xUnit);
    feed(spec.vAxis, spanExtent(wave.y0, wave.y0 + (ny - 1) * wave.dy), wave.yUnit);
  }
  // An empty graph still shows left and bottom.
  if (extents.size === 0) {
    for (const name of ["left", "bottom"]) {
      extents.set(name, { min: Infinity, max: -Infinity, minPositive: Infinity });
    }
  }

  const blank = layoutText("", size, family, measure);
  const axisList: AxisInfo[] = [];
  for (const [name, spec] of Object.entries(graph.axes)) {
    const extent = extents.get(name);
    if (!extent) continue;
    axisList.push({
      name,
      spec,
      vertical: isVerticalSide(spec.side),
      range: axisRange(spec, extent),
      unit: commonUnit(unitLists.get(name) ?? []),
      lane: 0,
      scale: makeScale(0, 1, false, 0, 1),
      ticks: { major: [], minor: [], exponent: 0 },
      labels: [],
      title: blank,
      depth: 0,
      line: 0,
    });
  }
  const bySide = (side: AxisSide) => axisList.filter((axis) => axis.spec.side === side);

  // Axes on one side share a lane unless their spans overlap.
  for (const side of AXIS_SIDES) {
    const placed: AxisInfo[] = [];
    for (const axis of bySide(side)) {
      let lane = 0;
      while (
        placed.some((other) => other.lane === lane && overlaps(other.spec.span, axis.spec.span))
      ) {
        lane += 1;
      }
      axis.lane = lane;
      placed.push(axis);
    }
  }

  // A mirror echoes an axis on the opposite edge, where nothing else is in the way.
  const mirrors = axisList.filter(
    (axis) =>
      axis.spec.mirror !== "off" &&
      !bySide(OPPOSITE[axis.spec.side]).some((other) => overlaps(other.spec.span, axis.spec.span)),
  );
  const occupied = (side: AxisSide): boolean =>
    bySide(side).length > 0 || mirrors.some((axis) => OPPOSITE[axis.spec.side] === side);

  // Axes are drawn slightly outside the data area so traces never cover them.
  const standoff = Math.min(
    8,
    Math.ceil(Math.max(0.5, ...traces.map((t) => traceReach(t.spec)))) + 1,
  );
  const tickOut = (spec: AxisSpec): number =>
    spec.ticks !== "none" && spec.ticks !== "inside" ? MAJOR_TICK : 0;
  const labelExtent = (axis: AxisInfo): number =>
    axis.vertical
      ? Math.max(0, ...axis.labels.map((label) => label.width))
      : Math.max(cap, ...axis.labels.map((label) => label.ascent));

  const margins: Record<AxisSide, number> = { left: 48, right: 12, top: 12, bottom: 36 };
  let plot: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const laneOffsets = new Map<AxisSide, number[]>();

  // Margins depend on the tick labels, which depend on the axis lengths, which
  // depend on the margins. Two passes settle it.
  for (let pass = 0; pass < 2; pass += 1) {
    plot = {
      x: Math.round(margins.left),
      y: Math.round(margins.top),
      w: Math.max(16, Math.round(width - margins.left - margins.right)),
      h: Math.max(16, Math.round(height - margins.top - margins.bottom)),
    };
    for (const axis of axisList) {
      const [lo, hi] = axis.spec.span;
      const [p0, p1] = axis.vertical
        ? [Math.round(plot.y + plot.h * (1 - lo)), Math.round(plot.y + plot.h * (1 - hi))]
        : [Math.round(plot.x + plot.w * lo), Math.round(plot.x + plot.w * hi)];
      const scale = makeScale(axis.range[0], axis.range[1], axis.spec.log, p0, p1);
      const length = Math.abs(p1 - p0);
      let maxCount = Math.min(12, Math.max(2, Math.floor(length / (axis.vertical ? 36 : 64))));
      let ticks = ticksFor(axis.spec, scale, maxCount);
      let labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
      if (!axis.vertical) {
        // Thin the ticks out until neighbouring labels clear each other.
        for (; maxCount > 1; maxCount -= 1) {
          const widest = Math.max(0, ...labels.map((label) => label.width));
          const pixels = ticks.major.map((tick) => scale.toPixel(tick.value));
          let spacing = Infinity;
          for (let index = 1; index < pixels.length; index += 1) {
            spacing = Math.min(spacing, Math.abs(pixels[index]! - pixels[index - 1]!));
          }
          if (widest + size * 0.8 <= spacing) break;
          ticks = ticksFor(axis.spec, scale, maxCount - 1);
          labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
        }
      }
      axis.scale = scale;
      axis.ticks = ticks;
      axis.labels = labels;
      axis.title = layoutText(
        axisLabelText(axis.spec.label, ticks.exponent, axis.unit),
        size,
        family,
        measure,
      );
      axis.depth =
        tickOut(axis.spec) +
        TICK_LABEL_GAP +
        labelExtent(axis) +
        (axis.title.width > 0 ? AXIS_LABEL_GAP + axis.title.ascent + axis.title.descent : 0);
    }

    for (const side of AXIS_SIDES) {
      const axes = bySide(side);
      const offsets: number[] = [];
      let total = 0;
      for (let lane = 0; axes.some((axis) => axis.lane === lane); lane += 1) {
        offsets[lane] = total;
        total += Math.max(...axes.filter((axis) => axis.lane === lane).map((axis) => axis.depth));
        total += LANE_GAP;
      }
      laneOffsets.set(side, offsets);
      let margin = axes.length > 0 ? standoff + total - LANE_GAP : 0;
      for (const source of mirrors) {
        if (OPPOSITE[source.spec.side] !== side) continue;
        const showTicks = source.spec.mirror !== "on";
        const need =
          standoff +
          (showTicks ? tickOut(source.spec) : 0) +
          (source.spec.mirror === "labels" ? TICK_LABEL_GAP + labelExtent(source) : 0);
        margin = Math.max(margin, need);
      }
      margins[side] = Math.ceil(OUTER_PAD + margin);
    }
    // Labels at the ends of an axis stick out past the plot corners.
    for (const axis of axisList) {
      axis.ticks.major.forEach((tick, index) => {
        const label = axis.labels[index]!;
        const pixel = axis.scale.toPixel(tick.value);
        if (axis.vertical) {
          margins.top = Math.max(margins.top, Math.ceil(label.ascent / 2 - (pixel - plot.y) + 3));
          margins.bottom = Math.max(
            margins.bottom,
            Math.ceil(label.ascent / 2 - (plot.y + plot.h - pixel) + 3),
          );
        } else {
          margins.left = Math.max(margins.left, Math.ceil(label.width / 2 - (pixel - plot.x) + 3));
          margins.right = Math.max(
            margins.right,
            Math.ceil(label.width / 2 - (plot.x + plot.w - pixel) + 3),
          );
        }
      });
    }
  }

  const prims: Prim[] = [{ kind: "rect", x: 0, y: 0, w: width, h: height, fill: PAPER }];
  const right = plot.x + plot.w;
  const bottom = plot.y + plot.h;
  const edge: Record<AxisSide, number> = { left: plot.x, right, top: plot.y, bottom };
  // +1 points away from the plot on that side.
  const outward = (side: AxisSide): number => (side === "left" || side === "top" ? -1 : 1);
  for (const axis of axisList) {
    const { side } = axis.spec;
    const offset = standoff + (laneOffsets.get(side)?.[axis.lane] ?? 0);
    axis.line = edge[side] + outward(side) * offset;
  }
  const info = new Map(axisList.map((axis) => [axis.name, axis]));

  // Grid lines, under everything else.
  for (const axis of axisList) {
    if (axis.spec.grid === "off") continue;
    const lines = (values: number[], stroke: string) => {
      const points: number[] = [];
      for (const value of values) {
        const pixel = Math.round(axis.scale.toPixel(value));
        if (axis.vertical) points.push(plot.x, pixel, right, pixel);
        else points.push(pixel, plot.y, pixel, bottom);
      }
      if (points.length > 0)
        prims.push({ kind: "segments", points, stroke, width: 1, crisp: true });
    };
    if (axis.spec.grid === "all") lines(axis.ticks.minor, GRID_MINOR);
    lines(
      axis.ticks.major.map((tick) => tick.value),
      GRID_MAJOR,
    );
  }

  // Everything drawn in data coordinates is clipped to its own pair of axes.
  const clipFor = (item: { vAxis: string; hAxis: string }): Rect => {
    const h = info.get(item.hAxis)!.scale;
    const v = info.get(item.vAxis)!.scale;
    return {
      x: Math.min(h.p0, h.p1) - standoff,
      y: Math.min(v.p0, v.p1) - standoff,
      w: Math.abs(h.p1 - h.p0) + standoff * 2,
      h: Math.abs(v.p1 - v.p0) + standoff * 2,
    };
  };
  const clipped = (item: { vAxis: string; hAxis: string }, children: Prim[]) => {
    if (children.length > 0) prims.push({ kind: "clip", ...clipFor(item), children });
  };

  const imageInfos: ImageInfo[] = [];
  for (const { spec, wave } of images) {
    const [nx, ny] = wave.shape as [number, number];
    const extent = extentOf(wave.data);
    const zMin = spec.zMin ?? (Number.isFinite(extent.min) ? extent.min : 0);
    const zMax = spec.zMax ?? (Number.isFinite(extent.max) ? extent.max : 1);
    imageInfos.push({ spec, zMin, zMax });
    const xs = info.get(spec.hAxis)!.scale;
    const ys = info.get(spec.vAxis)!.scale;
    const xa = xs.toPixel(wave.x0 - wave.dx / 2);
    const xb = xs.toPixel(wave.x0 + (nx - 0.5) * wave.dx);
    const ya = ys.toPixel(wave.y0 - wave.dy / 2);
    const yb = ys.toPixel(wave.y0 + (ny - 0.5) * wave.dy);
    if (![xa, xb, ya, yb].every(Number.isFinite) || nx === 0 || ny === 0) continue;
    const cols = Math.min(nx, IMAGE_LIMIT);
    const rows = Math.min(ny, IMAGE_LIMIT);
    clipped(spec, [
      {
        kind: "image",
        x: Math.min(xa, xb),
        y: Math.min(ya, yb),
        w: Math.abs(xb - xa),
        h: Math.abs(yb - ya),
        cols,
        rows,
        rgba: cachedMatrix(wave.data, nx, ny, cols, rows, {
          table: spec.colorTable,
          zMin,
          zMax,
          reverse: spec.reverse,
          flipX: xa > xb,
          // Index 0 belongs at the bottom unless the axis runs downward.
          flipY: ya < yb,
        }),
      },
    ]);
  }

  for (const { spec, wave } of contours) {
    const [nx, ny] = wave.shape as [number, number];
    const extent = extentOf(wave.data);
    const xs = info.get(spec.hAxis)!.scale;
    const ys = info.get(spec.vAxis)!.scale;
    const levels = contourLevels(spec.levels, extent.min, extent.max);
    const children: Prim[] = [];
    (levels as readonly number[]).forEach((level: number, index: number) => {
      const source = cachedContour(wave.data, nx, ny, level);
      const points = new Float32Array(source.length);
      for (let at = 0; at < source.length; at += 2) {
        points[at] = xs.toPixel(wave.x0 + source[at]! * wave.dx);
        points[at + 1] = ys.toPixel(wave.y0 + source[at + 1]! * wave.dy);
      }
      const stroke = spec.colorTable
        ? colorAt(spec.colorTable, levels.length > 1 ? index / (levels.length - 1) : 0.5)
        : spec.color;
      if (points.length > 0) {
        children.push({ kind: "segments", points, stroke, width: spec.lineSize });
      }
    });
    clipped(spec, children);
  }

  const geometry: TraceGeometry[] = [];
  for (const { spec, y, x } of traces) {
    const xs = info.get(spec.hAxis)!.scale;
    const ys = info.get(spec.vAxis)!.scale;
    const clip = clipFor(spec);
    const children: Prim[] = [];
    const dash = DASHES[spec.lineStyle];
    const item: TraceGeometry = { name: spec.name, runs: [], markers: null };

    const yError = errorAt(spec.yError, waves);
    const xError = errorAt(spec.xError, waves);
    if (yError || xError) {
      const { first, last } = visibleRange(y, x, xs.min, xs.max);
      const bars: number[] = [];
      for (let index = first; index <= last; index += 1) {
        const xValue = traceX(y, x, index);
        const yValue = y.data[index]!;
        const px = xs.toPixel(xValue);
        const py = ys.toPixel(yValue);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        const dy = yError?.(index);
        if (dy !== undefined && dy !== null && dy > 0) {
          const top = ys.toPixel(yValue + dy);
          const low = ys.toPixel(yValue - dy);
          const a = Number.isFinite(top) ? top : py;
          const b = Number.isFinite(low) ? low : py;
          bars.push(
            px,
            a,
            px,
            b,
            px - ERROR_CAP,
            a,
            px + ERROR_CAP,
            a,
            px - ERROR_CAP,
            b,
            px + ERROR_CAP,
            b,
          );
        }
        const dx = xError?.(index);
        if (dx !== undefined && dx !== null && dx > 0) {
          const hi = xs.toPixel(xValue + dx);
          const lo = xs.toPixel(xValue - dx);
          const a = Number.isFinite(hi) ? hi : px;
          const b = Number.isFinite(lo) ? lo : px;
          bars.push(
            a,
            py,
            b,
            py,
            a,
            py - ERROR_CAP,
            a,
            py + ERROR_CAP,
            b,
            py - ERROR_CAP,
            b,
            py + ERROR_CAP,
          );
        }
      }
      if (bars.length > 0) {
        children.push({
          kind: "segments",
          points: Float32Array.from(bars),
          stroke: spec.color,
          width: Math.max(1, spec.lineSize),
        });
      }
    }

    const wantsLine =
      spec.mode === "lines" || spec.mode === "lines+markers" || spec.mode === "cityscape";
    if (wantsLine) {
      let { runs } = tracePixels(y, x, xs, ys);
      if (spec.mode === "cityscape") {
        runs = runs.map((run) => {
          const steps = new Float32Array(Math.max(0, run.length * 2 - 2));
          for (let index = 0, at = 0; index < run.length; index += 2) {
            if (index > 0) {
              steps[at++] = run[index]!;
              steps[at++] = run[index - 1]!;
            }
            steps[at++] = run[index]!;
            steps[at++] = run[index + 1]!;
          }
          return steps;
        });
      }
      for (const run of runs) {
        children.push({
          kind: "polyline",
          points: run,
          stroke: spec.color,
          width: spec.lineSize,
          dash,
        });
      }
      item.runs = runs;
    }
    if (spec.mode !== "lines" && spec.mode !== "cityscape") {
      const points = markerPixels(y, x, xs, ys, clip);
      item.markers = points;
      if (spec.mode === "sticks") {
        // Sticks run from each point to zero, or to the axis if zero is off-scale.
        const zero = ys.log ? Number.NaN : ys.toPixel(0);
        const low = Math.max(ys.p0, ys.p1);
        const high = Math.min(ys.p0, ys.p1);
        const base = Number.isFinite(zero) ? Math.min(low, Math.max(high, zero)) : low;
        const segments = new Float32Array(points.length * 2);
        for (let index = 0; index < points.length; index += 2) {
          segments.set([points[index]!, points[index + 1]!, points[index]!, base], index * 2);
        }
        children.push({
          kind: "segments",
          points: segments,
          stroke: spec.color,
          width: spec.lineSize,
        });
      } else if (spec.mode === "dots") {
        children.push({
          kind: "markers",
          points,
          shape: "square",
          size: Math.max(0.75, spec.lineSize),
          fill: spec.color,
          stroke: spec.color,
          width: 0,
        });
      } else {
        children.push({
          kind: "markers",
          points,
          shape: spec.marker,
          size: spec.markerSize,
          fill: spec.markerFill ? spec.color : null,
          stroke: spec.color,
          width: Math.max(1, spec.lineSize),
        });
      }
    }
    clipped(spec, children);
    geometry.push(item);
  }

  /** Draws an axis line with ticks and labels at `line`, for an axis or its mirror. */
  const drawAxis = (
    axis: AxisInfo,
    side: AxisSide,
    line: number,
    show: { ticks: boolean; labels: boolean; title: boolean },
  ): void => {
    const { scale } = axis;
    const out = outward(side);
    const low = Math.min(scale.p0, scale.p1);
    const high = Math.max(scale.p0, scale.p1);
    // The line reaches a neighbouring axis so corners close.
    const reach = (neighbour: AxisSide, atPlotEdge: boolean): number =>
      atPlotEdge && axis.lane === 0 && occupied(neighbour) ? standoff : 0;
    const segments: number[] = axis.vertical
      ? [line, low - reach("top", low === plot.y), line, high + reach("bottom", high === bottom)]
      : [low - reach("left", low === plot.x), line, high + reach("right", high === right), line];

    if (show.ticks && axis.spec.ticks !== "none") {
      const mode = axis.spec.ticks;
      const addTick = (value: number, length: number) => {
        const pixel = Math.round(scale.toPixel(value));
        const outer = mode === "inside" ? 0 : length;
        const inner = mode === "outside" ? 0 : length;
        if (axis.vertical) segments.push(line - inner * out, pixel, line + outer * out, pixel);
        else segments.push(pixel, line - inner * out, pixel, line + outer * out);
      };
      for (const tick of axis.ticks.major) addTick(tick.value, MAJOR_TICK);
      for (const value of axis.ticks.minor) addTick(value, MINOR_TICK);
    }
    prims.push({ kind: "segments", points: segments, stroke: INK, width: 1, crisp: true });

    let at = line + out * (show.ticks ? tickOut(axis.spec) : 0);
    if (show.labels) {
      at += out * TICK_LABEL_GAP;
      axis.ticks.major.forEach((tick, index) => {
        const label = axis.labels[index]!;
        const pixel = scale.toPixel(tick.value);
        if (axis.vertical) {
          emitText(prims, label, at, pixel + cap / 2, {
            align: side === "left" ? 1 : 0,
            family,
            fill: INK,
          });
        } else {
          emitText(prims, label, pixel, side === "bottom" ? at + cap : at, {
            align: 0.5,
            family,
            fill: INK,
          });
        }
      });
      at += out * labelExtent(axis);
    }
    if (show.title && axis.title.width > 0) {
      at += out * AXIS_LABEL_GAP;
      const { title } = axis;
      const middle = (scale.p0 + scale.p1) / 2;
      if (axis.vertical) {
        // Reads bottom-to-top on both sides, like Igor.
        const baseline = side === "left" ? at - title.descent : at + title.ascent;
        emitText(prims, title, baseline, middle, { align: 0.5, rotate: -90, family, fill: INK });
      } else {
        const baseline = side === "bottom" ? at + title.ascent : at - title.descent;
        emitText(prims, title, middle, baseline, { align: 0.5, family, fill: INK });
      }
    }
  };

  const axes: GraphLayout["axes"] = {};
  for (const axis of axisList) {
    const { side } = axis.spec;
    drawAxis(axis, side, axis.line, { ticks: true, labels: true, title: true });
    const low = Math.min(axis.scale.p0, axis.scale.p1);
    const length = Math.abs(axis.scale.p1 - axis.scale.p0);
    const near = Math.min(axis.line, axis.line + outward(side) * axis.depth) - 2;
    const depth = axis.depth + 4;
    axes[axis.name] = {
      side,
      scale: axis.scale,
      unit: axis.unit,
      hit: axis.vertical
        ? { x: near, y: low, w: depth, h: length }
        : { x: low, y: near, w: length, h: depth },
    };
  }
  for (const source of mirrors) {
    const side = OPPOSITE[source.spec.side];
    drawAxis(source, side, edge[side] + outward(side) * standoff, {
      ticks: source.spec.mirror !== "on",
      labels: source.spec.mirror === "labels",
      title: false,
    });
  }

  const cursors: CursorGeometry[] = [];
  if (options.cursors !== false) {
    for (const [name, cursor] of Object.entries(graph.cursors) as [
      CursorName,
      { trace: string; point: number },
    ][]) {
      const trace = traces.find((item) => item.spec.name === cursor.trace);
      if (!trace || cursor.point >= trace.y.data.length) continue;
      const x = info.get(trace.spec.hAxis)!.scale.toPixel(traceX(trace.y, trace.x, cursor.point));
      const y = info.get(trace.spec.vAxis)!.scale.toPixel(trace.y.data[cursor.point]!);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      cursors.push({ name, trace: cursor.trace, point: cursor.point, x, y });
      // A is round and B is square, as in Igor.
      const mark: Prim[] = [
        {
          kind: "markers",
          points: [x, y],
          shape: name === "A" ? "circle" : "square",
          size: 5,
          fill: null,
          stroke: INK,
          width: 1.2,
        },
        {
          kind: "segments",
          points: [x - 9, y, x + 9, y, x, y - 9, x, y + 9],
          stroke: INK,
          width: 1,
        },
      ];
      emitText(mark, layoutText(name, 10, family, measure), x + 7, y - 7, { family, fill: INK });
      prims.push({ kind: "clip", ...clipFor(trace.spec), children: mark });
    }
  }

  for (const annotation of graph.annotations) {
    if (annotation.kind === "colorscale") {
      emitColorScale(prims, annotation, graph, imageInfos, plot, measure);
    } else {
      emitAnnotation(prims, annotation, graph, plot, measure);
    }
  }

  return { width, height, prims, plot, axes, traces: geometry, cursors, missing: [...missing] };
}

/** Distance from a point to the nearest part of a trace, in pixels. */
export function distanceToTrace(trace: TraceGeometry, px: number, py: number): number {
  let best = Infinity;
  for (const run of trace.runs) {
    if (run.length === 2) best = Math.min(best, Math.hypot(run[0]! - px, run[1]! - py));
    for (let index = 2; index < run.length; index += 2) {
      const ax = run[index - 2]!;
      const ay = run[index - 1]!;
      const bx = run[index]!;
      const by = run[index + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t =
        lengthSquared === 0
          ? 0
          : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
      best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
    }
  }
  if (trace.markers) {
    for (let index = 0; index < trace.markers.length; index += 2) {
      best = Math.min(best, Math.hypot(trace.markers[index]! - px, trace.markers[index + 1]! - py));
    }
  }
  return best;
}

/**
 * The point of a trace nearest (in X) to a pixel position, for placing a
 * cursor. Uses the X scaling directly, or searches the X wave.
 */
export function nearestPoint(y: Wave, x: Wave | null, scale: Scale, pixel: number): number {
  const count = x ? Math.min(y.data.length, x.data.length) : y.data.length;
  if (count === 0) return 0;
  const value = scale.toValue(pixel);
  if (!x) return Math.min(count - 1, Math.max(0, Math.round((value - y.x0) / y.dx)));
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < count; index += 1) {
    const distance = Math.abs(scale.toPixel(x.data[index]!) - pixel);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

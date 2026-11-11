import {
  AXIS_NAMES,
  type Anchor,
  type AnnotationSpec,
  type AxisName,
  type AxisSpec,
  type GraphSpec,
  type TraceSpec,
  type Wave,
} from "../doc/types";
import { extentOf, markerPixels, tracePixels, xExtentOf, type Extent } from "./decimate";
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

export interface AxisGeometry {
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

export interface GraphLayout {
  width: number;
  height: number;
  prims: Prim[];
  /** The data area. */
  plot: Rect;
  axes: Partial<Record<AxisName, AxisGeometry>>;
  traces: TraceGeometry[];
  /** Waves referenced by traces that no longer exist. */
  missing: string[];
}

const OPPOSITE: Record<AxisName, AxisName> = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom",
};
const isVertical = (axis: AxisName): boolean => axis === "left" || axis === "right";

interface ResolvedTrace {
  spec: TraceSpec;
  y: Wave;
  x: Wave | null;
}

interface Side {
  name: AxisName;
  /** axis: carries traces; mirror: echoes the opposite axis; none: bare edge. */
  role: "axis" | "mirror" | "none";
  /** The spec that governs ticks on this side (its own, or the mirrored one's). */
  spec: AxisSpec;
  showTicks: boolean;
  showLabels: boolean;
}

function mergeExtent(a: Extent, b: Extent): Extent {
  return {
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
    minPositive: Math.min(a.minPositive, b.minPositive),
  };
}

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

/**
 * Lays a graph out at a given size and returns the instructions to draw it,
 * plus the geometry the UI needs for hit-testing and zooming.
 *
 * Pure: the result depends only on the arguments, so the same call serves the
 * screen, SVG export and tests.
 */
export function layoutGraph(
  graph: GraphSpec,
  waves: Readonly<Record<string, Wave>>,
  width: number,
  height: number,
  measure: MeasureText,
): GraphLayout {
  const size = graph.fontSize;
  const family = graph.fontFamily;
  const cap = size * CAP_HEIGHT;

  const missing = new Set<string>();
  const traces: ResolvedTrace[] = [];
  for (const spec of graph.traces) {
    const y = waves[spec.y];
    const x = spec.x === null ? null : waves[spec.x];
    if (!y) missing.add(spec.y);
    if (x === undefined && spec.x !== null) missing.add(spec.x);
    if (y && x !== undefined && !spec.hidden) traces.push({ spec, y, x });
  }

  // Which sides carry traces. An empty graph still shows left and bottom.
  const used = new Set<AxisName>();
  for (const { spec } of traces) {
    used.add(spec.vAxis);
    used.add(spec.hAxis);
  }
  if (used.size === 0) {
    used.add("left");
    used.add("bottom");
  }

  const sides: Side[] = AXIS_NAMES.map((name) => {
    if (used.has(name)) {
      const spec = graph.axes[name];
      return { name, role: "axis", spec, showTicks: spec.ticks !== "none", showLabels: true };
    }
    const source = graph.axes[OPPOSITE[name]];
    if (used.has(OPPOSITE[name]) && source.mirror !== "off") {
      return {
        name,
        role: "mirror",
        spec: source,
        showTicks: source.mirror !== "on" && source.ticks !== "none",
        showLabels: source.mirror === "labels",
      };
    }
    return { name, role: "none", spec: graph.axes[name], showTicks: false, showLabels: false };
  });
  const side = (name: AxisName): Side => sides.find((item) => item.name === name)!;

  // Data ranges and units per axis that carries traces.
  const ranges = new Map<AxisName, [number, number]>();
  const units = new Map<AxisName, string>();
  for (const name of used) {
    const spec = graph.axes[name];
    let extent: Extent = { min: Infinity, max: -Infinity, minPositive: Infinity };
    const axisUnits: string[] = [];
    for (const trace of traces) {
      if (isVertical(name) && trace.spec.vAxis === name) {
        extent = mergeExtent(extent, extentOf(trace.y.data));
        axisUnits.push(trace.y.unit);
      } else if (!isVertical(name) && trace.spec.hAxis === name) {
        extent = mergeExtent(extent, xExtentOf(trace.y, trace.x));
        axisUnits.push(trace.x ? trace.x.unit : trace.y.xUnit);
      }
    }
    ranges.set(name, axisRange(spec, extent));
    units.set(name, commonUnit(axisUnits));
  }

  // Axes are drawn slightly outside the data area so traces never cover them.
  const standoff = Math.min(
    8,
    Math.ceil(Math.max(0.5, ...traces.map((t) => traceReach(t.spec)))) + 1,
  );

  interface AxisDraw {
    scale: Scale;
    ticks: TickSet;
    labels: (TextBlock | null)[];
    title: TextBlock;
  }

  const outwardTick = (item: Side): number =>
    item.showTicks && item.spec.ticks !== "inside" ? MAJOR_TICK : 0;

  const margins: Record<AxisName, number> = { left: 48, right: 12, top: 12, bottom: 36 };
  let plot: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const draws = new Map<AxisName, AxisDraw>();

  // Margins depend on the tick labels, which depend on the axis lengths, which
  // depend on the margins. Two passes settle it.
  for (let pass = 0; pass < 2; pass += 1) {
    plot = {
      x: Math.round(margins.left),
      y: Math.round(margins.top),
      w: Math.max(16, Math.round(width - margins.left - margins.right)),
      h: Math.max(16, Math.round(height - margins.top - margins.bottom)),
    };
    draws.clear();
    for (const name of used) {
      const spec = graph.axes[name];
      const [min, max] = ranges.get(name)!;
      const vertical = isVertical(name);
      const scale = vertical
        ? makeScale(min, max, spec.log, plot.y + plot.h, plot.y)
        : makeScale(min, max, spec.log, plot.x, plot.x + plot.w);
      const length = vertical ? plot.h : plot.w;
      let maxCount = Math.min(12, Math.max(2, Math.floor(length / (vertical ? 36 : 64))));
      let ticks = ticksFor(spec, scale, maxCount);
      let labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
      if (!vertical) {
        // Thin the ticks out until neighbouring labels clear each other.
        for (; maxCount > 1; maxCount -= 1) {
          const widest = Math.max(0, ...labels.map((label) => label.width));
          const pixels = ticks.major.map((tick) => scale.toPixel(tick.value));
          let spacing = Infinity;
          for (let index = 1; index < pixels.length; index += 1) {
            spacing = Math.min(spacing, Math.abs(pixels[index]! - pixels[index - 1]!));
          }
          if (widest + size * 0.8 <= spacing) break;
          ticks = ticksFor(spec, scale, maxCount - 1);
          labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
        }
      }
      const title = layoutText(
        axisLabelText(spec.label, ticks.exponent, units.get(name) ?? ""),
        size,
        family,
        measure,
      );
      draws.set(name, { scale, ticks, labels, title });
    }

    for (const item of sides) {
      const draw = draws.get(item.role === "mirror" ? OPPOSITE[item.name] : item.name);
      let margin = OUTER_PAD;
      if (item.role !== "none" && draw) {
        margin += standoff + outwardTick(item);
        if (item.showLabels) {
          const extent = isVertical(item.name)
            ? Math.max(0, ...draw.labels.map((label) => label?.width ?? 0))
            : Math.max(cap, ...draw.labels.map((label) => label?.ascent ?? 0));
          margin += TICK_LABEL_GAP + extent;
        }
        if (item.role === "axis" && draw.title.width > 0) {
          margin += AXIS_LABEL_GAP + draw.title.ascent + draw.title.descent;
        }
      }
      margins[item.name] = Math.ceil(margin);
    }
    // Labels at the ends of an axis stick out past the plot corners.
    for (const item of sides) {
      const draw = draws.get(item.role === "mirror" ? OPPOSITE[item.name] : item.name);
      if (!item.showLabels || !draw) continue;
      draw.ticks.major.forEach((tick, index) => {
        const label = draw.labels[index];
        if (!label) return;
        const pixel = draw.scale.toPixel(tick.value);
        if (isVertical(item.name)) {
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

  // Grid lines, under everything else.
  for (const name of used) {
    const spec = graph.axes[name];
    const draw = draws.get(name)!;
    if (spec.grid === "off") continue;
    const lines = (values: number[], stroke: string) => {
      const points: number[] = [];
      for (const value of values) {
        const pixel = Math.round(draw.scale.toPixel(value));
        if (isVertical(name)) points.push(plot.x, pixel, right, pixel);
        else points.push(pixel, plot.y, pixel, bottom);
      }
      if (points.length > 0)
        prims.push({ kind: "segments", points, stroke, width: 1, crisp: true });
    };
    if (spec.grid === "all") lines(draw.ticks.minor, GRID_MINOR);
    lines(
      draw.ticks.major.map((tick) => tick.value),
      GRID_MAJOR,
    );
  }

  // Traces, clipped to the data area plus the standoff.
  const clipped: Prim[] = [];
  const clip: Rect = {
    x: plot.x - standoff,
    y: plot.y - standoff,
    w: plot.w + standoff * 2,
    h: plot.h + standoff * 2,
  };
  const geometry: TraceGeometry[] = [];
  for (const { spec, y, x } of traces) {
    const xs = draws.get(spec.hAxis)!.scale;
    const ys = draws.get(spec.vAxis)!.scale;
    const dash = DASHES[spec.lineStyle];
    const item: TraceGeometry = { name: spec.name, runs: [], markers: null };
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
        clipped.push({
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
        const base = Number.isFinite(zero) ? Math.min(bottom, Math.max(plot.y, zero)) : bottom;
        const segments = new Float32Array(points.length * 2);
        for (let index = 0; index < points.length; index += 2) {
          segments.set([points[index]!, points[index + 1]!, points[index]!, base], index * 2);
        }
        clipped.push({
          kind: "segments",
          points: segments,
          stroke: spec.color,
          width: spec.lineSize,
        });
      } else if (spec.mode === "dots") {
        clipped.push({
          kind: "markers",
          points,
          shape: "square",
          size: Math.max(0.75, spec.lineSize),
          fill: spec.color,
          stroke: spec.color,
          width: 0,
        });
      } else {
        clipped.push({
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
    geometry.push(item);
  }
  prims.push({ kind: "clip", ...clip, children: clipped });

  // Axes, ticks and labels.
  const axes: GraphLayout["axes"] = {};
  for (const item of sides) {
    if (item.role === "none") continue;
    const { name } = item;
    const draw = draws.get(item.role === "mirror" ? OPPOSITE[name] : name)!;
    const vertical = isVertical(name);
    // +1 points away from the plot on this side.
    const outward = name === "left" || name === "top" ? -1 : 1;
    const line =
      name === "left"
        ? plot.x - standoff
        : name === "right"
          ? right + standoff
          : name === "top"
            ? plot.y - standoff
            : bottom + standoff;

    // The axis line reaches the neighbouring axes so corners close.
    const reach = (neighbour: AxisName): number => (side(neighbour).role === "none" ? 0 : standoff);
    const segments: number[] = vertical
      ? [line, plot.y - reach("top"), line, bottom + reach("bottom")]
      : [plot.x - reach("left"), line, right + reach("right"), line];

    if (item.showTicks) {
      const mode = item.spec.ticks;
      const addTick = (value: number, length: number) => {
        const pixel = Math.round(draw.scale.toPixel(value));
        const out = mode === "inside" ? 0 : length;
        const inn = mode === "outside" ? 0 : length;
        if (vertical) segments.push(line - inn * outward, pixel, line + out * outward, pixel);
        else segments.push(pixel, line - inn * outward, pixel, line + out * outward);
      };
      for (const tick of draw.ticks.major) addTick(tick.value, MAJOR_TICK);
      for (const value of draw.ticks.minor) addTick(value, MINOR_TICK);
    }
    prims.push({ kind: "segments", points: segments, stroke: INK, width: 1, crisp: true });

    let edge = line + outward * outwardTick(item);
    if (item.showLabels) {
      edge += outward * TICK_LABEL_GAP;
      let extent = 0;
      draw.ticks.major.forEach((tick, index) => {
        const label = draw.labels[index];
        if (!label) return;
        const pixel = draw.scale.toPixel(tick.value);
        if (vertical) {
          extent = Math.max(extent, label.width);
          emitText(prims, label, edge, pixel + cap / 2, {
            align: name === "left" ? 1 : 0,
            family,
            fill: INK,
          });
        } else {
          extent = Math.max(extent, label.ascent, cap);
          const baseline = name === "bottom" ? edge + cap : edge;
          emitText(prims, label, pixel, baseline, { align: 0.5, family, fill: INK });
        }
      });
      edge += outward * extent;
    }
    if (item.role === "axis" && draw.title.width > 0) {
      edge += outward * AXIS_LABEL_GAP;
      const { title } = draw;
      if (vertical) {
        // Reads bottom-to-top on both sides, like Igor.
        const baseline = name === "left" ? edge - title.descent : edge + title.ascent;
        emitText(prims, title, baseline, plot.y + plot.h / 2, {
          align: 0.5,
          rotate: -90,
          family,
          fill: INK,
        });
      } else {
        const baseline = name === "bottom" ? edge + title.ascent : edge - title.descent;
        emitText(prims, title, plot.x + plot.w / 2, baseline, { align: 0.5, family, fill: INK });
      }
    }

    if (item.role === "axis") {
      const hit: Rect = vertical
        ? name === "left"
          ? { x: 0, y: plot.y, w: plot.x, h: plot.h }
          : { x: right, y: plot.y, w: width - right, h: plot.h }
        : name === "top"
          ? { x: plot.x, y: 0, w: plot.w, h: plot.y }
          : { x: plot.x, y: bottom, w: plot.w, h: height - bottom };
      axes[name] = { scale: draw.scale, hit, unit: units.get(name) ?? "" };
    }
  }

  for (const annotation of graph.annotations) {
    emitAnnotation(prims, annotation, graph, plot, measure);
  }

  return { width, height, prims, plot, axes, traces: geometry, missing: [...missing] };
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

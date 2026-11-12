import {
  AXIS_SIDES,
  DATE_UNIT,
  isVerticalSide,
  type Anchor,
  type AnnotationSpec,
  type AxisSide,
  type AxisSpec,
  type ComplexPart,
  type CursorName,
  type GraphSpec,
  type ImageSpec,
  type TraceSpec,
  type Wave,
  type WaveData,
  wavePart,
} from "../doc/types";
import { colorAt, renderCells, renderMatrix } from "./colorTables";
import { chainSegments, contourLevels, contourSegments } from "./contour";
import {
  extentOf,
  markerPixels,
  stemPixels,
  tracePixels,
  visibleRange,
  xExtentOf,
  type Extent,
} from "./decimate";
import { DASHES, type MeasureText, type Prim, type Rect } from "./displayList";
import { emitText, layoutText, CAP_HEIGHT, type TextBlock } from "./richText";
import { makeScale, shiftScale, type Scale } from "./scale";
import {
  axisLabelText,
  categoryTicks,
  dateTicks,
  formatDate,
  formatNumber,
  isTimeZone,
  linearTicks,
  logTicks,
  timeZone,
  UTC,
  type TickSet,
  type TimeZone,
} from "./ticks";

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

export type AxisKind = "number" | "date" | "category";

export interface AxisGeometry {
  side: AxisSide;
  /** How values on the axis read: plain numbers, dates, or category names. */
  kind: AxisKind;
  categories: readonly string[] | null;
  scale: Scale;
  /** Where clicks count as "on this axis". */
  hit: Rect;
  unit: string;
}

export interface TraceGeometry {
  name: string;
  /** The scales the trace is drawn with: its axes', shifted by its offsets. */
  xScale: Scale;
  yScale: Scale;
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

export interface AnnotationGeometry {
  name: string;
  /** The box as drawn, for hit-testing and dragging. */
  box: Rect;
}

export interface GraphLayout {
  width: number;
  height: number;
  prims: Prim[];
  annotations: AnnotationGeometry[];
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
  /** The time zone date axes are labelled in (see DocState.timeZone); UTC if left out. */
  timeZone?: string;
}

const OPPOSITE: Record<AxisSide, AxisSide> = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom",
};

interface ResolvedTrace {
  spec: TraceSpec;
  /** For a category plot this is the Y wave re-scaled to X = 0, 1, 2, ... */
  y: Wave;
  x: Wave | null;
  categories: readonly string[] | null;
  xUnit: string;
}

interface AxisInfo {
  name: string;
  spec: AxisSpec;
  vertical: boolean;
  range: [number, number];
  unit: string;
  kind: AxisKind;
  categories: readonly string[] | null;
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

/** Ticks for an axis, and for a date axis what its labels leave unsaid. */
function ticksFor(
  axis: AxisInfo,
  scale: Scale,
  maxCount: number,
  zone: TimeZone,
): TickSet & { context?: string } {
  if (axis.kind === "category") {
    return categoryTicks(scale.min, scale.max, maxCount, axis.categories ?? []);
  }
  if (axis.kind === "date") {
    const ticks = dateTicks(scale.min, scale.max, maxCount, zone);
    if (ticks) return ticks;
  }
  const { tickFormat: format, tickStep: step } = axis.spec;
  return axis.spec.log
    ? logTicks(scale.min, scale.max, maxCount, format)
    : linearTicks(scale.min, scale.max, maxCount, axis.spec.minor, { step, format });
}

/**
 * The span of the cells of an image along one axis. A log axis starts at the
 * lowest cell edge above zero, so that the cells beyond it are whole.
 */
function cellExtent(origin: number, step: number, count: number): Extent {
  const extent = spanExtent(origin - step / 2, origin + (count - 0.5) * step);
  const width = Math.abs(step);
  if (extent.min <= 0 && extent.max > 0 && width > 0) {
    let edge = extent.min + (Math.floor(-extent.min / width) + 1) * width;
    // An edge that should be at zero but is not quite, by rounding, is the next one up.
    if (edge < width * 1e-9) edge += width;
    if (edge <= extent.max) extent.minPositive = edge;
  }
  return extent;
}

/** The extent of values that are drawn shifted by an offset. */
function shiftExtent(extent: Extent, offset: number, data: WaveData): Extent {
  if (offset === 0 || !Number.isFinite(extent.min)) return extent;
  const min = extent.min + offset;
  const max = extent.max + offset;
  let minPositive = min > 0 ? min : Infinity;
  if (min <= 0 && max > 0) {
    for (let index = 0; index < data.length; index += 1) {
      const value = data[index]! + offset;
      if (value > 0 && value < minPositive) minPositive = value;
    }
  }
  return { min, max, minPositive };
}

/** The usual ratio between neighbouring X values of a trace, for bars on a log axis. */
function barRatio(y: Wave, x: Wave | null): number {
  const extent = xExtentOf(y, x);
  const count = x ? x.data.length : y.data.length;
  return count > 1 && extent.minPositive < extent.max
    ? (extent.max / extent.minPositive) ** (1 / (count - 1))
    : 2;
}

/** The distance between neighbouring bars of a trace, in pixels. */
function barPitch(y: Wave, x: Wave | null, scale: Scale): number {
  if (scale.log) {
    const perDecade = Math.abs((scale.p1 - scale.p0) / Math.log10(scale.max / scale.min));
    return perDecade * Math.log10(barRatio(y, x));
  }
  return barSpacing(y, x) * Math.abs((scale.p1 - scale.p0) / (scale.max - scale.min));
}

/** Per-point colors come in this many steps of the color table. */
const COLOR_BINS = 64;
/** Above this many visible points a line is drawn in one color even if it has a color wave. */
const COLORED_LINE_LIMIT = 20_000;

/** The usual distance between neighbouring points of a trace along X. */
function barSpacing(y: Wave, x: Wave | null): number {
  if (!x) return Math.abs(y.dx);
  const extent = extentOf(x.data);
  const count = x.data.length;
  return count > 1 && Number.isFinite(extent.min) ? (extent.max - extent.min) / (count - 1) : 1;
}

const planeCache = new WeakMap<WaveData, Map<string, WaveData>>();

/**
 * The 2-D plane of a wave that an image or contour shows: the wave itself
 * if it is 2-D, or the chosen layer and chunk of a 3-D or 4-D wave.
 */
export function planeOf(
  wave: Wave,
  layer: number,
  chunk: number,
): { data: WaveData; nx: number; ny: number } | null {
  const [nx, ny, nz = 1, nc = 1] = wave.shape;
  if (wave.shape.length < 2 || nx === undefined || ny === undefined) return null;
  if (layer >= nz || chunk >= nc) return null;
  if (wave.shape.length === 2) return { data: wave.data, nx, ny };
  let planes = planeCache.get(wave.data);
  if (!planes) planeCache.set(wave.data, (planes = new Map()));
  const key = `${layer}|${chunk}`;
  let data = planes.get(key);
  if (!data) {
    if (planes.size >= 8) planes.clear();
    data = new Float64Array(nx * ny);
    const stride = nz * nc;
    const offset = layer * nc + chunk;
    for (let index = 0; index < data.length; index += 1)
      data[index] = wave.data[index * stride + offset]!;
    planes.set(key, data);
  }
  return { data, nx, ny };
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
  if (trace.mode === "bars") {
    out.push({ kind: "rect", x: x + w / 2 - 6, y: y - 4, w: 12, h: 8, fill: trace.color });
    return;
  }
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

const imageCache = new WeakMap<WaveData, Map<string, Uint8ClampedArray<ArrayBuffer>>>();
const contourCache = new WeakMap<WaveData, Map<number, Float64Array[]>>();

/** Samples per pixel along a log axis, which puts each cell edge within a quarter pixel. */
const LOG_IMAGE_DENSITY = 2;

/**
 * Where the cells of an image go along one axis: the pixel span the picture
 * covers and, for each of its pixels from the left or top, the cell shown
 * there (-1 for none). `key` tells apart the ways of sampling, for caching.
 */
interface ImageAxis {
  start: number;
  size: number;
  cells: Int32Array;
  key: string;
}

function imageAxis(scale: Scale, origin: number, step: number, count: number): ImageAxis | null {
  if (count === 0) return null;
  const first = origin - step / 2;
  const last = origin + (count - 0.5) * step;
  if (!scale.log) {
    // Evenly spaced cells: the whole matrix is stretched over its span as it is.
    const a = scale.toPixel(first);
    const b = scale.toPixel(last);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const samples = Math.min(count, IMAGE_LIMIT);
    const cells = new Int32Array(samples);
    for (let at = 0; at < samples; at += 1) {
      const sample = Math.min(count - 1, Math.floor(((at + 0.5) * count) / samples));
      cells[at] = a <= b ? sample : count - 1 - sample;
    }
    return { start: Math.min(a, b), size: Math.abs(b - a), cells, key: `${samples}|${a <= b}` };
  }
  // On a log axis cells are wider at one end than the other, so the part in
  // view is sampled pixel by pixel through the scale. That keeps one picture,
  // without seams between cells, and its size follows the plot, not the data.
  // Cells reaching down to zero or below start where the axis does.
  const from = Math.max(Math.min(first, last), Math.min(scale.min, scale.max));
  const to = Math.min(Math.max(first, last), Math.max(scale.min, scale.max));
  if (!(to > from)) return null;
  const a = scale.toPixel(from);
  const b = scale.toPixel(to);
  const start = Math.min(a, b);
  const size = Math.abs(b - a);
  const samples = Math.max(1, Math.min(IMAGE_LIMIT, Math.ceil(size * LOG_IMAGE_DENSITY)));
  const cells = new Int32Array(samples);
  for (let at = 0; at < samples; at += 1) {
    const cell = Math.round((scale.toValue(start + ((at + 0.5) * size) / samples) - origin) / step);
    cells[at] = cell >= 0 && cell < count ? cell : -1;
  }
  const key = [start, size, samples, scale.min, scale.max, scale.p0, scale.p1, origin, step];
  return { start, size, cells, key: `log|${key.join("|")}` };
}

function cachedMatrix(
  data: WaveData,
  ny: number,
  across: ImageAxis,
  up: ImageAxis,
  options: Parameters<typeof renderCells>[4],
): Uint8ClampedArray<ArrayBuffer> {
  let entries = imageCache.get(data);
  if (!entries) imageCache.set(data, (entries = new Map()));
  const key = [across.key, up.key, ...Object.values(options)].join("|");
  let rgba = entries.get(key);
  if (!rgba) {
    if (entries.size >= 4) entries.clear();
    rgba = renderCells(data, ny, across.cells, up.cells, options);
    entries.set(key, rgba);
  }
  return rgba;
}

function cachedContour(data: WaveData, nx: number, ny: number, level: number): Float64Array[] {
  let entries = contourCache.get(data);
  if (!entries) contourCache.set(data, (entries = new Map()));
  let chains = entries.get(level);
  if (!chains) {
    if (entries.size >= 256) entries.clear();
    chains = chainSegments(contourSegments(data, nx, ny, level));
    entries.set(level, chains);
  }
  return chains;
}

/** A contour line gets one label for about this many pixels of its length, up to four. */
const LABEL_EVERY = 260;

/**
 * Makes room for labels along a line: one in the middle of a short line,
 * several spread evenly along a long one. Returns the pieces of the line
 * between the gaps, and where and at what angle (degrees, kept upright) each
 * label goes; or null if the line is too short for any, or the places for
 * them are all out of view.
 */
function breakForLabels(
  points: Float32Array,
  labelWidth: number,
  area: Rect,
): { parts: Float32Array[]; labels: { x: number; y: number; angle: number }[] } | null {
  const count = points.length / 2;
  if (count < 2) return null;
  const along = new Float64Array(count);
  for (let index = 1; index < count; index += 1) {
    along[index] =
      along[index - 1]! +
      Math.hypot(
        points[index * 2]! - points[index * 2 - 2]!,
        points[index * 2 + 1]! - points[index * 2 - 1]!,
      );
  }
  const total = along[count - 1]!;
  const gap = labelWidth / 2 + 4;
  if (total < labelWidth * 3 + 24) return null;
  /** The point at a distance along the line, and the index of the vertex before it. */
  const at = (distance: number) => {
    let index = 1;
    while (index < count - 1 && along[index]! < distance) index += 1;
    const span = along[index]! - along[index - 1]! || 1;
    const t = (distance - along[index - 1]!) / span;
    return {
      before: index - 1,
      x: points[index * 2 - 2]! + (points[index * 2]! - points[index * 2 - 2]!) * t,
      y: points[index * 2 - 1]! + (points[index * 2 + 1]! - points[index * 2 - 1]!) * t,
    };
  };
  /** The stretch of the line between two distances along it. */
  const piece = (from: number, to: number): Float32Array => {
    const start = at(from);
    const end = at(to);
    const inner = Math.max(0, end.before - start.before);
    const part = new Float32Array((inner + 2) * 2);
    part.set([start.x, start.y]);
    part.set(points.subarray((start.before + 1) * 2, (start.before + 1 + inner) * 2), 2);
    part.set([end.x, end.y], (inner + 1) * 2);
    return part;
  };

  const wanted = Math.max(1, Math.min(4, Math.floor(total / LABEL_EVERY)));
  const inset = labelWidth / 2;
  const parts: Float32Array[] = [];
  const labels: { x: number; y: number; angle: number }[] = [];
  let from = 0;
  for (let index = 0; index < wanted; index += 1) {
    const centre = (total * (index + 0.5)) / wanted;
    const middle = at(centre);
    if (
      middle.x < area.x + inset ||
      middle.x > area.x + area.w - inset ||
      middle.y < area.y + inset ||
      middle.y > area.y + area.h - inset
    ) {
      continue;
    }
    const start = at(centre - gap);
    const end = at(centre + gap);
    let angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    else if (angle < -90) angle += 180;
    parts.push(piece(from, centre - gap));
    labels.push({ x: middle.x, y: middle.y, angle });
    from = centre + gap;
  }
  if (labels.length === 0) return null;
  parts.push(piece(from, total));
  return { parts, labels };
}

/** Moves a box by an annotation's offset, keeping it inside the graph. */
function placeBox(box: Rect, annotation: AnnotationSpec, plot: Rect, bounds: Rect): Rect {
  const x = box.x + annotation.x * plot.w;
  const y = box.y + annotation.y * plot.h;
  return {
    ...box,
    x: Math.round(Math.max(bounds.x, Math.min(bounds.x + bounds.w - box.w, x))),
    y: Math.round(Math.max(bounds.y, Math.min(bounds.y + bounds.h - box.h, y))),
  };
}

function emitColorScale(
  out: Prim[],
  annotation: AnnotationSpec,
  graph: GraphSpec,
  images: readonly ImageInfo[],
  plot: Rect,
  bounds: Rect,
  measure: MeasureText,
): Rect | null {
  const image = images.find((item) => annotation.text === "" || item.spec.name === annotation.text);
  if (!image) return null;
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
  const box = placeBox(
    anchorBox(annotation.anchor, plot, width, height, 8),
    annotation,
    plot,
    bounds,
  );
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
  return box;
}

/** What a tag points at: where it is drawn, and its values for the text. */
interface TagTarget {
  px: number;
  py: number;
  x: number;
  y: number;
  /** Whether the X value is a date, for writing it out. */
  date: boolean;
}

/** The point where the line from a box's middle towards (px, py) leaves the box. */
function boxExit(box: Rect, px: number, py: number): [number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const t = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  return [cx + dx * t, cy + dy * t];
}

function emitAnnotation(
  out: Prim[],
  annotation: AnnotationSpec,
  graph: GraphSpec,
  plot: Rect,
  bounds: Rect,
  measure: MeasureText,
  target: TagTarget | null,
  zone: TimeZone,
): Rect | null {
  const size = graph.fontSize;
  const family = graph.fontFamily;
  const visible = graph.traces.filter((trace) => !trace.hidden);
  const byName = new Map(graph.traces.map((trace) => [trace.name, trace]));
  const tag = annotation.kind === "tag";
  if (tag && !target) return null;

  let text = annotation.text;
  if (tag && target) {
    const x = target.date ? formatDate(target.x, zone) : formatNumber(target.x);
    const y = formatNumber(target.y);
    text = (text === "" ? "{x}, {y}" : text)
      .replaceAll("{x}", x)
      .replaceAll("{y}", y)
      .replaceAll("{point}", String(annotation.point));
  }
  // A legend line is `\s(traceName) text`; with no text at all it lists every trace.
  const source =
    annotation.kind === "legend" && text === ""
      ? visible.map((trace) => `\\s(${trace.name}) ${trace.name}`)
      : text.split("\n");
  const rows = source.map((line) => {
    const match = /^\\s\(([^)]*)\)\s?/.exec(line);
    const trace = match ? (byName.get(match[1]!) ?? null) : null;
    const block = layoutText(match ? line.slice(match[0].length) : line, size, family, measure);
    return { trace, block };
  });
  if (rows.length === 0) return null;

  const symbolWidth = 26;
  const symbolGap = 6;
  const padding = tag ? 4 : 6;
  const rowHeight = Math.round(size * 1.35);
  const hasSymbols = rows.some((row) => row.trace);
  const textX = hasSymbols ? symbolWidth + symbolGap : 0;
  const width = Math.ceil(padding * 2 + textX + Math.max(...rows.map((row) => row.block.width)));
  const height = padding * 2 + rowHeight * rows.length;
  // A tag's box is centred on its point before it is moved; the others sit at their anchor.
  const home: Rect =
    tag && target
      ? { x: target.px - width / 2, y: target.py - height / 2, w: width, h: height }
      : anchorBox(annotation.anchor, plot, width, height, 8);
  const box = placeBox(home, annotation, plot, bounds);

  if (tag && target) {
    // A line from the box to the point, ending in an arrowhead.
    const [fromX, fromY] = boxExit(box, target.px, target.py);
    const length = Math.hypot(target.px - fromX, target.py - fromY);
    const inside =
      target.px >= box.x &&
      target.px <= box.x + box.w &&
      target.py >= box.y &&
      target.py <= box.y + box.h;
    if (!inside && length > 6) {
      const ux = (target.px - fromX) / length;
      const uy = (target.py - fromY) / length;
      const head = Math.min(7, length / 2);
      // Stop short of the point itself, so its marker stays visible.
      const tipX = target.px - ux * 3;
      const tipY = target.py - uy * 3;
      const baseX = tipX - ux * head;
      const baseY = tipY - uy * head;
      out.push({
        kind: "segments",
        points: [fromX, fromY, baseX, baseY],
        stroke: INK,
        width: 1,
      });
      out.push({
        kind: "polygon",
        points: [
          tipX,
          tipY,
          baseX - uy * head * 0.4,
          baseY + ux * head * 0.4,
          baseX + uy * head * 0.4,
          baseY - ux * head * 0.4,
        ],
        fill: INK,
      });
    }
  }
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
  return box;
}

/** Whether the X of a run of pixels only ever goes one way. */
function oneWay(run: Float32Array): boolean {
  let rising = true;
  let falling = true;
  for (let index = 2; index < run.length; index += 2) {
    if (run[index]! < run[index - 2]!) rising = false;
    if (run[index]! > run[index - 2]!) falling = false;
  }
  return rising || falling;
}

/**
 * The part of a run (whose X goes one way) between two X positions, from
 * left to right, with its ends cut where the run crosses them.
 */
function sliceRun(run: Float32Array, lo: number, hi: number): number[] {
  const count = run.length / 2;
  const rising = run[0]! <= run[run.length - 2]!;
  const out: number[] = [];
  let px = Number.NaN;
  let py = Number.NaN;
  for (let step = 0; step < count; step += 1) {
    const at = (rising ? step : count - 1 - step) * 2;
    const x = run[at]!;
    const y = run[at + 1]!;
    if (step > 0) {
      const cut = (edge: number) => out.push(edge, py + ((y - py) * (edge - px)) / (x - px));
      if (px < lo && x > lo) cut(lo);
      if (px < hi && x > hi) cut(hi);
    }
    if (x >= lo && x <= hi) out.push(x, y);
    px = x;
    py = y;
  }
  return out;
}

/** A polygon along one edge and back along the other, both given in the same direction. */
function ring(out: readonly number[], back: readonly number[]): Float32Array {
  const points = new Float32Array(out.length + back.length);
  points.set(out);
  for (let at = 0; at < back.length; at += 2) {
    points[out.length + at] = back[back.length - 2 - at]!;
    points[out.length + at + 1] = back[back.length - 1 - at]!;
  }
  return points;
}

/**
 * The areas between two traces, out along one and back along the other.
 * A gap in either breaks the band, so each area covers only the X that a
 * run of each trace spans, and nothing joins across the missing stretch.
 */
function bandBetween(upper: Float32Array[], lower: Float32Array[]): Float32Array[] {
  const spans = (runs: Float32Array[]) =>
    runs
      .filter((run) => run.length >= 4)
      .map((run) => {
        const ends = [run[0]!, run[run.length - 2]!];
        return { run, lo: Math.min(...ends), hi: Math.max(...ends) };
      })
      .sort((one, other) => one.lo - other.lo);
  const above = spans(upper);
  const below = spans(lower);
  const areas: Float32Array[] = [];
  let i = 0;
  let j = 0;
  while (i < above.length && j < below.length) {
    const a = above[i]!;
    const b = below[j]!;
    const lo = Math.max(a.lo, b.lo);
    const hi = Math.min(a.hi, b.hi);
    if (hi > lo) {
      areas.push(ring(sliceRun(a.run, lo, hi), sliceRun(b.run, lo, hi)));
    }
    if (a.hi < b.hi) i += 1;
    else j += 1;
  }
  return areas;
}

/**
 * The areas between two traces whose X goes back and forth, where X cannot
 * say what lies opposite what: points are paired by index instead, and a
 * point missing from either trace breaks the band.
 */
function bandByIndex(
  one: ResolvedTrace,
  other: ResolvedTrace,
  first: { xs: Scale; ys: Scale },
  second: { xs: Scale; ys: Scale },
): Float32Array[] {
  const count = Math.min(
    one.x ? Math.min(one.y.data.length, one.x.data.length) : one.y.data.length,
    other.x ? Math.min(other.y.data.length, other.x.data.length) : other.y.data.length,
  );
  const areas: Float32Array[] = [];
  let out: number[] = [];
  let back: number[] = [];
  const close = () => {
    if (out.length >= 4) areas.push(ring(out, back));
    out = [];
    back = [];
  };
  for (let index = 0; index < count; index += 1) {
    const ax = first.xs.toPixel(traceX(one.y, one.x, index));
    const ay = first.ys.toPixel(one.y.data[index]!);
    const bx = second.xs.toPixel(traceX(other.y, other.x, index));
    const by = second.ys.toPixel(other.y.data[index]!);
    if ([ax, ay, bx, by].every(Number.isFinite)) {
      out.push(ax, ay);
      back.push(bx, by);
    } else close();
  }
  close();
  return areas;
}

/** The size of an error bar at one point: from a wave, or constant. */
function errorAt(source: string | number | null, waves: Readonly<Record<string, Wave>>) {
  if (source === null) return null;
  if (typeof source === "number") return () => source;
  const data = waves[source]?.data;
  return data ? (index: number) => data[index] ?? Number.NaN : null;
}

/**
 * The waves that position a trace's points. For a category plot (a text X
 * wave) the points sit at 0, 1, 2, ..., expressed here as X scaling.
 */
export function tracePosition(
  trace: { y: string; x: string | null; part?: ComplexPart },
  waves: Readonly<Record<string, Wave>>,
): { y: Wave; x: Wave | null; categories: readonly string[] | null } | null {
  const source = waves[trace.y];
  if (!source) return null;
  // What is plotted of a complex wave is one real number per point.
  const y = wavePart(source, trace.part ?? "real");
  const x = trace.x === null ? null : waves[trace.x];
  if (x === undefined) return null;
  if (x?.text) return { y: { ...y, x0: 0, dx: 1 }, x: null, categories: x.text };
  return { y, x, categories: null };
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
  const zone = isTimeZone(options.timeZone) ? timeZone(options.timeZone) : UTC;

  // Resolve what can be drawn; anything else is reported as missing.
  const missing = new Set<string>();
  const axisOk = (item: { vAxis: string; hAxis: string }) =>
    item.vAxis in graph.axes && item.hAxis in graph.axes;

  const traces: ResolvedTrace[] = [];
  for (const spec of graph.traces) {
    const yWave = waves[spec.y];
    const xWave = spec.x === null ? null : waves[spec.x];
    const yOk = yWave && !yWave.text && yWave.shape.length === 1;
    const xOk = xWave === null || (xWave && xWave.shape.length === 1);
    if (!yOk) missing.add(spec.y);
    if (!xOk && spec.x !== null) missing.add(spec.x);
    if (!yOk || !xOk || !axisOk(spec) || spec.hidden) continue;
    // A text X wave makes a category plot: the points sit at 0, 1, 2, ...
    const categories = xWave?.text ?? null;
    const shown = wavePart(yWave, spec.part);
    traces.push({
      spec,
      y: categories ? { ...shown, x0: 0, dx: 1 } : shown,
      x: categories ? null : (xWave ?? null),
      categories,
      xUnit: categories ? "" : xWave ? xWave.unit : yWave.xUnit,
    });
  }
  const matrices = <
    T extends { wave: string; vAxis: string; hAxis: string; layer: number; chunk: number },
  >(
    items: readonly T[],
  ) =>
    items.flatMap((spec) => {
      const source = waves[spec.wave];
      const wave = source && wavePart(source, "part" in spec ? (spec.part as ComplexPart) : "real");
      const plane = wave && !wave.text ? planeOf(wave, spec.layer, spec.chunk) : null;
      if (!wave || !plane) {
        missing.add(spec.wave);
        return [];
      }
      return axisOk(spec) ? [{ spec, wave, ...plane }] : [];
    });
  const images = matrices(graph.images);
  const contours = matrices(graph.contours);

  // Bars drawn against the same axes share each slot side by side.
  const barGroups = new Map<string, number>();
  const barSlots = new Map<TraceSpec, { index: number; of: () => number }>();
  for (const { spec } of traces) {
    if (spec.mode !== "bars") continue;
    const key = `${spec.hAxis}|${spec.vAxis}`;
    const index = barGroups.get(key) ?? 0;
    barGroups.set(key, index + 1);
    barSlots.set(spec, { index, of: () => barGroups.get(key)! });
  }

  // Data extent and unit per axis in use.
  const extents = new Map<string, Extent>();
  const unitLists = new Map<string, string[]>();
  const categoryLabels = new Map<string, readonly string[]>();
  const feed = (axis: string, extent: Extent, unit: string) => {
    const current = extents.get(axis);
    extents.set(axis, current ? mergeExtent(current, extent) : extent);
    unitLists.set(axis, [...(unitLists.get(axis) ?? []), unit]);
  };
  for (const { spec, y, x, categories, xUnit } of traces) {
    const bars = spec.mode === "bars";
    // Bars and fills grow from zero, so zero belongs in view.
    const fromZero = bars || spec.fill === "zero";
    const up = extentOf(y.data);
    feed(
      spec.vAxis,
      shiftExtent(fromZero ? mergeExtent(up, spanExtent(0, 0)) : up, spec.yOffset, y.data),
      y.unit,
    );
    const across = x
      ? shiftExtent(extentOf(x.data), spec.xOffset, x.data)
      : xExtentOf({ ...y, x0: y.x0 + spec.xOffset }, null);
    let wide = across;
    if (categories || bars) {
      // Room for half a bar beyond the first and last point.
      if (graph.axes[spec.hAxis]!.log) {
        const half = Math.sqrt(barRatio(y, x));
        if (across.minPositive < Infinity) {
          wide = spanExtent(across.minPositive / half, across.max * half);
        }
      } else {
        const half = barSpacing(y, x) / 2;
        wide = spanExtent(across.min - half, across.max + half);
      }
    }
    feed(spec.hAxis, wide, xUnit);
    if (categories && !categoryLabels.has(spec.hAxis)) categoryLabels.set(spec.hAxis, categories);
  }
  for (const { spec, wave, nx, ny } of images) {
    // An image pixel is centred on its scaled position and half a step wide each way.
    feed(spec.hAxis, cellExtent(wave.x0, wave.dx, nx), wave.xUnit);
    feed(spec.vAxis, cellExtent(wave.y0, wave.dy, ny), wave.yUnit);
  }
  for (const { spec, wave, nx, ny } of contours) {
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
    const unit = commonUnit(unitLists.get(name) ?? []);
    const categories = categoryLabels.get(name) ?? null;
    axisList.push({
      name,
      spec,
      vertical: isVerticalSide(spec.side),
      range: axisRange(spec, extent),
      unit,
      kind: categories ? "category" : unit === DATE_UNIT && !spec.log ? "date" : "number",
      categories,
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
      const ends = axis.vertical
        ? [Math.round(plot.y + plot.h * (1 - lo)), Math.round(plot.y + plot.h * (1 - hi))]
        : [Math.round(plot.x + plot.w * lo), Math.round(plot.x + plot.w * hi)];
      // A reversed axis has its lowest value where the highest would be.
      const [p0, p1] = axis.spec.reverse ? [ends[1]!, ends[0]!] : [ends[0]!, ends[1]!];
      const scale = makeScale(axis.range[0], axis.range[1], axis.spec.log, p0, p1);
      const length = Math.abs(p1 - p0);
      // Category axes start with every category and thin out from there.
      let maxCount =
        axis.kind === "category"
          ? Math.min(400, axis.categories?.length ?? 1)
          : Math.min(12, Math.max(2, Math.floor(length / (axis.vertical ? 36 : 64))));
      if (axis.kind === "category" && axis.vertical) {
        maxCount = Math.min(maxCount, Math.max(1, Math.floor(length / (size * 1.3))));
      }
      let ticks = ticksFor(axis, scale, maxCount, zone);
      let labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
      if (!axis.vertical) {
        // Thin the ticks out until neighbouring labels clear each other.
        while (maxCount > 1) {
          const widest = Math.max(0, ...labels.map((label) => label.width));
          const pixels = ticks.major.map((tick) => scale.toPixel(tick.value));
          let spacing = Infinity;
          for (let index = 1; index < pixels.length; index += 1) {
            spacing = Math.min(spacing, Math.abs(pixels[index]! - pixels[index - 1]!));
          }
          if (widest + size * 0.8 <= spacing) break;
          // Ticks at a step the user chose stay where they are.
          if (axis.kind === "number" && !axis.spec.log && axis.spec.tickStep !== null) break;
          maxCount = axis.kind === "category" ? Math.floor(maxCount * 0.7) : maxCount - 1;
          ticks = ticksFor(axis, scale, Math.max(1, maxCount), zone);
          labels = ticks.major.map((tick) => layoutText(tick.label, size, family, measure));
        }
      }
      axis.scale = scale;
      axis.ticks = ticks;
      axis.labels = labels;
      // The automatic label is the unit; for dates it is the day or year the ticks leave out.
      const unitText =
        axis.kind === "date" ? (ticks.context ?? "") : axis.kind === "category" ? "" : axis.unit;
      axis.title = layoutText(
        axisLabelText(axis.spec.label, ticks.exponent, unitText),
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
  for (const { spec, wave, data, nx, ny } of images) {
    const extent = extentOf(data);
    const zMin = spec.zMin ?? (Number.isFinite(extent.min) ? extent.min : 0);
    const zMax = spec.zMax ?? (Number.isFinite(extent.max) ? extent.max : 1);
    imageInfos.push({ spec, zMin, zMax });
    const across = imageAxis(info.get(spec.hAxis)!.scale, wave.x0, wave.dx, nx);
    const up = imageAxis(info.get(spec.vAxis)!.scale, wave.y0, wave.dy, ny);
    if (!across || !up) continue;
    clipped(spec, [
      {
        kind: "image",
        x: across.start,
        y: up.start,
        w: across.size,
        h: up.size,
        cols: across.cells.length,
        rows: up.cells.length,
        rgba: cachedMatrix(data, ny, across, up, {
          table: spec.colorTable,
          zMin,
          zMax,
          reverse: spec.reverse,
        }),
      },
    ]);
  }

  for (const { spec, wave, data, nx, ny } of contours) {
    const extent = extentOf(data);
    const xs = info.get(spec.hAxis)!.scale;
    const ys = info.get(spec.vAxis)!.scale;
    const levels = contourLevels(spec.levels, extent.min, extent.max);
    const children: Prim[] = [];
    const labelSize = size * 0.85;
    const area = clipFor(spec);
    levels.forEach((level, index) => {
      const stroke = spec.colorTable
        ? colorAt(spec.colorTable, levels.length > 1 ? index / (levels.length - 1) : 0.5)
        : spec.color;
      const lines = cachedContour(data, nx, ny, level)
        .map((chain) => {
          const points = new Float32Array(chain.length);
          for (let at = 0; at < chain.length; at += 2) {
            points[at] = xs.toPixel(wave.x0 + chain[at]! * wave.dx);
            points[at + 1] = ys.toPixel(wave.y0 + chain[at + 1]! * wave.dy);
          }
          return points;
        })
        .sort((one, other) => other.length - one.length);
      // The level is written on every line long enough to take it, more than once on long ones.
      const text = spec.labels
        ? layoutText(formatNumber(Number(level.toPrecision(6))), labelSize, family, measure)
        : null;
      for (const points of lines) {
        const broken = text ? breakForLabels(points, text.width, area) : null;
        for (const part of broken ? broken.parts : [points]) {
          if (part.length >= 4) {
            children.push({ kind: "polyline", points: part, stroke, width: spec.lineSize });
          }
        }
        for (const label of text && broken ? broken.labels : []) {
          const angle = (label.angle * Math.PI) / 180;
          const drop = (labelSize * CAP_HEIGHT) / 2;
          emitText(
            children,
            text!,
            label.x - Math.sin(angle) * drop,
            label.y + Math.cos(angle) * drop,
            {
              align: 0.5,
              rotate: label.angle,
              family,
              fill: stroke,
            },
          );
        }
      }
    });
    clipped(spec, children);
  }

  const scalesOf = (spec: TraceSpec) => ({
    xs: shiftScale(info.get(spec.hAxis)!.scale, spec.xOffset),
    ys: shiftScale(info.get(spec.vAxis)!.scale, spec.yOffset),
  });
  /**
   * Where a trace's zero is drawn: at zero if that is on the axis, else at the
   * nearer end. A log axis has no zero; there it is the end with the smallest
   * value, which is at the top when the axis is reversed.
   */
  const baseline = (ys: Scale): number => {
    const low = Math.max(ys.p0, ys.p1);
    const high = Math.min(ys.p0, ys.p1);
    if (ys.log) return ys.min <= ys.max ? ys.p0 : ys.p1;
    const zero = ys.toPixel(0);
    return Number.isFinite(zero) ? Math.min(low, Math.max(high, zero)) : low;
  };
  const pixelRuns = new Map<TraceSpec, Float32Array[]>();
  const runsOf = (trace: ResolvedTrace): Float32Array[] => {
    let runs = pixelRuns.get(trace.spec);
    if (!runs) {
      const { xs, ys } = scalesOf(trace.spec);
      runs = tracePixels(trace.y, trace.x, xs, ys).runs;
      if (trace.spec.mode === "cityscape") {
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
      pixelRuns.set(trace.spec, runs);
    }
    return runs;
  };

  const geometry: TraceGeometry[] = [];
  traces.forEach((trace, order) => {
    const { spec, y, x } = trace;
    const { xs, ys } = scalesOf(spec);
    const clip = clipFor(spec);
    const children: Prim[] = [];
    const dash = DASHES[spec.lineStyle];
    const item: TraceGeometry = {
      name: spec.name,
      xScale: xs,
      yScale: ys,
      runs: [],
      markers: null,
    };

    // The colors of the points, when a wave gives them: a function from a
    // point's index to its step in the color table (-1: no color, use the trace's).
    const zWave = spec.colorWave === null ? undefined : waves[spec.colorWave];
    let binOf: ((index: number) => number) | null = null;
    if (zWave && !zWave.text) {
      const extent = extentOf(zWave.data);
      const zMin = spec.colorMin ?? extent.min;
      const zMax = spec.colorMax ?? extent.max;
      const span = zMax - zMin;
      binOf = (index) => {
        const z = zWave.data[index];
        if (z === undefined || Number.isNaN(z)) return -1;
        const fraction = span > 0 ? (z - zMin) / span : 0.5;
        return Math.max(0, Math.min(COLOR_BINS - 1, Math.floor(fraction * COLOR_BINS)));
      };
    } else if (spec.colorWave !== null) {
      missing.add(spec.colorWave);
    }
    const binColor = (bin: number): string =>
      bin < 0 ? spec.color : colorAt(spec.colorTable, (bin + 0.5) / COLOR_BINS);
    /** Splits points (x, y pairs or longer groups of `stride` numbers) by color. */
    const byColor = (points: ArrayLike<number>, indices: readonly number[], stride: number) => {
      const groups = new Map<number, number[]>();
      indices.forEach((index, at) => {
        const bin = binOf!(index);
        let group = groups.get(bin);
        if (!group) groups.set(bin, (group = []));
        for (let part = 0; part < stride; part += 1) group.push(points[at * stride + part]!);
      });
      return [...groups].sort(([one], [other]) => one - other);
    };

    // The area under the trace, behind everything else of it.
    if (spec.fill !== "none") {
      const fill = spec.fillColor ?? spec.color;
      const opacity = spec.fillOpacity;
      const upper = runsOf(trace);
      if (spec.fill === "zero") {
        const base = baseline(ys);
        for (const run of upper) {
          if (run.length < 4) continue;
          const points = new Float32Array(run.length + 4);
          points.set(run);
          points.set([run[run.length - 2]!, base, run[0]!, base], run.length);
          children.push({ kind: "polygon", points, fill, opacity });
        }
      } else {
        // Out along this trace and back along the next one, if they share axes.
        const next = traces[order + 1];
        if (next && next.spec.hAxis === spec.hAxis && next.spec.vAxis === spec.vAxis) {
          const lower = runsOf(next);
          const areas =
            upper.every(oneWay) && lower.every(oneWay)
              ? bandBetween(upper, lower)
              : bandByIndex(trace, next, scalesOf(spec), scalesOf(next.spec));
          for (const points of areas) children.push({ kind: "polygon", points, fill, opacity });
        }
      }
    }

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
      const runs = runsOf(trace);
      item.runs = runs;
      const { first, last } = visibleRange(y, x, xs.min, xs.max);
      if (binOf && spec.mode !== "cityscape" && last - first < COLORED_LINE_LIMIT) {
        // Each piece of the line takes the color of the point it starts from.
        const pieces: number[] = [];
        const starts: number[] = [];
        let fromX = Number.NaN;
        let fromY = Number.NaN;
        for (let index = first; index <= last; index += 1) {
          const px = xs.toPixel(traceX(y, x, index));
          const py = ys.toPixel(y.data[index]!);
          if (Number.isFinite(fromX) && Number.isFinite(fromY) && Number.isFinite(px + py)) {
            pieces.push(fromX, fromY, px, py);
            starts.push(index - 1);
          }
          fromX = px;
          fromY = py;
        }
        for (const [bin, points] of byColor(pieces, starts, 4)) {
          children.push({
            kind: "segments",
            points: Float32Array.from(points),
            stroke: binColor(bin),
            width: spec.lineSize,
            dash,
          });
        }
      } else {
        for (const run of runs) {
          children.push({
            kind: "polyline",
            points: run,
            stroke: spec.color,
            width: spec.lineSize,
            dash,
          });
        }
      }
    }
    if (spec.mode !== "lines" && spec.mode !== "cityscape") {
      const indices: number[] = [];
      const points = markerPixels(y, x, xs, ys, clip, indices);
      item.markers = points;
      // Bars share each slot: together they fill 80% of the distance between points.
      let barWidth = 0;
      let shift = 0;
      if (spec.mode === "bars") {
        const slot = barSlots.get(spec)!;
        const count = slot.of();
        const pitch = barPitch(y, x, info.get(spec.hAxis)!.scale);
        barWidth = Math.max(1, (pitch * 0.8) / count);
        shift = (slot.index - (count - 1) / 2) * barWidth;
      }
      // Bars and sticks off the ends of the Y range are cut off at the edge, not left out.
      const stemIndices: number[] = [];
      const stems =
        spec.mode === "bars" || spec.mode === "sticks"
          ? stemPixels(y, x, xs, ys, Math.abs(shift) + barWidth / 2 + spec.lineSize, stemIndices)
          : null;
      const shown = stems ?? points;
      const shownIndices = stems ? stemIndices : indices;
      // One group in the trace's color, or one per color when a wave gives them.
      const groups: [string, ArrayLike<number>][] = binOf
        ? byColor(shown, shownIndices, 2).map(([bin, group]) => [binColor(bin), group])
        : [[spec.color, shown]];
      for (const [color, group] of groups) {
        if (spec.mode === "bars") {
          const base = baseline(ys);
          for (let index = 0; index < group.length; index += 2) {
            const top = group[index + 1]!;
            children.push({
              kind: "rect",
              x: group[index]! + shift - barWidth / 2,
              y: Math.min(top, base),
              w: barWidth,
              h: Math.abs(top - base),
              fill: color,
            });
          }
        } else if (spec.mode === "sticks") {
          // Sticks run from each point to zero, or to the axis if zero is off-scale.
          const base = baseline(ys);
          const segments = new Float32Array(group.length * 2);
          for (let index = 0; index < group.length; index += 2) {
            segments.set([group[index]!, group[index + 1]!, group[index]!, base], index * 2);
          }
          children.push({
            kind: "segments",
            points: segments,
            stroke: color,
            width: spec.lineSize,
          });
        } else if (spec.mode === "dots") {
          children.push({
            kind: "markers",
            points: group,
            shape: "square",
            size: Math.max(0.75, spec.lineSize),
            fill: color,
            stroke: color,
            width: 0,
          });
        } else {
          children.push({
            kind: "markers",
            points: group,
            shape: spec.marker,
            size: spec.markerSize,
            fill: spec.markerFill ? color : null,
            stroke: color,
            width: Math.max(1, spec.lineSize),
          });
        }
      }
    }
    clipped(spec, children);
    geometry.push(item);
  });

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
      kind: axis.kind,
      categories: axis.categories,
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
      const scales = scalesOf(trace.spec);
      const x = scales.xs.toPixel(traceX(trace.y, trace.x, cursor.point));
      const y = scales.ys.toPixel(trace.y.data[cursor.point]!);
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
          // On whole pixels, so the cross is sharp wherever the point falls.
          crisp: true,
        },
      ];
      emitText(mark, layoutText(name, 10, family, measure), x + 7, y - 7, { family, fill: INK });
      prims.push({ kind: "clip", ...clipFor(trace.spec), children: mark });
    }
  }

  const bounds: Rect = { x: 0, y: 0, w: width, h: height };
  const annotations: AnnotationGeometry[] = [];
  for (const annotation of graph.annotations) {
    let box: Rect | null;
    if (annotation.kind === "colorscale") {
      box = emitColorScale(prims, annotation, graph, imageInfos, plot, bounds, measure);
    } else {
      let target: TagTarget | null = null;
      const trace = traces.find((item) => item.spec.name === annotation.trace);
      if (annotation.kind === "tag" && trace && annotation.point < trace.y.data.length) {
        const scales = scalesOf(trace.spec);
        const x = traceX(trace.y, trace.x, annotation.point);
        const y = trace.y.data[annotation.point]!;
        const px = scales.xs.toPixel(x);
        const py = scales.ys.toPixel(y);
        const area = clipFor(trace.spec);
        // A tag whose point is out of view is not drawn.
        if (px >= area.x && px <= area.x + area.w && py >= area.y && py <= area.y + area.h) {
          target = { px, py, x, y, date: info.get(trace.spec.hAxis)!.kind === "date" };
        }
      }
      box = emitAnnotation(prims, annotation, graph, plot, bounds, measure, target, zone);
    }
    if (box) annotations.push({ name: annotation.name, box });
  }

  return {
    width,
    height,
    prims,
    annotations,
    plot,
    axes,
    traces: geometry,
    cursors,
    missing: [...missing],
  };
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

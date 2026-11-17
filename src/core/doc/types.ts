import { emptyPythonEnv, type PythonEnv } from "./pythonEnv";
import { dict, type Dict } from "./dict";
import type { AnalysisTemplate, TemplateRun } from "./analysisTemplates";
import type { AnalysisResult } from "./results";

/** The number types a wave can hold, named as NumPy names them. */
export const WAVE_TYPES = [
  "float64",
  "float32",
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "complex128",
  "complex64",
] as const;
export type WaveType = (typeof WAVE_TYPES)[number];

/** How a wave's numbers are held in memory: one typed array per type. */
export type WaveData =
  | Float64Array
  | Float32Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

const ARRAY_OF = {
  float64: Float64Array,
  float32: Float32Array,
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  // A complex wave keeps its real and imaginary parts in two arrays.
  complex128: Float64Array,
  complex64: Float32Array,
} as const;

/** The smallest and largest value of each integer type. */
const INTEGER_RANGE: Partial<Record<WaveType, readonly [number, number]>> = {
  int8: [-128, 127],
  uint8: [0, 255],
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};

export const isComplexType = (type: WaveType): boolean => type.startsWith("complex");
export const isIntegerType = (type: WaveType): boolean => type in INTEGER_RANGE;

/** An array of zeros of the kind that holds a type (one part of it, for a complex type). */
export function newWaveData(type: WaveType, length: number): WaveData {
  return new ARRAY_OF[type](length);
}

/**
 * Writes values into wave data. Into an integer type they are rounded to the
 * nearest whole number and held at the ends of its range, as Igor does; what
 * is not a number becomes 0.
 */
export function storeValues(
  target: WaveData,
  type: WaveType,
  values: ArrayLike<number>,
  start = 0,
): void {
  const range = INTEGER_RANGE[type];
  if (!range) {
    target.set(values, start);
    return;
  }
  const [low, high] = range;
  for (let index = 0; index < values.length; index += 1) {
    const value = Math.round(values[index]!);
    target[start + index] = value < low ? low : value > high ? high : value || 0;
  }
}

/** Values as wave data of a type; the same array if it is of that kind already. */
export function toWaveData(values: ArrayLike<number>, type: WaveType): WaveData {
  if (values instanceof ARRAY_OF[type]) return values;
  const data = newWaveData(type, values.length);
  storeValues(data, type, values);
  return data;
}

/** The type that a typed array holds, real or as one part of a complex wave. */
export function typeOfData(data: WaveData, complex = false): WaveType {
  if (complex) return data instanceof Float32Array ? "complex64" : "complex128";
  for (const type of WAVE_TYPES) {
    if (data instanceof ARRAY_OF[type]) return type;
  }
  return "float64";
}

/**
 * A named array with scaling, in the style of an Igor wave.
 *
 * A wave is numeric (1 to 4 dimensions, values in `data` in C order: the last
 * index varies fastest) or text (1-D, values in `text`). The first two
 * dimensions have scaling: index i along dimension 0 is at X = x0 + i*dx, and
 * index j along dimension 1 is at Y = y0 + j*dy.
 */
export interface Wave {
  /** Path below root, with ":" between data folders: "signal" or "run1:signal". */
  readonly name: string;
  /**
   * Numeric values, in the typed array of the wave's type; for a complex
   * wave, the real parts. Empty for a text wave.
   */
  readonly data: WaveData;
  /** The imaginary parts of a complex wave, as long as `data`; null otherwise. */
  readonly imag: WaveData | null;
  /** The number type. "float64" for a text wave, where it means nothing. */
  readonly type: WaveType;
  /** Text values, or null for a numeric wave. */
  readonly text: readonly string[] | null;
  readonly shape: readonly number[];
  readonly x0: number;
  readonly dx: number;
  readonly xUnit: string;
  readonly y0: number;
  readonly dy: number;
  readonly yUnit: string;
  /** Unit of the stored values. */
  readonly unit: string;
  readonly note: string;
  /**
   * Changes every time the wave's content changes (values, shape, scaling,
   * units, note, name); unique across all waves. Not when only its formula
   * changes: that is about where the values come from, not what they are.
   */
  readonly rev: number;
  /** The formula that gives the wave its values (see ./formula); absent when it has none. */
  readonly formula?: Formula;
}

/**
 * A wave's formula: an expression of other waves that its values are
 * computed from (Igor's dependency formula, `R := V / I`).
 *
 * Whether the values are up to date is told by revisions: `rev` is the
 * wave's own revision once the values were written, and `inputs` the
 * revision of each input then. Both change whenever their wave does and are
 * never reused, so the values are up to date exactly when all of them still
 * match. Revisions do not survive saving, so the file keeps only whether the
 * values were out of date then.
 */
export interface Formula {
  /** As it was typed (rewritten only when an input is renamed). */
  readonly expr: string;
  /** Recomputed whenever an input changes; otherwise only when asked to (Recalculate). */
  readonly auto: boolean;
  /** The revision of each input wave when last computed: null for one that did not exist. */
  readonly inputs: Dict<number | null>;
  /** The wave's own revision as the last computation left it. */
  readonly rev: number;
  /** Why the last computation failed, or null. The values are still those from before it. */
  readonly error: string | null;
  /** How many points of the last computation were divided by zero, and so are NaN. */
  readonly zeroDivisions: number;
}

/** The unit that marks values as dates: seconds since 1970-01-01 UTC. As in Igor. */
export const DATE_UNIT = "dat";

/** Number of elements along the first dimension. */
export const waveRows = (wave: Wave): number => wave.shape[0] ?? 0;
export const isTextWave = (wave: Wave): boolean => wave.text !== null;

export const AXIS_SIDES = ["left", "bottom", "right", "top"] as const;
export type AxisSide = (typeof AXIS_SIDES)[number];
export const isVerticalSide = (side: AxisSide): boolean => side === "left" || side === "right";

export const TRACE_MODES = [
  "lines",
  "markers",
  "lines+markers",
  "sticks",
  "dots",
  "cityscape",
  "bars",
] as const;
export type TraceMode = (typeof TRACE_MODES)[number];

export const LINE_STYLES = ["solid", "dash", "dot", "dashdot"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const MARKER_SHAPES = ["circle", "square", "triangle", "diamond", "cross", "plus"] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];

/** Which real number a complex value is shown as. */
export const COMPLEX_PARTS = ["real", "imag", "magnitude", "phase"] as const;
export type ComplexPart = (typeof COMPLEX_PARTS)[number];

const partCache = new WeakMap<Wave, Map<ComplexPart, Float64Array>>();

/**
 * A wave as the real numbers to show for it: itself, unless it is complex
 * and another part than the real one is wanted. Phase is in radians.
 */
export function wavePart(wave: Wave, part: ComplexPart): Wave {
  const { imag } = wave;
  if (part === "real" || !imag) return wave.imag ? { ...wave, imag: null } : wave;
  let parts = partCache.get(wave);
  if (!parts) partCache.set(wave, (parts = new Map()));
  let data = parts.get(part);
  if (!data) {
    const real = wave.data;
    data = new Float64Array(real.length);
    for (let index = 0; index < data.length; index += 1) {
      data[index] =
        part === "imag"
          ? imag[index]!
          : part === "magnitude"
            ? Math.hypot(real[index]!, imag[index]!)
            : Math.atan2(imag[index]!, real[index]!);
    }
    parts.set(part, data);
  }
  return { ...wave, data, imag: null };
}

/** What the area under a trace is filled down (or up) to. */
export const FILL_MODES = ["none", "zero", "next"] as const;
export type FillMode = (typeof FILL_MODES)[number];

/** An error bar size: the name of a wave with one value per point, or a constant. */
export type ErrorSource = string | number | null;

export interface TraceStyle {
  mode: TraceMode;
  /** Always normalized to `#rrggbb`. */
  color: string;
  lineSize: number;
  lineStyle: LineStyle;
  marker: MarkerShape;
  markerSize: number;
  /** Filled markers when true, outlined when false. */
  markerFill: boolean;
  hidden: boolean;
  /** Symmetric error bars in Y and X. */
  yError: ErrorSource;
  xError: ErrorSource;
  /**
   * Fills the area between the trace and zero, or between it and the next
   * trace of the graph (for a band between two curves).
   */
  fill: FillMode;
  /** null fills with the trace's own color. */
  fillColor: string | null;
  fillOpacity: number;
  /** Added to every point where it is drawn; the wave is not changed. */
  xOffset: number;
  yOffset: number;
  /**
   * A wave with one value per point that colors the trace point by point
   * through `colorTable`, from `colorMin` to `colorMax` (null follows the wave).
   */
  colorWave: string | null;
  colorTable: ColorTable;
  colorMin: number | null;
  colorMax: number | null;
  /** For a complex Y wave: the part of each value that is plotted. */
  part: ComplexPart;
  /**
   * A wave with one value per point (text, or numbers that are written out)
   * whose values are drawn at the points instead of markers, as Igor's text
   * markers are: labels placed in data coordinates.
   */
  textMarker: string | null;
  /** Which point of each label sits on its data point: "MC" centres it, "RC" puts it to the left. */
  textAnchor: Anchor;
  /** The size of the labels; null is the graph's font size. */
  textSize: number | null;
  /** Degrees clockwise the labels are turned about their anchor. */
  textRotation: number;
}

export interface TraceSpec extends TraceStyle {
  /** Unique within the graph: the Y wave's own name, plus `#n` for repeats. */
  name: string;
  y: string;
  /**
   * X wave name, or null to use the Y wave's X scaling. A text wave here
   * makes a category plot: the points are spaced evenly and labelled with
   * the text.
   */
  x: string | null;
  /** Names of the axes the trace is plotted against. */
  vAxis: string;
  hAxis: string;
}

export const COLOR_TABLES = ["grays", "viridis", "plasma", "hot", "rainbow", "bluered"] as const;
export type ColorTable = (typeof COLOR_TABLES)[number];

/**
 * A wave shown as an image: dimension 0 along the horizontal axis and
 * dimension 1 along the vertical. For a wave of 3 or 4 dimensions, `layer`
 * and `chunk` pick the plane to show (indices along dimensions 2 and 3).
 */
export interface ImageSpec {
  name: string;
  wave: string;
  vAxis: string;
  hAxis: string;
  layer: number;
  chunk: number;
  colorTable: ColorTable;
  /** Values mapped to the ends of the color table; null follows the data. */
  zMin: number | null;
  zMax: number | null;
  reverse: boolean;
  /** For a complex wave: the part of each value that is shown. */
  part: ComplexPart;
}

/** Contour lines of one plane of a wave (see {@link ImageSpec}). */
export interface ContourSpec {
  name: string;
  wave: string;
  vAxis: string;
  hAxis: string;
  layer: number;
  chunk: number;
  /** Writes each level's value on its line. */
  labels: boolean;
  /** How many levels to choose automatically, or the level values themselves. */
  levels: number | readonly number[];
  color: string;
  lineSize: number;
  /** Colors the lines by level instead of using `color`. */
  colorTable: ColorTable | null;
}

export const MIRROR_MODES = ["off", "on", "ticks", "labels"] as const;
export type MirrorMode = (typeof MIRROR_MODES)[number];
export const TICK_MODES = ["outside", "inside", "crossing", "none"] as const;
export type TickMode = (typeof TICK_MODES)[number];
export const GRID_MODES = ["off", "major", "all"] as const;
export type GridMode = (typeof GRID_MODES)[number];
export const LABEL_STYLES = ["plain", "italic", "bold", "bold italic"] as const;
export type LabelStyle = (typeof LABEL_STYLES)[number];
/**
 * Which labels an axis shows, as Igor's noLabel: on, both the tick labels and
 * the axis label (noLabel=0); axis only, the axis label without tick labels
 * (noLabel=1); off, neither (noLabel=2). The axis line and its ticks stay.
 */
export const AXIS_LABEL_MODES = ["on", "axis only", "off"] as const;
export type AxisLabelMode = (typeof AXIS_LABEL_MODES)[number];

export interface AxisSpec {
  /** Which edge of the plot the axis belongs to. Fixed when the axis is made. */
  side: AxisSide;
  /** null means automatic (derived from wave units). */
  label: string | null;
  /** Font size of the label; null is the graph's. Codes in the label can change it further. */
  labelSize: number | null;
  /** The style the whole label is set in, before any codes in it. */
  labelStyle: LabelStyle;
  /**
   * How far the axis label is turned from where its side sets it, in degrees
   * (Igor's lblRot), clockwise: the label of a left axis reads upwards, of a
   * right axis downwards, of a bottom or top axis across. 180 turns it round.
   */
  labelRotation: number;
  /** Font size of the tick labels; null is the graph's. */
  tickLabelSize: number | null;
  /** Which labels are drawn: all, the axis label only, or none (see {@link AXIS_LABEL_MODES}). */
  labels: AxisLabelMode;
  /** null means autoscale to the data. */
  min: number | null;
  max: number | null;
  log: boolean;
  /** off: no opposite axis; on: plain line; ticks: line with ticks; labels: ticks and labels. */
  mirror: MirrorMode;
  /**
   * Draws the axis line. Off, only its ticks and labels are drawn: with no
   * ticks and labels "off" too, the axis is not drawn at all, as for a
   * ternary diagram drawn with traces.
   */
  line: boolean;
  ticks: TickMode;
  minor: boolean;
  grid: GridMode;
  /** Runs high to low: the largest value at the left or the bottom. */
  reverse: boolean;
  /** Distance between major ticks; null chooses one. For plain number axes that are not log. */
  tickStep: number | null;
  /**
   * How tick labels are written, in the style of a Python format spec:
   * ".2f", "e", ".1e", "g", ",.0f", "%". null factors a power of 1000 out
   * of the labels and shows it once on the axis.
   */
  tickFormat: string | null;
  /**
   * The part of the plot area the axis covers, as fractions from 0 (bottom or
   * left) to 1. Axes with separate spans stack plots in one graph.
   */
  span: readonly [number, number];
}

export const ANCHORS = ["LT", "MT", "RT", "LC", "MC", "RC", "LB", "MB", "RB"] as const;
export type Anchor = (typeof ANCHORS)[number];

export const ANNOTATION_KINDS = ["legend", "text", "colorscale", "tag"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export interface AnnotationSpec {
  name: string;
  kind: AnnotationKind;
  /**
   * legend: empty lists every trace. text: the text itself.
   * colorscale: the image it describes (empty for the first image).
   * tag: the text, in which {x}, {y} and {point} stand for the point's
   * values; empty shows "x, y".
   */
  text: string;
  anchor: Anchor;
  frame: boolean;
  /**
   * How far the box has been moved from where it would sit, as fractions of
   * the plot area's width and height. For a tag this is the way from its
   * point to the middle of its box.
   */
  x: number;
  y: number;
  /** For a tag: the trace and the point on it that the tag is attached to. */
  trace: string | null;
  point: number;
}

export const DRAWING_KINDS = [
  "line",
  "arrow",
  "rect",
  "roundrect",
  "oval",
  "polygon",
  "text",
] as const;
export type DrawingKind = (typeof DRAWING_KINDS)[number];
/** How a drawing's points are given: as fractions of the plot area, or as values on its axes. */
export const DRAWING_COORDS = ["plot", "axes"] as const;
export type DrawingCoords = (typeof DRAWING_COORDS)[number];
/** Behind the traces (over the grid), or in front of everything but the legends and text boxes. */
export const DRAWING_LAYERS = ["back", "front"] as const;
export type DrawingLayer = (typeof DRAWING_LAYERS)[number];
export const ARROW_ENDS = ["none", "end", "start", "both"] as const;
export type ArrowEnds = (typeof ARROW_ENDS)[number];

/**
 * A shape or text drawn on a graph, as Igor's drawing tools draw them
 * (DrawLine, DrawRect, DrawOval, DrawPoly, DrawText).
 */
export interface DrawingSpec {
  /** Unique in its graph: "draw0", "draw1", ... */
  name: string;
  kind: DrawingKind;
  /**
   * x0, y0, x1, y1, ...: the two ends of a line or arrow, two opposite
   * corners of a rectangle or oval, the corners of a polygon, the top left
   * corner of text. With `coords` "plot", fractions of the plot area from its
   * top left corner (0 to 1 across and down, beyond for outside it); with
   * "axes", values on `hAxis` and `vAxis`, so that the drawing moves with the data.
   */
  points: readonly number[];
  coords: DrawingCoords;
  hAxis: string;
  vAxis: string;
  /** Always normalized to `#rrggbb`. */
  color: string;
  /** In pixels; 0 draws no outline. */
  lineSize: number;
  lineStyle: LineStyle;
  /** The fill of a closed shape, or null for none. */
  fill: string | null;
  fillOpacity: number;
  /** Which ends of a line have arrowheads. */
  arrow: ArrowEnds;
  /** A polygon closes back to its first corner; open, it is a line through its corners. */
  closed: boolean;
  text: string;
  /** The size of text; null is the graph's font size. */
  textSize: number | null;
  layer: DrawingLayer;
}

/** A new drawing of a kind, before what it is given. */
export const defaultDrawing = (
  kind: DrawingKind,
): Omit<DrawingSpec, "name" | "kind" | "points"> => ({
  coords: "plot",
  hAxis: "bottom",
  vAxis: "left",
  color: "#000000",
  lineSize: 1,
  lineStyle: "solid",
  fill: null,
  fillOpacity: 1,
  arrow: kind === "arrow" ? "end" : "none",
  closed: true,
  text: "",
  textSize: null,
  layer: "front",
});

/** Where a new tag's box sits relative to its point, in plot fractions. */
export const TAG_OFFSET = { x: 0.08, y: -0.14 } as const;

export const CURSOR_NAMES = ["A", "B"] as const;
export type CursorName = (typeof CURSOR_NAMES)[number];

/** A cursor sits on one point of one trace. */
export interface CursorSpec {
  trace: string;
  point: number;
}

export interface GraphStyle {
  fontSize: number;
  fontFamily: string;
  /** Shows the cursor readout bar under the graph. */
  showInfo: boolean;
  /**
   * The margins around the plot area, in points, as Igor's ModifyGraph
   * margin: null leaves a side automatic, as wide as its axes and their
   * labels need. A fixed margin may cut labels off, or leave room to spare.
   */
  marginLeft: number | null;
  marginBottom: number | null;
  marginRight: number | null;
  marginTop: number | null;
  /**
   * How much bigger the graph is drawn in its window than it is, as Igor's
   * ModifyGraph expand: 2 shows it twice as big. Only the window shows it;
   * the graph's figure, and what is exported, keep their own size.
   */
  magnification: number;
}

/** The margins of a graph by side, as they are named in its properties. */
export const MARGIN_PROPS = {
  left: "marginLeft",
  bottom: "marginBottom",
  right: "marginRight",
  top: "marginTop",
} as const satisfies Record<AxisSide, keyof GraphStyle>;

/** The magnifications the Modify Graph dialog offers, as Igor's; 1 is none. */
export const MAGNIFICATIONS = [
  0.125, 0.25, 0.5, 0.667, 0.75, 1, 1.333, 1.5, 1.75, 2, 3, 4, 5, 8,
] as const;
export const MIN_MAGNIFICATION = 0.125;
export const MAX_MAGNIFICATION = 8;
/** The longest a margin can be, in points (5 inches). */
export const MAX_MARGIN = 360;

/** The units a length on paper is given in: points (1/72 inch), centimetres and inches. */
export const LENGTH_UNITS = ["pt", "cm", "inch"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

export const PLOT_SIZE_MODES = ["auto", "absolute", "aspect", "plan", "perUnit"] as const;
export type PlotSizeMode = (typeof PLOT_SIZE_MODES)[number];

/**
 * How one side of the plot area (the rectangle the axes enclose) is sized,
 * as Igor's ModifyGraph width and height:
 *
 * - auto: what the window leaves after the margins (width=0).
 * - absolute: a length on paper (width=n).
 * - aspect: `factor` times the other side (width={Aspect, f}).
 * - plan: one unit of the horizontal axis `hAxis` is `factor` times as long
 *   as one unit of the vertical axis `vAxis` for the width, and the other
 *   way round for the height; 1 scales both alike (width={Plan, f, h, v}).
 * - perUnit: `value` `unit`s for each unit of `axis` (width={perUnit, n, axis}).
 *
 * A unit of a log axis is a decade. Aspect and plan depend on the other
 * side, so the two sides cannot both use them.
 */
export type PlotDimension =
  | { mode: "auto" }
  | { mode: "absolute"; value: number; unit: LengthUnit }
  | { mode: "aspect"; factor: number }
  | { mode: "plan"; factor: number; hAxis: string; vAxis: string }
  | { mode: "perUnit"; value: number; unit: LengthUnit; axis: string };

export const AUTO_SIZE: PlotDimension = { mode: "auto" };

/** Whether a side of the plot area is sized from the other side. */
export const dependsOnOther = (dimension: PlotDimension): boolean =>
  dimension.mode === "aspect" || dimension.mode === "plan";

/** The axes a side of the plot area is sized by. */
export function sizeAxes(dimension: PlotDimension): string[] {
  if (dimension.mode === "plan") return [dimension.hAxis, dimension.vAxis];
  if (dimension.mode === "perUnit") return [dimension.axis];
  return [];
}

/**
 * Graphs linked to look at the same thing: zooming or panning one zooms the
 * others alike (the bottom axis, and the left with "xy"), and with
 * `cursors` a cursor set on one is set on the others at the point nearest
 * the same X. The graphs of a group share its name.
 */
export interface GraphLink {
  group: string;
  axes: "x" | "xy";
  cursors: boolean;
}

export interface GraphSpec extends GraphStyle {
  name: string;
  /** The graphs this one is linked to (see {@link GraphLink}), or null. */
  link: GraphLink | null;
  /** The width of the plot area (see {@link PlotDimension}); auto follows the window. */
  width: PlotDimension;
  /** The height of the plot area. */
  height: PlotDimension;
  /**
   * The style (see {@link StyleSpec}) last given to the graph, or null.
   * Traces and axes added to the graph later take their look from it.
   */
  style: string | null;
  traces: readonly TraceSpec[];
  images: readonly ImageSpec[];
  contours: readonly ContourSpec[];
  /** Keyed by axis name. "left", "bottom", "right" and "top" always exist. */
  axes: Dict<AxisSpec>;
  annotations: readonly AnnotationSpec[];
  /** Shapes and text drawn on the graph with its drawing tools, back to front. */
  drawings: readonly DrawingSpec[];
  cursors: Readonly<Partial<Record<CursorName, CursorSpec>>>;
}

/*
 * A style is the look of a graph kept under a name, to give other graphs the
 * same fonts, lines, colors and size. What it holds is the look and never the
 * data, and the rule that tells them apart is: a property is look when the
 * same value is right for a graph of any other data, and data when the right
 * value depends on what is plotted. So font, the size and style of axis
 * labels and tick labels, tick direction, mirror axes, grid, line width,
 * colors and markers are look; ranges, labels (their words), log or
 * linear, reversal, tick step and format (they follow the values), axis spans
 * (they follow which axes there are), which waves are plotted, error bars,
 * offsets, fills and color waves are data. Hidden traces and the cursor bar
 * are the state of the work, not of the figure, so neither is held.
 */

/** The graph-wide properties a style can hold. */
export const GRAPH_LOOK = [
  "fontSize",
  "fontFamily",
  "marginLeft",
  "marginBottom",
  "marginRight",
  "marginTop",
] as const;
/** The properties of an axis a style can hold. */
export const AXIS_LOOK = [
  "mirror",
  "line",
  "ticks",
  "minor",
  "grid",
  "labelSize",
  "labelStyle",
  "labelRotation",
  "tickLabelSize",
  "labels",
] as const;
/** The properties of a trace a style can hold, for each place in its cycle. */
export const TRACE_LOOK = [
  "mode",
  "color",
  "lineSize",
  "lineStyle",
  "marker",
  "markerSize",
  "markerFill",
] as const;

export type GraphLook = Pick<GraphStyle, (typeof GRAPH_LOOK)[number]>;
export type AxisLook = Pick<AxisSpec, (typeof AXIS_LOOK)[number]>;
export type TraceLook = Pick<TraceStyle, (typeof TRACE_LOOK)[number]>;

/**
 * The axes a style describes: the four sides by their names, and "other" for
 * any axis that was added. An added axis without an "other" entry looks like
 * the axis of its side, so stacked plots match.
 */
export const AXIS_ROLES = [...AXIS_SIDES, "other"] as const;
export type AxisRole = (typeof AXIS_ROLES)[number];

/** The size of the drawn graph (the figure, as exported), in CSS pixels. */
export interface FigureSize {
  width: number;
  height: number;
}

/**
 * The look of a graph kept under a name. Every part is optional and a style
 * changes only what it holds. `traces` is a cycle: the graph's traces take
 * its entries in order, starting again from the first when there are more
 * traces than entries.
 */
export interface StyleSpec {
  graph?: Partial<GraphLook>;
  size?: FigureSize;
  /**
   * How the plot area is sized, for the sides it says: auto, absolute or
   * aspect only. Plan and per unit follow the ranges of the axes, which are
   * data, so a style does not hold them (its `size` keeps what they gave).
   */
  plot?: { width?: PlotDimension; height?: PlotDimension };
  axes?: Partial<Record<AxisRole, Partial<AxisLook>>>;
  traces?: readonly Partial<TraceLook>[];
}

/*
 * A graph template is a graph with its waves taken out: the same traces,
 * axes, look, text and size, made again for other data. Where the graph had
 * a wave, the template has a slot, named by what the wave was for ("y",
 * "x", or "y1", "y2" for several traces), and making a graph from it means
 * saying which wave goes in each slot. It sits between a style, which keeps
 * only the look, and the recreation script, which makes the same graph of
 * the same waves.
 *
 * A template holds no wave names, so renaming or killing a wave does not
 * touch it. Text in its annotations and axis labels can name what fills a
 * slot instead: {y.name} and {y.unit} become the name and the unit of the
 * wave in slot y, {trace1} the name of the first trace and {image1} that of
 * the first image.
 */

/** What a wave fills in a graph template. */
export const SLOT_ROLES = ["y", "x", "yError", "xError", "color", "text", "z"] as const;
export type SlotRole = (typeof SLOT_ROLES)[number];

export interface TemplateSlot {
  name: string;
  /** What the wave was first used for in the graph the template was made from. */
  role: SlotRole;
  /**
   * The units of the wave it was made from, to warn when a graph is made of
   * data in other units: the unit of its values, and of its X and Y scaling
   * where the graph used them (null where it did not).
   */
  unit: string;
  xUnit: string | null;
  yUnit: string | null;
}

/** Properties of a trace that a template keeps besides the look its style holds. */
export const TRACE_DATA = [
  "yError",
  "xError",
  "fill",
  "fillColor",
  "fillOpacity",
  "xOffset",
  "yOffset",
  "colorWave",
  "colorTable",
  "colorMin",
  "colorMax",
  "part",
  "textMarker",
  "textAnchor",
  "textSize",
  "textRotation",
] as const;

/** A trace of a template: slot names where the trace has wave names. */
export interface TemplateTrace extends Pick<TraceStyle, (typeof TRACE_DATA)[number]> {
  y: string;
  x: string | null;
  vAxis: string;
  hAxis: string;
}

/** Properties of an axis that a template keeps besides the look its style holds. */
export const AXIS_DATA = [
  "label",
  "min",
  "max",
  "log",
  "reverse",
  "tickStep",
  "tickFormat",
  "span",
] as const;

export interface TemplateAxis extends Pick<AxisSpec, "side" | (typeof AXIS_DATA)[number]> {
  name: string;
}

/** An image or contour of a template: `wave` is a slot name. */
export type TemplateImage = Omit<ImageSpec, "name">;
export type TemplateContour = Omit<ContourSpec, "name">;

export interface TemplateAnnotation extends Pick<
  AnnotationSpec,
  "kind" | "text" | "anchor" | "frame" | "x" | "y" | "point"
> {
  /** For a tag: the place of its trace in the template's traces. */
  trace: number | null;
}

export interface GraphTemplate {
  /** The look and the size, as a style holds them. */
  style: StyleSpec;
  slots: readonly TemplateSlot[];
  traces: readonly TemplateTrace[];
  images: readonly TemplateImage[];
  contours: readonly TemplateContour[];
  /** Every axis, the four sides first. A range left as null is worked out from the data. */
  axes: readonly TemplateAxis[];
  annotations: readonly TemplateAnnotation[];
  /** Shapes and text drawn on the graph (their axes are the template's); left out, none. */
  drawings?: readonly Omit<DrawingSpec, "name">[];
  /** How the plot area is sized, every mode (its axes are the template's); left out, auto. */
  plot?: { width: PlotDimension; height: PlotDimension };
}

export interface TableSpec {
  name: string;
  /** The waves shown, as columns. */
  columns: readonly string[];
  /** Significant digits numbers are shown with. */
  digits: number;
  /** Column widths in pixels, by wave, for columns the user has resized. */
  widths: Dict<number>;
}

export const DEFAULT_TABLE_DIGITS = 8;

/**
 * A Python file kept in the experiment, with a window to edit it: the
 * counterpart of an Igor procedure window. It is `<name>.py` in Python's
 * working directory, so other code can import it.
 */
export interface ProcedureSpec {
  name: string;
  code: string;
  /** Runs the file when the experiment is opened and whenever Python starts. */
  autoRun: boolean;
  /**
   * How Run runs it: null runs it in the command line's namespace (as
   * `from name import *` would bring its names in); a name runs it as a
   * module of its own and binds it to that name (as `import name as tl`).
   */
  importAs: string | null;
}

/**
 * Text kept in the experiment, written in Markdown and shown formatted: a
 * notebook page for what was done and why, as Igor's notebooks are.
 */
export interface NoteSpec {
  name: string;
  text: string;
}

/** Something placed on a page layout: a graph, or a block of text. */
export interface PageItem {
  /** Unique on its page: "graph0", "text0", ... */
  name: string;
  kind: "graph" | "text";
  /** The graph shown, for an item of kind "graph". */
  graph: string | null;
  /** The text, which may have several lines, for an item of kind "text". */
  text: string;
  /** The top left corner on the page, in points (1/72 inch). */
  x: number;
  y: number;
  /** The size of a graph on the page, in points. Text takes the room it needs. */
  w: number;
  h: number;
  /** The font size of text, in points. */
  size: number;
}

/**
 * A page layout: graphs and text arranged on a sheet of paper, for a figure
 * of several panels. Like an Igor page layout, it shows the graphs as they
 * are; change a graph and the page follows.
 */
export interface PageSpec {
  name: string;
  /** The size of the paper, in points. */
  width: number;
  height: number;
  items: readonly PageItem[];
}

/** Paper sizes in points, upright. */
export const PAGE_SIZES = {
  A4: [595, 842],
  A5: [420, 595],
  A3: [842, 1191],
  Letter: [612, 792],
} as const;

/*
 * A panel is a window of controls that runs analyses: fields and pickers
 * that hold values, and buttons that call registered actions with them
 * (Igor's control panel). The values are part of the document, so they are
 * saved, undone and recorded like any other change.
 *
 * A button calls an action by its id with arguments that are plain values
 * or the value of a control of the panel (see ControlArg). It never holds
 * code: a panel whose buttons call only the application's own actions is
 * data, while one that calls an action a procedure registered runs the
 * user's Python (see panelTrust in ./panels).
 */

/** The kinds of control a panel can hold. */
export const CONTROL_KINDS = [
  "heading",
  "text",
  "number",
  "string",
  "checkbox",
  "choice",
  "wave",
  "list",
  "plot",
  "button",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** A reference to a control of the panel, as a button's argument. */
export interface ControlRef {
  readonly $control: string;
}

/**
 * An argument of a button's action: plain data (JSON) in which a reference
 * to a control stands for the control's value. Mostly the argument is a
 * plain value or a reference itself; a reference deep inside (in a list of
 * dicts, say) is the value there.
 */
export type ControlArg =
  | null
  | boolean
  | number
  | string
  | ControlRef
  | readonly ControlArg[]
  | { readonly [key: string]: ControlArg };

interface ControlBase {
  /** Unique in its panel; what buttons and Python name it by. */
  readonly name: string;
  /** The words shown: a heading or paragraph itself, a button's caption, or a field's label. */
  readonly label: string;
  /** Sits on the same line as the control before it, instead of a line of its own. */
  readonly inline: boolean;
  /*
   * The look and place of a control, each left out while it has its usual
   * value (so that a panel that uses none of them reads as before):
   */
  /** The color of its words, as `#rrggbb`; left out for the panel's own. */
  readonly color?: string;
  /** The color behind it, as `#rrggbb`; left out for none. */
  readonly background?: string;
  /**
   * Where its top left corner sits, in pixels from the top left of the
   * panel. Given together: a control placed so sits there, over the
   * controls that flow in their lines, which go on as if it were not there.
   * Left out, the control flows in its line (see `inline`).
   */
  readonly x?: number;
  readonly y?: number;
  /** Its size in pixels; left out, the size its content takes. */
  readonly w?: number;
  readonly h?: number;
  /** The order it is drawn in: one with a higher z is in front. Left out for 0. */
  readonly z?: number;
}

/** A wave a panel's plot draws, against the X wave or its own X scaling (x null). */
export interface PlotTrace {
  readonly y: string;
  readonly x: string | null;
}

export type PanelControl =
  | (ControlBase & { readonly kind: "heading" })
  | (ControlBase & { readonly kind: "text" })
  | (ControlBase & {
      readonly kind: "number";
      readonly value: number;
      /** Inclusive limits, or null for none. */
      readonly min: number | null;
      readonly max: number | null;
      /** How much the arrows change the value; null for 1. */
      readonly step: number | null;
    })
  | (ControlBase & { readonly kind: "string"; readonly value: string })
  | (ControlBase & { readonly kind: "checkbox"; readonly value: boolean })
  | (ControlBase & {
      readonly kind: "choice";
      /** One of the options, or null while there are none. */
      readonly value: string | number | null;
      readonly options: readonly (string | number)[];
    })
  | (ControlBase & {
      readonly kind: "wave";
      /**
       * The wave chosen, or null. It follows the wave when it is renamed; when
       * the wave is killed the name stays, and the control shows it as missing.
       */
      readonly value: string | null;
      /** Lists only waves of this many dimensions; null lists all numeric waves. */
      readonly dims: number | null;
      /** Lists only waves whose names match: text they contain, or a pattern with "*". */
      readonly filter: string;
      /** Lists text waves too, not only numeric ones. */
      readonly text: boolean;
    })
  | (ControlBase & {
      readonly kind: "list";
      /**
       * The waves selected, in the order of the list. They follow their waves
       * when renamed; a killed wave's name stays, and is shown as missing.
       */
      readonly value: readonly string[];
      /** Lists only waves of this many dimensions; null lists all numeric waves. */
      readonly dims: number | null;
      /** Lists only waves whose names match, as a wave picker's filter. */
      readonly filter: string;
      /** Lists text waves too, as a wave picker's text. */
      readonly text: boolean;
      /** Whether more than one wave can be selected. */
      readonly multiple: boolean;
    })
  | (ControlBase & {
      readonly kind: "plot";
      /** The waves it draws, which "From Active Graph" takes from the frontmost graph. */
      readonly traces: readonly PlotTrace[];
      /** Draws what the frontmost graph draws as it changes, instead of its own traces. */
      readonly live: boolean;
    })
  | (ControlBase & {
      readonly kind: "button";
      /** The id of the action it calls; "" for none yet. */
      readonly action: string;
      /** The version of the action; null for the highest there is. */
      readonly version: number | null;
      /** The action's arguments by name. */
      readonly args: Dict<ControlArg>;
    });

/** The controls that hold a value a button can pass on. */
export type ValueControl = Extract<PanelControl, { value: unknown }>;

export const hasValue = (control: PanelControl): control is ValueControl => "value" in control;

export interface PanelSpec {
  name: string;
  /** What the window's title bar says; the name when empty. */
  title: string;
  /** In the order they are shown. */
  controls: readonly PanelControl[];
}

export interface WindowState {
  /** Same as the name of the graph, table, procedure, page layout, panel or note it shows. */
  name: string;
  kind: "graph" | "table" | "procedure" | "page" | "panel" | "note";
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Closed but kept: what it shows stays in the experiment, and reopening it
   * brings it back as it is now (Igor keeps a recreation macro instead).
   * Left out when the window is open.
   */
  hidden?: boolean;
}

/** The windows that are open (not closed and kept), back to front. */
export const openWindows = (windows: readonly WindowState[]): WindowState[] =>
  windows.filter((window) => !window.hidden);

/** The frontmost open window, or null when none is open. */
export const frontWindow = (windows: readonly WindowState[]): WindowState | null =>
  windows.findLast((window) => !window.hidden) ?? null;

/** Every record kept by name is a {@link Dict}, built with the functions of ./dict. */
/**
 * What a plugin's editor or view had in its window, kept with the experiment
 * so that it opens again where it was left (docs/design/plugin-views.md §11).
 * Plain JSON, apart from the plugin's code: the plugin reads it back itself.
 */
export interface EditorMemory {
  plugin: string;
  editor: string;
  /** The version of the plugin that left it, for the plugin to tell an old state from a new one. */
  version: string;
  state: unknown;
}

/** The largest state an editor may keep, as JSON text. */
export const MAX_EDITOR_MEMORY = 1024 * 1024;

export interface DocState {
  readonly waves: Dict<Wave>;
  /** Creation order, for stable listing. */
  readonly waveOrder: readonly string[];
  /** Every data folder below root, as paths; a parent comes before its children. */
  readonly folders: readonly string[];
  readonly graphs: Dict<GraphSpec>;
  readonly tables: Dict<TableSpec>;
  readonly procedures: Dict<ProcedureSpec>;
  readonly pages: Dict<PageSpec>;
  readonly panels: Dict<PanelSpec>;
  readonly notes: Dict<NoteSpec>;
  /** Graph styles, by name. */
  readonly styles: Dict<StyleSpec>;
  /** The style new graphs are given, or null. Always one of `styles`. */
  readonly defaultStyle: string | null;
  /** Graph templates, by name. */
  readonly graphTemplates: Dict<GraphTemplate>;
  /** Analysis results (fits), by name, with what was asked for. */
  readonly results: Dict<AnalysisResult>;
  /** Analysis templates, by name: steps of actions to do to one sample after another. */
  readonly templates: Dict<AnalysisTemplate>;
  /** Records of templates run on lists of samples, by name, each with a copy of its template. */
  readonly runs: Dict<TemplateRun>;
  /**
   * The time zone dates are shown and typed in: "UTC", "local" (the zone of
   * the computer the experiment is open on) or an IANA name.
   */
  readonly timeZone: string;
  /** Back-to-front z-order; the last window is the active one. */
  readonly windows: readonly WindowState[];
  /**
   * The attributes of samples, by data folder ("run1:", with a colon) or by
   * wave (see ./attributes).
   */
  readonly attributes: Dict<Readonly<Record<string, number | string>>>;
  /** The Python packages the experiment uses beyond those Python starts with (see ./pythonEnv). */
  readonly python: PythonEnv;
  /**
   * The windows of plugins' editors and views as they were left, by
   * "<plugin>/<editor>". Not undone with the rest: like a note's text, it
   * belongs to its window.
   */
  readonly editors: Dict<EditorMemory>;
}

export const emptyDoc = (): DocState => ({
  waves: dict(),
  waveOrder: [],
  folders: [],
  graphs: dict(),
  tables: dict(),
  procedures: dict(),
  pages: dict(),
  panels: dict(),
  notes: dict(),
  styles: dict(),
  defaultStyle: null,
  graphTemplates: dict(),
  results: dict(),
  templates: dict(),
  runs: dict(),
  timeZone: "UTC",
  windows: [],
  attributes: dict(),
  python: emptyPythonEnv(),
  editors: dict(),
});

/** Height of a window's title bar; the content area is the window minus this. */
export const TITLE_BAR_HEIGHT = 24;
/** Height of the cursor readout bar under a graph. */
export const INFO_BAR_HEIGHT = 56;

/**
 * The height the cursor readout bar takes in a graph's window: a graph's
 * window is its title bar, the figure, and this, from top to bottom. Showing
 * the bar grows the window and hiding it shrinks it, so the figure keeps its
 * size (see the "modifyGraph" command).
 */
export const infoBarHeight = (graph: GraphSpec | undefined): number =>
  graph?.showInfo ? INFO_BAR_HEIGHT : 0;

/** The smallest a window can be made. */
export const MIN_WINDOW_WIDTH = 160;
export const MIN_WINDOW_HEIGHT = 120;

/**
 * The size a graph's window offers it, and the size it is exported at when
 * its plot area follows the window. A side of the plot area that is not
 * auto makes the figure as big as it needs to be instead, and the window is
 * fitted to it (see ../plot/windowFit). A magnified graph's window shows a
 * figure that much smaller, drawn that much bigger.
 */
export function figureSize(window: WindowState, graph: GraphSpec | undefined): FigureSize {
  const magnification = graph?.magnification ?? 1;
  return {
    width: Math.round(window.w / magnification),
    height: Math.round((window.h - TITLE_BAR_HEIGHT - infoBarHeight(graph)) / magnification),
  };
}

/**
 * The size of the window that shows a figure of this size whole: the
 * figure magnified, the title bar and the cursor bar. The reverse of
 * {@link figureSize}.
 */
export function windowSizeFor(
  figure: FigureSize,
  graph: GraphSpec | undefined,
): { w: number; h: number } {
  const magnification = graph?.magnification ?? 1;
  return {
    w: Math.round(figure.width * magnification),
    h: Math.round(figure.height * magnification) + TITLE_BAR_HEIGHT + infoBarHeight(graph),
  };
}

/**
 * What kind of error the app reports, for code (Python, plugins, tools) to
 * tell them apart without reading the message. They are part of the public
 * API: changing or removing one is a breaking change (see CHANGELOG.md).
 */
export const ERROR_CODES = [
  /** A value, name or argument that is not allowed (`details.field` says which). */
  "INVALID_ARGUMENT",
  /** Something asked for by name is not there (`details.kind`, `details.name`). */
  "NOT_FOUND",
  /** A name is taken already (`details.kind`, `details.name`). */
  "ALREADY_EXISTS",
  /** Something cannot be removed while other things use it (`details.users`). */
  "IN_USE",
  /** What a step was computed from changed meanwhile: doing it again may work. */
  "CONFLICT",
  /** A file, format or package the app cannot handle. */
  "UNSUPPORTED",
  /** A plugin failed: it raised, timed out or returned what is not allowed. */
  "PLUGIN_FAILED",
  /** A fault of the app itself. */
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error as it crosses to Python and other callers: what it is, in words and in data. */
export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

/**
 * The app refused a request. `code` says what kind of refusal it is (see
 * {@link ERROR_CODES}); most are arguments that are not allowed, the default.
 */
export class DocError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ErrorCode = "INVALID_ARGUMENT",
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocError";
    this.code = code;
    this.details = details;
  }
}

/** An error of any kind as {@link ErrorInfo}: a DocError says its own; anything else is the app's fault. */
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof DocError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message, details: {} };
}

/** The Python class of each code (`op.NotFoundError`, ...): the name the history gives an error. */
export const ERROR_CLASSES: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "InvalidArgumentError",
  NOT_FOUND: "NotFoundError",
  ALREADY_EXISTS: "AlreadyExistsError",
  IN_USE: "InUseError",
  CONFLICT: "ConflictError",
  UNSUPPORTED: "UnsupportedError",
  PLUGIN_FAILED: "PluginFailedError",
  INTERNAL: "InternalError",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The argument or property an error is about (`details.field`), or null: a
 * value not allowed there, or a wave named there that is not to be found.
 * A name that is taken (ALREADY_EXISTS) is about the name.
 */
export function errorField(error: unknown): string | null {
  if (!(error instanceof DocError)) return null;
  const field = error.details.field;
  if (typeof field === "string" && field !== "") return field;
  return error.code === "ALREADY_EXISTS" ? "name" : null;
}

/**
 * A run that was stopped (interrupted, or its plugin stopped) before it
 * ended. It is not a failure, so it has no {@link ErrorCode}: the history
 * marks it as stopped, and a dialog that started it says nothing went wrong.
 */
export class CancelledError extends Error {
  constructor(message = "Stopped.") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

export const DEFAULT_FONT_FAMILY = "Helvetica Neue, Helvetica, Arial, sans-serif";

export const defaultAxis = (side: AxisSide): AxisSpec => ({
  side,
  label: null,
  labelSize: null,
  labelStyle: "plain",
  labelRotation: 0,
  tickLabelSize: null,
  labels: "on",
  min: null,
  max: null,
  log: false,
  mirror: "off",
  line: true,
  ticks: "outside",
  minor: false,
  grid: "off",
  reverse: false,
  tickStep: null,
  tickFormat: null,
  span: [0, 1],
});

/** Igor's standard trace colors, starting with its default red. */
export const TRACE_COLORS = [
  "#ff0000",
  "#0000ff",
  "#009900",
  "#000000",
  "#ff9900",
  "#9900cc",
  "#00a0c8",
  "#996633",
] as const;

export const defaultTraceStyle = (index: number): TraceStyle => ({
  mode: "lines",
  color: TRACE_COLORS[index % TRACE_COLORS.length]!,
  lineSize: 1,
  lineStyle: "solid",
  marker: "circle",
  markerSize: 3,
  markerFill: true,
  hidden: false,
  yError: null,
  xError: null,
  fill: "none",
  fillColor: null,
  fillOpacity: 0.25,
  xOffset: 0,
  yOffset: 0,
  colorWave: null,
  colorTable: "rainbow",
  colorMin: null,
  colorMax: null,
  part: "real",
  textMarker: null,
  textAnchor: "MC",
  textSize: null,
  textRotation: 0,
});

/** The last component of a wave or folder path. */
export const leafName = (path: string): string => path.slice(path.lastIndexOf(":") + 1);

/** The folder a path is in; "" for root. */
export const parentFolder = (path: string): string => {
  const at = path.lastIndexOf(":");
  return at === -1 ? "" : path.slice(0, at);
};

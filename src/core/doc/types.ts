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
  /** Numeric values. Empty for a text wave. */
  readonly data: Float64Array;
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
  /** Changes every time the wave changes; unique across all waves. */
  readonly rev: number;
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

export interface AxisSpec {
  /** Which edge of the plot the axis belongs to. Fixed when the axis is made. */
  side: AxisSide;
  /** null means automatic (derived from wave units). */
  label: string | null;
  /** null means autoscale to the data. */
  min: number | null;
  max: number | null;
  log: boolean;
  /** off: no opposite axis; on: plain line; ticks: line with ticks; labels: ticks and labels. */
  mirror: MirrorMode;
  ticks: TickMode;
  minor: boolean;
  grid: GridMode;
  /**
   * The part of the plot area the axis covers, as fractions from 0 (bottom or
   * left) to 1. Axes with separate spans stack plots in one graph.
   */
  span: readonly [number, number];
}

export const ANCHORS = ["LT", "MT", "RT", "LC", "MC", "RC", "LB", "MB", "RB"] as const;
export type Anchor = (typeof ANCHORS)[number];

export const ANNOTATION_KINDS = ["legend", "text", "colorscale"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export interface AnnotationSpec {
  name: string;
  kind: AnnotationKind;
  /**
   * legend: empty lists every trace. text: the text itself.
   * colorscale: the image it describes (empty for the first image).
   */
  text: string;
  anchor: Anchor;
  frame: boolean;
}

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
}

export interface GraphSpec extends GraphStyle {
  name: string;
  traces: readonly TraceSpec[];
  images: readonly ImageSpec[];
  contours: readonly ContourSpec[];
  /** Keyed by axis name. "left", "bottom", "right" and "top" always exist. */
  axes: Readonly<Record<string, AxisSpec>>;
  annotations: readonly AnnotationSpec[];
  cursors: Readonly<Partial<Record<CursorName, CursorSpec>>>;
}

export interface TableSpec {
  name: string;
  columns: readonly string[];
}

export interface WindowState {
  /** Same as the graph or table name. */
  name: string;
  kind: "graph" | "table";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DocState {
  readonly waves: Readonly<Record<string, Wave>>;
  /** Creation order, for stable listing. */
  readonly waveOrder: readonly string[];
  /** Every data folder below root, as paths; a parent comes before its children. */
  readonly folders: readonly string[];
  readonly graphs: Readonly<Record<string, GraphSpec>>;
  readonly tables: Readonly<Record<string, TableSpec>>;
  /** Back-to-front z-order; the last window is the active one. */
  readonly windows: readonly WindowState[];
}

export const emptyDoc = (): DocState => ({
  waves: {},
  waveOrder: [],
  folders: [],
  graphs: {},
  tables: {},
  windows: [],
});

export class DocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocError";
  }
}

export const DEFAULT_FONT_FAMILY = "Helvetica Neue, Helvetica, Arial, sans-serif";

export const defaultAxis = (side: AxisSide): AxisSpec => ({
  side,
  label: null,
  min: null,
  max: null,
  log: false,
  mirror: "off",
  ticks: "outside",
  minor: false,
  grid: "off",
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
});

/** The last component of a wave or folder path. */
export const leafName = (path: string): string => path.slice(path.lastIndexOf(":") + 1);

/** The folder a path is in; "" for root. */
export const parentFolder = (path: string): string => {
  const at = path.lastIndexOf(":");
  return at === -1 ? "" : path.slice(0, at);
};

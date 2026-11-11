/** A named 1-D numeric array with X scaling, in the style of an Igor wave. */
export interface Wave {
  readonly name: string;
  readonly data: Float64Array;
  /** X value of point 0. */
  readonly x0: number;
  /** X increment per point. */
  readonly dx: number;
  readonly xUnit: string;
  /** Unit of the stored values. */
  readonly unit: string;
  readonly note: string;
  /** Changes every time the wave changes; unique across all waves. */
  readonly rev: number;
}

export const AXIS_NAMES = ["left", "bottom", "right", "top"] as const;
export type AxisName = (typeof AXIS_NAMES)[number];
export type VerticalAxis = "left" | "right";
export type HorizontalAxis = "bottom" | "top";

export const TRACE_MODES = [
  "lines",
  "markers",
  "lines+markers",
  "sticks",
  "dots",
  "cityscape",
] as const;
export type TraceMode = (typeof TRACE_MODES)[number];

export const LINE_STYLES = ["solid", "dash", "dot", "dashdot"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

export const MARKER_SHAPES = ["circle", "square", "triangle", "diamond", "cross", "plus"] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];

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
}

export interface TraceSpec extends TraceStyle {
  /** Unique within the graph: the Y wave name, plus `#n` for repeats. */
  name: string;
  y: string;
  /** X wave name, or null to use the Y wave's X scaling. */
  x: string | null;
  vAxis: VerticalAxis;
  hAxis: HorizontalAxis;
}

export const MIRROR_MODES = ["off", "on", "ticks", "labels"] as const;
export type MirrorMode = (typeof MIRROR_MODES)[number];
export const TICK_MODES = ["outside", "inside", "crossing", "none"] as const;
export type TickMode = (typeof TICK_MODES)[number];
export const GRID_MODES = ["off", "major", "all"] as const;
export type GridMode = (typeof GRID_MODES)[number];

export interface AxisSpec {
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
}

export const ANCHORS = ["LT", "MT", "RT", "LC", "MC", "RC", "LB", "MB", "RB"] as const;
export type Anchor = (typeof ANCHORS)[number];

export interface AnnotationSpec {
  name: string;
  kind: "legend" | "text";
  /** For a legend, an empty string means "list every trace". */
  text: string;
  anchor: Anchor;
  frame: boolean;
}

export interface GraphStyle {
  fontSize: number;
  fontFamily: string;
}

export interface GraphSpec extends GraphStyle {
  name: string;
  traces: readonly TraceSpec[];
  axes: Readonly<Record<AxisName, AxisSpec>>;
  annotations: readonly AnnotationSpec[];
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
  readonly graphs: Readonly<Record<string, GraphSpec>>;
  readonly tables: Readonly<Record<string, TableSpec>>;
  /** Back-to-front z-order; the last window is the active one. */
  readonly windows: readonly WindowState[];
}

export const emptyDoc = (): DocState => ({
  waves: {},
  waveOrder: [],
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

export const defaultAxis = (): AxisSpec => ({
  label: null,
  min: null,
  max: null,
  log: false,
  mirror: "off",
  ticks: "outside",
  minor: false,
  grid: "off",
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
});

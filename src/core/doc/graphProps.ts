/** How the properties of graphs, axes, traces and the rest are checked. (Applied through ./commands.) */
import { MAX_PLOT_SIZE, MIN_PLOT_SIZE, SCREEN_UNITS_PER_POINT, toPoints } from "../plot/plotSize";
import { isTickFormat } from "../plot/ticks";
import { normalizeColor } from "./colors";
import { withEntry } from "./dict";
import { RESERVED_SLOT_NAMES } from "./graphTemplates";
import type { AnalysisTemplate, TemplateRun } from "./analysisTemplates";
import { styledGraph, styledWindows } from "./styles";
import {
  ANCHORS,
  ANNOTATION_KINDS,
  ARROW_ENDS,
  defaultDrawing,
  DRAWING_COORDS,
  DRAWING_KINDS,
  DRAWING_LAYERS,
  type DrawingSpec,
  AXIS_DATA,
  AXIS_LOOK,
  AXIS_ROLES,
  AXIS_SIDES,
  COLOR_TABLES,
  COMPLEX_PARTS,
  DocError,
  FILL_MODES,
  GRAPH_LOOK,
  GRID_MODES,
  LABEL_STYLES,
  AXIS_LABEL_MODES,
  MAX_MAGNIFICATION,
  MAX_MARGIN,
  MIN_MAGNIFICATION,
  LENGTH_UNITS,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  PLOT_SIZE_MODES,
  SLOT_ROLES,
  TAG_OFFSET,
  TICK_MODES,
  TRACE_DATA,
  TRACE_LOOK,
  TRACE_MODES,
  defaultAxis,
  defaultTraceStyle,
  dependsOnOther,
  AUTO_SIZE,
  isVerticalSide,
  type AnnotationSpec,
  type AxisLook,
  type AxisRole,
  type AxisSide,
  type AxisSpec,
  type ContourSpec,
  type DocState,
  type ErrorSource,
  type FigureSize,
  type GraphLook,
  type GraphSpec,
  type GraphStyle,
  type GraphTemplate,
  type ImageSpec,
  type PlotDimension,
  type StyleSpec,
  type TemplateAnnotation,
  type TemplateAxis,
  type TemplateContour,
  type TemplateImage,
  type TemplateSlot,
  type TemplateTrace,
  type TraceLook,
  type TraceStyle,
  type PageItem,
  type PageSpec,
} from "./types";
import type { Props } from "./commandTypes";
import { bool, checkName, finite, index, oneOf, positive, putGraph } from "./commandSupport";

export const errorSource =
  (what: string) =>
  (value: unknown): ErrorSource => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    throw new DocError(
      `${what} must be a wave name, a number that is not negative, or null.`,
      "INVALID_ARGUMENT",
      { field: what },
    );
  };

export const TRACE_VALIDATORS: { [K in keyof TraceStyle]: (value: unknown) => TraceStyle[K] } = {
  mode: (value) => oneOf(value, TRACE_MODES, "mode"),
  color: normalizeColor,
  lineSize: (value) => positive(value, "lineSize"),
  lineStyle: (value) => oneOf(value, LINE_STYLES, "lineStyle"),
  marker: (value) => oneOf(value, MARKER_SHAPES, "marker"),
  markerSize: (value) => positive(value, "markerSize"),
  markerFill: (value) => bool(value, "markerFill"),
  hidden: (value) => bool(value, "hidden"),
  yError: errorSource("yError"),
  xError: errorSource("xError"),
  fill: (value) => oneOf(value, FILL_MODES, "fill"),
  fillColor: (value) => (value === null ? null : normalizeColor(value)),
  fillOpacity: (value) => {
    const opacity = finite(value, "fillOpacity");
    if (opacity < 0 || opacity > 1)
      throw new DocError("fillOpacity must be between 0 and 1.", "INVALID_ARGUMENT", {
        field: "fillOpacity",
      });
    return opacity;
  },
  xOffset: (value) => finite(value, "xOffset"),
  yOffset: (value) => finite(value, "yOffset"),
  colorWave: (value) => {
    if (value === null || typeof value === "string") return value;
    throw new DocError("colorWave must be a wave name or null.", "INVALID_ARGUMENT", {
      field: "colorWave",
    });
  },
  colorTable: (value) => oneOf(value, COLOR_TABLES, "colorTable"),
  colorMin: (value) => (value === null ? null : finite(value, "colorMin")),
  colorMax: (value) => (value === null ? null : finite(value, "colorMax")),
  part: (value) => oneOf(value, COMPLEX_PARTS, "part"),
  textMarker: (value) => {
    if (value === null || typeof value === "string") return value;
    throw new DocError("textMarker must be a wave name or null.", "INVALID_ARGUMENT", {
      field: "textMarker",
    });
  },
  textAnchor: (value) => oneOf(value, ANCHORS, "textAnchor"),
  textSize: (value) => (value === null ? null : fontSize(value, "textSize")),
  textRotation: (value) => {
    const degrees = finite(value, "textRotation");
    if (degrees < -360 || degrees > 360) {
      throw new DocError("textRotation must be between -360 and 360 degrees.", "INVALID_ARGUMENT", {
        field: "textRotation",
      });
    }
    return degrees;
  },
};

export const nullableNumber = (what: string) => (value: unknown) =>
  value === null ? null : finite(value, what);

export function fontSize(value: unknown, what: string): number {
  const size = positive(value, what);
  if (size < 4 || size > 96)
    throw new DocError(`${what} must be between 4 and 96.`, "INVALID_ARGUMENT", { field: what });
  return size;
}

export const AXIS_VALIDATORS: {
  [K in Exclude<keyof AxisSpec, "side">]: (value: unknown) => AxisSpec[K];
} = {
  label: (value) => {
    if (value === null || typeof value === "string") return value;
    throw new DocError("label must be text, or null for the automatic label.", "INVALID_ARGUMENT", {
      field: "label",
    });
  },
  labelSize: (value) => (value === null ? null : fontSize(value, "labelSize")),
  labelStyle: (value) => oneOf(value, LABEL_STYLES, "labelStyle"),
  labelRotation: (value) => {
    const degrees = finite(value, "labelRotation");
    if (degrees < -360 || degrees > 360) {
      throw new DocError(
        "labelRotation must be between -360 and 360 degrees.",
        "INVALID_ARGUMENT",
        { field: "labelRotation" },
      );
    }
    return degrees;
  },
  tickLabelSize: (value) => (value === null ? null : fontSize(value, "tickLabelSize")),
  labels: (value) => oneOf(value, AXIS_LABEL_MODES, "labels"),
  min: nullableNumber("min"),
  max: nullableNumber("max"),
  log: (value) => bool(value, "log"),
  mirror: (value) => oneOf(value, MIRROR_MODES, "mirror"),
  line: (value) => bool(value, "line"),
  ticks: (value) => oneOf(value, TICK_MODES, "ticks"),
  minor: (value) => bool(value, "minor"),
  grid: (value) => oneOf(value, GRID_MODES, "grid"),
  reverse: (value) => bool(value, "reverse"),
  tickStep: (value) => (value === null ? null : positive(value, "tickStep")),
  tickFormat: (value) => {
    if (value === null || value === "") return null;
    if (typeof value === "string" && isTickFormat(value)) return value;
    throw new DocError(
      'tickFormat must be a format such as ".2f", "e", ".1e", "g", ",.0f" or "%", or null.',
      "INVALID_ARGUMENT",
      { field: "tickFormat" },
    );
  },
  span: (value) => {
    if (Array.isArray(value) && value.length === 2) {
      const lo = finite(value[0], "span");
      const hi = finite(value[1], "span");
      if (lo >= 0 && hi <= 1 && hi - lo >= 0.02) return [lo, hi];
    }
    throw new DocError("span must be (low, high) with 0 <= low < high <= 1.", "INVALID_ARGUMENT", {
      field: "span",
    });
  },
};

/** A margin in points, from 0 to {@link MAX_MARGIN}, or null for automatic. */
export function margin(value: unknown, what: string): number | null {
  if (value === null) return null;
  const points = typeof value === "number" ? value : NaN;
  if (!(points >= 0 && points <= MAX_MARGIN)) {
    throw new DocError(
      `${what} must be between 0 and ${MAX_MARGIN} points, or None for auto.`,
      "INVALID_ARGUMENT",
      { field: what },
    );
  }
  return points;
}

export const GRAPH_VALIDATORS: { [K in keyof GraphStyle]: (value: unknown) => GraphStyle[K] } = {
  fontSize: (value) => fontSize(value, "fontSize"),
  fontFamily: (value) => {
    if (typeof value !== "string" || !value.trim())
      throw new DocError("fontFamily must be text.", "INVALID_ARGUMENT", { field: "fontFamily" });
    return value;
  },
  showInfo: (value) => bool(value, "showInfo"),
  marginLeft: (value) => margin(value, "marginLeft"),
  marginBottom: (value) => margin(value, "marginBottom"),
  marginRight: (value) => margin(value, "marginRight"),
  marginTop: (value) => margin(value, "marginTop"),
  magnification: (value) => {
    const factor = positive(value, "magnification");
    if (factor < MIN_MAGNIFICATION - 1e-9 || factor > MAX_MAGNIFICATION + 1e-9) {
      throw new DocError(
        `magnification must be between ${MIN_MAGNIFICATION} and ${MAX_MAGNIFICATION} (1 is none).`,
        "INVALID_ARGUMENT",
        { field: "magnification" },
      );
    }
    return factor;
  },
};

/** The longest and the shortest a plot area can be given, in points. */
export const MIN_PLOT_POINTS = MIN_PLOT_SIZE / SCREEN_UNITS_PER_POINT;
export const MAX_PLOT_POINTS = MAX_PLOT_SIZE / SCREEN_UNITS_PER_POINT;

/** A factor of an aspect or a plan: from 1/100 to 100. */
export function sizeFactor(value: unknown, what: string): number {
  const factor = positive(value, what);
  if (factor < 0.01 || factor > 100)
    throw new DocError(`${what} must be between 0.01 and 100.`, "INVALID_ARGUMENT", {
      field: what,
    });
  return factor;
}

/**
 * Checks how a side of the plot area is sized, given as data. The axes it
 * names are checked against the graph by {@link checkPlotSize}.
 */
export function checkPlotDimension(value: unknown, what: string): PlotDimension {
  const props = propsOf(value, what);
  const mode = oneOf(props.mode, PLOT_SIZE_MODES, `${what}'s mode`);
  const keys: Record<(typeof PLOT_SIZE_MODES)[number], readonly string[]> = {
    auto: [],
    absolute: ["value", "unit"],
    aspect: ["factor"],
    plan: ["factor", "hAxis", "vAxis"],
    perUnit: ["value", "unit", "axis"],
  };
  for (const key of Object.keys(props)) {
    if (key !== "mode" && !keys[mode].includes(key)) {
      throw new DocError(
        `A ${mode} ${what} has no property ${JSON.stringify(key)}. It takes: ${["mode", ...keys[mode]].join(", ")}.`,
        "INVALID_ARGUMENT",
        { field: key },
      );
    }
  }
  const axisName = (key: string) => {
    if (typeof props[key] !== "string")
      throw new DocError(`A ${mode} ${what} needs ${key}, an axis name.`);
    return props[key];
  };
  switch (mode) {
    case "auto":
      return { mode };
    case "absolute": {
      const length = positive(props.value, `${what}'s value`);
      const unit = oneOf(props.unit ?? "pt", LENGTH_UNITS, `${what}'s unit`);
      const points = toPoints(length, unit);
      if (points < MIN_PLOT_POINTS - 1e-9 || points > MAX_PLOT_POINTS + 1e-9) {
        throw new DocError(
          `${what} must be between ${MIN_PLOT_POINTS} and ${MAX_PLOT_POINTS} points (${(MAX_PLOT_POINTS / 72).toFixed(1)} inches).`,
        );
      }
      return { mode, value: length, unit };
    }
    case "aspect":
      return { mode, factor: sizeFactor(props.factor, `${what}'s factor`) };
    case "plan":
      return {
        mode,
        factor: sizeFactor(props.factor, `${what}'s factor`),
        hAxis: axisName("hAxis"),
        vAxis: axisName("vAxis"),
      };
    case "perUnit":
      return {
        mode,
        value: positive(props.value, `${what}'s value`),
        unit: oneOf(props.unit ?? "pt", LENGTH_UNITS, `${what}'s unit`),
        axis: axisName("axis"),
      };
  }
}

/**
 * Checks the two sides of a plot area together, against the axes there are
 * (`sideOf` gives the side of an axis, or undefined if there is none):
 * plan takes a horizontal and a vertical axis, per unit an axis along its
 * own side, and the two sides cannot both be sized from each other.
 */
export function checkPlotSize(
  width: PlotDimension,
  height: PlotDimension,
  sideOf: (axis: string) => AxisSide | undefined,
  owner: string,
): void {
  if (dependsOnOther(width) && dependsOnOther(height)) {
    throw new DocError(
      "The width and the height of the plot area cannot both be sized from each other (aspect or plan). Make one of them auto, absolute or per unit.",
    );
  }
  const axisOn = (axis: string, vertical: boolean, use: string) => {
    const side = sideOf(axis);
    if (side === undefined) {
      throw new DocError(
        `${owner} has no axis named ${JSON.stringify(axis)} for ${use}.`,
        "NOT_FOUND",
        { kind: "axis", name: axis },
      );
    }
    if (isVerticalSide(side) !== vertical) {
      throw new DocError(
        `${use[0]!.toUpperCase()}${use.slice(1)} needs a ${vertical ? "vertical" : "horizontal"} axis; ${axis} is ${vertical ? "horizontal" : "vertical"}.`,
      );
    }
  };
  for (const [dimension, what, vertical] of [
    [width, "the width", false],
    [height, "the height", true],
  ] as const) {
    if (dimension.mode === "plan") {
      axisOn(dimension.hAxis, false, `the plan of ${what}`);
      axisOn(dimension.vAxis, true, `the plan of ${what}`);
    } else if (dimension.mode === "perUnit") {
      axisOn(dimension.axis, vertical, `the per unit size of ${what}`);
    }
  }
}

/**
 * The plot size modes of a graph read from a file, checked against its
 * axes: a side that is missing (a file from before they existed) or that
 * cannot be used is auto.
 */
export function savedPlotSize(
  width: unknown,
  height: unknown,
  axes: Readonly<Record<string, AxisSpec>>,
): Pick<GraphSpec, "width" | "height"> {
  const read = (value: unknown, what: string): PlotDimension => {
    if (value === undefined || value === null) return AUTO_SIZE;
    try {
      return checkPlotDimension(value, what);
    } catch {
      return AUTO_SIZE;
    }
  };
  const sideOf = (axis: string) => (Object.hasOwn(axes, axis) ? axes[axis]!.side : undefined);
  let result = { width: read(width, "width"), height: read(height, "height") };
  for (const side of ["height", "width"] as const) {
    try {
      checkPlotSize(result.width, result.height, sideOf, "The graph");
    } catch {
      result = { ...result, [side]: AUTO_SIZE };
    }
  }
  return result;
}

export type GraphProps = GraphStyle & Pick<GraphSpec, "width" | "height">;
export const GRAPH_PROP_VALIDATORS: { [K in keyof GraphProps]: (value: unknown) => GraphProps[K] } =
  {
    ...GRAPH_VALIDATORS,
    width: (value) => checkPlotDimension(value, "width"),
    height: (value) => checkPlotDimension(value, "height"),
  };

/** The axes a style's plot sizes may hold: none, since it holds no plan or per unit. */
export function checkStylePlot(value: unknown): { width?: PlotDimension; height?: PlotDimension } {
  const parts = validateProps<{ width: PlotDimension; height: PlotDimension }>(
    propsOf(value, "plot"),
    {
      width: (item) => checkPlotDimension(item, "width"),
      height: (item) => checkPlotDimension(item, "height"),
    },
    "plot size",
  );
  for (const dimension of [parts.width, parts.height]) {
    if (
      dimension &&
      dimension.mode !== "auto" &&
      dimension.mode !== "absolute" &&
      dimension.mode !== "aspect"
    ) {
      throw new DocError(
        "A style sizes the plot area as auto, absolute or aspect only: plan and per unit follow the data.",
      );
    }
  }
  if (parts.width && parts.height)
    checkPlotSize(parts.width, parts.height, () => undefined, "A style");
  return ordered(parts, ["width", "height"]);
}

export type Validators<T> = { [K in keyof T]: (value: unknown) => T[K] };

/** The validators of some properties, for the part of an object a style can hold. */
export function someOf<T, K extends keyof T>(validators: Validators<T>, keys: readonly K[]) {
  const result = {} as Validators<Pick<T, K>>;
  for (const key of keys) result[key] = validators[key];
  return result;
}

export const GRAPH_LOOK_VALIDATORS = someOf<GraphStyle, keyof GraphLook>(
  GRAPH_VALIDATORS,
  GRAPH_LOOK,
);
export const AXIS_LOOK_VALIDATORS = someOf<Omit<AxisSpec, "side">, keyof AxisLook>(
  AXIS_VALIDATORS,
  AXIS_LOOK,
);
export const TRACE_LOOK_VALIDATORS = someOf<TraceStyle, keyof TraceLook>(
  TRACE_VALIDATORS,
  TRACE_LOOK,
);

export const figureSide = (what: string, least: number) => (value: unknown) => {
  const size = finite(value, what);
  if (size < least || size > 4000) {
    throw new DocError(`${what} must be between ${least} and 4000 pixels.`, "INVALID_ARGUMENT", {
      field: what,
    });
  }
  return size;
};
export const SIZE_VALIDATORS = {
  width: figureSide("width", 160),
  height: figureSide("height", 100),
};

/** A dict of properties, or an error naming what it should have been. */
export function propsOf(value: unknown, what: string): Props {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocError(`${what} must be a dict of properties.`, "INVALID_ARGUMENT", {
      field: what,
    });
  }
  return value as Props;
}

/** The validated properties, in the order of `keys`, so equal parts are written alike. */
export function ordered<T, K extends keyof T>(props: Partial<T>, keys: readonly K[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) if (props[key] !== undefined) result[key] = props[key];
  return result;
}

export const STYLE_PARTS = ["graph", "size", "plot", "axes", "traces"] as const;

/**
 * Checks a style given as data (from Python, a file or the browser's
 * library) and returns it in its usual form. Unknown parts and properties
 * and bad values are refused; parts that hold nothing are left out.
 */
export function checkStyle(value: unknown): StyleSpec {
  const parts = validateProps<Required<StyleSpec>>(
    propsOf(value, "A style"),
    {
      graph: (item) =>
        ordered(
          validateProps<GraphLook>(propsOf(item, "graph"), GRAPH_LOOK_VALIDATORS, "graph style"),
          GRAPH_LOOK,
        ),
      size: (item): FigureSize => {
        const size = validateProps<FigureSize>(propsOf(item, "size"), SIZE_VALIDATORS, "size");
        if (size.width === undefined || size.height === undefined) {
          throw new DocError("size needs both width and height.", "INVALID_ARGUMENT", {
            field: "size",
          });
        }
        return { width: size.width, height: size.height };
      },
      plot: checkStylePlot,
      axes: (item) => {
        const roles = validateProps<Record<AxisRole, unknown>>(
          propsOf(item, "axes"),
          Object.fromEntries(
            AXIS_ROLES.map((role) => [role, (look: unknown) => look]),
          ) as Validators<Record<AxisRole, unknown>>,
          "axes",
        );
        const axes: Partial<Record<AxisRole, Partial<AxisLook>>> = {};
        for (const role of AXIS_ROLES) {
          if (roles[role] === undefined) continue;
          const look = ordered(
            validateProps<AxisLook>(
              propsOf(roles[role], `axes.${role}`),
              AXIS_LOOK_VALIDATORS,
              "axis style",
            ),
            AXIS_LOOK,
          );
          if (Object.keys(look).length > 0) axes[role] = look;
        }
        return axes;
      },
      traces: (item) => {
        if (!Array.isArray(item) || item.length > 1000) {
          throw new DocError(
            "traces must be a list of trace properties, one for each trace.",
            "INVALID_ARGUMENT",
            { field: "traces" },
          );
        }
        // An empty entry is a place in the cycle that leaves its trace alone.
        return item.map((entry: unknown) =>
          ordered(
            validateProps<TraceLook>(
              propsOf(entry, "A trace in a style"),
              TRACE_LOOK_VALIDATORS,
              "trace style",
            ),
            TRACE_LOOK,
          ),
        );
      },
    },
    "style",
  );
  const style: Record<string, unknown> = {};
  for (const part of STYLE_PARTS) {
    const content = parts[part];
    const empty =
      content === undefined ||
      (Array.isArray(content) ? content : Object.keys(content)).length === 0;
    if (!empty) style[part] = content;
  }
  return style as StyleSpec;
}

export function requireStyle(state: DocState, name: unknown): StyleSpec {
  const style = typeof name === "string" ? state.styles[name] : undefined;
  if (!style)
    throw new DocError(`No style named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "style",
      name: name,
    });
  return style;
}

/** Gives a graph a style, and its window the style's size. */
export function withStyle(state: DocState, graph: GraphSpec, name: string): DocState {
  const style = requireStyle(state, name);
  return {
    ...putGraph(state, styledGraph(graph, style, name)),
    windows: styledWindows(state.windows, graph, style),
  };
}

export type ImageProps = Pick<
  ImageSpec,
  "colorTable" | "zMin" | "zMax" | "reverse" | "layer" | "chunk" | "part"
>;
export const IMAGE_VALIDATORS: { [K in keyof ImageProps]: (value: unknown) => ImageProps[K] } = {
  colorTable: (value) => oneOf(value, COLOR_TABLES, "colorTable"),
  zMin: nullableNumber("zMin"),
  zMax: nullableNumber("zMax"),
  reverse: (value) => bool(value, "reverse"),
  layer: (value) => index(value, "layer"),
  chunk: (value) => index(value, "chunk"),
  part: (value) => oneOf(value, COMPLEX_PARTS, "part"),
};

export type ContourProps = Pick<
  ContourSpec,
  "levels" | "color" | "lineSize" | "colorTable" | "labels" | "layer" | "chunk"
>;
export const CONTOUR_VALIDATORS: {
  [K in keyof ContourProps]: (value: unknown) => ContourProps[K];
} = {
  levels: (value) => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 200) {
      return value;
    }
    if (Array.isArray(value) && value.length > 0 && value.length <= 200) {
      return value.map((level) => finite(level, "A contour level"));
    }
    throw new DocError(
      "levels must be a count from 1 to 200, or a list of level values.",
      "INVALID_ARGUMENT",
      { field: "levels" },
    );
  },
  color: normalizeColor,
  lineSize: (value) => positive(value, "lineSize"),
  colorTable: (value) => (value === null ? null : oneOf(value, COLOR_TABLES, "colorTable")),
  labels: (value) => bool(value, "labels"),
  layer: (value) => index(value, "layer"),
  chunk: (value) => index(value, "chunk"),
};

export type AnnotationProps = Pick<
  AnnotationSpec,
  "text" | "anchor" | "frame" | "x" | "y" | "point"
>;
export const ANNOTATION_VALIDATORS: {
  [K in keyof AnnotationProps]: (value: unknown) => AnnotationProps[K];
} = {
  text: (value) => {
    if (typeof value !== "string")
      throw new DocError("text must be text.", "INVALID_ARGUMENT", { field: "text" });
    return value;
  },
  anchor: (value) => oneOf(value, ANCHORS, "anchor"),
  frame: (value) => bool(value, "frame"),
  x: (value) => finite(value, "x"),
  y: (value) => finite(value, "y"),
  point: (value) => index(value, "point"),
};

export const pageSide = (what: string) => (value: unknown) => {
  const size = positive(value, what);
  if (size < 72 || size > 5000)
    throw new DocError(`${what} must be between 72 and 5000 points.`, "INVALID_ARGUMENT", {
      field: what,
    });
  return size;
};
export const PAGE_VALIDATORS = { width: pageSide("width"), height: pageSide("height") };

export type ItemProps = Pick<PageItem, "x" | "y" | "w" | "h" | "size" | "text">;
export const ITEM_VALIDATORS: { [K in keyof ItemProps]: (value: unknown) => ItemProps[K] } = {
  x: (value) => finite(value, "x"),
  y: (value) => finite(value, "y"),
  w: (value) => Math.max(40, positive(value, "w")),
  h: (value) => Math.max(40, positive(value, "h")),
  size: (value) => {
    const size = positive(value, "size");
    if (size < 4 || size > 200)
      throw new DocError("size must be between 4 and 200.", "INVALID_ARGUMENT", { field: "size" });
    return size;
  },
  text: (value) => {
    if (typeof value !== "string")
      throw new DocError("text must be text.", "INVALID_ARGUMENT", { field: "text" });
    return value;
  },
};

export const TRACE_DATA_VALIDATORS = someOf<TraceStyle, (typeof TRACE_DATA)[number]>(
  TRACE_VALIDATORS,
  TRACE_DATA,
);
export const AXIS_DATA_VALIDATORS = someOf<Omit<AxisSpec, "side">, (typeof AXIS_DATA)[number]>(
  AXIS_VALIDATORS,
  AXIS_DATA,
);

export function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new DocError(`${what} must be a list.`, "INVALID_ARGUMENT", { field: what });
  return value;
}

export function textOf(value: unknown, what: string): string {
  if (typeof value !== "string")
    throw new DocError(`${what} must be text.`, "INVALID_ARGUMENT", { field: what });
  return value;
}

/** The properties of an object (as read from data) besides some that are taken out. */
export function restOf(props: Props, taken: readonly string[]): Props {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !taken.includes(key)));
}

/** A validator that lets anything through, for properties checked on their own. */
export const anything = (value: unknown): unknown => value;

/**
 * Checks a graph template given as data (from Python, a file or the
 * browser's library) and returns it in its usual form, with its parts in one
 * order so that equal templates are written alike. What is left out takes
 * the value a new graph would have; unknown properties, bad values and
 * references to slots, axes or traces it does not have are refused.
 */
export function checkGraphTemplate(value: unknown): GraphTemplate {
  const parts = propsOf(value, "A graph template");
  validateProps(
    parts,
    {
      style: anything,
      slots: anything,
      traces: anything,
      images: anything,
      contours: anything,
      axes: anything,
      drawings: anything,
      annotations: anything,
      plot: anything,
    },
    "graph template",
  );

  const slots = listOf(parts.slots ?? [], "slots").map((item): TemplateSlot => {
    const props = propsOf(item, "A slot");
    validateProps(
      props,
      { name: anything, role: anything, unit: anything, xUnit: anything, yUnit: anything },
      "slot",
    );
    const name = checkName(props.name, "slot");
    if (RESERVED_SLOT_NAMES.has(name)) {
      throw new DocError(`A slot cannot be called ${name}: Python uses that word.`);
    }
    const scaling = (unit: unknown, what: string) =>
      unit === undefined || unit === null ? null : textOf(unit, what);
    return {
      name,
      role: oneOf(props.role, SLOT_ROLES, "role"),
      unit: props.unit === undefined ? "" : textOf(props.unit, "unit"),
      xUnit: scaling(props.xUnit, "xUnit"),
      yUnit: scaling(props.yUnit, "yUnit"),
    };
  });
  const slotNames = slots.map((slot) => slot.name);
  const doubled = slotNames.find((name, at) => slotNames.indexOf(name) !== at);
  if (doubled !== undefined) throw new DocError(`Two slots are called ${doubled}.`);
  const slot = (name: unknown, what: string): string => {
    if (typeof name === "string" && slotNames.includes(name)) return name;
    throw new DocError(
      `${what} must be one of the template's slots (${slotNames.join(", ") || "it has none"}), not ${JSON.stringify(name)}.`,
    );
  };

  const axisOf = (name: string, side: TemplateAxis["side"], data: AxisSpec): TemplateAxis => ({
    name,
    side,
    label: data.label,
    min: data.min,
    max: data.max,
    log: data.log,
    reverse: data.reverse,
    tickStep: data.tickStep,
    tickFormat: data.tickFormat,
    span: data.span,
  });
  const given = listOf(parts.axes ?? [], "axes").map((item): TemplateAxis => {
    const props = propsOf(item, "An axis");
    const name = checkName(props.name, "axis");
    const isSide = (AXIS_SIDES as readonly string[]).includes(name);
    const side = oneOf(props.side ?? (isSide ? name : undefined), AXIS_SIDES, "side");
    if (isSide && side !== name) throw new DocError(`The ${name} axis is on the ${name} side.`);
    const axis = axisOf(name, side, {
      ...defaultAxis(side),
      ...validateProps(restOf(props, ["name", "side"]), AXIS_DATA_VALIDATORS, "template axis"),
    });
    if (axis.min !== null && axis.max !== null && axis.min === axis.max) {
      throw new DocError("The axis range must not be empty.");
    }
    return axis;
  });
  const axisNames = given.map((axis) => axis.name);
  const twice = axisNames.find((name, at) => axisNames.indexOf(name) !== at);
  if (twice !== undefined) throw new DocError(`Two axes are called ${twice}.`);
  // The four sides are always there, first, as in every graph.
  const axes: TemplateAxis[] = [
    ...AXIS_SIDES.map(
      (side) => given.find((axis) => axis.name === side) ?? axisOf(side, side, defaultAxis(side)),
    ),
    ...given.filter((axis) => !(AXIS_SIDES as readonly string[]).includes(axis.name)),
  ];
  const axisRef = (name: unknown, vertical: boolean): string => {
    const axis = axes.find((item) => item.name === name);
    if (!axis) {
      throw new DocError(
        `The template has no axis named ${JSON.stringify(name)}. Axes: ${axes.map((item) => item.name).join(", ")}.`,
        "NOT_FOUND",
        { kind: "axis", name },
      );
    }
    if (isVerticalSide(axis.side) !== vertical) {
      throw new DocError(
        `Axis ${axis.name} is ${vertical ? "horizontal" : "vertical"}; a ${vertical ? "vertical" : "horizontal"} axis is needed here.`,
      );
    }
    return axis.name;
  };

  const traces = listOf(parts.traces ?? [], "traces").map((item): TemplateTrace => {
    const props = propsOf(item, "A trace");
    const data = {
      ...defaultTraceStyle(0),
      ...validateProps(
        restOf(props, ["y", "x", "vAxis", "hAxis"]),
        TRACE_DATA_VALIDATORS,
        "template trace",
      ),
    };
    const source = (value: ErrorSource, what: string): ErrorSource =>
      typeof value === "string" ? slot(value, what) : value;
    return {
      y: slot(props.y, "A trace's y"),
      x: props.x === undefined || props.x === null ? null : slot(props.x, "A trace's x"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      yError: source(data.yError, "yError"),
      xError: source(data.xError, "xError"),
      fill: data.fill,
      fillColor: data.fillColor,
      fillOpacity: data.fillOpacity,
      xOffset: data.xOffset,
      yOffset: data.yOffset,
      colorWave: data.colorWave === null ? null : slot(data.colorWave, "colorWave"),
      colorTable: data.colorTable,
      colorMin: data.colorMin,
      colorMax: data.colorMax,
      part: data.part,
      textMarker: data.textMarker === null ? null : slot(data.textMarker, "textMarker"),
      textAnchor: data.textAnchor,
      textSize: data.textSize,
      textRotation: data.textRotation,
    };
  });

  const images = listOf(parts.images ?? [], "images").map((item): TemplateImage => {
    const props = propsOf(item, "An image");
    const data: ImageProps = {
      colorTable: "grays",
      zMin: null,
      zMax: null,
      reverse: false,
      layer: 0,
      chunk: 0,
      part: "real",
      ...validateProps<ImageProps>(
        restOf(props, ["wave", "vAxis", "hAxis"]),
        IMAGE_VALIDATORS,
        "image",
      ),
    };
    return {
      wave: slot(props.wave, "An image's wave"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      colorTable: data.colorTable,
      zMin: data.zMin,
      zMax: data.zMax,
      reverse: data.reverse,
      layer: data.layer,
      chunk: data.chunk,
      part: data.part,
    };
  });

  const contours = listOf(parts.contours ?? [], "contours").map((item): TemplateContour => {
    const props = propsOf(item, "A contour");
    const data: ContourProps = {
      levels: 10,
      color: "#000000",
      lineSize: 1,
      colorTable: null,
      labels: true,
      layer: 0,
      chunk: 0,
      ...validateProps<ContourProps>(
        restOf(props, ["wave", "vAxis", "hAxis"]),
        CONTOUR_VALIDATORS,
        "contour",
      ),
    };
    return {
      wave: slot(props.wave, "A contour's wave"),
      vAxis: axisRef(props.vAxis ?? "left", true),
      hAxis: axisRef(props.hAxis ?? "bottom", false),
      levels: data.levels,
      color: data.color,
      lineSize: data.lineSize,
      colorTable: data.colorTable,
      labels: data.labels,
      layer: data.layer,
      chunk: data.chunk,
    };
  });

  const annotations = listOf(parts.annotations ?? [], "annotations").map(
    (item): TemplateAnnotation => {
      const props = propsOf(item, "An annotation");
      const kind = oneOf(props.kind, ANNOTATION_KINDS, "kind");
      const tag = kind === "tag";
      const data = validateProps<AnnotationProps>(
        restOf(props, ["kind", "trace"]),
        ANNOTATION_VALIDATORS,
        "annotation",
      );
      const trace = props.trace === undefined || props.trace === null ? null : props.trace;
      if (trace !== null && !tag) throw new DocError("Only a tag points at a trace.");
      if (tag && trace === null) throw new DocError("A tag needs the trace it points at.");
      const place = trace === null ? null : index(trace, "trace");
      if (place !== null && place >= traces.length) {
        throw new DocError(
          `A tag points at trace ${place}, but the template has ${traces.length} (counted from 0).`,
        );
      }
      return {
        kind,
        text: data.text ?? "",
        anchor: data.anchor ?? (kind === "colorscale" ? "RC" : "RT"),
        frame: data.frame ?? true,
        x: data.x ?? (tag ? TAG_OFFSET.x : 0),
        y: data.y ?? (tag ? TAG_OFFSET.y : 0),
        trace: place,
        point: data.point ?? 0,
      };
    },
  );

  let plot: GraphTemplate["plot"];
  if (parts.plot !== undefined && parts.plot !== null) {
    const given = validateProps<{ width: PlotDimension; height: PlotDimension }>(
      propsOf(parts.plot, "plot"),
      {
        width: (item) => checkPlotDimension(item, "width"),
        height: (item) => checkPlotDimension(item, "height"),
      },
      "plot size",
    );
    const width = given.width ?? AUTO_SIZE;
    const height = given.height ?? AUTO_SIZE;
    checkPlotSize(
      width,
      height,
      (name) => axes.find((axis) => axis.name === name)?.side,
      "The template",
    );
    if (width.mode !== "auto" || height.mode !== "auto") plot = { width, height };
  }

  const drawings = listOf(parts.drawings ?? [], "drawings").map((item) => {
    const props = propsOf(item, "A drawing");
    const kind = oneOf(props.kind, DRAWING_KINDS, "kind");
    const rest = validateProps<DrawingProps>(
      restOf(props, ["kind"]),
      DRAWING_VALIDATORS,
      "drawing",
    );
    return { ...defaultDrawing(kind), kind, points: [] as readonly number[], ...rest };
  });

  return {
    style: checkStyle(parts.style ?? {}),
    slots,
    traces,
    images,
    contours,
    axes,
    annotations,
    ...(drawings.length > 0 ? { drawings } : {}),
    ...(plot ? { plot } : {}),
  };
}

export function requireTemplate(state: DocState, name: unknown): GraphTemplate {
  const template = typeof name === "string" ? state.graphTemplates[name] : undefined;
  if (!template)
    throw new DocError(`No graph template named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "graph template",
      name: name,
    });
  return template;
}

export const putTemplate = (state: DocState, name: string, template: GraphTemplate): DocState => ({
  ...state,
  graphTemplates: withEntry(state.graphTemplates, name, template),
});

export function requireAnalysisTemplate(state: DocState, name: unknown): AnalysisTemplate {
  const template = typeof name === "string" ? state.templates[name] : undefined;
  if (!template)
    throw new DocError(`No template named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "template",
      name: name,
    });
  return template;
}

export const putAnalysisTemplate = (
  state: DocState,
  name: string,
  template: AnalysisTemplate,
): DocState => ({ ...state, templates: withEntry(state.templates, name, template) });

export function requireRun(state: DocState, name: unknown): TemplateRun {
  const run = typeof name === "string" ? state.runs[name] : undefined;
  if (!run)
    throw new DocError(`No run named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "run",
      name: name,
    });
  return run;
}

export function requirePage(state: DocState, name: string): PageSpec {
  const page = state.pages[name];
  if (!page)
    throw new DocError(`No page layout named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: "page layout",
      name: name,
    });
  return page;
}

export const putPage = (state: DocState, page: PageSpec): DocState => ({
  ...state,
  pages: withEntry(state.pages, page.name, page),
});

export type DrawingProps = Omit<DrawingSpec, "name" | "kind">;
export const DRAWING_VALIDATORS: {
  [K in keyof DrawingProps]: (value: unknown) => DrawingProps[K];
} = {
  points: (value) => {
    if (!Array.isArray(value) || value.length > 2000) {
      throw new DocError(
        "points must be a list of numbers: x0, y0, x1, y1, ...",
        "INVALID_ARGUMENT",
        { field: "points" },
      );
    }
    return value.map((item) => finite(item, "A point"));
  },
  coords: (value) => oneOf(value, DRAWING_COORDS, "coords"),
  hAxis: (value) => textOf(value, "hAxis"),
  vAxis: (value) => textOf(value, "vAxis"),
  color: normalizeColor,
  lineSize: (value) => {
    const size = finite(value, "lineSize");
    if (size < 0 || size > 50)
      throw new DocError("lineSize must be between 0 and 50.", "INVALID_ARGUMENT", {
        field: "lineSize",
      });
    return size;
  },
  lineStyle: (value) => oneOf(value, LINE_STYLES, "lineStyle"),
  fill: (value) => (value === null ? null : normalizeColor(value)),
  fillOpacity: (value) => {
    const opacity = finite(value, "fillOpacity");
    if (opacity < 0 || opacity > 1)
      throw new DocError("fillOpacity must be between 0 and 1.", "INVALID_ARGUMENT", {
        field: "fillOpacity",
      });
    return opacity;
  },
  arrow: (value) => oneOf(value, ARROW_ENDS, "arrow"),
  closed: (value) => bool(value, "closed"),
  text: (value) => textOf(value, "text"),
  textSize: (value) => (value === null ? null : fontSize(value, "textSize")),
  layer: (value) => oneOf(value, DRAWING_LAYERS, "layer"),
};

/** How many numbers the points of a drawing of each kind are. */
export const DRAWING_POINTS: Record<DrawingSpec["kind"], { least: number; most: number }> = {
  line: { least: 4, most: 4 },
  arrow: { least: 4, most: 4 },
  rect: { least: 4, most: 4 },
  roundrect: { least: 4, most: 4 },
  oval: { least: 4, most: 4 },
  text: { least: 2, most: 2 },
  polygon: { least: 4, most: 2000 },
};

/** Checks a drawing as a whole: its points for its kind, and its axes when it is on them. */
export function checkDrawing(graph: GraphSpec, drawing: DrawingSpec): DrawingSpec {
  const { least, most } = DRAWING_POINTS[drawing.kind];
  const count = drawing.points.length;
  if (count % 2 !== 0 || count < least || count > most) {
    throw new DocError(
      least === most
        ? `A ${drawing.kind} has ${least / 2} point${least === 2 ? "" : "s"}: ${least} numbers, not ${count}.`
        : `A ${drawing.kind} has at least ${least / 2} points (x, y pairs), not ${count} numbers.`,
    );
  }
  if (drawing.coords === "axes") {
    for (const [name, vertical] of [
      [drawing.hAxis, false],
      [drawing.vAxis, true],
    ] as const) {
      const axis = graph.axes[name];
      if (!axis)
        throw new DocError(
          `${graph.name} has no axis named ${JSON.stringify(name)}.`,
          "NOT_FOUND",
          { kind: "axis", name },
        );
      if (isVerticalSide(axis.side) !== vertical) {
        throw new DocError(
          `Axis ${name} is ${vertical ? "horizontal" : "vertical"}; a drawing needs a ${vertical ? "vertical" : "horizontal"} one there.`,
        );
      }
    }
  }
  return drawing;
}

export function validateProps<T>(
  props: Props,
  validators: { [K in keyof T]: (value: unknown) => T[K] },
  what: string,
): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(props)) {
    // Own properties only: "constructor" is not a property, though every object has one.
    const validate = Object.hasOwn(validators, key)
      ? (validators as Record<string, (value: unknown) => unknown>)[key]
      : undefined;
    if (!validate) {
      throw new DocError(
        `Unknown ${what} property ${JSON.stringify(key)}. Known properties: ${Object.keys(validators).join(", ")}.`,
        "INVALID_ARGUMENT",
        { field: key },
      );
    }
    (result as Record<string, unknown>)[key] = validate(value);
  }
  return result;
}

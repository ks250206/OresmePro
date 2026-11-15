import { dependsOnOther, type LengthUnit, type PlotDimension } from "../doc/types";

/** Points (1/72 inch) in one of each unit. */
export const POINTS_PER: Record<LengthUnit, number> = { pt: 1, cm: 72 / 2.54, inch: 72 };

/** A length in points. */
export const toPoints = (value: number, unit: LengthUnit): number => value * POINTS_PER[unit];

/**
 * Layout units in a point for a graph in its window and in the files it is
 * saved as. One layout unit is one CSS pixel, 1/96 inch: on screen it is a
 * CSS pixel, and a graph's PDF is written at 0.75 pt to the unit. A page
 * layout lays its graphs out with one unit to the point instead.
 */
export const SCREEN_UNITS_PER_POINT = 96 / 72;

/**
 * The bounds of a side of the plot area that is not auto, in layout units.
 * A size worked out beyond them (a plan of a very long axis, say) is held
 * at the bound, and the plot area then no longer has the ratio asked for.
 */
export const MIN_PLOT_SIZE = 16;
export const MAX_PLOT_SIZE = 4000;

/** What a side's size needs to know of an axis it is sized by. */
export interface AxisExtent {
  /** How many units the axis shows: its range, or the decades of a log axis. */
  units: number;
  /** The part of the side the axis covers (its span), from 0 to 1. */
  span: number;
}

export interface PlotSizeInput {
  width: PlotDimension;
  height: PlotDimension;
  /** The figure size the window (or the caller) offers: what auto sides fill. */
  available: { width: number; height: number };
  /** The room the axes and their labels need around the plot area. */
  margins: { left: number; right: number; top: number; bottom: number };
  /** The axes the graph has, or null for one it does not. */
  axis: (name: string) => AxisExtent | null;
  /** Layout units in a point: {@link SCREEN_UNITS_PER_POINT}, or 1 on a page. */
  unitsPerPoint: number;
}

export interface PlotSizeResult {
  /** The plot area, in whole layout units. */
  plotWidth: number;
  plotHeight: number;
  /** The figure: the plot area and the margins, or what was available for an auto side. */
  width: number;
  height: number;
  /** Whether each side is fixed by its mode rather than following what is available. */
  fixedWidth: boolean;
  fixedHeight: boolean;
}

const clampPlot = (size: number): number =>
  Math.round(Math.min(MAX_PLOT_SIZE, Math.max(MIN_PLOT_SIZE, size)));

/**
 * The size of the plot area and of the figure, from the size modes of the
 * two sides. An auto side is what is available less the margins, as it
 * always was (at least 16 units); any other side is worked out from its mode
 * and the figure is then that side plus the margins. A side sized from the
 * other (aspect, plan) is worked out after it. When both would depend on
 * each other (which the document refuses) the width is taken as auto.
 *
 * Pure, and called again for each pass of the margins: the margins depend
 * on the tick labels, which depend on the plot area.
 */
export function plotAreaSize(input: PlotSizeInput): PlotSizeResult {
  const { margins, available, unitsPerPoint } = input;
  let width = input.width;
  const height = input.height;
  if (dependsOnOther(width) && dependsOnOther(height)) width = { mode: "auto" };

  const autoWidth = Math.max(16, Math.round(available.width - margins.left - margins.right));
  const autoHeight = Math.max(16, Math.round(available.height - margins.top - margins.bottom));
  const length = (value: number, unit: LengthUnit) => toPoints(value, unit) * unitsPerPoint;
  /** The length of the side `axis` is on, for `perUnit` layout units to its unit. */
  const sideFor = (axis: string, perUnit: number): number | null => {
    const extent = input.axis(axis);
    return extent ? (perUnit * extent.units) / extent.span : null;
  };
  /** The length of one unit of `axis`, on a side `side` long. */
  const unitOf = (axis: string, side: number): number | null => {
    const extent = input.axis(axis);
    return extent ? (side * extent.span) / extent.units : null;
  };

  /** A side's size from its own mode alone, or null if it follows the window or the other side. */
  const own = (dimension: PlotDimension): number | null => {
    switch (dimension.mode) {
      case "absolute":
        return clampPlot(length(dimension.value, dimension.unit));
      case "perUnit": {
        const side = sideFor(dimension.axis, length(dimension.value, dimension.unit));
        return side === null ? null : clampPlot(side);
      }
      default:
        return null;
    }
  };
  /** A side's size from the other side's. */
  const fromOther = (dimension: PlotDimension, other: number, horizontal: boolean) => {
    if (dimension.mode === "aspect") return clampPlot(dimension.factor * other);
    if (dimension.mode !== "plan") return null;
    // The width makes a unit of hAxis `factor` units of vAxis long; the height the reverse.
    const [mine, theirs] = horizontal
      ? [dimension.hAxis, dimension.vAxis]
      : [dimension.vAxis, dimension.hAxis];
    const unit = unitOf(theirs, other);
    const side = unit === null ? null : sideFor(mine, dimension.factor * unit);
    return side === null ? null : clampPlot(side);
  };

  let plotWidth: number;
  let plotHeight: number;
  let fixedWidth: boolean;
  let fixedHeight: boolean;
  if (dependsOnOther(width)) {
    const sized = own(height);
    plotHeight = sized ?? autoHeight;
    fixedHeight = sized !== null;
    const other = fromOther(width, plotHeight, true);
    plotWidth = other ?? autoWidth;
    fixedWidth = other !== null;
  } else {
    const sized = own(width);
    plotWidth = sized ?? autoWidth;
    fixedWidth = sized !== null;
    const other = dependsOnOther(height) ? fromOther(height, plotWidth, false) : own(height);
    plotHeight = other ?? autoHeight;
    fixedHeight = other !== null;
  }
  return {
    plotWidth,
    plotHeight,
    width: fixedWidth
      ? Math.round(margins.left) + plotWidth + Math.ceil(margins.right)
      : available.width,
    height: fixedHeight
      ? Math.round(margins.top) + plotHeight + Math.ceil(margins.bottom)
      : available.height,
    fixedWidth,
    fixedHeight,
  };
}

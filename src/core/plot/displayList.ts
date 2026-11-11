import type { MarkerShape } from "../doc/types";

/**
 * A graph is laid out into a flat list of these drawing instructions, which
 * the canvas and SVG backends both consume. Keeping the list backend-neutral
 * is what makes the screen and exported files agree.
 *
 * Coordinates are CSS pixels with the origin at the top-left.
 */
export type Prim =
  | {
      kind: "polyline";
      /** x0, y0, x1, y1, ... */
      points: ArrayLike<number>;
      stroke: string;
      width: number;
      dash?: readonly number[];
    }
  | {
      kind: "segments";
      /** Independent segments: ax, ay, bx, by, ... */
      points: ArrayLike<number>;
      stroke: string;
      width: number;
      dash?: readonly number[];
      /** Snap to the pixel grid (axes, ticks, grid lines). */
      crisp?: boolean;
    }
  | {
      kind: "markers";
      /** Centers: x0, y0, x1, y1, ... */
      points: ArrayLike<number>;
      shape: MarkerShape;
      /** Half-width of the marker. */
      size: number;
      fill: string | null;
      stroke: string;
      width: number;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      width?: number;
    }
  | {
      kind: "text";
      /** Left end of the alphabetic baseline. */
      x: number;
      y: number;
      text: string;
      family: string;
      size: number;
      fill: string;
      /** Clockwise rotation in degrees about (x, y). */
      rotate?: number;
    }
  | {
      kind: "image";
      x: number;
      y: number;
      w: number;
      h: number;
      /** Pixel dimensions of `rgba`; it is stretched over the rectangle unsmoothed. */
      cols: number;
      rows: number;
      /** Row 0 is the top. */
      rgba: Uint8ClampedArray<ArrayBuffer>;
    }
  | { kind: "clip"; x: number; y: number; w: number; h: number; children: Prim[] };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measures the advance width of text; the only thing layout needs from a font. */
export type MeasureText = (text: string, size: number, family: string) => number;

export const DASHES: Record<string, readonly number[] | undefined> = {
  solid: undefined,
  dash: [6, 4],
  dot: [1.5, 3],
  dashdot: [6, 3, 1.5, 3],
};

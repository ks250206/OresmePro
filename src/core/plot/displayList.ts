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
      kind: "polygon";
      /** Corners: x0, y0, x1, y1, ... The outline closes itself. */
      points: ArrayLike<number>;
      fill: string;
      /** 0 (invisible) to 1 (solid); solid if left out. */
      opacity?: number;
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
      /** Left out for upright, regular text, so plain text is drawn as it always was. */
      bold?: boolean;
      italic?: boolean;
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

/** Bold and italic, where text has them; left out (or false) for regular upright text. */
export interface FontStyle {
  bold?: boolean;
  italic?: boolean;
}

/** Measures the advance width of text; the only thing layout needs from a font. */
export type MeasureText = (text: string, size: number, family: string, style?: FontStyle) => number;

/**
 * The CSS font that draws and measures text, the same way for the canvas,
 * the measuring context and pictures of text, so that what is measured is
 * what is drawn.
 */
export const cssFont = (size: number, family: string, style: FontStyle = {}): string =>
  `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${size}px ${family}`;

export const DASHES: Record<string, readonly number[] | undefined> = {
  solid: undefined,
  dash: [6, 4],
  dot: [1.5, 3],
  dashdot: [6, 3, 1.5, 3],
};

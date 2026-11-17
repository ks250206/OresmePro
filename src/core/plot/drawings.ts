import type { DrawingSpec } from "../doc/types";
import { DASHES, type MeasureText, type Prim, type Rect } from "./displayList";
import { emitText, layoutText } from "./richText";
import type { Scale } from "./scale";

/** Where a drawing is on the graph, for picking it and its handles with the mouse. */
export interface DrawingGeometry {
  name: string;
  /** Its points in pixels: x0, y0, x1, y1, ... (for text, its top left corner). */
  points: number[];
  /** What it covers, in pixels: its outline's box, or the text's. */
  box: Rect;
}

/** How far the corners of a rounded rectangle are rounded, at most. */
const ROUND = 10;
/** Segments an oval is drawn with. */
const OVAL_STEPS = 72;

/** The pixels of a drawing's points, or null if an axis it is on is not drawn. */
export function drawingPixels(
  drawing: DrawingSpec,
  plot: Rect,
  scaleOf: (axis: string) => Scale | undefined,
): number[] | null {
  const out: number[] = [];
  if (drawing.coords === "plot") {
    for (let index = 0; index < drawing.points.length; index += 2) {
      out.push(
        plot.x + drawing.points[index]! * plot.w,
        plot.y + drawing.points[index + 1]! * plot.h,
      );
    }
    return out;
  }
  const xs = scaleOf(drawing.hAxis);
  const ys = scaleOf(drawing.vAxis);
  if (!xs || !ys) return null;
  for (let index = 0; index < drawing.points.length; index += 2) {
    const x = xs.toPixel(drawing.points[index]!);
    const y = ys.toPixel(drawing.points[index + 1]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push(x, y);
  }
  return out;
}

/** The point a pixel is at, in a drawing's own terms (see {@link DrawingSpec.points}). */
export function pixelToDrawing(
  drawing: Pick<DrawingSpec, "coords" | "hAxis" | "vAxis">,
  px: number,
  py: number,
  plot: Rect,
  scaleOf: (axis: string) => Scale | undefined,
): [number, number] | null {
  if (drawing.coords === "plot") {
    return [(px - plot.x) / plot.w, (py - plot.y) / plot.h];
  }
  const xs = scaleOf(drawing.hAxis);
  const ys = scaleOf(drawing.vAxis);
  if (!xs || !ys) return null;
  return [xs.toValue(px), ys.toValue(py)];
}

const boxOf = (points: ArrayLike<number>): Rect => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let index = 0; index < points.length; index += 2) {
    left = Math.min(left, points[index]!);
    right = Math.max(right, points[index]!);
    top = Math.min(top, points[index + 1]!);
    bottom = Math.max(bottom, points[index + 1]!);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
};

/** The outline of a rectangle with rounded corners, as a polygon. */
function roundedRect(box: Rect): number[] {
  const radius = Math.min(ROUND, box.w / 2, box.h / 2);
  const corners: [number, number, number][] = [
    [box.x + box.w - radius, box.y + radius, -Math.PI / 2],
    [box.x + box.w - radius, box.y + box.h - radius, 0],
    [box.x + radius, box.y + box.h - radius, Math.PI / 2],
    [box.x + radius, box.y + radius, Math.PI],
  ];
  const out: number[] = [];
  for (const [cx, cy, start] of corners) {
    for (let step = 0; step <= 8; step += 1) {
      const angle = start + (step / 8) * (Math.PI / 2);
      out.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    }
  }
  return out;
}

function oval(box: Rect): number[] {
  const out: number[] = [];
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  for (let step = 0; step < OVAL_STEPS; step += 1) {
    const angle = (step / OVAL_STEPS) * 2 * Math.PI;
    out.push(cx + (box.w / 2) * Math.cos(angle), cy + (box.h / 2) * Math.sin(angle));
  }
  return out;
}

/** An arrowhead at (x, y), pointing away from (fromX, fromY). */
function arrowhead(x: number, y: number, fromX: number, fromY: number, size: number): number[] {
  const angle = Math.atan2(y - fromY, x - fromX);
  const spread = Math.PI / 7;
  return [
    x,
    y,
    x - size * Math.cos(angle - spread),
    y - size * Math.sin(angle - spread),
    x - size * Math.cos(angle + spread),
    y - size * Math.sin(angle + spread),
  ];
}

/**
 * Adds a drawing's primitives at its pixels and returns the box it covers.
 * `size` and `family` are the graph's font, for text.
 */
export function emitDrawing(
  prims: Prim[],
  drawing: DrawingSpec,
  pixels: readonly number[],
  size: number,
  family: string,
  measure: MeasureText,
): Rect {
  const { color, lineSize } = drawing;
  const dash = DASHES[drawing.lineStyle];
  const stroke = (points: number[], closed: boolean) => {
    if (lineSize <= 0 || points.length < 4) return;
    prims.push({
      kind: "polyline",
      points: closed ? [...points, points[0]!, points[1]!] : points,
      stroke: color,
      width: lineSize,
      ...(dash ? { dash } : {}),
    });
  };
  const fill = (points: number[]) => {
    if (drawing.fill === null || points.length < 6) return;
    prims.push({ kind: "polygon", points, fill: drawing.fill, opacity: drawing.fillOpacity });
  };

  switch (drawing.kind) {
    case "line":
    case "arrow": {
      const [x0, y0, x1, y1] = pixels as [number, number, number, number];
      // The line stops at the base of an arrowhead, so a thick line does not poke through its tip.
      const head = 7 + lineSize * 2.5;
      const pull = (x: number, y: number, fromX: number, fromY: number): [number, number] => {
        const length = Math.hypot(x - fromX, y - fromY) || 1;
        const back = Math.min(length, head * 0.8);
        return [x - ((x - fromX) / length) * back, y - ((y - fromY) / length) * back];
      };
      const atEnd = drawing.arrow === "end" || drawing.arrow === "both";
      const atStart = drawing.arrow === "start" || drawing.arrow === "both";
      const start = atStart ? pull(x0, y0, x1, y1) : [x0, y0];
      const end = atEnd ? pull(x1, y1, x0, y0) : [x1, y1];
      stroke([start[0]!, start[1]!, end[0]!, end[1]!], false);
      if (atEnd)
        prims.push({ kind: "polygon", points: arrowhead(x1, y1, x0, y0, head), fill: color });
      if (atStart) {
        prims.push({ kind: "polygon", points: arrowhead(x0, y0, x1, y1, head), fill: color });
      }
      return boxOf(pixels);
    }
    case "rect":
    case "roundrect":
    case "oval": {
      const box = boxOf(pixels);
      const outline =
        drawing.kind === "rect"
          ? [box.x, box.y, box.x + box.w, box.y, box.x + box.w, box.y + box.h, box.x, box.y + box.h]
          : drawing.kind === "roundrect"
            ? roundedRect(box)
            : oval(box);
      fill(outline);
      stroke(outline, true);
      return box;
    }
    case "polygon": {
      const points = [...pixels];
      if (drawing.closed) fill(points);
      stroke(points, drawing.closed);
      return boxOf(points);
    }
    case "text": {
      const [x, y] = pixels as [number, number];
      const lines = drawing.text.split("\n");
      const lineSizePx = drawing.textSize ?? size;
      let top = y;
      let width = 0;
      for (const line of lines) {
        const block = layoutText(line, lineSizePx, family, measure);
        emitText(prims, block, x, top + block.ascent, { family, fill: color });
        width = Math.max(width, block.width);
        top += Math.max(block.ascent + block.descent, block.lineSize * 1.2);
      }
      return { x, y, w: Math.max(width, 4), h: Math.max(top - y, 4) };
    }
  }
}

/** How far from a line, in pixels, a click still picks it. */
const PICK = 5;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insidePolygon(px: number, py: number, points: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [points[i]!, points[i + 1]!, points[j]!, points[j + 1]!];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The drawing under a pixel, the front one first; null if none. */
export function drawingAt(
  drawings: readonly DrawingSpec[],
  geometry: readonly DrawingGeometry[],
  px: number,
  py: number,
): string | null {
  const kinds = new Map(drawings.map((drawing) => [drawing.name, drawing]));
  // The front layer is drawn last, so it is picked first; in a layer, the last drawn first.
  const inLayer = (layer: DrawingSpec["layer"]) =>
    geometry.filter((item) => kinds.get(item.name)?.layer === layer).reverse();
  for (const item of [...inLayer("front"), ...inLayer("back")]) {
    const drawing = kinds.get(item.name)!;
    const { points, box } = item;
    const near = (closed: boolean) => {
      const count = points.length / 2;
      for (let index = 0; index < count - (closed ? 0 : 1); index += 1) {
        const next = (index + 1) % count;
        const d = distanceToSegment(
          px,
          py,
          points[index * 2]!,
          points[index * 2 + 1]!,
          points[next * 2]!,
          points[next * 2 + 1]!,
        );
        if (d <= PICK + drawing.lineSize / 2) return true;
      }
      return false;
    };
    switch (drawing.kind) {
      case "line":
      case "arrow":
        if (near(false)) return item.name;
        break;
      case "polygon":
        if (near(drawing.closed) || (drawing.closed && insidePolygon(px, py, points))) {
          return item.name;
        }
        break;
      default:
        if (
          px >= box.x - PICK &&
          px <= box.x + box.w + PICK &&
          py >= box.y - PICK &&
          py <= box.y + box.h + PICK
        ) {
          return item.name;
        }
    }
  }
  return null;
}

/**
 * The handles of a selected drawing, in pixels: the ends of a line, the
 * corners of a polygon, the four corners of the box of a rectangle or oval.
 * Text has none: it is moved, and its size set in its dialog.
 */
export function drawingHandles(
  drawing: DrawingSpec,
  geometry: DrawingGeometry,
): [number, number][] {
  const { points, box } = geometry;
  switch (drawing.kind) {
    case "text":
      return [];
    case "rect":
    case "roundrect":
    case "oval":
      return [
        [box.x, box.y],
        [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h],
        [box.x, box.y + box.h],
      ];
    default: {
      const handles: [number, number][] = [];
      for (let index = 0; index < points.length; index += 2) {
        handles.push([points[index]!, points[index + 1]!]);
      }
      return handles;
    }
  }
}

/**
 * The pixels of a drawing after a handle is dragged to (px, py). A corner
 * of a box moves with the opposite corner held; an end or a polygon corner
 * moves by itself. `geometry` is the drawing as it was when the drag began,
 * so that the corner held stays the same one when the handle crosses it.
 */
export function dragHandle(
  drawing: DrawingSpec,
  geometry: DrawingGeometry,
  handle: number,
  px: number,
  py: number,
): number[] {
  if (drawing.kind === "rect" || drawing.kind === "roundrect" || drawing.kind === "oval") {
    const corners = drawingHandles(drawing, geometry);
    const [ox, oy] = corners[(handle + 2) % 4]!;
    return [ox, oy, px, py];
  }
  const points = [...geometry.points];
  points[handle * 2] = px;
  points[handle * 2 + 1] = py;
  return points;
}

/**
 * A value to keep. Fractions of the plot area go to 1/10000 (a hundredth of
 * a pixel on a large graph). Values on axes are kept as they are: an axis can
 * have a large offset and a narrow range (dates are seconds since 1970), so
 * any fixed number of digits would move the drawing. Only the noise of binary
 * arithmetic is taken away, at 15 significant digits.
 */
export function tidyDrawingValue(value: number, coords: DrawingSpec["coords"]): number {
  if (coords === "plot") return Math.round(value * 1e4) / 1e4;
  return value === 0 ? 0 : Number(value.toPrecision(15));
}

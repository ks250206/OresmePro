import { DEFAULT_FONT_FAMILY, type DocState, type PageItem, type PageSpec } from "../doc/types";
import type { MeasureText, Prim, Rect } from "./displayList";
import { layoutGraph } from "./layout";
import { CAP_HEIGHT, emitText, layoutText } from "./richText";

export interface PageLayout {
  width: number;
  height: number;
  /** The whole page, in points from its top left corner. */
  prims: Prim[];
  /** Where each item is, for selecting and dragging. */
  items: { name: string; kind: "graph" | "text"; box: Rect }[];
}

/** Drawing instructions moved by an offset: how a graph is put at its place on a page. */
export function translatePrims(prims: readonly Prim[], dx: number, dy: number): Prim[] {
  const shifted = (points: ArrayLike<number>): Float32Array => {
    const moved = new Float32Array(points.length);
    for (let index = 0; index < points.length; index += 2) {
      moved[index] = points[index]! + dx;
      moved[index + 1] = points[index + 1]! + dy;
    }
    return moved;
  };
  return prims.map((prim): Prim => {
    switch (prim.kind) {
      case "polyline":
      case "polygon":
      case "segments":
      case "markers":
        return { ...prim, points: shifted(prim.points) };
      case "clip":
        return {
          ...prim,
          x: prim.x + dx,
          y: prim.y + dy,
          children: translatePrims(prim.children, dx, dy),
        };
      default:
        return { ...prim, x: prim.x + dx, y: prim.y + dy };
    }
  });
}

/** A text item's lines laid out, and the box they take on the page. */
function layoutTextItem(item: PageItem, measure: MeasureText) {
  const lines = item.text
    .split("\n")
    .map((line) => layoutText(line, item.size, DEFAULT_FONT_FAMILY, measure));
  const lineHeight = item.size * 1.3;
  const width = Math.max(item.size, ...lines.map((line) => line.width));
  return {
    lines,
    lineHeight,
    box: { x: item.x, y: item.y, w: width, h: lineHeight * lines.length },
  };
}

/**
 * Where an item is on its page. A graph has the size it is given; text
 * takes the room its words need, so its box depends on the font.
 */
export function itemBox(item: PageItem, measure: MeasureText): Rect {
  return item.kind === "graph"
    ? { x: item.x, y: item.y, w: item.w, h: item.h }
    : layoutTextItem(item, measure).box;
}

const PAPER = "#ffffff";
const INK = "#000000";

/**
 * Lays out a page: each graph drawn at the size it has on the page, each
 * block of text at its place. One unit is one point, and a graph's fonts
 * keep their size in points, so 10 pt axis labels are 10 pt on paper.
 */
export function layoutPage(
  page: PageSpec,
  state: Pick<DocState, "graphs" | "waves" | "timeZone">,
  measure: MeasureText,
): PageLayout {
  const prims: Prim[] = [{ kind: "rect", x: 0, y: 0, w: page.width, h: page.height, fill: PAPER }];
  const items: PageLayout["items"] = [];
  for (const item of page.items) {
    if (item.kind === "graph") {
      const graph = item.graph === null ? undefined : state.graphs[item.graph];
      if (!graph) continue;
      const layout = layoutGraph(graph, state.waves, item.w, item.h, measure, {
        cursors: false,
        timeZone: state.timeZone,
      });
      prims.push({
        kind: "clip",
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        children: translatePrims(layout.prims, item.x, item.y),
      });
      items.push({
        name: item.name,
        kind: "graph",
        box: { x: item.x, y: item.y, w: item.w, h: item.h },
      });
      continue;
    }
    const { lines, lineHeight, box } = layoutTextItem(item, measure);
    lines.forEach((line, index) => {
      emitText(prims, line, item.x, item.y + lineHeight * index + item.size * (0.15 + CAP_HEIGHT), {
        family: DEFAULT_FONT_FAMILY,
        fill: INK,
      });
    });
    items.push({ name: item.name, kind: "text", box });
  }
  return { width: page.width, height: page.height, prims, items };
}

import {
  DEFAULT_FONT_FAMILY,
  type DocState,
  type GraphSpec,
  type PageItem,
  type PageSpec,
} from "../doc/types";
import type { MeasureText, Prim, Rect } from "./displayList";
import { layoutGraph, type GraphLayout } from "./layout";
import { graphWaveKey } from "./windowFit";
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

/**
 * A text item's lines laid out, each with the baseline it sits on, and the
 * box they take on the page. A line is as tall as the largest text on it needs.
 */
function layoutTextItem(item: PageItem, measure: MeasureText) {
  let height = 0;
  const lines = item.text.split("\n").map((text) => {
    const block = layoutText(text, item.size, DEFAULT_FONT_FAMILY, measure);
    const baseline = item.y + height + block.lineSize * (0.15 + CAP_HEIGHT);
    height += block.lineSize * 1.3;
    return { block, baseline };
  });
  const width = Math.max(item.size, ...lines.map((line) => line.block.width));
  return { lines, box: { x: item.x, y: item.y, w: width, h: height } };
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

type PageState = Pick<DocState, "graphs" | "waves" | "timeZone">;

/** A graph laid out as it is drawn on a page: at its size there, in points, without cursors. */
function layoutPageGraph(
  graph: GraphSpec,
  state: PageState,
  w: number,
  h: number,
  measure: MeasureText,
): GraphLayout {
  return layoutGraph(graph, state.waves, w, h, measure, {
    unitsPerPoint: 1,
    cursors: false,
    timeZone: state.timeZone,
  });
}

/**
 * Keeps the layouts of a page's graphs from one drawing of the page to the
 * next, each until what it is made of changes: its graph, the waves it
 * draws, its size, the time zone. A window showing a page lays it out again
 * whenever any graph or wave of the experiment changes; with this, only the
 * graphs those changes touch are laid out again.
 */
export class PageGraphCache {
  private readonly kept = new Map<
    string,
    {
      graph: GraphSpec;
      waves: string;
      w: number;
      h: number;
      zone: string;
      measure: MeasureText;
      layout: GraphLayout;
    }
  >();

  layout(
    item: string,
    graph: GraphSpec,
    state: PageState,
    w: number,
    h: number,
    measure: MeasureText,
  ): GraphLayout {
    const waves = graphWaveKey(graph, state.waves);
    const kept = this.kept.get(item);
    if (
      kept &&
      kept.graph === graph &&
      kept.waves === waves &&
      kept.w === w &&
      kept.h === h &&
      kept.zone === state.timeZone &&
      kept.measure === measure
    )
      return kept.layout;
    const layout = layoutPageGraph(graph, state, w, h, measure);
    this.kept.set(item, { graph, waves, w, h, zone: state.timeZone, measure, layout });
    return layout;
  }

  /** Forgets the items no longer on the page. */
  keepOnly(items: readonly string[]): void {
    const names = new Set(items);
    for (const item of this.kept.keys()) if (!names.has(item)) this.kept.delete(item);
  }
}

/**
 * Lays out a page: each graph drawn at the size it has on the page, each
 * block of text at its place. One unit is one point, and a graph's fonts
 * keep their size in points, so 10 pt axis labels are 10 pt on paper.
 */
export function layoutPage(
  page: PageSpec,
  state: Pick<DocState, "graphs" | "waves" | "timeZone">,
  measure: MeasureText,
  cache?: PageGraphCache,
): PageLayout {
  cache?.keepOnly(page.items.map((item) => item.name));
  const prims: Prim[] = [{ kind: "rect", x: 0, y: 0, w: page.width, h: page.height, fill: PAPER }];
  const items: PageLayout["items"] = [];
  for (const item of page.items) {
    if (item.kind === "graph") {
      const graph = item.graph === null ? undefined : state.graphs[item.graph];
      if (!graph) continue;
      // A plot area of a fixed size has that size on paper: the graph is
      // drawn from the top left of its box, cut off at the box's edges.
      const layout = cache
        ? cache.layout(item.name, graph, state, item.w, item.h, measure)
        : layoutPageGraph(graph, state, item.w, item.h, measure);
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
    const { lines, box } = layoutTextItem(item, measure);
    for (const { block, baseline } of lines) {
      emitText(prims, block, item.x, baseline, { family: DEFAULT_FONT_FAMILY, fill: INK });
    }
    items.push({ name: item.name, kind: "text", box });
  }
  return { width: page.width, height: page.height, prims, items };
}

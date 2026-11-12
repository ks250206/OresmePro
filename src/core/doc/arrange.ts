import type { MeasureText, Rect } from "../plot/displayList";
import { itemBox } from "../plot/page";
import { oneOf, type Command } from "./commands";
import { DocError, type DocState, type PageItem, type PageSpec } from "./types";

/**
 * Lining up, spacing and sizing the items of a page layout. The geometry is
 * worked out here, once, for the layout window and for Python alike; what
 * comes out is plain item changes, so undo and saving need nothing new.
 */

export const ALIGN_EDGES = ["left", "right", "top", "bottom", "center", "middle"] as const;
/** "center" lines up the middles across (one above the other), "middle" the middles down. */
export type AlignEdge = (typeof ALIGN_EDGES)[number];
export const DISTRIBUTE_DIRECTIONS = ["horizontal", "vertical"] as const;
export type DistributeDirection = (typeof DISTRIBUTE_DIRECTIONS)[number];
export const MATCH_DIMENSIONS = ["width", "height", "both"] as const;
export type MatchDimension = (typeof MATCH_DIMENSIONS)[number];

/** Room left around a grid and between its cells unless asked otherwise, in points. */
export const GRID_MARGIN = 36;
export const GRID_GAP = 12;
/** Rows and columns of the grids offered ready-made. */
export const GRID_PRESETS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 1],
  [2, 2],
  [3, 2],
  [2, 3],
];
const MAX_CELLS_PER_SIDE = 20;
/** The smallest a graph on a page can be (see the item validators in commands.ts). */
const SMALLEST_GRAPH = 40;

/** The smallest rectangle around all the boxes. */
export function boundsOf(boxes: readonly Rect[]): Rect {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Lines boxes up along an edge or their middles, against the outermost of
 * them. A single box has nothing to line up with, so it goes to the page's
 * edge or middle instead.
 */
export function alignBoxes(
  boxes: readonly Rect[],
  edge: AlignEdge,
  page: { width: number; height: number },
): Rect[] {
  const frame =
    boxes.length === 1 ? { x: 0, y: 0, w: page.width, h: page.height } : boundsOf(boxes);
  return boxes.map((box) => {
    switch (edge) {
      case "left":
        return { ...box, x: frame.x };
      case "right":
        return { ...box, x: frame.x + frame.w - box.w };
      case "center":
        return { ...box, x: frame.x + (frame.w - box.w) / 2 };
      case "top":
        return { ...box, y: frame.y };
      case "bottom":
        return { ...box, y: frame.y + frame.h - box.h };
      case "middle":
        return { ...box, y: frame.y + (frame.h - box.h) / 2 };
    }
  });
}

/**
 * Spaces boxes so the gaps between neighbours are equal. The boxes keep
 * their order and the span they cover: the first starts where the leftmost
 * (or topmost) started and the last ends where the furthest one ended.
 * Boxes of different sizes get equal gaps, not equally spaced middles.
 */
export function distributeBoxes(boxes: readonly Rect[], direction: DistributeDirection): Rect[] {
  const result = boxes.map((box) => ({ ...box }));
  if (boxes.length < 3) return result;
  const [at, size] = direction === "horizontal" ? (["x", "w"] as const) : (["y", "h"] as const);
  const order = boxes
    .map((_, index) => index)
    .sort((a, b) => boxes[a]![at] - boxes[b]![at] || a - b);
  const start = Math.min(...boxes.map((box) => box[at]));
  const end = Math.max(...boxes.map((box) => box[at] + box[size]));
  const filled = boxes.reduce((total, box) => total + box[size], 0);
  const gap = (end - start - filled) / (boxes.length - 1);
  let next = start;
  for (const index of order) {
    result[index]![at] = next;
    next += boxes[index]![size] + gap;
  }
  return result;
}

/** Gives every box the width, height or both of the first; top left corners stay. */
export function matchSizes(boxes: readonly Rect[], dimension: MatchDimension): Rect[] {
  const [reference] = boxes;
  if (!reference) return [];
  return boxes.map((box) => ({
    ...box,
    w: dimension === "height" ? box.w : reference.w,
    h: dimension === "width" ? box.h : reference.h,
  }));
}

/**
 * The cells of a grid filling an area, in reading order: along the first
 * row, then the next. `gap` is the room between columns and between rows.
 */
export function gridCells(
  rows: number,
  columns: number,
  area: Rect,
  gap: readonly [number, number],
): Rect[] {
  const w = (area.w - (columns - 1) * gap[0]) / columns;
  const h = (area.h - (rows - 1) * gap[1]) / rows;
  const cells: Rect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({ x: area.x + column * (w + gap[0]), y: area.y + row * (h + gap[1]), w, h });
    }
  }
  return cells;
}

/**
 * The order a reader meets boxes in: row by row from the top, left to right
 * within a row. A row is the topmost box left and every box whose middle is
 * level with it, so panels that are only roughly lined up still read in rows.
 * Returns indices into `boxes`.
 */
export function readingOrder(boxes: readonly Rect[]): number[] {
  const byTop = boxes
    .map((_, index) => index)
    .sort((a, b) => boxes[a]!.y - boxes[b]!.y || boxes[a]!.x - boxes[b]!.x || a - b);
  const order: number[] = [];
  const left = new Set(byTop);
  for (const first of byTop) {
    if (!left.has(first)) continue;
    const head = boxes[first]!;
    const row = byTop.filter((index) => {
      const box = boxes[index]!;
      return left.has(index) && box.y + box.h / 2 < head.y + head.h;
    });
    row.sort((a, b) => boxes[a]!.x - boxes[b]!.x || a - b);
    for (const index of row) {
      left.delete(index);
      order.push(index);
    }
  }
  return order;
}

/** One of the ways of rearranging items, as the layout window and Python ask for it. */
export type Arrangement =
  | { action: "align"; items: readonly string[]; edge: AlignEdge }
  | { action: "distribute"; items: readonly string[]; direction: DistributeDirection }
  /** To the size of the first graph named. */
  | { action: "matchSize"; items: readonly string[]; dimension: MatchDimension }
  | {
      /** Puts graphs in a grid inside the margins; `items` null means every graph, in reading order. */
      action: "arrange";
      items: readonly string[] | null;
      rows: number;
      columns: number;
      margin: number;
      /** Between columns, between rows. */
      gap: readonly [number, number];
    };

function itemNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new DocError("items must be a list of item names.");
  }
  return [...new Set(value as string[])];
}

function count(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_CELLS_PER_SIDE) {
    throw new DocError(`${what} must be a whole number from 1 to ${MAX_CELLS_PER_SIDE}.`);
  }
  return value as number;
}

function room(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DocError(`${what} must be a number of points, 0 or more.`);
  }
  return value;
}

/** Checks a request, as it may come from Python, and returns it in its proper form. */
export function checkArrangement(request: Readonly<Record<string, unknown>>): Arrangement {
  const action = oneOf(
    request.action,
    ["align", "distribute", "matchSize", "arrange"] as const,
    "action",
  );
  switch (action) {
    case "align":
      return {
        action,
        items: itemNames(request.items),
        edge: oneOf(request.edge, ALIGN_EDGES, "edge"),
      };
    case "distribute":
      return {
        action,
        items: itemNames(request.items),
        direction: oneOf(request.direction, DISTRIBUTE_DIRECTIONS, "direction"),
      };
    case "matchSize":
      return {
        action,
        items: itemNames(request.items),
        dimension: oneOf(request.dimension, MATCH_DIMENSIONS, "dimension"),
      };
    case "arrange": {
      const gap = request.gap ?? GRID_GAP;
      const gaps = Array.isArray(gap) ? gap : [gap, gap];
      if (gaps.length !== 2) {
        throw new DocError("gap must be a number, or two: between columns and between rows.");
      }
      return {
        action,
        items:
          request.items === null || request.items === undefined ? null : itemNames(request.items),
        rows: count(request.rows, "rows"),
        columns: count(request.columns, "columns"),
        margin: room(request.margin ?? GRID_MARGIN, "margin"),
        gap: [room(gaps[0], "gap"), room(gaps[1], "gap")],
      };
    }
  }
}

function findPage(state: DocState, name: string): PageSpec {
  // Not `pages[name]`: a page called "constructor" must not find Object's own.
  const page = Object.hasOwn(state.pages, name) ? state.pages[name] : undefined;
  if (!page) throw new DocError(`No page layout named ${JSON.stringify(name)}.`);
  return page;
}

function findItems(page: PageSpec, names: readonly string[]): PageItem[] {
  return names.map((name) => {
    const item = page.items.find((other) => other.name === name);
    if (!item) throw new DocError(`${page.name} has no item named ${JSON.stringify(name)}.`);
    return item;
  });
}

/** Keeps positions to a hundredth of a point, so the numbers read cleanly. */
const tidy = (value: number): number => Math.round(value * 100) / 100;

export interface ArrangeOutcome {
  /** Item changes that make the arrangement; none if everything is in place already. */
  commands: Command[];
  /** Graphs that did not fit in the grid and stay where they are. */
  leftOut: string[];
}

/**
 * Works out how to rearrange items on a page. Text takes the room its words
 * need, which only the font can tell, so `measure` is needed to know its box.
 */
export function arrangeLayout(
  state: DocState,
  layout: string,
  request: Readonly<Record<string, unknown>>,
  measure: MeasureText,
): ArrangeOutcome {
  const page = findPage(state, layout);
  const arrangement = checkArrangement(request);
  let items: PageItem[];
  let boxes: Rect[];
  let leftOut: string[] = [];
  switch (arrangement.action) {
    case "align": {
      items = findItems(page, arrangement.items);
      if (items.length === 0) throw new DocError("Name the items to align.");
      boxes = alignBoxes(
        items.map((item) => itemBox(item, measure)),
        arrangement.edge,
        page,
      );
      break;
    }
    case "distribute": {
      items = findItems(page, arrangement.items);
      if (items.length < 3) throw new DocError("Spacing items evenly needs three or more of them.");
      boxes = distributeBoxes(
        items.map((item) => itemBox(item, measure)),
        arrangement.direction,
      );
      break;
    }
    case "matchSize": {
      // Text is as big as its words; only graphs have a size to change.
      items = findItems(page, arrangement.items).filter((item) => item.kind === "graph");
      if (items.length < 2) throw new DocError("Matching sizes needs two or more graphs.");
      boxes = matchSizes(
        items.map((item) => itemBox(item, measure)),
        arrangement.dimension,
      );
      break;
    }
    case "arrange": {
      const { rows, columns, margin, gap } = arrangement;
      let graphs: PageItem[];
      if (arrangement.items === null) {
        const all = page.items.filter((item) => item.kind === "graph");
        graphs = readingOrder(all.map((item) => itemBox(item, measure))).map(
          (index) => all[index]!,
        );
      } else {
        graphs = findItems(page, arrangement.items).filter((item) => item.kind === "graph");
      }
      if (graphs.length === 0) throw new DocError(`${page.name} has no graphs to arrange.`);
      const area = {
        x: margin,
        y: margin,
        w: page.width - 2 * margin,
        h: page.height - 2 * margin,
      };
      const cells = gridCells(rows, columns, area, gap);
      const [cell] = cells;
      if (!cell || cell.w < SMALLEST_GRAPH || cell.h < SMALLEST_GRAPH) {
        throw new DocError(
          `A ${rows} × ${columns} grid leaves too little room for each graph; use fewer rows or columns, or smaller margins and gaps.`,
        );
      }
      items = graphs.slice(0, cells.length);
      boxes = cells.slice(0, items.length);
      leftOut = graphs.slice(cells.length).map((item) => item.name);
      break;
    }
  }
  const commands: Command[] = [];
  items.forEach((item, index) => {
    const box = boxes[index]!;
    const props: Record<string, number> = {};
    if (tidy(box.x) !== item.x) props.x = tidy(box.x);
    if (tidy(box.y) !== item.y) props.y = tidy(box.y);
    if (item.kind === "graph") {
      if (tidy(box.w) !== item.w) props.w = tidy(box.w);
      if (tidy(box.h) !== item.h) props.h = tidy(box.h);
    }
    if (Object.keys(props).length > 0) {
      commands.push({ op: "modifyLayoutItem", layout: page.name, item: item.name, props });
    }
  });
  return { commands, leftOut };
}

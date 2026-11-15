import type { Command } from "../doc/commands";
import {
  infoBarHeight,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  TITLE_BAR_HEIGHT,
  figureSize,
  type DocState,
  type GraphSpec,
  type WindowState,
} from "../doc/types";
import type { MeasureText } from "./displayList";
import { layoutGraph } from "./layout";

/**
 * The revisions of the waves a graph draws, as one string: it changes when
 * the data of the graph does, and not when other waves change.
 */
export function graphWaveKey(graph: GraphSpec, waves: DocState["waves"]): string {
  return [
    ...graph.traces.flatMap((trace) => [
      trace.y,
      trace.x,
      trace.yError,
      trace.xError,
      trace.colorWave,
    ]),
    ...graph.images.map((image) => image.wave),
    ...graph.contours.map((contour) => contour.wave),
  ]
    .map((wave) => (typeof wave === "string" ? waves[wave]?.rev : ""))
    .join(",");
}

/** Whether a side of a graph's plot area has a size of its own rather than following the window. */
export const fixedSides = (graph: GraphSpec): { width: boolean; height: boolean } => ({
  width: graph.width.mode !== "auto",
  height: graph.height.mode !== "auto",
});

/**
 * The size a graph's window needs to show its figure whole, as Igor sizes a
 * graph window to a plot area that is not auto: in a fixed side, the figure
 * (the plot area and the margins) plus, across, the title bar and the cursor
 * bar when shown; a side that follows the window keeps the window's size. A
 * window cannot be smaller than {@link MIN_WINDOW_WIDTH} by
 * {@link MIN_WINDOW_HEIGHT}; a smaller figure leaves room beside it. Null
 * when the window shows something else or fits already.
 */
export function fittedWindowSize(
  state: DocState,
  window: WindowState,
  measure: MeasureText,
): { w: number; h: number } | null {
  const graph = window.kind === "graph" ? state.graphs[window.name] : undefined;
  if (!graph) return null;
  const fixed = fixedSides(graph);
  if (!fixed.width && !fixed.height) return null;
  const available = figureSize(window, graph);
  const figure = layoutGraph(graph, state.waves, available.width, available.height, measure, {
    timeZone: state.timeZone,
    sizeOnly: true,
  });
  // The window holds the title bar, the figure and the cursor readout bar (see infoBarHeight).
  const info = infoBarHeight(graph);
  const w = fixed.width ? Math.max(MIN_WINDOW_WIDTH, figure.width) : window.w;
  const h = fixed.height
    ? Math.max(MIN_WINDOW_HEIGHT, figure.height + TITLE_BAR_HEIGHT + info)
    : window.h;
  return w === window.w && h === window.h ? null : { w, h };
}

/**
 * The commands that fit every graph window whose plot area is fixed to its
 * figure (see {@link fittedWindowSize}). `fit` can stand in for the
 * function, to remember what it worked out.
 */
export function windowFitCommands(
  state: DocState,
  measure: MeasureText,
  fit: typeof fittedWindowSize = fittedWindowSize,
): Command[] {
  const commands: Command[] = [];
  for (const window of state.windows) {
    const size = fit(state, window, measure);
    if (size) commands.push({ op: "moveWindow", name: window.name, ...size });
  }
  return commands;
}

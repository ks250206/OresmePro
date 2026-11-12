import { dict } from "./dict";
import {
  AXIS_LOOK,
  AXIS_SIDES,
  GRAPH_LOOK,
  INFO_BAR_HEIGHT,
  TITLE_BAR_HEIGHT,
  TRACE_LOOK,
  figureSize,
  type AxisLook,
  type AxisRole,
  type AxisSpec,
  type DocState,
  type GraphSpec,
  type StyleSpec,
  type TraceLook,
  type WindowState,
} from "./types";

/** The named properties of an object, in the order given. */
function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = source[key];
  return result;
}

const isSide = (name: string): name is (typeof AXIS_SIDES)[number] =>
  (AXIS_SIDES as readonly string[]).includes(name);

/**
 * The look of a graph as a style (see {@link StyleSpec} for what that is):
 * its fonts, the four axes of its sides, a cycle of its traces' looks, and
 * with `size` the size it is drawn at.
 */
export function captureStyle(state: DocState, graphName: string, size: boolean): StyleSpec {
  const graph = state.graphs[graphName];
  if (!graph) throw new Error(`No graph named ${JSON.stringify(graphName)}.`);
  const window = state.windows.find((item) => item.name === graphName);
  const axes: Partial<Record<AxisRole, Partial<AxisLook>>> = {};
  for (const side of AXIS_SIDES) axes[side] = pick(graph.axes[side]!, AXIS_LOOK);
  return {
    graph: pick(graph, GRAPH_LOOK),
    ...(size && window ? { size: figureSize(window, graph) } : {}),
    axes,
    ...(graph.traces.length > 0
      ? { traces: graph.traces.map((trace) => pick(trace, TRACE_LOOK)) }
      : {}),
  };
}

/** What a style gives the axis of a graph with this name. */
export function axisLook(
  style: StyleSpec | undefined,
  name: string,
  axis: AxisSpec,
): Partial<AxisLook> | undefined {
  if (isSide(name)) return style?.axes?.[name];
  return style?.axes?.other ?? style?.axes?.[axis.side];
}

/** What a style gives the trace at this place in a graph: its cycle, wrapped around. */
export function traceLook(style: StyleSpec | undefined, index: number): Partial<TraceLook> {
  const cycle = style?.traces ?? [];
  return cycle.length === 0 ? {} : cycle[index % cycle.length]!;
}

/**
 * A graph given a style: what the style holds replaces what the graph has,
 * and everything else (its data above all) is left as it is. The graph
 * remembers the style by `name`.
 */
export function styledGraph(graph: GraphSpec, style: StyleSpec, name: string): GraphSpec {
  return {
    ...graph,
    ...style.graph,
    style: name,
    axes: dict(
      Object.entries(graph.axes).map(([axisName, axis]) => [
        axisName,
        { ...axis, ...axisLook(style, axisName, axis) },
      ]),
    ),
    traces: graph.traces.map((trace, index) => ({ ...trace, ...traceLook(style, index) })),
  };
}

/** The windows, with a graph's window sized to draw it at the style's size, if it has one. */
export function styledWindows(
  windows: readonly WindowState[],
  graph: GraphSpec,
  style: StyleSpec,
): readonly WindowState[] {
  const { size } = style;
  if (!size) return windows;
  const info = graph.showInfo ? INFO_BAR_HEIGHT : 0;
  return windows.map((window) =>
    window.name === graph.name
      ? { ...window, w: size.width, h: size.height + TITLE_BAR_HEIGHT + info }
      : window,
  );
}

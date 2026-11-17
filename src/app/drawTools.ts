import type { DrawingKind } from "../core/doc/types";
import { createStore, useStore } from "./store";

/**
 * The drawing tools of graphs, as Igor shows them with ⌘T: a palette beside
 * the graph, the tool chosen in it, and the drawing selected. They are the
 * state of the work, not of the figure, so they are not saved.
 */
export type DrawTool = "select" | DrawingKind;

export interface GraphTools {
  tool: DrawTool;
  /** The drawing selected, to move, resize, change or remove. */
  selected: string | null;
  /** New drawings are pinned to the axes (they move with the data) instead of the plot area. */
  onAxes: boolean;
}

const OFF: GraphTools = { tool: "select", selected: null, onAxes: false };

/** The tools of each graph that shows them, by graph name. */
export const drawTools = createStore<{ graphs: Readonly<Record<string, GraphTools>> }>({
  graphs: {},
});

/** The tools of a graph, or null when it does not show them. */
export const useDrawTools = (graph: string): GraphTools | null =>
  useStore(drawTools, (state) =>
    Object.hasOwn(state.graphs, graph) ? state.graphs[graph]! : null,
  );

/** Whether a graph (or none) shows its tools, for menus. */
export const useToolsShown = (graph: string | null): boolean =>
  useStore(drawTools, (state) => graph !== null && Object.hasOwn(state.graphs, graph));

export const toolsShown = (graph: string): boolean => Object.hasOwn(drawTools.get().graphs, graph);

/** Shows a graph's tools, or hides them. */
export function toggleTools(graph: string, show = !toolsShown(graph)): void {
  drawTools.set(({ graphs }) => {
    const next = { ...graphs };
    if (show) next[graph] = graphs[graph] ?? OFF;
    else delete next[graph];
    return { graphs: next };
  });
}

/** Changes what a graph's tools hold (and shows them). */
export function setTools(graph: string, change: Partial<GraphTools>): void {
  drawTools.set(({ graphs }) => ({
    graphs: { ...graphs, [graph]: { ...(graphs[graph] ?? OFF), ...change } },
  }));
}

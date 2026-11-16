import { createStore, useStore } from "./store";

/**
 * Tool windows: the Procedure Browser and the Variables window. Like the
 * forms of plugins' actions (see ./actionWindows), they float over the
 * experiment's windows and are not part of it: not saved, not undone.
 */
export const TOOLS = ["procedureBrowser", "variables"] as const;
export type Tool = (typeof TOOLS)[number];

export interface ToolWindowState {
  tool: Tool;
  x: number;
  y: number;
  w: number;
  h: number;
}

const START: Record<Tool, Omit<ToolWindowState, "tool">> = {
  procedureBrowser: { x: 80, y: 40, w: 320, h: 380 },
  variables: { x: 140, y: 70, w: 420, h: 320 },
};
export const MIN_TOOL = { w: 220, h: 140 };

/** The tool windows open, back to front. */
export const toolWindows = createStore<{ windows: readonly ToolWindowState[] }>({ windows: [] });

export const useToolWindows = (): readonly ToolWindowState[] =>
  useStore(toolWindows, (state) => state.windows);

/** Opens a tool window, or brings it to the front if it is open. */
export function openTool(tool: Tool): void {
  toolWindows.set(({ windows }) => {
    const open = windows.find((window) => window.tool === tool);
    if (open) return { windows: [...windows.filter((window) => window !== open), open] };
    return { windows: [...windows, { tool, ...START[tool] }] };
  });
}

export function closeTool(tool: Tool): void {
  toolWindows.set(({ windows }) => ({ windows: windows.filter((window) => window.tool !== tool) }));
}

/** Moves or resizes a tool window, keeping its title bar on the desktop. */
export function placeTool(tool: Tool, place: Partial<Omit<ToolWindowState, "tool">>): void {
  toolWindows.set(({ windows }) => ({
    windows: windows.map((window) =>
      window.tool === tool
        ? {
            ...window,
            x: Math.round(place.x ?? window.x),
            y: Math.max(0, Math.round(place.y ?? window.y)),
            w: Math.max(MIN_TOOL.w, Math.round(place.w ?? window.w)),
            h: Math.max(MIN_TOOL.h, Math.round(place.h ?? window.h)),
          }
        : window,
    ),
  }));
}

export function raiseTool(tool: Tool): void {
  const { windows } = toolWindows.get();
  if (windows.at(-1)?.tool !== tool) openTool(tool);
}

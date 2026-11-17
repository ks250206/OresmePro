import { createStore, useStore } from "./store";

/**
 * Tool windows: the Procedure Browser, the Variables window and the plugins' model editors. Like the
 * forms of plugins' actions (see ./actionWindows), they float over the
 * experiment's windows and are not part of it: not saved, not undone.
 */
export const TOOLS = ["procedureBrowser", "variables"] as const;
/** A plugin's model editor (src/app/pluginEditors.ts): editor:<plugin>/<editor>. */
export type EditorTool = `editor:${string}`;
export type Tool = (typeof TOOLS)[number] | EditorTool;

export interface ToolWindowState {
  tool: Tool;
  x: number;
  y: number;
  w: number;
  h: number;
}

const START: Record<(typeof TOOLS)[number] | "editor", Omit<ToolWindowState, "tool">> = {
  procedureBrowser: { x: 80, y: 40, w: 380, h: 420 },
  variables: { x: 140, y: 70, w: 420, h: 320 },
  editor: { x: 40, y: 12, w: 960, h: 700 },
};

const startOf = (tool: Tool) =>
  START[tool.startsWith("editor:") ? "editor" : (tool as (typeof TOOLS)[number])];
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
    return { windows: [...windows, { tool, ...startOf(tool) }] };
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

/** Closes the editor windows of a plugin (when it is removed). */
export function closeEditorWindows(plugin: string): void {
  toolWindows.set(({ windows }) => ({
    windows: windows.filter((window) => !window.tool.startsWith(`editor:${plugin}/`)),
  }));
}

/** Closes the windows of every plugin's editors: another experiment was opened. */
export function closeAllEditorWindows(): void {
  toolWindows.set(({ windows }) => ({
    windows: windows.filter((window) => !window.tool.startsWith("editor:")),
  }));
}

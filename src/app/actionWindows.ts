import { createStore, useStore } from "./store";

/**
 * The forms of plugins' actions open on the desktop: windows that float
 * over the experiment's own and are not part of it, so that an action can be
 * run again and again while the graphs and tables stay in reach. They are
 * not saved, and closing one forgets the values in its form.
 */
export interface ActionWindowState {
  /** The plugin's name and the action's, which together say which form it is. */
  plugin: string;
  action: string;
  /** Its top left corner on the desktop, in pixels. */
  x: number;
  y: number;
}

/** The windows open, back to front. */
export const actionWindows = createStore<{ windows: readonly ActionWindowState[] }>({
  windows: [],
});

export const useActionWindows = (): readonly ActionWindowState[] =>
  useStore(actionWindows, (state) => state.windows);

const same = (window: ActionWindowState, plugin: string, action: string) =>
  window.plugin === plugin && window.action === action;

/** Where a new window opens: down and to the right of the one opened before. */
const START = { x: 120, y: 60 };
const CASCADE = 24;

/** Opens the form of a plugin's action, or brings it to the front if it is open. */
export function openActionWindow(plugin: string, action: string): void {
  actionWindows.set(({ windows }) => {
    const open = windows.find((window) => same(window, plugin, action));
    if (open) return { windows: [...windows.filter((window) => window !== open), open] };
    const step = windows.length % 8;
    const placed = { plugin, action, x: START.x + step * CASCADE, y: START.y + step * CASCADE };
    return { windows: [...windows, placed] };
  });
}

export function closeActionWindow(plugin: string, action: string): void {
  actionWindows.set(({ windows }) => ({
    windows: windows.filter((window) => !same(window, plugin, action)),
  }));
}

/** Moves a window, keeping its title bar on the desktop. */
export function moveActionWindow(plugin: string, action: string, x: number, y: number): void {
  actionWindows.set(({ windows }) => ({
    windows: windows.map((window) =>
      same(window, plugin, action)
        ? { ...window, x: Math.round(x), y: Math.max(0, Math.round(y)) }
        : window,
    ),
  }));
}

/** Brings a window in front of the others. */
export function raiseActionWindow(plugin: string, action: string): void {
  const { windows } = actionWindows.get();
  if (windows.length === 0 || same(windows.at(-1)!, plugin, action)) return;
  openActionWindow(plugin, action);
}

/** Closes the windows of a plugin's actions, or only those it no longer has. */
export function closePluginWindows(plugin: string, keep: readonly string[] = []): void {
  actionWindows.set(({ windows }) => ({
    windows: windows.filter((window) => window.plugin !== plugin || keep.includes(window.action)),
  }));
}

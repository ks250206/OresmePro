import type { WindowState } from "../core/doc/types";
import { doc, runGui, type MenuItem } from "./session";

/** The kinds of window, as the Windows menu groups them. */
const WINDOW_GROUPS: readonly [WindowState["kind"], string][] = [
  ["graph", "Graphs"],
  ["table", "Tables"],
  ["procedure", "Procedures"],
  ["page", "Layouts"],
  ["panel", "Panels"],
];

/**
 * The windows of the experiment for the Windows menu: a submenu for each
 * kind there is, the open windows by name and then the closed ones, which
 * reopen when chosen.
 */
export function windowListItems(
  windows: readonly WindowState[],
  top: WindowState | null,
): MenuItem[] {
  const byName = (a: WindowState, b: WindowState) => a.name.localeCompare(b.name);
  return WINDOW_GROUPS.flatMap(([kind, title]): MenuItem[] => {
    const mine = windows.filter((window) => window.kind === kind);
    if (mine.length === 0) return [];
    const open = mine.filter((window) => !window.hidden).sort(byName);
    const closed = mine.filter((window) => window.hidden).sort(byName);
    return [
      {
        label: `${title} (${mine.length})`,
        submenu: [
          ...open.map<MenuItem>((window) => ({
            label: window.name,
            checked: window === top,
            onSelect: () => doc.dispatch({ op: "activateWindow", name: window.name }),
          })),
          ...(open.length > 0 && closed.length > 0 ? [{ separator: true }] : []),
          ...closed.map<MenuItem>((window) => ({
            label: `${window.name} (closed)`,
            onSelect: () => runGui({ op: "reopenWindow", name: window.name }),
          })),
        ],
      },
    ];
  });
}

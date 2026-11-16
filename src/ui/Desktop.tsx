import { useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { setEditing, usePanelRuntime } from "../app/panels";
import { doc, runGui, TITLE_BAR_HEIGHT, ui, useDoc } from "../app/session";
import { openWindows, type WindowState } from "../core/doc/types";
import { fixedSides } from "../core/plot/windowFit";
import { ActionWindows } from "./ActionWindow";
import { GraphWindow } from "./GraphWindow";
import { LayoutWindow } from "./LayoutWindow";
import { keepFocus, menuBarItems, openContextMenu, type MenuDefinition } from "./Menu";
import { NoteWindow } from "./NoteWindow";
import { PanelWindow } from "./PanelWindow";
import { ProcedureWindow } from "./ProcedureWindow";
import { TableWindow } from "./TableWindow";

interface Edges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

const HANDLES: { edges: Edges; className: string }[] = [
  { edges: { top: true }, className: "left-2 right-2 -top-1 h-2 cursor-ns-resize" },
  { edges: { bottom: true }, className: "left-2 right-2 -bottom-1 h-2 cursor-ns-resize" },
  { edges: { left: true }, className: "top-2 bottom-2 -left-1 w-2 cursor-ew-resize" },
  { edges: { right: true }, className: "top-2 bottom-2 -right-1 w-2 cursor-ew-resize" },
  { edges: { top: true, left: true }, className: "-left-1 -top-1 h-3 w-3 cursor-nwse-resize" },
  { edges: { top: true, right: true }, className: "-right-1 -top-1 h-3 w-3 cursor-nesw-resize" },
  {
    edges: { bottom: true, left: true },
    className: "-bottom-1 -left-1 h-3 w-3 cursor-nesw-resize",
  },
  {
    edges: { bottom: true, right: true },
    className: "-bottom-1 -right-1 h-3 w-3 cursor-nwse-resize",
  },
];

/** Tracks a pointer drag, reporting the offset from where it started. */
function useDrag(
  onMove: (dx: number, dy: number, start: WindowState) => void,
  window: WindowState,
) {
  const start = useRef<{ x: number; y: number; window: WindowState } | null>(null);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { x: event.clientX, y: event.clientY, window };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const origin = start.current;
      if (origin) onMove(event.clientX - origin.x, event.clientY - origin.y, origin.window);
    },
    onPointerUp: () => {
      start.current = null;
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

function ResizeHandle({
  window,
  edges,
  className,
}: {
  window: WindowState;
  /** The edges it moves, less those whose side is fixed (see {@link Locked}). */
  edges: Edges;
  className: string;
}) {
  const drag = useDrag((dx, dy, start) => {
    const minW = 200;
    const minH = 140;
    let { x, y, w, h } = start;
    if (edges.right) w = Math.max(minW, start.w + dx);
    if (edges.bottom) h = Math.max(minH, start.h + dy);
    if (edges.left) {
      w = Math.max(minW, start.w - dx);
      x = start.x + start.w - w;
    }
    if (edges.top) {
      h = Math.max(minH, start.h - dy);
      y = Math.max(0, start.y + start.h - h);
      h = start.y + start.h - y;
    }
    doc.dispatch({ op: "moveWindow", name: window.name, x, y, w, h });
  }, window);
  return <div className={`absolute z-10 ${className}`} {...drag} />;
}

/**
 * The sides of a window that cannot be resized by hand: those of a graph
 * whose plot area has a size of its own there, as the window always fits
 * its figure in that side (see ../core/plot/windowFit).
 */
interface Locked {
  width: boolean;
  height: boolean;
}

/** A handle's edges, less those of locked sides; null if none is left. */
function freeEdges(edges: Edges, locked: Locked): Edges | null {
  const free: Edges = {
    left: edges.left && !locked.width,
    right: edges.right && !locked.width,
    top: edges.top && !locked.height,
    bottom: edges.bottom && !locked.height,
  };
  return free.left || free.right || free.top || free.bottom ? free : null;
}

/** The Edit / Done toggle in the title bar of a panel. */
function PanelEditToggle({ name }: { name: string }) {
  const editing = usePanelRuntime((state) => state.editing[name] === true);
  return (
    <button
      type="button"
      aria-label={`Edit ${name}`}
      aria-pressed={editing}
      title={
        editing ? "Stop editing the panel" : "Edit the panel: add, change and arrange controls"
      }
      className="rounded px-1 text-[10.5px] text-muted hover:bg-chrome hover:text-ink aria-pressed:text-accent"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => setEditing(name, !editing)}
    >
      {editing ? "Done" : "Edit"}
    </button>
  );
}

function WindowFrame({
  window,
  active,
  title,
  z,
  accessory,
  locked = { width: false, height: false },
  children,
}: {
  window: WindowState;
  active: boolean;
  title: string;
  z: number;
  locked?: Locked;
  /** Shown at the right end of the title bar. */
  accessory?: ReactNode;
  children: ReactNode;
}) {
  const drag = useDrag((dx, dy, start) => {
    doc.dispatch({
      op: "moveWindow",
      name: window.name,
      x: Math.max(80 - start.w, start.x + dx),
      y: Math.max(0, start.y + dy),
    });
  }, window);
  return (
    <section
      aria-label={window.name}
      data-window={window.name}
      data-active={active}
      className={`absolute flex flex-col rounded-md border bg-paper ${
        active ? "border-[#8d95a1] shadow-[0_8px_28px_rgb(0_0_0/0.22)]" : "border-line shadow-md"
      }`}
      style={{ left: window.x, top: window.y, width: window.w, height: window.h, zIndex: z }}
      onPointerDownCapture={() => {
        if (!active) doc.dispatch({ op: "activateWindow", name: window.name });
      }}
    >
      <header
        className={`flex shrink-0 items-center gap-2 rounded-t-md border-b px-2 ${
          active ? "border-line bg-chrome-2" : "border-line-soft bg-chrome text-muted"
        }`}
        style={{ height: TITLE_BAR_HEIGHT - 1 }}
        {...drag}
        // On the bar, not the title: dragging captures the pointer, so the bar gets the clicks.
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          ui.set({ dialog: { kind: "renameWindow", name: window.name } });
        }}
      >
        <button
          type="button"
          aria-label={`Close ${window.name}`}
          title="Close or kill (Alt-click: kill)"
          className={`grid h-3 w-3 place-items-center rounded-full text-[9px] leading-none text-transparent hover:text-black/70 ${
            active ? "bg-[#e5665e]" : "bg-line"
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) =>
            // Alt-click kills at once; a click asks whether to close or kill.
            event.altKey
              ? runGui({ op: "killWindow", name: window.name })
              : ui.set({ dialog: { kind: "closeWindow", name: window.name } })
          }
        >
          {"×"}
        </button>
        <span
          className="min-w-0 flex-1 truncate text-center text-[11.5px] font-medium"
          title="Double-click to rename"
        >
          {title}
        </span>
        {accessory ?? <span className="w-3" />}
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-md">{children}</div>
      {HANDLES.map((handle, index) => {
        const edges = freeEdges(handle.edges, locked);
        if (!edges) return null;
        // A corner left with one side to move resizes only that way.
        const corner =
          (handle.edges.left || handle.edges.right) && (handle.edges.top || handle.edges.bottom);
        const cursor =
          corner && locked.width
            ? "!cursor-ns-resize"
            : corner && locked.height
              ? "!cursor-ew-resize"
              : "";
        return (
          <ResizeHandle
            key={index}
            window={window}
            edges={edges}
            className={`${handle.className} ${cursor}`}
          />
        );
      })}
    </section>
  );
}

function windowTitle(window: WindowState, names: readonly string[]): string {
  // An image and its contours share a name; say it once.
  const unique = [...new Set(names)];
  if (unique.length === 0) return window.name;
  const shown = unique.slice(0, 4).join(", ");
  return `${window.name}: ${shown}${unique.length > 4 ? ", \u2026" : ""}`;
}

/**
 * Whether a right click lands on the desktop itself: windows have context
 * menus of their own, and text and fields keep the browser's.
 */
const onBackground = (target: EventTarget): boolean =>
  !(target as HTMLElement).closest("[data-window], [data-floating], .selectable, input, textarea");

/**
 * The area where graph, table and procedure windows live. Right-clicking it
 * gives the menu bar's commands, as `menus`.
 */
export function Desktop({ menus }: { menus: readonly MenuDefinition[] }) {
  const all = useDoc((state) => state.windows);
  // Closed windows are kept in the experiment but not drawn.
  const windows = useMemo(() => openWindows(all), [all]);
  const graphs = useDoc((state) => state.graphs);
  const tables = useDoc((state) => state.tables);
  const panels = useDoc((state) => state.panels);
  const top = windows.at(-1);
  // Render in a stable order so a window's DOM (and canvas) survives re-stacking;
  // z-order is expressed with z-index instead.
  const ordered = [...windows].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-desktop"
      data-desktop
      onMouseDown={(event) => {
        // As with the menu bar, the keys go on acting where they did.
        if (event.button === 2 && onBackground(event.target)) keepFocus(event);
      }}
      onContextMenu={(event) => {
        if (!onBackground(event.target)) return;
        event.preventDefault();
        openContextMenu(event, menuBarItems(menus));
      }}
    >
      {windows.length === 0 && all.length > 0 ? (
        <div className="absolute inset-0 grid place-items-center text-muted">
          <div className="max-w-sm text-center leading-relaxed">
            <div className="mb-1 text-[13px] font-medium text-ink/70">Every window is closed</div>
            Reopen one from the <b>Windows</b> menu, where each kind lists its windows.
          </div>
        </div>
      ) : windows.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-muted">
          <div className="max-w-sm text-center leading-relaxed">
            <div className="mb-1 text-[13px] font-medium text-ink/70">No windows yet</div>
            Type Python in the command window below, for example
            <code className="mx-1 rounded bg-paper/70 px-1 font-mono">
              op.display(np.sin(np.linspace(0, 20, 500)))
            </code>
            or use <b>Windows &rsaquo; New Graph</b>.
          </div>
        </div>
      ) : null}
      {ordered.map((window) => {
        const graph = graphs[window.name];
        const table = tables[window.name];
        const names = graph
          ? [...graph.traces, ...graph.images, ...graph.contours].map((item) => item.name)
          : (table?.columns ?? []);
        const panel = Object.hasOwn(panels, window.name) ? panels[window.name] : undefined;
        return (
          <WindowFrame
            key={window.name}
            window={window}
            active={window === top}
            title={
              window.kind === "procedure"
                ? `${window.name}.py`
                : panel
                  ? panel.title || window.name
                  : `${windowTitle(window, names)}${graph?.link ? " · linked" : ""}`
            }
            z={windows.indexOf(window) + 1}
            accessory={window.kind === "panel" ? <PanelEditToggle name={window.name} /> : undefined}
            locked={graph ? fixedSides(graph) : undefined}
          >
            {window.kind === "graph" ? (
              <GraphWindow name={window.name} />
            ) : window.kind === "table" ? (
              <TableWindow name={window.name} />
            ) : window.kind === "page" ? (
              <LayoutWindow name={window.name} />
            ) : window.kind === "panel" ? (
              <PanelWindow name={window.name} />
            ) : window.kind === "note" ? (
              <NoteWindow name={window.name} />
            ) : (
              <ProcedureWindow name={window.name} />
            )}
          </WindowFrame>
        );
      })}
      <ActionWindows z={windows.length + 1} />
    </div>
  );
}

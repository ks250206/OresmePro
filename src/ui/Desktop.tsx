import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { doc, runGui, TITLE_BAR_HEIGHT, useDoc } from "../app/session";
import type { WindowState } from "../core/doc/types";
import { GraphWindow } from "./GraphWindow";
import { LayoutWindow } from "./LayoutWindow";
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

function WindowFrame({
  window,
  active,
  title,
  z,
  children,
}: {
  window: WindowState;
  active: boolean;
  title: string;
  z: number;
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
      >
        <button
          type="button"
          aria-label={`Close ${window.name}`}
          title="Close"
          className={`grid h-3 w-3 place-items-center rounded-full text-[9px] leading-none text-transparent hover:text-black/70 ${
            active ? "bg-[#e5665e]" : "bg-line"
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => runGui({ op: "killWindow", name: window.name })}
        >
          {"×"}
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[11.5px] font-medium">
          {title}
        </span>
        <span className="w-3" />
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-md">{children}</div>
      {HANDLES.map((handle, index) => (
        <ResizeHandle key={index} window={window} {...handle} />
      ))}
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

/** The area where graph, table and procedure windows live. */
export function Desktop() {
  const windows = useDoc((state) => state.windows);
  const graphs = useDoc((state) => state.graphs);
  const tables = useDoc((state) => state.tables);
  const top = windows.at(-1);
  // Render in a stable order so a window's DOM (and canvas) survives re-stacking;
  // z-order is expressed with z-index instead.
  const ordered = [...windows].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-desktop" data-desktop>
      {windows.length === 0 ? (
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
        return (
          <WindowFrame
            key={window.name}
            window={window}
            active={window === top}
            title={window.kind === "procedure" ? `${window.name}.py` : windowTitle(window, names)}
            z={windows.indexOf(window) + 1}
          >
            {window.kind === "graph" ? (
              <GraphWindow name={window.name} />
            ) : window.kind === "table" ? (
              <TableWindow name={window.name} />
            ) : window.kind === "page" ? (
              <LayoutWindow name={window.name} />
            ) : (
              <ProcedureWindow name={window.name} />
            )}
          </WindowFrame>
        );
      })}
    </div>
  );
}

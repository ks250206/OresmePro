import { useRef, type ReactNode } from "react";
import {
  closeTool,
  placeTool,
  raiseTool,
  useToolWindows,
  type Tool,
  type ToolWindowState,
} from "../app/toolWindows";
import { ProcedureBrowser } from "./ProcedureBrowser";
import { VariablesView } from "./VariablesView";
import { XpsWindow } from "./XpsWindow";

const TITLES: Record<Tool, string> = {
  procedureBrowser: "Procedure Browser",
  variables: "Variables",
  xps: "XPS Peak Fitting",
};

function content(tool: Tool): ReactNode {
  if (tool === "xps") return <XpsWindow />;
  return tool === "procedureBrowser" ? <ProcedureBrowser /> : <VariablesView />;
}

/** One tool window: a title bar to drag it by, its content, and a corner to resize it by. */
function ToolWindow({ window, front, z }: { window: ToolWindowState; front: boolean; z: number }) {
  const drag = useRef<{
    x: number;
    y: number;
    from: ToolWindowState;
    resize: boolean;
  } | null>(null);
  const title = TITLES[window.tool];
  const start = (event: React.PointerEvent, resize: boolean) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: window, resize };
  };
  const move = (event: React.PointerEvent) => {
    const at = drag.current;
    if (!at) return;
    const dx = event.clientX - at.x;
    const dy = event.clientY - at.y;
    placeTool(
      window.tool,
      at.resize
        ? { w: at.from.w + dx, h: at.from.h + dy }
        : { x: Math.max(80 - at.from.w, at.from.x + dx), y: at.from.y + dy },
    );
  };
  const stop = () => {
    drag.current = null;
  };
  return (
    <section
      role="dialog"
      aria-label={title}
      data-floating
      className={`pointer-events-auto absolute flex flex-col rounded-md border bg-chrome ${
        front ? "border-[#8d95a1] shadow-[0_8px_28px_rgb(0_0_0/0.22)]" : "border-line shadow-md"
      }`}
      style={{
        left: window.x,
        top: window.y,
        width: window.w,
        height: window.h,
        // Never past the bottom of the desktop, however big it was made.
        maxHeight: `calc(100% - ${window.y + 4}px)`,
        minHeight: 120,
        zIndex: z,
      }}
      onPointerDownCapture={() => raiseTool(window.tool)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target instanceof HTMLInputElement)) {
          event.stopPropagation();
          closeTool(window.tool);
        }
      }}
    >
      <header
        className={`flex h-[22px] shrink-0 cursor-default items-center gap-2 rounded-t-md border-b px-2 ${
          front ? "border-line bg-chrome-2" : "border-line-soft bg-chrome text-muted"
        }`}
        onPointerDown={(event) => start(event, false)}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
      >
        <button
          type="button"
          aria-label={`Close ${title}`}
          title="Close"
          className={`grid h-3 w-3 place-items-center rounded-full text-[9px] leading-none text-transparent hover:text-black/70 ${
            front ? "bg-[#e5665e]" : "bg-line"
          }`}
          onClick={() => closeTool(window.tool)}
        >
          {"×"}
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[11.5px] font-medium">
          {title}
        </span>
        <span className="w-3" />
      </header>
      <div className="relative min-h-0 flex-1">{content(window.tool)}</div>
      <div
        aria-hidden
        className="absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize"
        onPointerDown={(event) => start(event, true)}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
      />
    </section>
  );
}

/** The tool windows open, over the experiment's windows (at `z`) and under dialogs. */
export function ToolWindows({ z }: { z: number }) {
  const windows = useToolWindows();
  if (windows.length === 0) return null;
  // In a stable order, so that raising one does not move it in the page and lose the focus.
  const ordered = [...windows].sort((a, b) => a.tool.localeCompare(b.tool));
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: z }}>
      {ordered.map((window) => (
        <ToolWindow
          key={window.tool}
          window={window}
          front={window === windows.at(-1)}
          z={windows.indexOf(window) + 1}
        />
      ))}
    </div>
  );
}

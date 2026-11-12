import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { exportPage } from "../app/actions";
import { measureText } from "../app/measure";
import { doc, runGui, runGuiCoalesced, ui, useDoc } from "../app/session";
import type { Command } from "../core/doc/commands";
import { echoPython } from "../core/doc/echo";
import { PAGE_SIZES } from "../core/doc/types";
import { drawPrims } from "../core/plot/canvas";
import type { Rect } from "../core/plot/displayList";
import { layoutPage } from "../core/plot/page";
import { Button, Select } from "./controls";
import { openContextMenu } from "./Menu";

/** Room left around the page inside the window, in pixels. */
const MARGIN = 16;
const round = (value: number): number => Math.round(value * 2) / 2;

type Corner = "nw" | "ne" | "sw" | "se";

interface Drag {
  item: string;
  /** Moving the item, or resizing it by one of its corners. */
  corner: Corner | null;
  x: number;
  y: number;
  box: Rect;
}

/**
 * A page layout window: the page drawn to fit the window, with the items on
 * it selected, dragged and resized by the mouse.
 */
export function LayoutWindow({ name }: { name: string }) {
  const page = useDoc((state) => state.pages[name]);
  const graphs = useDoc((state) => state.graphs);
  const waves = useDoc((state) => state.waves);
  const zone = useDoc((state) => state.timeZone);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      setDpr(window.devicePixelRatio || 1);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => (page ? layoutPage(page, { graphs, waves, timeZone: zone }, measureText) : null),
    [page, graphs, waves, zone],
  );
  // Pixels per point: the page as large as fits.
  const zoom = page
    ? Math.max(
        0.05,
        Math.min((size.w - 2 * MARGIN) / page.width, (size.h - 2 * MARGIN) / page.height),
      )
    : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || size.w === 0) return;
    const scale = zoom * dpr;
    canvas.width = Math.round(layout.width * scale);
    canvas.height = Math.round(layout.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawPrims(context, layout.prims, scale);
  }, [layout, zoom, dpr, size.w]);

  if (!page || !layout) return null;
  const chosen = layout.items.find((item) => item.name === selected) ?? null;

  /** A position in the window as a position on the page, in points. */
  const toPage = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / zoom, y: (event.clientY - box.top) / zoom };
  };
  const itemAt = (x: number, y: number) =>
    layout.items.findLast(
      ({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,
    ) ?? null;

  const change = (item: string, props: Record<string, number>) => {
    const command: Command = { op: "modifyLayoutItem", layout: name, item, props };
    // One line in the history for the whole drag, with where the item ended up.
    runGuiCoalesced(`page:${name}:${item}`, [command], () => {
      const now = doc.getState().pages[name]?.items.find((other) => other.name === item);
      if (!now) return "";
      const final = Object.fromEntries(
        Object.keys(props).map((key) => [key, now[key as "x" | "y" | "w" | "h"]]),
      );
      return echoPython({ ...command, props: final }) ?? "";
    });
  };

  const start = (event: ReactPointerEvent<HTMLElement>, item: string, corner: Corner | null) => {
    if (event.button !== 0) return;
    const box = layout.items.find((other) => other.name === item)?.box;
    if (!box) return;
    event.stopPropagation();
    hostRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(item);
    drag.current = { item, corner, ...toPage(event), box };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const at = toPage(event);
    const dx = at.x - current.x;
    const dy = at.y - current.y;
    const { box, corner } = current;
    if (!corner) {
      change(current.item, { x: round(box.x + dx), y: round(box.y + dy) });
      return;
    }
    // The corner opposite the one held stays where it is.
    const left = corner.includes("w") ? Math.min(box.x + dx, box.x + box.w - 40) : box.x;
    const top = corner.includes("n") ? Math.min(box.y + dy, box.y + box.h - 40) : box.y;
    const right = corner.includes("e") ? Math.max(box.x + box.w + dx, box.x + 40) : box.x + box.w;
    const bottom = corner.includes("s") ? Math.max(box.y + box.h + dy, box.y + 40) : box.y + box.h;
    change(current.item, {
      x: round(left),
      y: round(top),
      w: round(right - left),
      h: round(bottom - top),
    });
  };

  const stop = () => {
    drag.current = null;
  };

  const remove = (item: string) => {
    runGui({ op: "removeLayoutItem", layout: name, item });
    setSelected(null);
  };

  const edit = (item: string) => {
    const spec = page.items.find((other) => other.name === item);
    if (spec?.kind === "text") ui.set({ dialog: { kind: "pageText", layout: name, item } });
    else if (spec?.graph) doc.dispatch({ op: "activateWindow", name: spec.graph });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!chosen) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(chosen.name);
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    change(chosen.name, { x: chosen.box.x + move[0], y: chosen.box.y + move[1] });
  };

  const paper =
    Object.entries(PAGE_SIZES).find(
      ([, [w, h]]) =>
        (w === page.width && h === page.height) || (h === page.width && w === page.height),
    )?.[0] ?? "custom";
  const landscape = page.width > page.height;
  const setPaper = (next: string, wide: boolean) => {
    const dimensions = PAGE_SIZES[next as keyof typeof PAGE_SIZES];
    if (!dimensions) return;
    const [short, long] = dimensions;
    runGui({
      op: "modifyLayout",
      layout: name,
      props: wide ? { width: long, height: short } : { width: short, height: long },
    });
  };
  const graphNames = Object.keys(graphs).sort((a, b) => a.localeCompare(b));
  const handles: Corner[] = ["nw", "ne", "sw", "se"];

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-chrome px-2 text-[11.5px]">
        <Select
          aria-label="Add graph"
          className="!h-5 max-w-[9rem] shrink-0"
          value=""
          disabled={graphNames.length === 0}
          onChange={(event) => {
            const graph = event.target.value;
            if (!graph) return;
            const made = runGui({ op: "addLayoutItem", layout: name, kind: "graph", graph });
            if (made) setSelected(made);
          }}
        >
          <option value="">Add Graph…</option>
          {graphNames.map((graph) => (
            <option key={graph}>{graph}</option>
          ))}
        </Select>
        <Button
          className="!h-5 shrink-0 whitespace-nowrap !px-2"
          onClick={() => ui.set({ dialog: { kind: "pageText", layout: name } })}
        >
          Add Text…
        </Button>
        <span className="flex-1" />
        <Select
          aria-label="Paper"
          className="!h-5"
          value={paper}
          onChange={(event) => setPaper(event.target.value, landscape)}
        >
          {paper === "custom" ? <option value="custom">custom</option> : null}
          {Object.keys(PAGE_SIZES).map((key) => (
            <option key={key}>{key}</option>
          ))}
        </Select>
        <Select
          aria-label="Orientation"
          className="!h-5"
          value={landscape ? "landscape" : "portrait"}
          disabled={paper === "custom"}
          onChange={(event) => setPaper(paper, event.target.value === "landscape")}
        >
          <option>portrait</option>
          <option>landscape</option>
        </Select>
        <Button
          className="!h-5 shrink-0 whitespace-nowrap !px-2"
          onClick={() => exportPage(name, `${name}.pdf`)}
        >
          Save PDF
        </Button>
      </div>
      <div
        ref={hostRef}
        tabIndex={0}
        role="application"
        aria-label={`${name} page`}
        className="relative min-h-0 flex-1 overflow-hidden bg-desktop outline-none"
        onKeyDown={onKeyDown}
        onPointerDown={() => setSelected(null)}
      >
        <div
          className="absolute shadow-[0_1px_8px_rgb(0_0_0/0.3)]"
          style={{
            left: Math.max(MARGIN, (size.w - page.width * zoom) / 2),
            top: Math.max(MARGIN, (size.h - page.height * zoom) / 2),
            width: page.width * zoom,
            height: page.height * zoom,
          }}
          onPointerDown={(event) => {
            const at = toPage(event);
            const item = itemAt(at.x, at.y);
            if (item) start(event, item.name, null);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          onDoubleClick={(event) => {
            const at = toPage(event);
            const item = itemAt(at.x, at.y);
            if (item) edit(item.name);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const at = toPage(event);
            const item = itemAt(at.x, at.y);
            if (!item) return;
            setSelected(item.name);
            openContextMenu(event, [
              {
                label: item.kind === "text" ? "Edit Text…" : "Show the Graph",
                onSelect: () => edit(item.name),
              },
              { label: `Remove ${item.name}`, onSelect: () => remove(item.name) },
            ]);
          }}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />
          {layout.items.map((item) => (
            <div
              key={item.name}
              data-item={item.name}
              aria-label={item.name}
              className={`pointer-events-none absolute ${
                item.name === selected ? "outline outline-1 outline-accent" : ""
              }`}
              style={{
                left: item.box.x * zoom,
                top: item.box.y * zoom,
                width: item.box.w * zoom,
                height: item.box.h * zoom,
              }}
            >
              {item.name === selected && item.kind === "graph"
                ? handles.map((corner) => (
                    <div
                      key={corner}
                      data-handle={corner}
                      className={`pointer-events-auto absolute h-2 w-2 border border-accent bg-white ${
                        corner === "nw" || corner === "se"
                          ? "cursor-nwse-resize"
                          : "cursor-nesw-resize"
                      }`}
                      style={{
                        left: corner.includes("w") ? -4 : undefined,
                        right: corner.includes("e") ? -4 : undefined,
                        top: corner.includes("n") ? -4 : undefined,
                        bottom: corner.includes("s") ? -4 : undefined,
                      }}
                      onPointerDown={(event) => start(event, item.name, corner)}
                      onPointerMove={onPointerMove}
                      onPointerUp={stop}
                      onPointerCancel={stop}
                    />
                  ))
                : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

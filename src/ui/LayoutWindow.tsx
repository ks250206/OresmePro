import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { exportPage, pageMenuItems, selectItems } from "../app/actions";
import { measureText } from "../app/measure";
import { doc, runGui, runGuiCoalesced, ui, useDoc, useUi, type MenuItem } from "../app/session";
import type { Command } from "../core/doc/commands";
import { echoPython } from "../core/doc/echo";
import { PAGE_SIZES } from "../core/doc/types";
import { drawPrims } from "../core/plot/canvas";
import type { Rect } from "../core/plot/displayList";
import { layoutPage } from "../core/plot/page";
import { Button, Select } from "./controls";
import { keepFocus, openContextMenu } from "./Menu";

/** Room left around the page inside the window, in pixels. */
const MARGIN = 16;
const round = (value: number): number => Math.round(value * 2) / 2;
/** Positions to a hundredth of a point, as alignment leaves them. */
const tidy = (value: number): number => Math.round(value * 100) / 100;

type Corner = "nw" | "ne" | "sw" | "se";
type Place = "x" | "y" | "w" | "h";

/** What a press of the mouse button started, until it is let go. */
type Gesture =
  | {
      kind: "move";
      /** Ties the changes of one drag into one undo step and one history entry. */
      key: string;
      x: number;
      y: number;
      /** Where each item being moved started. */
      from: { name: string; x: number; y: number }[];
      moved: boolean;
      /**
       * A click on one item of several selected, without dragging, selects
       * just that item once the button is let go.
       */
      only: string | null;
    }
  | { kind: "resize"; key: string; item: string; corner: Corner; x: number; y: number; box: Rect }
  /** A rubber band drawn from (x, y), adding what it touches to `base`. */
  | { kind: "band"; x: number; y: number; base: readonly string[] };

const touches = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, index) => name === b[index]);

let gestureCount = 0;

/**
 * A page layout window: the page drawn to fit the window, with the items on
 * it selected (one or several), dragged, resized by the mouse and lined up.
 */
export function LayoutWindow({ name }: { name: string }) {
  const page = useDoc((state) =>
    Object.hasOwn(state.pages, name) ? state.pages[name] : undefined,
  );
  const graphs = useDoc((state) => state.graphs);
  const waves = useDoc((state) => state.waves);
  const zone = useDoc((state) => state.timeZone);
  const chosen = useUi((state) =>
    Object.hasOwn(state.pageSelection, name) ? state.pageSelection[name] : undefined,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [band, setBand] = useState<Rect | null>(null);
  const gesture = useRef<Gesture | null>(null);
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

  // A layout made later under the same name starts with nothing selected.
  useEffect(
    () => () =>
      ui.set((state) => ({
        pageSelection: Object.fromEntries(
          Object.entries(state.pageSelection).filter(([layout]) => layout !== name),
        ),
      })),
    [name],
  );

  const layout = useMemo(
    () => (page ? layoutPage(page, { graphs, waves, timeZone: zone }, measureText) : null),
    [page, graphs, waves, zone],
  );
  // Items removed since they were selected (by Python, or by undo) drop out.
  const selected = useMemo(
    () => (chosen ?? []).filter((item) => page?.items.some((other) => other.name === item)),
    [chosen, page],
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
  const select = (items: readonly string[]) => {
    if (!sameList(items, selected)) selectItems(name, items);
  };
  const single =
    selected.length === 1 ? (layout.items.find((item) => item.name === selected[0]) ?? null) : null;

  /** A position in the window as a position on the page, in points. */
  const toPage = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) / zoom, y: (event.clientY - box.top) / zoom };
  };
  const itemAt = (x: number, y: number) =>
    layout.items.findLast(
      ({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h,
    ) ?? null;

  /**
   * Changes items as part of a gesture: applied at once, written into the
   * history once the gesture is over, as where the items ended up.
   */
  const change = (
    key: string,
    changes: { item: string; props: Partial<Record<Place, number>> }[],
  ) => {
    const commands: Command[] = changes.map(({ item, props }) => ({
      op: "modifyLayoutItem",
      layout: name,
      item,
      props,
    }));
    runGuiCoalesced(key, commands, () => {
      const { pages } = doc.getState();
      const now = Object.hasOwn(pages, name) ? pages[name]!.items : null;
      if (!now) return "";
      return changes
        .map(({ item, props }) => {
          const spec = now.find((other) => other.name === item);
          if (!spec) return null;
          const final = Object.fromEntries(Object.keys(props).map((at) => [at, spec[at as Place]]));
          return echoPython({ op: "modifyLayoutItem", layout: name, item, props: final });
        })
        .filter(Boolean)
        .join("\n");
    });
  };

  /** Starts dragging the given items; `only` as in {@link Gesture}. */
  const startMove = (
    at: { x: number; y: number },
    items: readonly string[],
    only: string | null,
  ) => {
    gestureCount += 1;
    gesture.current = {
      kind: "move",
      key: `page:${name}:drag${gestureCount}`,
      ...at,
      from: page.items
        .filter((item) => items.includes(item.name))
        .map((item) => ({ name: item.name, x: item.x, y: item.y })),
      moved: false,
      only,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    hostRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = toPage(event);
    const item = itemAt(at.x, at.y);
    const toggle = event.shiftKey || event.metaKey;
    // The selection as it is now, not as it was drawn: a second click can
    // arrive before the first one's selection has been rendered.
    const stored = ui.get().pageSelection;
    const selected = (Object.hasOwn(stored, name) ? stored[name]! : []).filter((chosen) =>
      page.items.some((other) => other.name === chosen),
    );
    const select = (items: readonly string[]) => {
      if (!sameList(items, selected)) selectItems(name, items);
    };
    if (!item) {
      // On empty paper: a rubber band, which adds to the selection with Shift.
      if (!toggle) select([]);
      gesture.current = { kind: "band", ...at, base: toggle ? selected : [] };
      return;
    }
    const isSelected = selected.includes(item.name);
    if (toggle) {
      select(
        isSelected ? selected.filter((other) => other !== item.name) : [...selected, item.name],
      );
      gesture.current = null;
      return;
    }
    if (!isSelected) select([item.name]);
    startMove(
      at,
      isSelected ? selected : [item.name],
      isSelected && selected.length > 1 ? item.name : null,
    );
  };

  const startResize = (event: ReactPointerEvent<HTMLElement>, item: string, corner: Corner) => {
    if (event.button !== 0) return;
    const box = layout.items.find((other) => other.name === item)?.box;
    if (!box) return;
    event.stopPropagation();
    hostRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureCount += 1;
    gesture.current = {
      kind: "resize",
      key: `page:${name}:resize${gestureCount}`,
      item,
      corner,
      ...toPage(event),
      box,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    const at = toPage(event);
    const dx = at.x - current.x;
    const dy = at.y - current.y;
    if (current.kind === "band") {
      const rect = {
        x: Math.min(at.x, current.x),
        y: Math.min(at.y, current.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      };
      setBand(rect);
      const hit = layout.items
        .filter((item) => touches(item.box, rect) && !current.base.includes(item.name))
        .map((item) => item.name);
      select([...current.base, ...hit]);
      return;
    }
    if (current.kind === "move") {
      // Every item moves by the same distance, so items lined up stay lined up.
      const [first] = current.from;
      const now = page.items.find((item) => item.name === first?.name);
      if (!first || !now) return;
      if (tidy(first.x + round(dx)) === now.x && tidy(first.y + round(dy)) === now.y) return;
      current.moved = true;
      change(
        current.key,
        current.from.map((item) => ({
          item: item.name,
          props: { x: tidy(item.x + round(dx)), y: tidy(item.y + round(dy)) },
        })),
      );
      return;
    }
    // The corner opposite the one held stays where it is.
    const { box, corner } = current;
    const left = corner.includes("w") ? Math.min(box.x + dx, box.x + box.w - 40) : box.x;
    const top = corner.includes("n") ? Math.min(box.y + dy, box.y + box.h - 40) : box.y;
    const right = corner.includes("e") ? Math.max(box.x + box.w + dx, box.x + 40) : box.x + box.w;
    const bottom = corner.includes("s") ? Math.max(box.y + box.h + dy, box.y + 40) : box.y + box.h;
    change(current.key, [
      {
        item: current.item,
        props: { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) },
      },
    ]);
  };

  const onPointerUp = () => {
    const current = gesture.current;
    gesture.current = null;
    if (current?.kind === "band") setBand(null);
    if (current?.kind === "move" && !current.moved && current.only) select([current.only]);
  };

  const remove = (items: readonly string[]) => {
    runGui(items.map((item) => ({ op: "removeLayoutItem", layout: name, item })));
    select([]);
  };

  const edit = (item: string) => {
    const spec = page.items.find((other) => other.name === item);
    if (spec?.kind === "text") ui.set({ dialog: { kind: "pageText", layout: name, item } });
    else if (spec?.graph) doc.dispatch({ op: "activateWindow", name: spec.graph });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      gesture.current = null;
      setBand(null);
      select([]);
      return;
    }
    if (selected.length === 0) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(selected);
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = Object.hasOwn(moves, event.key) ? moves[event.key] : undefined;
    if (!move) return;
    event.preventDefault();
    // A run of presses on the same items is one undo step and one history entry.
    change(
      `page:${name}:nudge:${selected.join(",")}`,
      page.items
        .filter((item) => selected.includes(item.name))
        .map((item) => ({
          item: item.name,
          props: { x: tidy(item.x + move[0]), y: tidy(item.y + move[1]) },
        })),
    );
  };

  const onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const at = toPage(event);
    const item = itemAt(at.x, at.y);
    let targets = selected;
    if (item && !selected.includes(item.name)) {
      targets = [item.name];
      select(targets);
    }
    const own: MenuItem[] = [];
    if (item && targets.length === 1) {
      own.push({
        label: item.kind === "text" ? "Edit Text…" : "Show the Graph",
        onSelect: () => edit(item.name),
      });
    }
    if (item) {
      own.push(
        {
          label: targets.length === 1 ? `Remove ${item.name}` : `Remove ${targets.length} Items`,
          onSelect: () => remove(targets),
        },
        { separator: true },
      );
    }
    openContextMenu(event, [...own, ...pageMenuItems(page, targets)]);
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
            if (made) select([made]);
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
        <Button
          className="!h-5 shrink-0 whitespace-nowrap !px-2"
          aria-haspopup="menu"
          onMouseDown={keepFocus}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            openContextMenu(
              { clientX: box.left, clientY: box.bottom + 2 },
              pageMenuItems(page, selected),
            );
          }}
        >
          Arrange ▾
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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const at = toPage(event);
          const item = itemAt(at.x, at.y);
          if (item) edit(item.name);
        }}
        onContextMenu={onContextMenu}
      >
        <div
          className="absolute shadow-[0_1px_8px_rgb(0_0_0/0.3)]"
          style={{
            left: Math.max(MARGIN, (size.w - page.width * zoom) / 2),
            top: Math.max(MARGIN, (size.h - page.height * zoom) / 2),
            width: page.width * zoom,
            height: page.height * zoom,
          }}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />
          {layout.items.map((item) => (
            <div
              key={item.name}
              data-item={item.name}
              data-selected={selected.includes(item.name) || undefined}
              aria-label={item.name}
              className={`pointer-events-none absolute ${
                selected.includes(item.name) ? "outline outline-1 outline-accent" : ""
              }`}
              style={{
                left: item.box.x * zoom,
                top: item.box.y * zoom,
                width: item.box.w * zoom,
                height: item.box.h * zoom,
              }}
            >
              {item === single && item.kind === "graph"
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
                      onPointerDown={(event) => startResize(event, item.name, corner)}
                    />
                  ))
                : null}
            </div>
          ))}
          {band ? (
            <div
              data-band
              className="pointer-events-none absolute border border-dashed border-accent bg-accent/10"
              style={{
                left: band.x * zoom,
                top: band.y * zoom,
                width: band.w * zoom,
                height: band.h * zoom,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { autoscaleGraph, exportGraph } from "../app/actions";
import { measureText } from "../app/measure";
import {
  doc,
  INFO_BAR_HEIGHT,
  runGui,
  runGuiCoalesced,
  ui,
  useDoc,
  useUi,
  type MenuItem,
} from "../app/session";
import type { Command } from "../core/doc/commands";
import { echoPython } from "../core/doc/echo";
import {
  CURSOR_NAMES,
  DATE_UNIT,
  isVerticalSide,
  type CursorName,
  type GraphSpec,
  type Wave,
} from "../core/doc/types";
import { drawPrims } from "../core/plot/canvas";
import type { Rect } from "../core/plot/displayList";
import {
  distanceToTrace,
  layoutGraph,
  nearestPoint,
  tracePosition,
  traceX,
  type GraphLayout,
} from "../core/plot/layout";
import { formatDate, formatNumber } from "../core/plot/ticks";
import { marqueeZoom, panBy, tidy, zoomAbout } from "../core/plot/zoom";
import { openContextMenu } from "./Menu";

const inside = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

function axisAt(layout: GraphLayout, x: number, y: number): string | null {
  for (const [name, axis] of Object.entries(layout.axes)) {
    if (inside(axis.hit, x, y)) return name;
  }
  return null;
}

function nearestTrace(layout: GraphLayout, x: number, y: number, tolerance: number): string | null {
  let best: string | null = null;
  let bestDistance = tolerance;
  for (const trace of layout.traces) {
    const distance = distanceToTrace(trace, x, y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = trace.name;
    }
  }
  return best;
}

/** The data coordinates under the pointer, on the axes that cover that spot. */
function readout(layout: GraphLayout, x: number, y: number): string {
  const parts: string[] = [];
  for (const [name, axis] of Object.entries(layout.axes)) {
    const vertical = isVerticalSide(axis.side);
    const { scale } = axis;
    const at = vertical ? y : x;
    if (at < Math.min(scale.p0, scale.p1) || at > Math.max(scale.p0, scale.p1)) continue;
    const value = scale.toValue(at);
    const perPixel = Math.abs(scale.toValue(at + 1) - value);
    const label = name === "bottom" ? "x" : name === "left" ? "y" : name;
    const text =
      axis.kind === "category"
        ? (axis.categories?.[Math.round(value)] ?? "")
        : axis.kind === "date"
          ? formatDate(Math.round(value))
          : `${formatNumber(tidy(value, perPixel * 100))}${axis.unit ? ` ${axis.unit}` : ""}`;
    parts.push(`${label} = ${text}`);
  }
  return parts.join("    ");
}

function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const update = () => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [ratio]);
  return ratio;
}

interface CursorValues {
  trace: string;
  point: number;
  x: number;
  y: number;
  /** The values as shown: dates and category names are not plain numbers. */
  xText: string;
  yText: string;
}

function cursorValues(
  graph: GraphSpec,
  waves: Readonly<Record<string, Wave>>,
  name: CursorName,
): CursorValues | null {
  const cursor = graph.cursors[name];
  const trace = cursor && graph.traces.find((item) => item.name === cursor.trace);
  const position = trace && tracePosition(trace, waves);
  if (!cursor || !position || cursor.point >= position.y.data.length) return null;
  const x = traceX(position.y, position.x, cursor.point);
  const y = position.y.data[cursor.point]!;
  const xUnit = position.x ? position.x.unit : position.y.xUnit;
  const show = (value: number, unit: string) =>
    unit === DATE_UNIT ? formatDate(value) : formatNumber(value, 7);
  return {
    trace: cursor.trace,
    point: cursor.point,
    x,
    y,
    xText: position.categories ? (position.categories[cursor.point] ?? "") : show(x, xUnit),
    yText: show(y, position.y.unit),
  };
}

/** The readout under a graph: where cursors A and B are, and the difference. */
function CursorInfo({ graph }: { graph: GraphSpec }) {
  const waves = useDoc((state) => state.waves);
  const a = cursorValues(graph, waves, "A");
  const b = cursorValues(graph, waves, "B");
  const row = (label: string, values: CursorValues | null) => (
    <>
      <b>{label}</b>
      {values ? (
        <>
          <span className="truncate">
            {values.trace}[{values.point}]
          </span>
          <span>X: {values.xText}</span>
          <span>Y: {values.yText}</span>
        </>
      ) : (
        <span className="col-span-3 text-muted">right-click a trace to place</span>
      )}
    </>
  );
  return (
    <div
      role="status"
      aria-label="Cursor info"
      className="selectable grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] content-center gap-x-3 whitespace-nowrap border-t border-line bg-chrome px-2 font-mono text-[11px] leading-[16px]"
      style={{ height: INFO_BAR_HEIGHT }}
    >
      {row("A", a)}
      {row("B", b)}
      <b>{"\u0394"}</b>
      {a && b ? (
        <>
          <span>{b.point - a.point} points</span>
          <span>X: {formatNumber(b.x - a.x, 7)}</span>
          <span>Y: {formatNumber(b.y - a.y, 7)}</span>
        </>
      ) : (
        <span className="col-span-3 text-muted">B {"\u2212"} A, once both are placed</span>
      )}
    </div>
  );
}

interface Marquee extends Rect {
  /** True once the drag has ended and the marquee menu is showing. */
  done: boolean;
}

type Gesture =
  | { kind: "marquee"; x: number; y: number }
  | { kind: "pan"; x: number; y: number; layout: GraphLayout }
  | { kind: "cursor"; name: CursorName };

export function GraphWindow({ name }: { name: string }) {
  const graph = useDoc((state) => state.graphs[name]);
  const waves = useDoc((state) => state.waves);
  const menuOpen = useUi((state) => state.contextMenu !== null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const touchedAxes = useRef(new Set<string>());
  /** The cursor the arrow keys move. */
  const activeCursor = useRef<CursorName>("A");
  const dpr = useDevicePixelRatio();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      setSize({ w: Math.round(box.width), h: Math.round(box.height) });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Re-layout only when this graph's own waves change, not on every edit elsewhere.
  const waveKey = graph
    ? [
        ...graph.traces.flatMap((trace) => [trace.y, trace.x, trace.yError, trace.xError]),
        ...graph.images.map((image) => image.wave),
        ...graph.contours.map((contour) => contour.wave),
      ]
        .map((wave) => (typeof wave === "string" ? waves[wave]?.rev : ""))
        .join(",")
    : "";
  const layout = useMemo(
    () =>
      graph && size.w > 0 && size.h > 0
        ? layoutGraph(graph, doc.getState().waves, size.w, size.h, measureText)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waveKey stands in for the wave data
    [graph, waveKey, size.w, size.h],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    canvas.width = Math.round(layout.width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPrims(context, layout.prims, dpr);
  }, [layout, dpr]);

  // The marquee stays up while its menu is open and goes away with it.
  useEffect(() => {
    if (!menuOpen) setMarquee((current) => (current?.done ? null : current));
  }, [menuOpen]);

  if (!graph) return null;

  const position = (event: { clientX: number; clientY: number }) => {
    const box = hostRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  /** Applies view changes from a continuous gesture, echoing once at the end. */
  const applyView = (commands: Command[]) => {
    if (commands.length === 0) return;
    for (const command of commands) {
      if (command.op === "modifyAxis") touchedAxes.current.add(command.axis);
    }
    runGuiCoalesced(`view:${name}`, commands, () => {
      const current = doc.getState().graphs[name];
      const lines = [...touchedAxes.current].map((axis) =>
        echoPython({
          op: "modifyAxis",
          graph: name,
          axis,
          props: { min: current?.axes[axis]?.min ?? null, max: current?.axes[axis]?.max ?? null },
        }),
      );
      touchedAxes.current.clear();
      return lines.join("\n");
    });
  };

  /** The point of a trace under a horizontal pixel position. */
  const pointAt = (traceName: string, x: number): number | null => {
    const trace = graph.traces.find((item) => item.name === traceName);
    const position = trace && tracePosition(trace, waves);
    const scale = trace && layout?.axes[trace.hAxis]?.scale;
    if (!position || !scale) return null;
    return nearestPoint(position.y, position.x, scale, x);
  };

  const setCursor = (cursor: CursorName, trace: string, point: number, coalesce: boolean) => {
    activeCursor.current = cursor;
    const command: Command = { op: "setCursor", graph: name, cursor, trace, point };
    const reveal: Command[] = graph.showInfo
      ? []
      : [{ op: "modifyGraph", graph: name, props: { showInfo: true } }];
    if (!coalesce) {
      runGui([command, ...reveal]);
      return;
    }
    runGuiCoalesced(`cursor:${name}:${cursor}`, [command], () => {
      const now = doc.getState().graphs[name]?.cursors[cursor];
      return now
        ? (echoPython({
            op: "setCursor",
            graph: name,
            cursor,
            trace: now.trace,
            point: now.point,
          }) ?? "")
        : "";
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout || event.button !== 0) return;
    hostRef.current?.focus({ preventScroll: true });
    const { x, y } = position(event);
    const grabbed = layout.cursors.find((cursor) => Math.hypot(cursor.x - x, cursor.y - y) <= 9);
    if (grabbed) {
      event.currentTarget.setPointerCapture(event.pointerId);
      activeCursor.current = grabbed.name;
      gesture.current = { kind: "cursor", name: grabbed.name };
      return;
    }
    if (!inside(layout.plot, x, y)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = event.altKey ? { kind: "pan", x, y, layout } : { kind: "marquee", x, y };
    setMarquee(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout) return;
    const { x, y } = position(event);
    const current = gesture.current;
    if (current?.kind === "marquee") {
      const cx = Math.min(layout.plot.x + layout.plot.w, Math.max(layout.plot.x, x));
      const cy = Math.min(layout.plot.y + layout.plot.h, Math.max(layout.plot.y, y));
      setMarquee({
        x: Math.min(current.x, cx),
        y: Math.min(current.y, cy),
        w: Math.abs(cx - current.x),
        h: Math.abs(cy - current.y),
        done: false,
      });
    } else if (current?.kind === "pan") {
      // Pan relative to the view at the start of the drag, so it tracks the pointer exactly.
      applyView(panBy(name, current.layout.axes, x - current.x, y - current.y, current));
    } else if (current?.kind === "cursor") {
      const cursor = graph.cursors[current.name];
      const point = cursor ? pointAt(cursor.trace, x) : null;
      if (cursor && point !== null && point !== cursor.point) {
        setCursor(current.name, cursor.trace, point, true);
      }
    }
    ui.set({ readout: inside(layout.plot, x, y) ? readout(layout, x, y) : "" });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (!layout || current?.kind !== "marquee" || !marquee) return;
    if (marquee.w < 4 || marquee.h < 4) {
      setMarquee(null);
      return;
    }
    setMarquee({ ...marquee, done: true });
    const zoom = (mode: "expand" | "shrink", horizontal: boolean, vertical: boolean) => () =>
      runGui(marqueeZoom(name, layout.axes, marquee, mode, { horizontal, vertical }));
    openContextMenu(event, [
      { label: "Expand", onSelect: zoom("expand", true, true) },
      { label: "Horiz Expand", onSelect: zoom("expand", true, false) },
      { label: "Vert Expand", onSelect: zoom("expand", false, true) },
      { separator: true },
      { label: "Shrink", onSelect: zoom("shrink", true, true) },
      { label: "Horiz Shrink", onSelect: zoom("shrink", true, false) },
      { label: "Vert Shrink", onSelect: zoom("shrink", false, true) },
    ]);
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!layout) return;
    const { x, y } = position(event);
    const axis = axisAt(layout, x, y);
    if (!axis && !inside(layout.plot, x, y)) return;
    const factor = Math.exp(Math.max(-120, Math.min(120, event.deltaY)) * 0.0016);
    applyView(zoomAbout(name, layout.axes, x, y, factor, axis));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const which = graph.cursors[activeCursor.current]
      ? activeCursor.current
      : CURSOR_NAMES.find((cursor) => graph.cursors[cursor]);
    const cursor = which && graph.cursors[which];
    const trace = cursor && graph.traces.find((item) => item.name === cursor.trace);
    const length = trace ? (waves[trace.y]?.data.length ?? 0) : 0;
    if (!which || !cursor || length === 0) return;
    event.preventDefault();
    const stride = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1);
    const point = Math.min(length - 1, Math.max(0, cursor.point + stride));
    if (point !== cursor.point) setCursor(which, cursor.trace, point, true);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!layout) return;
    const { x, y } = position(event);
    setMarquee(null);
    const axis = axisAt(layout, x, y);
    if (axis) {
      ui.set({ dialog: { kind: "modifyAxis", graph: name, axis } });
    } else if (inside(layout.plot, x, y)) {
      const trace = nearestTrace(layout, x, y, 6) ?? undefined;
      const image = graph.images.at(-1);
      const contour = graph.contours.at(-1);
      if (trace || (graph.traces.length > 0 && !image && !contour)) {
        ui.set({ dialog: { kind: "modifyTrace", graph: name, trace } });
      } else if (image) {
        ui.set({ dialog: { kind: "modifyImage", graph: name, image: image.name } });
      } else if (contour) {
        ui.set({ dialog: { kind: "modifyContour", graph: name, contour: contour.name } });
      }
    } else {
      ui.set({ dialog: { kind: "modifyGraph", graph: name } });
    }
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!layout) return;
    const { x, y } = position(event);
    const axis = axisAt(layout, x, y) ?? undefined;
    const trace = nearestTrace(layout, x, y, 6) ?? undefined;
    const point = trace ? pointAt(trace, x) : null;
    const open = (dialog: NonNullable<ReturnType<typeof ui.get>["dialog"]>) => () =>
      ui.set({ dialog });
    const items: MenuItem[] = [
      { label: "Autoscale Axes", shortcut: "Ctrl+A", onSelect: () => autoscaleGraph(name) },
      { separator: true },
    ];
    if (trace && point !== null) {
      for (const cursor of CURSOR_NAMES) {
        items.push({
          label: `Put Cursor ${cursor} on ${trace}[${point}]`,
          onSelect: () => setCursor(cursor, trace, point, false),
        });
      }
    }
    for (const cursor of CURSOR_NAMES) {
      if (graph.cursors[cursor]) {
        items.push({
          label: `Remove Cursor ${cursor}`,
          onSelect: () => runGui({ op: "removeCursor", graph: name, cursor }),
        });
      }
    }
    items.push(
      {
        label: "Show Cursor Info",
        shortcut: "Ctrl+I",
        checked: graph.showInfo,
        onSelect: () =>
          runGui({ op: "modifyGraph", graph: name, props: { showInfo: !graph.showInfo } }),
      },
      { separator: true },
      {
        label: trace ? `Modify ${trace}…` : "Modify Trace Appearance…",
        disabled: graph.traces.length === 0,
        onSelect: open({ kind: "modifyTrace", graph: name, trace }),
      },
      {
        label: axis ? `Modify ${axis} Axis…` : "Modify Axis…",
        onSelect: open({ kind: "modifyAxis", graph: name, axis }),
      },
      ...graph.images.map((image) => ({
        label: `Modify Image ${image.name}…`,
        onSelect: open({ kind: "modifyImage", graph: name, image: image.name }),
      })),
      ...graph.contours.map((contour) => ({
        label: `Modify Contour ${contour.name}…`,
        onSelect: open({ kind: "modifyContour", graph: name, contour: contour.name }),
      })),
      { label: "Modify Graph…", onSelect: open({ kind: "modifyGraph", graph: name }) },
      { separator: true },
      { label: "Append Traces…", onSelect: open({ kind: "appendTraces", graph: name }) },
      {
        label: "Append Image…",
        onSelect: open({ kind: "matrixPlot", plot: "image", graph: name }),
      },
      {
        label: "Append Contour…",
        onSelect: open({ kind: "matrixPlot", plot: "contour", graph: name }),
      },
      { label: "Add Axis…", onSelect: open({ kind: "addAxis", graph: name }) },
      {
        label: "Add Legend",
        onSelect: () => runGui({ op: "addAnnotation", graph: name, kind: "legend" }),
      },
      { label: "Add Text…", onSelect: open({ kind: "addText", graph: name }) },
    );
    if (graph.images.length > 0) {
      items.push({
        label: "Add Color Scale",
        onSelect: () => runGui({ op: "addAnnotation", graph: name, kind: "colorscale" }),
      });
    }
    const removals: MenuItem[] = [
      ...(trace
        ? [
            {
              label: `Remove ${trace}`,
              onSelect: () => runGui({ op: "removeTraces", graph: name, traces: [trace] }),
            },
          ]
        : []),
      ...graph.images.map((image) => ({
        label: `Remove Image ${image.name}`,
        onSelect: () => runGui({ op: "removeImage", graph: name, image: image.name }),
      })),
      ...graph.contours.map((contour) => ({
        label: `Remove Contour ${contour.name}`,
        onSelect: () => runGui({ op: "removeContour", graph: name, contour: contour.name }),
      })),
      ...graph.annotations.map((annotation) => ({
        label: `Remove ${annotation.name}`,
        onSelect: () =>
          runGui({ op: "removeAnnotation", graph: name, annotation: annotation.name }),
      })),
    ];
    if (removals.length > 0) items.push({ separator: true }, ...removals);
    items.push(
      { separator: true },
      { label: "Save as PDF", onSelect: () => exportGraph(name, `${name}.pdf`) },
      { label: "Save as SVG", onSelect: () => exportGraph(name, `${name}.svg`) },
      { label: "Save as PNG", onSelect: () => exportGraph(name, `${name}.png`) },
    );
    openContextMenu(event, items);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      <div
        ref={hostRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 cursor-crosshair outline-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          setMarquee(null);
        }}
        onPointerLeave={() => ui.set({ readout: "" })}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${name}: ${
            [...graph.traces, ...graph.images, ...graph.contours]
              .map((item) => item.name)
              .join(", ") || "empty graph"
          }`}
          style={{ width: size.w, height: size.h }}
          className="block"
        />
        {marquee ? (
          <div
            className="pointer-events-none absolute border border-dashed border-black/70 bg-black/[0.04]"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        ) : null}
        {layout && layout.missing.length > 0 ? (
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-danger/10 px-2 py-0.5 text-danger">
            Cannot plot: {layout.missing.join(", ")}
          </div>
        ) : null}
      </div>
      {graph.showInfo ? <CursorInfo graph={graph} /> : null}
    </div>
  );
}

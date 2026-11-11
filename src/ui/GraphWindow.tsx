import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { autoscaleGraph, exportGraphPng, exportGraphSvg } from "../app/actions";
import { measureText } from "../app/measure";
import { doc, runGui, runGuiCoalesced, ui, useDoc, useUi } from "../app/session";
import type { Command } from "../core/doc/commands";
import { echoPython } from "../core/doc/echo";
import type { AxisName } from "../core/doc/types";
import { drawPrims } from "../core/plot/canvas";
import type { Rect } from "../core/plot/displayList";
import { distanceToTrace, layoutGraph, type GraphLayout } from "../core/plot/layout";
import { formatNumber } from "../core/plot/ticks";
import { marqueeZoom, panBy, tidy, zoomAbout } from "../core/plot/zoom";
import { openContextMenu } from "./Menu";

const inside = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

function axisAt(layout: GraphLayout, x: number, y: number): AxisName | null {
  for (const [name, axis] of Object.entries(layout.axes)) {
    if (inside(axis.hit, x, y)) return name as AxisName;
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

function readout(layout: GraphLayout, x: number, y: number): string {
  const parts: string[] = [];
  for (const [name, axis] of Object.entries(layout.axes)) {
    const vertical = name === "left" || name === "right";
    const { scale } = axis;
    const value = scale.toValue(vertical ? y : x);
    const perPixel = Math.abs(scale.toValue((vertical ? y : x) + 1) - value);
    const label = name === "bottom" ? "x" : name === "left" ? "y" : name;
    parts.push(
      `${label} = ${formatNumber(tidy(value, perPixel * 100))}${axis.unit ? ` ${axis.unit}` : ""}`,
    );
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

interface Marquee extends Rect {
  /** True once the drag has ended and the marquee menu is showing. */
  done: boolean;
}

type Gesture =
  | { kind: "marquee"; x: number; y: number }
  | { kind: "pan"; x: number; y: number; layout: GraphLayout };

export function GraphWindow({ name }: { name: string }) {
  const graph = useDoc((state) => state.graphs[name]);
  const waves = useDoc((state) => state.waves);
  const menuOpen = useUi((state) => state.contextMenu !== null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const touchedAxes = useRef(new Set<AxisName>());
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
    ? graph.traces
        .map((trace) => `${waves[trace.y]?.rev}/${trace.x ? waves[trace.x]?.rev : ""}`)
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
          props: { min: current?.axes[axis].min ?? null, max: current?.axes[axis].max ?? null },
        }),
      );
      touchedAxes.current.clear();
      return lines.join("\n");
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout || event.button !== 0) return;
    const { x, y } = position(event);
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
      applyView(panBy(name, current.layout.axes, x - current.x, y - current.y));
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

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!layout) return;
    const { x, y } = position(event);
    setMarquee(null);
    const axis = axisAt(layout, x, y);
    if (axis) ui.set({ dialog: { kind: "modifyAxis", graph: name, axis } });
    else if (inside(layout.plot, x, y)) {
      const trace = nearestTrace(layout, x, y, 6) ?? undefined;
      if (graph.traces.length > 0) ui.set({ dialog: { kind: "modifyTrace", graph: name, trace } });
    } else ui.set({ dialog: { kind: "modifyGraph", graph: name } });
  };

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!layout) return;
    const { x, y } = position(event);
    const axis = axisAt(layout, x, y) ?? undefined;
    const trace = nearestTrace(layout, x, y, 6) ?? undefined;
    openContextMenu(event, [
      { label: "Autoscale Axes", shortcut: "Ctrl+A", onSelect: () => autoscaleGraph(name) },
      { separator: true },
      {
        label: trace ? `Modify ${trace}…` : "Modify Trace Appearance…",
        disabled: graph.traces.length === 0,
        onSelect: () => ui.set({ dialog: { kind: "modifyTrace", graph: name, trace } }),
      },
      {
        label: axis ? `Modify ${axis} Axis…` : "Modify Axis…",
        onSelect: () => ui.set({ dialog: { kind: "modifyAxis", graph: name, axis } }),
      },
      {
        label: "Modify Graph…",
        onSelect: () => ui.set({ dialog: { kind: "modifyGraph", graph: name } }),
      },
      { separator: true },
      {
        label: "Append Traces…",
        onSelect: () => ui.set({ dialog: { kind: "appendTraces", graph: name } }),
      },
      ...(trace
        ? [
            {
              label: `Remove ${trace}`,
              onSelect: () => runGui({ op: "removeTraces", graph: name, traces: [trace] }),
            },
          ]
        : []),
      {
        label: "Add Legend",
        onSelect: () => runGui({ op: "addAnnotation", graph: name, kind: "legend" }),
      },
      { label: "Add Text…", onSelect: () => ui.set({ dialog: { kind: "addText", graph: name } }) },
      ...graph.annotations.map((annotation) => ({
        label: `Remove ${annotation.name}`,
        onSelect: () =>
          runGui({ op: "removeAnnotation", graph: name, annotation: annotation.name }),
      })),
      { separator: true },
      { label: "Save as SVG", onSelect: () => exportGraphSvg(name) },
      { label: "Save as PNG", onSelect: () => exportGraphPng(name) },
    ]);
  };

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 cursor-crosshair bg-white"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesture.current = null;
        setMarquee(null);
      }}
      onPointerLeave={() => ui.set({ readout: "" })}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${name}: ${graph.traces.map((trace) => trace.name).join(", ") || "empty graph"}`}
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
          Missing waves: {layout.missing.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

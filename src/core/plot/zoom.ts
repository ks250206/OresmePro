import type { Command } from "../doc/commands";
import { isVerticalSide } from "../doc/types";
import type { Rect } from "./displayList";
import type { AxisGeometry } from "./layout";
import type { Scale } from "./scale";

/**
 * Rounds a value to as many digits as matter at the given span, so ranges
 * chosen with the mouse read as `0.1234`, not `0.12340000000000001`.
 */
export function tidy(value: number, span: number): number {
  if (value === 0 || !Number.isFinite(value) || !(span > 0)) return value;
  const digits = Math.ceil(Math.log10(Math.abs(value) / span)) + 4;
  return Number(value.toPrecision(Math.min(15, Math.max(4, digits))));
}

const forward = (scale: Scale, value: number): number => (scale.log ? Math.log10(value) : value);
const inverse = (scale: Scale, t: number): number => (scale.log ? 10 ** t : t);

function rangeCommand(graph: string, axis: string, scale: Scale, t0: number, t1: number): Command {
  const min = inverse(scale, t0);
  const max = inverse(scale, t1);
  const span = Math.abs(max - min);
  return {
    op: "modifyAxis",
    graph,
    axis,
    props: { min: tidy(min, span), max: tidy(max, span) },
  };
}

type Axes = Readonly<Record<string, AxisGeometry>>;

/** Does the pixel position lie along this axis's own stretch of the plot? */
function covers(geometry: AxisGeometry, px: number, py: number): boolean {
  const at = isVerticalSide(geometry.side) ? py : px;
  const { p0, p1 } = geometry.scale;
  return at >= Math.min(p0, p1) - 1 && at <= Math.max(p0, p1) + 1;
}

/**
 * Commands that zoom to (expand) or out from (shrink) a marquee rectangle,
 * like the marquee menu in an Igor graph. Shrinking makes the current view
 * fit into the marquee. Only axes whose stretch of the plot the marquee
 * touches are affected, which matters when axes are stacked.
 */
export function marqueeZoom(
  graph: string,
  axes: Axes,
  marquee: Rect,
  mode: "expand" | "shrink",
  directions: { horizontal: boolean; vertical: boolean },
): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes)) {
    const vertical = isVerticalSide(geometry.side);
    if (vertical ? !directions.vertical : !directions.horizontal) continue;
    const { scale } = geometry;
    const low = Math.min(scale.p0, scale.p1);
    const high = Math.max(scale.p0, scale.p1);
    const from = Math.max(low, vertical ? marquee.y : marquee.x);
    const to = Math.min(high, vertical ? marquee.y + marquee.h : marquee.x + marquee.w);
    if (to - from < 1) continue;
    // Marquee edges in the order of the axis: the one nearer `min` first.
    const edges = scale.p0 <= scale.p1 ? [from, to] : [to, from];
    const m0 = forward(scale, scale.toValue(edges[0]!));
    const m1 = forward(scale, scale.toValue(edges[1]!));
    if (!Number.isFinite(m0) || !Number.isFinite(m1) || m0 === m1) continue;
    if (mode === "expand") {
      commands.push(rangeCommand(graph, name, scale, m0, m1));
    } else {
      const t0 = forward(scale, scale.min);
      const t1 = forward(scale, scale.max);
      const factor = (t1 - t0) / (m1 - m0);
      commands.push(
        rangeCommand(graph, name, scale, t0 - (m0 - t0) * factor, t1 + (t1 - m1) * factor),
      );
    }
  }
  return commands;
}

/**
 * Commands that zoom by `factor` (>1 zooms out) about a pixel position: one
 * named axis, or every axis under the pointer.
 */
export function zoomAbout(
  graph: string,
  axes: Axes,
  px: number,
  py: number,
  factor: number,
  only: string | null,
): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes)) {
    if (only ? only !== name : !covers(geometry, px, py)) continue;
    const { scale } = geometry;
    const pivot = forward(scale, scale.toValue(isVerticalSide(geometry.side) ? py : px));
    const t0 = forward(scale, scale.min);
    const t1 = forward(scale, scale.max);
    if (!Number.isFinite(pivot)) continue;
    commands.push(
      rangeCommand(
        graph,
        name,
        scale,
        pivot - (pivot - t0) * factor,
        pivot + (t1 - pivot) * factor,
      ),
    );
  }
  return commands;
}

/**
 * Commands that shift the view by a pixel offset (dragging the data), for
 * the axes under the point where the drag started.
 */
export function panBy(
  graph: string,
  axes: Axes,
  dx: number,
  dy: number,
  start?: { x: number; y: number },
): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes)) {
    if (start && !covers(geometry, start.x, start.y)) continue;
    const { scale } = geometry;
    const pixels = isVerticalSide(geometry.side) ? dy : dx;
    if (pixels === 0) continue;
    const t0 = forward(scale, scale.min);
    const t1 = forward(scale, scale.max);
    const shift = (pixels * (t1 - t0)) / (scale.p1 - scale.p0);
    commands.push(rangeCommand(graph, name, scale, t0 - shift, t1 - shift));
  }
  return commands;
}

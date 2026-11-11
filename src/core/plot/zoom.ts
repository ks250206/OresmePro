import type { Command } from "../doc/commands";
import type { AxisName } from "../doc/types";
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

function rangeCommand(
  graph: string,
  axis: AxisName,
  scale: Scale,
  t0: number,
  t1: number,
): Command {
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

const isVertical = (axis: AxisName): boolean => axis === "left" || axis === "right";

type Axes = Partial<Record<AxisName, AxisGeometry>>;

/**
 * Commands that zoom to (expand) or out from (shrink) a marquee rectangle,
 * like the marquee menu in an Igor graph. Shrinking makes the current view
 * fit into the marquee.
 */
export function marqueeZoom(
  graph: string,
  axes: Axes,
  marquee: Rect,
  mode: "expand" | "shrink",
  directions: { horizontal: boolean; vertical: boolean },
): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes) as [AxisName, AxisGeometry][]) {
    const vertical = isVertical(name);
    if (vertical ? !directions.vertical : !directions.horizontal) continue;
    const { scale } = geometry;
    // Marquee edges in the order of the axis: the one nearer `min` first.
    const edges = vertical
      ? [marquee.y + marquee.h, marquee.y]
      : [marquee.x, marquee.x + marquee.w];
    if (scale.p0 > scale.p1 !== vertical) edges.reverse();
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

/** Commands that zoom by `factor` (>1 zooms out) about a pixel position. */
export function zoomAbout(
  graph: string,
  axes: Axes,
  px: number,
  py: number,
  factor: number,
  only: AxisName | null,
): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes) as [AxisName, AxisGeometry][]) {
    if (only && only !== name) continue;
    const { scale } = geometry;
    const pivot = forward(scale, scale.toValue(isVertical(name) ? py : px));
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

/** Commands that shift the view by a pixel offset (dragging the data). */
export function panBy(graph: string, axes: Axes, dx: number, dy: number): Command[] {
  const commands: Command[] = [];
  for (const [name, geometry] of Object.entries(axes) as [AxisName, AxisGeometry][]) {
    const { scale } = geometry;
    const pixels = isVertical(name) ? dy : dx;
    if (pixels === 0) continue;
    const t0 = forward(scale, scale.min);
    const t1 = forward(scale, scale.max);
    const shift = (pixels * (t1 - t0)) / (scale.p1 - scale.p0);
    commands.push(rangeCommand(graph, name, scale, t0 - shift, t1 - shift));
  }
  return commands;
}

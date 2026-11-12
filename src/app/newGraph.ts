import { checkName, uniqueName, windowTaken, type Command } from "../core/doc/commands";
import { echoPython, pyLiteral } from "../core/doc/echo";
import { traceLook } from "../core/doc/styles";
import {
  DATE_UNIT,
  TRACE_COLORS,
  type DocState,
  type GraphSpec,
  type StyleSpec,
  type Wave,
} from "../core/doc/types";
import { extentOf } from "../core/plot/decimate";
import { formatDate, formatNumber, UTC, type TimeZone } from "../core/plot/ticks";

/*
 * What the New Graph and Append Traces dialogs work out, apart from how they
 * look: how the selected Y and X waves pair up, what is known about each
 * trace before it is made, and the commands and Python that make them.
 */

/** The entry of the X list that plots a Y wave against its own X scaling, as in Igor. */
export const CALCULATED = "_calculated_";

type Waves = Readonly<Record<string, Wave | undefined>>;

/** A trace the dialog is about to make. `x` is null for the Y wave's own scaling. */
export interface PlannedTrace {
  y: string;
  x: string | null;
  vAxis: string;
  hAxis: string;
}

export interface Pairing {
  /** The traces the selection makes; empty when it makes none. */
  traces: PlannedTrace[];
  /** Why the selection cannot be plotted, or null. */
  problem: string | null;
  /** How the selection pairs, in a sentence, when it pairs. */
  summary: string;
}

const points = (wave: Wave): number => wave.shape[0] ?? 0;
const plural = (count: number, word: string): string =>
  `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

/** A 1-D numeric wave: what can be plotted as Y. */
export const isCurve = (wave: Wave): boolean => !wave.text && wave.shape.length === 1;
/** What can be an X wave: a 1-D numeric wave, or a text wave for categories. */
export const isXWave = (wave: Wave): boolean => wave.shape.length === 1;

/**
 * Pairs the selected Y waves with the selected X waves, both in the order of
 * their lists. One X (or `_calculated_`, or none) serves every Y; as many X
 * as Y pair first with first, second with second; anything else is refused,
 * as is a pair whose lengths differ.
 */
export function pairSelection(
  waves: Waves,
  y: readonly string[],
  x: readonly string[],
  axes: { vAxis: string; hAxis: string },
): Pairing {
  const none = (problem: string | null, summary = ""): Pairing => ({
    traces: [],
    problem,
    summary,
  });
  if (y.length === 0) return none(null, "Select one or more Y waves.");
  for (const name of y) {
    const wave = waves[name];
    if (!wave) return none(`There is no wave named ${name}.`);
    if (!isCurve(wave)) return none(`${name} is not a 1-D numeric wave and cannot be plotted.`);
  }
  const xs = x.length === 0 ? [CALCULATED] : x;
  if (xs.length !== 1 && xs.length !== y.length) {
    return none(
      `${plural(xs.length, "X wave")} for ${plural(y.length, "Y wave")}: select one X wave for all of them, or as many X waves as Y waves to pair them in order.`,
    );
  }
  const traces = y.map((name, index) => {
    const xName = xs.length === 1 ? xs[0]! : xs[index]!;
    return { y: name, x: xName === CALCULATED ? null : xName, ...axes };
  });
  const mismatched: string[] = [];
  for (const trace of traces) {
    if (trace.x === null) continue;
    const xWave = waves[trace.x];
    if (!xWave) return none(`There is no wave named ${trace.x}.`);
    if (!isXWave(xWave)) return none(`${trace.x} is not 1-D and cannot be an X wave.`);
    const yPoints = points(waves[trace.y]!);
    if (points(xWave) !== yPoints) {
      mismatched.push(
        `${trace.y} has ${plural(yPoints, "point")} but ${trace.x} has ${points(xWave).toLocaleString("en-US")}`,
      );
    }
  }
  if (mismatched.length > 0) {
    const more =
      mismatched.length > 1 ? ` (and ${plural(mismatched.length - 1, "more pair")})` : "";
    return none(`${mismatched[0]}: a Y and an X wave must have as many points.${more}`);
  }
  let summary: string;
  if (xs.length === 1 && y.length > 1) {
    const against = xs[0] === CALCULATED ? "against its own X scaling" : `against ${xs[0]}`;
    summary = `Each of the ${y.length} Y waves ${against}.`;
  } else if (xs.length === 1) {
    summary =
      xs[0] === CALCULATED ? `${y[0]} against its own X scaling.` : `${y[0]} against ${xs[0]}.`;
  } else {
    summary = `${y.length} pairs, in list order: first Y with first X, second with second, and so on.`;
  }
  return { traces, problem: null, summary };
}

/** The selected names in the order of their list, which is the order they pair in. */
export const inListOrder = (selected: readonly string[], list: readonly string[]): string[] =>
  list.filter((name) => selected.includes(name));

/** A trace as it reads in a list: `signal vs time`, or `signal`. */
export const traceLabel = (trace: { y: string; x: string | null }): string =>
  trace.x === null ? trace.y : `${trace.y} vs ${trace.x}`;

function formatValue(value: number, unit: string, zone: TimeZone): string {
  return unit === DATE_UNIT ? formatDate(value, zone) : formatNumber(value);
}

/** `0 to 9.995 s`: a range of values with their unit, dates written as dates. */
function rangeText(from: number, to: number, unit: string, zone: TimeZone): string {
  const text = `${formatValue(from, unit, zone)} to ${formatValue(to, unit, zone)}`;
  return unit && unit !== DATE_UNIT ? `${text} ${unit}` : text;
}

/** What the dialog shows about a trace before it is made. */
export interface TraceInfo {
  label: string;
  points: string;
  type: string;
  /** The X values it will span: from its X wave, or from its Y wave's scaling. */
  xRange: string;
  /** The unit of the Y values. */
  unit: string;
  axes: string;
}

export function traceInfo(waves: Waves, trace: PlannedTrace, zone: TimeZone = UTC): TraceInfo {
  const yWave = waves[trace.y];
  const xWave = trace.x === null ? null : waves[trace.x];
  const base = { label: traceLabel(trace), axes: `${trace.vAxis}, ${trace.hAxis}` };
  if (!yWave) return { ...base, points: "", type: "", xRange: "(no such wave)", unit: "" };
  const count = points(yWave);
  let xRange: string;
  if (xWave === undefined) {
    xRange = "(no such X wave)";
  } else if (xWave?.text) {
    const labels = points(xWave);
    xRange = `${labels.toLocaleString("en-US")} ${labels === 1 ? "category" : "categories"}`;
  } else if (xWave) {
    const extent = extentOf(xWave.data);
    xRange = Number.isFinite(extent.min)
      ? rangeText(extent.min, extent.max, xWave.unit, zone)
      : "no finite X values";
  } else {
    xRange =
      count === 0
        ? "no points"
        : rangeText(yWave.x0, yWave.x0 + (count - 1) * yWave.dx, yWave.xUnit, zone);
  }
  return {
    ...base,
    points: count.toLocaleString("en-US"),
    type: yWave.type,
    xRange,
    unit: yWave.unit,
  };
}

/** One line about a wave, as the data browser shows it: points, type, scaling, units, note. */
export function waveDetails(wave: Wave, zone: TimeZone = UTC): string {
  const parts = [
    `${wave.name}: ${wave.shape.map((size) => size.toLocaleString("en-US")).join("×")} points`,
  ];
  if (wave.text) {
    parts.push("text");
  } else {
    parts.push(wave.type);
    const count = points(wave);
    parts.push(
      `X ${count > 0 ? rangeText(wave.x0, wave.x0 + (count - 1) * wave.dx, wave.xUnit, zone) : "empty"} (step ${formatNumber(wave.dx)})`,
    );
    if (wave.unit) parts.push(`unit ${wave.unit}`);
  }
  const note = wave.note.split("\n", 1)[0]!.trim();
  if (note) parts.push(`note: ${note.length > 60 ? `${note.slice(0, 59)}…` : note}`);
  return parts.join(" · ");
}

/** The colors traces get from a style's cycle (or Igor's colors), starting at `start`. */
export function traceColors(style: StyleSpec | undefined, start: number, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return traceLook(style, index).color ?? TRACE_COLORS[index % TRACE_COLORS.length]!;
  });
}

interface Group {
  y: string[];
  x: string | null;
  vAxis: string;
  hAxis: string;
}

/** Runs of traces that share an X wave and axes: each is added by one call. */
export function groupTraces(traces: readonly PlannedTrace[]): Group[] {
  const groups: Group[] = [];
  for (const trace of traces) {
    const last = groups.at(-1);
    if (last && last.x === trace.x && last.vAxis === trace.vAxis && last.hAxis === trace.hAxis) {
      last.y.push(trace.y);
    } else {
      groups.push({ y: [trace.y], x: trace.x, vAxis: trace.vAxis, hAxis: trace.hAxis });
    }
  }
  return groups;
}

/** The commands that make the traces, one undo step, and the Python written for them. */
export interface GraphPlan {
  commands: Command[];
  echo: string;
}

const appendCommand = (graph: string, group: Group): Command => ({
  op: "appendTraces",
  graph,
  y: group.y,
  ...(group.x !== null ? { x: group.x } : {}),
  ...(group.vAxis !== "left" ? { vAxis: group.vAxis } : {}),
  ...(group.hAxis !== "bottom" ? { hAxis: group.hAxis } : {}),
});

/** `op.graph("Graph0").append(...)` as `g.append(...)`. */
function appendLines(graph: string, commands: readonly Command[]): string[] {
  const prefix = `op.graph(${pyLiteral(graph)})`;
  return commands.map((command) => `g${echoPython(command)!.slice(prefix.length)}`);
}

/**
 * A new graph of the traces. The first group goes into `op.display`, unless
 * it is on other axes than left and bottom, which only `append` takes; the
 * rest are appended. `name` is the name the user gave, or null; `autoName`
 * is the name the graph gets otherwise, needed by the commands that append
 * to it but left out of the Python, where `g` stands for the graph.
 */
export function newGraphPlan(
  traces: readonly PlannedTrace[],
  name: string | null,
  autoName: string,
): GraphPlan {
  const groups = groupTraces(traces);
  const first = groups[0];
  const startsPlain = first !== undefined && first.vAxis === "left" && first.hAxis === "bottom";
  const rest = startsPlain ? groups.slice(1) : groups;
  const graph = name ?? autoName;
  const display: Command = {
    op: "display",
    y: startsPlain ? first.y : [],
    ...(startsPlain && first.x !== null ? { x: first.x } : {}),
    ...(name !== null || rest.length > 0 ? { name: graph } : {}),
  };
  const appends = rest.map((group) => appendCommand(graph, group));
  const shown = echoPython({ ...display, name: name ?? undefined } as Command)!;
  const echo =
    appends.length === 0 ? shown : [`g = ${shown}`, ...appendLines(graph, appends)].join("\n");
  return { commands: [display, ...appends], echo };
}

/** Traces appended to an existing graph: a call for each group. */
export function appendPlan(graph: string, traces: readonly PlannedTrace[]): GraphPlan {
  const commands = groupTraces(traces).map((group) => appendCommand(graph, group));
  const echo =
    commands.length === 1
      ? echoPython(commands[0]!)!
      : [`g = op.graph(${pyLiteral(graph)})`, ...appendLines(graph, commands)].join("\n");
  return { commands, echo };
}

/** The name a new graph gets when none is given. */
export const nextGraphName = (state: DocState): string => uniqueName("Graph", windowTaken(state));

/** Why a name typed for a new graph cannot be used, or null (an empty name is fine). */
export function graphNameProblem(state: DocState, name: string): string | null {
  if (name === "") return null;
  try {
    checkName(name, "graph");
  } catch (error) {
    return (error as Error).message;
  }
  return windowTaken(state)(name) ? `A window named ${name} already exists.` : null;
}

/**
 * The waves shown in the frontmost window, when it is a graph or a table:
 * Igor's "From Target", which limits the dialog's lists to them.
 */
export function targetWaves(state: DocState): { window: string; waves: string[] } | null {
  const top = state.windows.at(-1);
  if (!top) return null;
  if (top.kind === "table") {
    const table = state.tables[top.name];
    return table ? { window: top.name, waves: [...table.columns] } : null;
  }
  if (top.kind === "graph") {
    const graph = state.graphs[top.name];
    if (!graph) return null;
    const names = graph.traces.flatMap((trace) => (trace.x ? [trace.y, trace.x] : [trace.y]));
    return { window: top.name, waves: [...new Set(names)] };
  }
  return null;
}

/** The traces a graph has, as the dialog lists them. */
export const graphTraces = (graph: GraphSpec): PlannedTrace[] =>
  graph.traces.map(({ y, x, vAxis, hAxis }) => ({ y, x, vAxis, hAxis }));

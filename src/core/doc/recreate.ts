import { applyCommand, type Command } from "./commands";
import { echoPython } from "./echo";
import {
  AXIS_SIDES,
  CURSOR_NAMES,
  TAG_OFFSET,
  emptyDoc,
  type DocState,
  type GraphSpec,
} from "./types";

type Props = Record<string, unknown>;

/** The properties of `target` that differ from `base`, leaving out the keys in `skip`. */
function difference(base: object, target: object, skip: readonly string[]): Props {
  const props: Props = {};
  for (const [key, value] of Object.entries(target)) {
    if (skip.includes(key)) continue;
    const before = (base as Props)[key];
    if (JSON.stringify(before) !== JSON.stringify(value)) props[key] = value;
  }
  return props;
}

const hasKeys = (props: Props): boolean => Object.keys(props).length > 0;

/**
 * The commands that build a graph again from nothing, like Igor's window
 * recreation macro. They are worked out by replaying them on a scratch
 * document and comparing with the graph, so only what differs from the
 * defaults is written. The new graph is called `name`.
 */
export function recreationCommands(
  state: DocState,
  graphName: string,
  name = graphName,
): Command[] {
  const target = state.graphs[graphName];
  if (!target) throw new Error(`No graph named ${JSON.stringify(graphName)}.`);
  let scratch: DocState = { ...emptyDoc(), waves: state.waves, waveOrder: state.waveOrder };
  const commands: Command[] = [];
  const run = (command: Command): string | null => {
    const outcome = applyCommand(scratch, command);
    scratch = outcome.state;
    commands.push(command);
    return outcome.result;
  };
  const built = (): GraphSpec => scratch.graphs[name]!;

  // Traces that share an X wave and axes are added in one call, as they were made.
  const groups: { y: string[]; x: string | null; vAxis: string; hAxis: string }[] = [];
  for (const trace of target.traces) {
    const last = groups.at(-1);
    if (last && last.x === trace.x && last.vAxis === trace.vAxis && last.hAxis === trace.hAxis) {
      last.y.push(trace.y);
    } else {
      groups.push({ y: [trace.y], x: trace.x, vAxis: trace.vAxis, hAxis: trace.hAxis });
    }
  }
  const first = groups[0];
  const startsPlain = first?.vAxis === "left" && first.hAxis === "bottom";
  run({
    op: "display",
    y: startsPlain ? first.y : [],
    ...(startsPlain && first.x !== null ? { x: first.x } : {}),
    name,
    // Everything that differs from a plain graph is written out below, so
    // where new graphs get a style the copy must start plain.
    ...(state.defaultStyle !== null ? { style: null } : {}),
  });
  for (const [axis, spec] of Object.entries(target.axes)) {
    if (!(AXIS_SIDES as readonly string[]).includes(axis)) {
      run({ op: "addAxis", graph: name, name: axis, side: spec.side });
    }
  }
  for (const group of startsPlain ? groups.slice(1) : groups) {
    run({
      op: "appendTraces",
      graph: name,
      y: group.y,
      ...(group.x !== null ? { x: group.x } : {}),
      ...(group.vAxis !== "left" ? { vAxis: group.vAxis } : {}),
      ...(group.hAxis !== "bottom" ? { hAxis: group.hAxis } : {}),
    });
  }
  // A trace may have another name here than in the graph it is copied from
  // (after traces were removed there); cursors follow the new names.
  const traceNames = new Map<string, string>();
  target.traces.forEach((trace, index) => {
    const made = built().traces[index]!;
    traceNames.set(trace.name, made.name);
    const props = difference(made, trace, ["name", "y", "x", "vAxis", "hAxis"]);
    if (hasKeys(props)) run({ op: "modifyTrace", graph: name, trace: made.name, props });
  });

  for (const image of target.images) {
    const base = { op: "appendImage" as const, graph: name, wave: image.wave };
    const axes = {
      ...(image.vAxis !== "left" ? { vAxis: image.vAxis } : {}),
      ...(image.hAxis !== "bottom" ? { hAxis: image.hAxis } : {}),
    };
    // Try it on the side to learn the defaults, then make it with what differs.
    const trial = applyCommand(scratch, { ...base, ...axes }).state.graphs[name]!.images.at(-1)!;
    const props = difference(trial, image, ["name", "wave", "vAxis", "hAxis"]);
    run({ ...base, ...axes, ...(hasKeys(props) ? { props } : {}) });
  }
  for (const contour of target.contours) {
    const base = { op: "appendContour" as const, graph: name, wave: contour.wave };
    const axes = {
      ...(contour.vAxis !== "left" ? { vAxis: contour.vAxis } : {}),
      ...(contour.hAxis !== "bottom" ? { hAxis: contour.hAxis } : {}),
    };
    const trial = applyCommand(scratch, { ...base, ...axes }).state.graphs[name]!.contours.at(-1)!;
    const props = difference(trial, contour, ["name", "wave", "vAxis", "hAxis"]);
    run({ ...base, ...axes, ...(hasKeys(props) ? { props } : {}) });
  }

  for (const [axis, spec] of Object.entries(target.axes)) {
    const props = difference(built().axes[axis]!, spec, ["side"]);
    if (hasKeys(props)) run({ op: "modifyAxis", graph: name, axis, props });
  }
  for (const annotation of target.annotations) {
    const { kind, text, anchor, frame, x, y, point } = annotation;
    const tag = kind === "tag";
    // A tag whose trace is gone has nothing to point at.
    const trace = annotation.trace === null ? undefined : traceNames.get(annotation.trace);
    if (tag && trace === undefined) continue;
    const made = run({
      op: "addAnnotation",
      graph: name,
      kind,
      text,
      ...(tag ? { trace, point } : { anchor }),
      frame,
      // Where it sits is written only if it was moved.
      ...(x !== (tag ? TAG_OFFSET.x : 0) || y !== (tag ? TAG_OFFSET.y : 0) ? { x, y } : {}),
    });
    const now = built().annotations.find((item) => item.name === made);
    const props = now ? difference(now, annotation, ["name", "kind", "trace"]) : {};
    if (made && hasKeys(props)) {
      run({ op: "modifyAnnotation", graph: name, annotation: made, props });
    }
  }
  for (const cursor of CURSOR_NAMES) {
    const spec = target.cursors[cursor];
    const trace = spec ? traceNames.get(spec.trace) : undefined;
    if (spec && trace) run({ op: "setCursor", graph: name, cursor, trace, point: spec.point });
  }
  const style = difference(built(), target, [
    "name",
    "traces",
    "images",
    "contours",
    "axes",
    "annotations",
    "cursors",
    // Which style the graph was given is not part of how it looks.
    "style",
  ]);
  if (hasKeys(style)) run({ op: "modifyGraph", graph: name, props: style });
  return commands;
}

/**
 * Python that draws a graph again: `g = op.display(...)` followed by a line
 * for each thing that is not the default. Run as it is, it makes a new graph
 * and leaves the original alone.
 */
export function graphScript(state: DocState, graphName: string): string {
  // On the scratch document the graph can have any name; one that cannot
  // clash with a wave name inside the script keeps the rewriting below safe.
  const scratchName = "Graph0";
  const [display, ...rest] = recreationCommands(state, graphName, scratchName);
  const prefix = `op.graph(${JSON.stringify(scratchName)})`;
  const lines = [`g = ${echoPython({ ...display, name: undefined } as Command)}`];
  for (const command of rest) {
    const line = echoPython(command, (wave) => state.waves[wave]?.shape);
    if (line) lines.push(line.startsWith(prefix) ? `g${line.slice(prefix.length)}` : line);
  }
  return lines.join("\n");
}

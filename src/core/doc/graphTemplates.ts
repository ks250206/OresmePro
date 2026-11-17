import type { Command, CommandOutcome } from "./commands";
import { withEntry } from "./dict";
import { captureStyle, styledGraph, styledWindows } from "./styles";
import {
  AXIS_SIDES,
  DocError,
  leafName,
  type DocState,
  type ErrorSource,
  type GraphSpec,
  type GraphTemplate,
  type SlotRole,
  type TemplateSlot,
  type Wave,
} from "./types";

/*
 * Graph templates (see GraphTemplate): made from a graph, and graphs made
 * from them. The commands that keep them are in ./commands; what is here
 * takes a graph apart into slots and puts one together again.
 */

/** What a slot is called after, by what its wave was for. */
const SLOT_BASE: Record<SlotRole, string> = {
  y: "y",
  x: "x",
  yError: "yerr",
  xError: "xerr",
  color: "color",
  text: "labels",
  z: "z",
};

/**
 * Names a slot cannot have: they would clash with the other arguments of
 * Python's `make(name=..., y=...)`, or are not allowed as keywords there.
 */
export const RESERVED_SLOT_NAMES: ReadonlySet<string> = new Set([
  "name",
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** A slot in the making: the wave it came from, and where it was first used. */
interface Draft extends Omit<TemplateSlot, "name"> {
  wave: string;
  /** The place of the trace (or of the slot among the image and contour slots) that first used it. */
  place: number;
}

/**
 * The parts of text that are left as they are when wave names in it are made
 * into slot references: Igor's formatting codes and the references a template
 * or a tag already understands. A legend's `\s(trace)` comes first, as it
 * names a trace; what is left is words.
 */
const TEXT_TOKEN =
  /\\s\(([^)]*)\)|\\(?:\\|[SBMu]|f\d\d|Zr\d{3}|Z\d\d|F'[^']*'|K\([^)]*\)|[[\]]\d)|\{(?:x|y|point|(?:trace|image)\d+|\p{L}[\p{L}\p{N}_]*\.(?:name|unit))\}|[\p{L}\p{N}_]+/gu;

/**
 * A unit as labels write it: alone in parentheses or brackets, "Current (A)".
 * Not the parentheses of a code (`\s(trace)`, `\K(r,g,b)`).
 */
const UNIT_TEXT = /(?<!\\[sK])([([])([^()[\]{}\\]+)([)\]])/g;

/** A reference to what fills a template, as it is written in text. */
const TEXT_REFERENCE = /\{(?:(trace|image)(\d+)|(\p{L}[\p{L}\p{N}_]*)\.(name|unit))\}/gu;

/**
 * Keeps a graph as a template: every wave it plots becomes a slot, and the
 * rest is kept as it is, apart from the axis ranges, which are kept only for
 * the axes in `fixed` and are otherwise worked out from the new data. Text
 * that names a wave of the graph (or one of its traces, in a legend) is made
 * to name what fills that slot instead, where there is no doubt which slot
 * it means, and so is a slot's unit written in parentheses: so a graph made
 * of another sample shows that sample's name and unit.
 */
export function captureTemplate(
  state: DocState,
  graphName: string,
  fixed: readonly string[] = [],
): GraphTemplate {
  const graph = state.graphs[graphName];
  if (!graph)
    throw new DocError(`No graph named ${JSON.stringify(graphName)}.`, "NOT_FOUND", {
      kind: "graph",
      name: graphName,
    });
  for (const axis of fixed) {
    if (!(axis in graph.axes)) {
      throw new DocError(`${graph.name} has no axis named ${JSON.stringify(axis)}.`, "NOT_FOUND", {
        kind: "axis",
        name: axis,
      });
    }
  }
  const { slots, slotOf } = slotsOf(state, graph);
  const slot = (wave: string) => slotOf.get(wave)!;

  // The name of a wave in text is taken for that wave only when no other
  // wave of the graph (in another folder) has the same name.
  const leafSlots = new Map<string, string | null>();
  for (const [wave, name] of slotOf) {
    const leaf = leafName(wave);
    leafSlots.set(leaf, leafSlots.has(leaf) ? null : name);
  }
  // So is a unit, when it is the unit of one slot only: (A) of a current
  // against a voltage, but not when two currents are plotted.
  const unitSlots = new Map<string, string | null>();
  for (const { name, unit } of slots) {
    if (unit !== "") unitSlots.set(unit, unitSlots.has(unit) ? null : name);
  }
  const traceNames = graph.traces.map((trace) => trace.name);
  const imageNames = graph.images.map((image) => image.name);
  const text = (source: string) =>
    source
      .replace(UNIT_TEXT, (whole, open: string, unit: string, shut: string) => {
        const name = unitSlots.get(unit.trim());
        return name ? `${open}{${name}.unit}${shut}` : whole;
      })
      .replace(TEXT_TOKEN, (token, trace: string | undefined) => {
        if (trace !== undefined) {
          const at = traceNames.indexOf(trace);
          return at === -1 ? token : `\\s({trace${at + 1}})`;
        }
        if (token.startsWith("\\") || token.startsWith("{")) return token;
        const name = leafSlots.get(token);
        return name ? `{${name}.name}` : token;
      });
  const source = (value: ErrorSource): ErrorSource =>
    typeof value === "string" ? slot(value) : value;

  const sides = AXIS_SIDES as readonly string[];
  const axisNames = [...sides, ...Object.keys(graph.axes).filter((name) => !sides.includes(name))];
  // The template keeps every mode of the plot area, plan and per unit too,
  // since it keeps the axes they name; its style then needs none.
  const { plot: _, ...style } = captureStyle(state, graph.name, true);
  const sized = graph.width.mode !== "auto" || graph.height.mode !== "auto";
  return {
    style,
    ...(sized ? { plot: { width: graph.width, height: graph.height } } : {}),
    slots,
    traces: graph.traces.map((trace) => ({
      y: slot(trace.y),
      x: trace.x === null ? null : slot(trace.x),
      vAxis: trace.vAxis,
      hAxis: trace.hAxis,
      yError: source(trace.yError),
      xError: source(trace.xError),
      fill: trace.fill,
      fillColor: trace.fillColor,
      fillOpacity: trace.fillOpacity,
      xOffset: trace.xOffset,
      yOffset: trace.yOffset,
      colorWave: trace.colorWave === null ? null : slot(trace.colorWave),
      colorTable: trace.colorTable,
      colorMin: trace.colorMin,
      colorMax: trace.colorMax,
      part: trace.part,
      textMarker: trace.textMarker === null ? null : slot(trace.textMarker),
      textAnchor: trace.textAnchor,
      textSize: trace.textSize,
      textRotation: trace.textRotation,
    })),
    images: graph.images.map((image) => {
      const { name: _, ...rest } = image;
      return { ...rest, wave: slot(image.wave) };
    }),
    contours: graph.contours.map((contour) => {
      const { name: _, ...rest } = contour;
      return { ...rest, wave: slot(contour.wave) };
    }),
    axes: axisNames.map((name) => {
      const axis = graph.axes[name]!;
      const keep = fixed.includes(name);
      return {
        name,
        side: axis.side,
        label: axis.label === null ? null : text(axis.label),
        min: keep ? axis.min : null,
        max: keep ? axis.max : null,
        log: axis.log,
        reverse: axis.reverse,
        tickStep: axis.tickStep,
        tickFormat: axis.tickFormat,
        span: axis.span,
      };
    }),
    annotations: graph.annotations.flatMap((annotation) => {
      const trace = annotation.trace === null ? -1 : traceNames.indexOf(annotation.trace);
      // A tag whose trace is gone has nothing to point at.
      if (annotation.kind === "tag" && trace === -1) return [];
      const image = annotation.kind === "colorscale" ? imageNames.indexOf(annotation.text) : -1;
      return [
        {
          kind: annotation.kind,
          text: image === -1 ? text(annotation.text) : `{image${image + 1}}`,
          anchor: annotation.anchor,
          frame: annotation.frame,
          x: annotation.x,
          y: annotation.y,
          trace: trace === -1 ? null : trace,
          point: annotation.point,
        },
      ];
    }),
    ...(graph.drawings.length > 0
      ? {
          drawings: graph.drawings.map((drawing) => {
            const { name, ...rest } = drawing;
            void name;
            return rest;
          }),
        }
      : {}),
  };
}

/**
 * The slots of a graph's waves, in the order the graph uses them: each wave
 * once, named after its first use, and numbered by its trace when there are
 * several of the same use, so that y1 and x1 belong to the first trace.
 */
function slotsOf(
  state: DocState,
  graph: GraphSpec,
): { slots: TemplateSlot[]; slotOf: Map<string, string> } {
  const drafts = new Map<string, Draft>();
  let zSlots = 0;
  /** `scaling`: which of the wave's scalings the graph draws it with. */
  const use = (name: string, role: SlotRole, place: number, scaling: "x" | "xy" | null) => {
    const wave = state.waves[name];
    let draft = drafts.get(name);
    if (!draft) {
      draft = { wave: name, role, place, unit: wave?.unit ?? "", xUnit: null, yUnit: null };
      drafts.set(name, draft);
      if (role === "z") zSlots += 1;
    }
    if (wave && scaling) draft.xUnit = wave.xUnit;
    if (wave && scaling === "xy") draft.yUnit = wave.yUnit;
  };
  graph.traces.forEach((trace, place) => {
    use(trace.y, "y", place, trace.x === null ? "x" : null);
    if (trace.x !== null) use(trace.x, "x", place, null);
    if (typeof trace.yError === "string") use(trace.yError, "yError", place, null);
    if (typeof trace.xError === "string") use(trace.xError, "xError", place, null);
    if (trace.colorWave !== null) use(trace.colorWave, "color", place, null);
    if (trace.textMarker !== null) use(trace.textMarker, "text", place, null);
  });
  for (const item of [...graph.images, ...graph.contours]) use(item.wave, "z", zSlots, "xy");

  const byRole = new Map<SlotRole, number>();
  for (const draft of drafts.values()) byRole.set(draft.role, (byRole.get(draft.role) ?? 0) + 1);
  const slotOf = new Map<string, string>();
  const slots: TemplateSlot[] = [];
  for (const { wave, role, place, unit, xUnit, yUnit } of drafts.values()) {
    const name = byRole.get(role) === 1 ? SLOT_BASE[role] : `${SLOT_BASE[role]}${place + 1}`;
    slotOf.set(wave, name);
    slots.push({ name, role, unit, xUnit, yUnit });
  }
  return { slots, slotOf };
}

/** The wave of a graph that each slot of a template made from it would hold, by slot. */
export function templateSources(state: DocState, graphName: string): Map<string, string> {
  const graph = state.graphs[graphName];
  if (!graph) return new Map();
  return new Map([...slotsOf(state, graph).slotOf].map(([wave, slot]) => [slot, wave]));
}

/** The slots a graph cannot be made without: those of the waves it plots. */
export function requiredSlots(template: GraphTemplate): Set<string> {
  return new Set([
    ...template.traces.map((trace) => trace.y),
    ...template.images.map((image) => image.wave),
    ...template.contours.map((contour) => contour.wave),
  ]);
}

/** What fills the slots for one graph: wave names by slot, as a command carries them. */
export type Sample = Readonly<Record<string, string | null>>;

/** The waves of a sample by slot, or an error saying what is wrong with it. */
export function sampleWaves(
  state: DocState,
  template: GraphTemplate,
  sample: unknown,
): Map<string, Wave> {
  if (typeof sample !== "object" || sample === null || Array.isArray(sample)) {
    throw new DocError("A sample is a dict of wave names by slot.");
  }
  const slots = template.slots.map((slot) => slot.name);
  const waves = new Map<string, Wave>();
  for (const [slot, value] of Object.entries(sample)) {
    if (!slots.includes(slot)) {
      throw new DocError(
        `The template has no slot ${JSON.stringify(slot)}. Its slots: ${slots.join(", ")}.`,
        "NOT_FOUND",
        { kind: "slot", name: slot },
      );
    }
    // An empty slot that is not needed leaves its part out (no error bars, say).
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") throw new DocError(`Slot ${slot} needs a wave name.`);
    const name = value.startsWith("root:") ? value.slice(5) : value;
    const wave = state.waves[name];
    if (!wave)
      throw new DocError(`No wave named ${JSON.stringify(value)} for slot ${slot}.`, "NOT_FOUND", {
        kind: "wave",
        name: value,
      });
    waves.set(slot, wave);
  }
  const missing = [...requiredSlots(template)].filter((slot) => !waves.has(slot));
  if (missing.length > 0) {
    throw new DocError(
      `No wave for slot${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} plotted.`,
    );
  }
  // Lengths are checked here to say which slots disagree; the commands
  // that make the graph would refuse them too, but in terms of waves.
  for (const trace of template.traces) {
    const y = waves.get(trace.y);
    if (!y || y.text) continue;
    const others = [trace.x, trace.yError, trace.xError, trace.colorWave, trace.textMarker];
    for (const other of others) {
      if (typeof other !== "string") continue;
      const wave = waves.get(other);
      const length = wave ? (wave.shape[0] ?? 0) : null;
      if (wave && length !== y.data.length) {
        throw new DocError(
          `${other} (${wave.name}) has ${length} points but ${trace.y} (${y.name}) has ${y.data.length}.`,
        );
      }
    }
  }
  return waves;
}

/**
 * Text of a template with its references filled in: {slot.name} and
 * {slot.unit} by the wave in that slot (nothing for an empty slot), and
 * {trace1}, {image1} by the names of the traces and images made. A
 * reference to anything the template does not have is left as it is.
 */
export function fillTemplateText(
  text: string,
  template: GraphTemplate,
  waves: ReadonlyMap<string, Wave>,
  traces: readonly string[] = [],
  images: readonly string[] = [],
): string {
  return text.replace(
    TEXT_REFERENCE,
    (
      reference,
      kind: string | undefined,
      place: string | undefined,
      slot: string | undefined,
      part: string | undefined,
    ) => {
      if (kind !== undefined) {
        const name = (kind === "trace" ? traces : images)[Number(place) - 1];
        return name ?? reference;
      }
      if (!template.slots.some((item) => item.name === slot)) return reference;
      const wave = waves.get(slot!);
      if (!wave) return "";
      return part === "name" ? leafName(wave.name) : wave.unit;
    },
  );
}

export type Apply = (state: DocState, command: Command) => CommandOutcome;

/**
 * The document with a new graph `name` made from a template for one sample.
 * It is built with the same commands as any graph, given as `apply` (the
 * document's applyCommand, which cannot be imported here without a cycle),
 * so the new waves are checked as they would be in any graph; then it gets
 * the template's look and size.
 */
export function makeFromTemplate(
  state: DocState,
  template: GraphTemplate,
  sample: unknown,
  name: string,
  apply: Apply,
): DocState {
  const waves = sampleWaves(state, template, sample);
  let next = state;
  const run = (command: Command): string | null => {
    const outcome = apply(next, command);
    next = outcome.state;
    return outcome.result;
  };
  const wave = (slot: string | null) => (slot === null ? null : (waves.get(slot)?.name ?? null));
  const source = (value: ErrorSource): ErrorSource =>
    typeof value === "string" ? wave(value) : value;

  run({ op: "display", y: [], name, style: null });
  for (const axis of template.axes) {
    if (!(AXIS_SIDES as readonly string[]).includes(axis.name)) {
      run({ op: "addAxis", graph: name, name: axis.name, side: axis.side });
    }
  }
  const traces: string[] = [];
  for (const trace of template.traces) {
    const { y, x, vAxis, hAxis, yError, xError, colorWave, textMarker, ...props } = trace;
    const made = run({
      op: "appendTraces",
      graph: name,
      y: [wave(y)!],
      x: wave(x),
      vAxis,
      hAxis,
    })!;
    traces.push(made);
    run({
      op: "modifyTrace",
      graph: name,
      trace: made,
      props: {
        ...props,
        yError: source(yError),
        xError: source(xError),
        colorWave: wave(colorWave),
        textMarker: wave(textMarker),
      },
    });
  }
  const images: string[] = [];
  for (const { wave: slot, vAxis, hAxis, ...props } of template.images) {
    images.push(run({ op: "appendImage", graph: name, wave: wave(slot)!, vAxis, hAxis, props })!);
  }
  for (const { wave: slot, vAxis, hAxis, ...props } of template.contours) {
    run({ op: "appendContour", graph: name, wave: wave(slot)!, vAxis, hAxis, props });
  }
  const fill = (text: string) => fillTemplateText(text, template, waves, traces, images);
  for (const { name: axis, side: _, label, ...props } of template.axes) {
    run({
      op: "modifyAxis",
      graph: name,
      axis,
      props: { ...props, label: label === null ? null : fill(label) },
    });
  }
  for (const annotation of template.annotations) {
    const { kind, text, anchor, frame, x, y } = annotation;
    if (kind === "tag") {
      const trace = annotation.trace === null ? undefined : traces[annotation.trace];
      const points = trace
        ? (waves.get(template.traces[annotation.trace!]!.y)?.data.length ?? 0)
        : 0;
      // The point is held to the end of a shorter wave, so the tag stays.
      if (trace === undefined || points === 0) continue;
      const point = Math.min(annotation.point, points - 1);
      run({ op: "addAnnotation", graph: name, kind, text: fill(text), trace, point, frame, x, y });
    } else {
      run({ op: "addAnnotation", graph: name, kind, text: fill(text), anchor, frame, x, y });
    }
  }
  for (const { kind, points, ...props } of template.drawings ?? []) {
    run({ op: "addDrawing", graph: name, kind, points, props });
  }
  const graph = next.graphs[name]!;
  // The template's look is not a style of the experiment, so the graph
  // remembers none, as it would after having its properties set one by one.
  const styled = {
    ...styledGraph(graph, template.style, name),
    ...template.plot,
    style: null,
  };
  return {
    ...next,
    graphs: withEntry(next.graphs, name, styled),
    windows: styledWindows(next.windows, styled, template.style),
  };
}

const unitText = (unit: string): string => (unit === "" ? "no unit" : JSON.stringify(unit));

/**
 * Warnings for waves whose units differ from those of the waves the template
 * was made from: a graph is still made, but its labels may say the wrong
 * thing. Samples that cannot be made at all are left to the command to refuse.
 */
export function templateWarnings(
  state: DocState,
  template: GraphTemplate,
  samples: readonly unknown[],
): string[] {
  const warnings: string[] = [];
  samples.forEach((sample, index) => {
    let waves: Map<string, Wave>;
    try {
      waves = sampleWaves(state, template, sample);
    } catch {
      return;
    }
    const prefix = samples.length > 1 ? `Sample ${index + 1}: ` : "";
    for (const slot of template.slots) {
      const wave = waves.get(slot.name);
      if (!wave) continue;
      const differs = (what: string, now: string, then: string | null) => {
        if (then === null || now === then) return;
        warnings.push(
          `${prefix}${wave.name} in slot ${slot.name} has ${what} in ${unitText(now)}; the template was made with ${unitText(then)}.`,
        );
      };
      differs("values", wave.unit, slot.unit);
      differs("X", wave.xUnit, slot.xUnit);
      differs("Y", wave.yUnit, slot.yUnit);
    }
  });
  return warnings;
}

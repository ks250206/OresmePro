import type { ActionArgs, JsonValue } from "../actions";
import { checkName, uniqueName, windowTaken, type Command } from "../doc/commands";
import type { ResultSource } from "../doc/results";
import { DocError, leafName, parentFolder, type DocState } from "../doc/types";
import { WAVE_PROPS, type CheckedResult, type PluginGraph } from "../sandbox/validate";
import type { PluginAction } from "./manifest";

/**
 * What a run of a plugin's action does to the experiment, worked out from
 * its checked outcome: new waves for the waves it returned and, when its
 * values hold a "result", an analysis result kept with the others. The waves
 * get names of their own and never replace a wave that is there: the plugin
 * does not get to choose what in the experiment it overwrites.
 */

export interface OutcomePlan {
  commands: Command[];
  /** The name each returned wave gets, by its role. */
  waves: Record<string, string>;
  /** The values returned, to hand back to whoever called. */
  values: JsonValue;
  /** Whether the commands keep an analysis result (its name is what addResult returns). */
  keepsResult: boolean;
  /** The graph the action asked for, to make once the waves are there (see makePluginGraph). */
  graph: PluginGraph | null;
}

const isObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The name itself if no wave has it, or else the name with _1, _2, ... as the loaders do. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The wave arguments of a call, by argument name. */
/** A wave's name as the document keeps it, without the optional "root:" in front. */
const canonical = (name: string): string => name.replace(/^root:/, "");

export function waveArgs(
  action: PluginAction,
  args: ActionArgs,
): Record<string, string | string[]> {
  const waves: Record<string, string | string[]> = {};
  for (const [name, spec] of Object.entries(action.params)) {
    const value = args[name];
    if (value === undefined) continue;
    // As the document names the waves: "root:signal" is the wave "signal".
    if (spec.type === "wave" && typeof value === "string") waves[name] = canonical(value);
    if (spec.type === "waves" && Array.isArray(value)) {
      // The arguments were checked: every item is a wave's name.
      waves[name] = value.filter((item) => typeof item === "string").map(canonical);
    }
  }
  return waves;
}

export function planOutcome(
  state: DocState,
  action: PluginAction,
  args: ActionArgs,
  outcome: CheckedResult,
  source: ResultSource,
  now: number,
): OutcomePlan {
  const inputs = waveArgs(action, args);
  const first = Object.values(inputs).flat()[0];
  // Next to the first wave it was given, named after it: "spectrum_fit".
  const folder = first ? parentFolder(first) : "";
  const stem = first ? leafName(first) : action.name;
  const taken = new Set(Object.keys(state.waves));
  const commands: Command[] = [];
  const waves: Record<string, string> = {};
  for (const [role, wave] of outcome.waves) {
    const base = folder ? `${folder}:${stem}_${role}` : `${stem}_${role}`;
    const name = freeName(base, taken);
    taken.add(name);
    waves[role] = name;
    const made = `Made by ${source.action} (${source.origin}${source.commit ? ` @ ${source.commit.slice(0, 12)}` : ""}).`;
    commands.push({
      op: "makeWave",
      name,
      ...(wave.text
        ? { text: wave.text }
        : { data: wave.data, type: wave.type, shape: wave.shape }),
      ...(wave.imag ? { imag: wave.imag } : {}),
      x0: wave.x0,
      dx: wave.dx,
      xUnit: wave.xUnit,
      y0: wave.y0,
      dy: wave.dy,
      yUnit: wave.yUnit,
      unit: wave.unit,
      note: wave.note ? `${wave.note}\n${made}` : made,
      overwrite: false,
    });
  }

  const given = isObject(outcome.values) ? outcome.values : {};
  const kept = given.result;
  let keepsResult = false;
  if (isObject(kept) && Array.isArray(kept.names)) {
    const params: Record<string, JsonValue> = {};
    for (const [name, value] of Object.entries(args)) {
      if (!(name in inputs)) params[name] = value;
    }
    const names = kept.names.map(String);
    const numbers = (value: JsonValue | undefined) =>
      Array.isArray(value)
        ? value.map((item) => (typeof item === "number" ? item : null))
        : names.map(() => null);
    const points = typeof kept.points === "number" ? kept.points : 0;
    commands.push({
      op: "addResult",
      result: {
        kind: "plugin",
        label: `${action.title}(${first ? leafName(first) : ""})`,
        created: now,
        settings: { action: source.action, inputs, params },
        inputs: Object.values(inputs).flat(),
        names,
        coef: numbers(kept.coef),
        sigma: numbers(kept.sigma),
        held: [],
        covariance: null,
        chisq: typeof kept.chisq === "number" ? kept.chisq : null,
        points,
        freedom:
          typeof kept.freedom === "number" ? kept.freedom : Math.max(0, points - names.length),
        converged: kept.converged !== false,
        reason: typeof kept.reason === "string" ? kept.reason : "",
        outputs: waves,
        source,
      },
    });
    keepsResult = true;
  }
  return { commands, waves, values: outcome.values, keepsResult, graph: outcome.graph };
}

/** What makePluginGraph works on: the document as the run's commands leave it. */
export interface GraphTarget {
  getState(): DocState;
  dispatch(command: Command): unknown;
}

/**
 * Makes the graph a plugin asked for, with the document's own commands, so
 * every property is checked as if typed in Python: a bad one refuses the
 * whole run. The graph shows only the waves the run made (`waves`, by role).
 * Returns the graph's name.
 */
export function makePluginGraph(
  target: GraphTarget,
  graph: PluginGraph,
  waves: Readonly<Record<string, string>>,
  plugin: string,
): string {
  const wave = (role: string): string => {
    const name = waves[role];
    if (name === undefined) {
      throw new DocError(`The graph uses ${role}, which is not a wave the action returned.`);
    }
    return name;
  };
  const run = (command: Command): unknown => {
    try {
      return target.dispatch(command);
    } catch (error) {
      if (error instanceof DocError) {
        throw new DocError(`The graph ${plugin} asked for cannot be made: ${error.message}`);
      }
      throw error;
    }
  };
  const base = graph.name === null ? "Graph" : checkName(graph.name, "graph");
  const name = run({
    op: "display",
    y: [],
    name: uniqueName(base, windowTaken(target.getState())),
  }) as string;
  const legend: string[] = [];
  for (const trace of graph.traces) {
    const made = run({
      op: "appendTraces",
      graph: name,
      y: [wave(trace.y)],
      x: trace.x === null ? null : wave(trace.x),
      vAxis: trace.vAxis,
      hAxis: trace.hAxis,
    }) as string;
    const props: Record<string, JsonValue> = { ...trace.props };
    for (const key of WAVE_PROPS) {
      if (typeof props[key] === "string") props[key] = wave(props[key] as string);
    }
    if (Object.keys(props).length > 0) run({ op: "modifyTrace", graph: name, trace: made, props });
    if (trace.legend !== null) legend.push(`\\s(${made}) ${trace.legend}`);
  }
  for (const [side, props] of Object.entries(graph.axes)) {
    if (Object.keys(props).length > 0) run({ op: "modifyAxis", graph: name, axis: side, props });
  }
  if (Object.keys(graph.graph).length > 0)
    run({ op: "modifyGraph", graph: name, props: graph.graph });
  for (const annotation of graph.annotations) {
    const made = run({
      op: "addAnnotation",
      graph: name,
      kind: annotation.kind,
      text: annotation.text ?? (annotation.kind === "legend" ? legend.join("\n") : ""),
    }) as string;
    if (Object.keys(annotation.props).length > 0) {
      run({ op: "modifyAnnotation", graph: name, annotation: made, props: annotation.props });
    }
  }
  return name;
}

import type { ActionArgs, JsonValue } from "../actions";
import { checkName, uniqueName, waveUsers, windowTaken, type Command } from "../doc/commands";
import { waveFingerprint, type AnalysisResult, type ResultSource } from "../doc/results";
import { DocError, leafName, parentFolder, type DocState } from "../doc/types";
import { WAVE_PROPS, type CheckedResult, type PluginGraph } from "../sandbox/validate";
import type { PluginAction } from "./manifest";

/**
 * What a run of a plugin's action does to the experiment, worked out from
 * its checked outcome: new waves for the waves it returned and, when its
 * values hold a "result", an analysis result kept with the others. The waves
 * get names of their own and never replace a wave that is there: the plugin
 * does not get to choose what in the experiment it overwrites.
 *
 * The one exception is the app's to make, never the plugin's: asked to
 * `replace` (a model editor fitting again, or `op.invoke(..., replace=True)`),
 * a run may make again the waves that the same action of the same plugin made
 * from the same input waves the last time it kept a result, under the same
 * names, but only those still as that result left them (their values and
 * scaling equal to the result's own copies). Anything changed or renamed
 * since, and anything else in the experiment, is left alone and the run's
 * waves get new names. See {@link previousOutputs}.
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
  /** When it replaces what a run made before (see previousOutputs): that run, and what to do with it. */
  replaced: Replaced | null;
}

/** What a run that replaces an earlier one's waves does to them. */
export interface Replaced {
  /** The result of the run before. */
  result: string;
  /** The waves of the run before still as it left them, by role. */
  unchanged: Record<string, string>;
  /** Waves of the run before that are still as it left them but that this run did not make again. */
  stale: string[];
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The run whose waves a run of `source.action` on these inputs may replace:
 * the latest result the same action of the same plugin kept for the same
 * input waves; and, by role, those of its waves that are still what it
 * made (equal to the result's own copies) and still under a name such a
 * run makes (not renamed), which may be made again under their names. Null
 * when there is no such run.
 */
export function previousOutputs(
  state: DocState,
  source: Pick<ResultSource, "action" | "plugin">,
  inputs: Readonly<Record<string, string | string[]>>,
): { result: AnalysisResult; unchanged: Record<string, string> } | null {
  let latest: AnalysisResult | null = null;
  for (const result of Object.values(state.results)) {
    if (
      result.kind !== "plugin" ||
      result.source?.action !== source.action ||
      result.source.plugin !== source.plugin ||
      !sameJson((result.settings as { inputs?: unknown }).inputs, inputs)
    )
      continue;
    if (!latest || result.created >= latest.created) latest = result;
  }
  if (!latest) return null;
  const given = new Set(Object.values(inputs).flat());
  // Only a wave still under a name a run of it makes ("<input>_<role>", or with _1, _2...):
  // a renamed wave was set aside by the user, though the result follows it to its new name.
  const first = Object.values(inputs).flat()[0];
  const folder = first ? parentFolder(first) : "";
  const stem = first ? leafName(first) : source.action.split(".").at(-1)!;
  const ownName = (role: string, name: string) => {
    const base = folder ? `${folder}:${stem}_${role}` : `${stem}_${role}`;
    return (
      name === base || (name.startsWith(`${base}_`) && /^\d+$/.test(name.slice(base.length + 1)))
    );
  };
  const unchanged: Record<string, string> = {};
  for (const [role, name] of Object.entries(latest.outputs)) {
    const wave = Object.hasOwn(state.waves, name) ? state.waves[name] : undefined;
    const keptName = latest.kept[role];
    const kept =
      keptName && Object.hasOwn(state.waves, keptName) ? state.waves[keptName] : undefined;
    if (!wave || !kept || given.has(name) || !ownName(role, name)) continue;
    if (waveFingerprint(wave) === waveFingerprint(kept) && wave.unit === kept.unit)
      unchanged[role] = name;
  }
  return { result: latest, unchanged };
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
  replace = false,
): OutcomePlan {
  const inputs = waveArgs(action, args);
  const previous = replace ? previousOutputs(state, source, inputs) : null;
  const reuse = previous?.unchanged ?? {};
  const first = Object.values(inputs).flat()[0];
  // Next to the first wave it was given, named after it: "spectrum_fit".
  const folder = first ? parentFolder(first) : "";
  const stem = first ? leafName(first) : action.name;
  const taken = new Set(Object.keys(state.waves));
  const commands: Command[] = [];
  const waves: Record<string, string> = {};
  for (const [role, wave] of outcome.waves) {
    const base = folder ? `${folder}:${stem}_${role}` : `${stem}_${role}`;
    const again = Object.hasOwn(reuse, role) ? reuse[role]! : null;
    const name = again ?? freeName(base, taken);
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
      overwrite: again !== null,
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
  const replaced: Replaced | null = previous
    ? {
        result: previous.result.name,
        unchanged: { ...previous.unchanged },
        stale: Object.entries(previous.unchanged)
          .filter(([role]) => !Object.hasOwn(waves, role))
          .map(([, name]) => name),
      }
    : null;
  return { commands, waves, values: outcome.values, keepsResult, graph: outcome.graph, replaced };
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

/**
 * Brings the graphs that showed only the waves a run replaced (see
 * planOutcome's `replace`) up to date with the graph the run asked for: the
 * traces of waves it no longer makes come out, those of waves it makes now
 * that a graph does not show go in as asked, and a legend that lists traces
 * (not one written by hand) lists them again. Their look, axes and size stay
 * as they are. A graph that shows anything else (a wave changed since, say)
 * is left alone. Returns the first graph updated, or null when there was
 * none and a graph is to be made instead.
 */
export function updatePluginGraphs(
  target: GraphTarget,
  graph: PluginGraph,
  waves: Readonly<Record<string, string>>,
  replaced: Replaced,
  plugin: string,
): string | null {
  const unchanged = new Set(Object.values(replaced.unchanged));
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
        throw new DocError(`The graph ${plugin} asked for cannot be updated: ${error.message}`);
      }
      throw error;
    }
  };
  const made = new Set(Object.values(waves));
  const shows = Object.values(target.getState().graphs)
    .filter(
      (item) =>
        item.traces.length > 0 &&
        item.traces.every(
          (trace) => unchanged.has(trace.y) && (trace.x === null || unchanged.has(trace.x)),
        ),
    )
    .map((item) => item.name);
  for (const name of shows) {
    const before = target.getState().graphs[name]!;
    const gone = before.traces.filter((trace) => !made.has(trace.y)).map((trace) => trace.name);
    if (gone.length > 0) run({ op: "removeTraces", graph: name, traces: gone });
    const legend: string[] = [];
    for (const trace of graph.traces) {
      const y = wave(trace.y);
      const x = trace.x === null ? null : wave(trace.x);
      const now = target.getState().graphs[name]!;
      let shown = now.traces.find((item) => item.y === y && item.x === x)?.name;
      if (!shown) {
        shown = run({
          op: "appendTraces",
          graph: name,
          y: [y],
          x,
          vAxis: trace.vAxis,
          hAxis: trace.hAxis,
        }) as string;
        const props: Record<string, JsonValue> = { ...trace.props };
        for (const key of WAVE_PROPS) {
          if (typeof props[key] === "string") props[key] = wave(props[key] as string);
        }
        if (Object.keys(props).length > 0)
          run({ op: "modifyTrace", graph: name, trace: shown, props });
      }
      if (trace.legend !== null) legend.push(`\\s(${shown}) ${trace.legend}`);
    }
    const listsTraces = graph.annotations.some(
      (item) => item.kind === "legend" && item.text === null,
    );
    const listing = target
      .getState()
      .graphs[name]!.annotations.find(
        (item) =>
          item.kind === "legend" &&
          item.text !== "" &&
          item.text.split("\n").every((line) => line.startsWith("\\s(")),
      );
    if (listsTraces && listing && legend.length > 0) {
      run({
        op: "modifyAnnotation",
        graph: name,
        annotation: listing.name,
        props: { text: legend.join("\n") },
      });
    }
  }
  return shows[0] ?? null;
}

/** Kills the waves a replaced run made that this run did not make again, unless something shows them. */
export function dropStale(target: GraphTarget, replaced: Replaced): void {
  for (const name of replaced.stale) {
    const state = target.getState();
    if (Object.hasOwn(state.waves, name) && waveUsers(state, name).length === 0)
      target.dispatch({ op: "killWaves", names: [name] });
  }
}

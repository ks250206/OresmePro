import { waveFingerprint, type Json, type JsonObject } from "./results";
import { DocError, type DocState } from "./types";

/*
 * An analysis template is a named procedure of analysis steps, to do to one
 * sample after another: each step is a registered action (see op.action) and
 * its arguments. An argument is a fixed value, the wave given for an input
 * slot ({"$input": "spectrum"}), or something an earlier step returned
 * ({"$step": "bg", "output": "subtracted"}). There are no expressions and no
 * other references: what does not fit is a Python function, registered as an
 * action of its own.
 *
 * The actions themselves live in Python, so whether a step's action exists
 * and takes its arguments is checked there, when the template is run. What
 * the document can check without Python, it checks when the template is
 * kept: names, the shape of each argument, and that every reference points
 * to a slot or to an earlier step.
 *
 * A run is the record of a template done to a list of samples: a copy of the
 * template as it was, and for each sample the waves it was given, a
 * fingerprint of each as it was used, how it went and what it made. Editing
 * or deleting the template afterwards leaves the record as it is.
 */

/** An input of a template: a wave given for each sample. */
export interface TemplateInput {
  name: string;
  /** What the wave is, for the person choosing it ("Spectrum"). */
  title: string;
  kind: "wave";
}

export interface TemplateStep {
  /** Names the step for the references of later steps. */
  id: string;
  /** The action called, by id, and the version it was written for. */
  action: string;
  version: number;
  /** By parameter name: a fixed value, a reference, or a list of those. */
  args: JsonObject;
}

export interface AnalysisTemplate {
  description: string;
  inputs: readonly TemplateInput[];
  steps: readonly TemplateStep[];
}

export const RUN_STATES = ["pending", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ON_ERROR = ["continue", "stop"] as const;
export type OnError = (typeof ON_ERROR)[number];

export interface RunSample {
  /** The wave given for each slot. */
  inputs: Record<string, string>;
  /** A fingerprint of each input as it was when the sample was last done (see waveFingerprint). */
  fingerprints: Record<string, string>;
  state: RunState;
  /** Why it failed, or why it was not done. */
  error: string;
  /** The analysis results its steps kept, and the waves they made. */
  results: string[];
  waves: string[];
  /** How many times it has been done: more than once when it was retried. */
  attempts: number;
  /** When it was last done, in milliseconds since the epoch, or null if never. */
  finished: number | null;
}

export interface TemplateRun {
  name: string;
  /** The name of the template it was made from, then. */
  template: string;
  /** The template as it was: a retry does the same steps whatever the template says now. */
  copy: AnalysisTemplate;
  onError: OnError;
  created: number;
  samples: RunSample[];
}

/** The first part of the name a run gets: Run0, Run1, ... */
export const RUN_BASE = "Run";

const NAME = /^[\p{L}][\p{L}\p{N}_]*$/u;
const ACTION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const PARAM = /^[A-Za-z][A-Za-z0-9_]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkTemplateName(value: unknown, what: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value.length > 255) {
    throw new DocError(
      `${JSON.stringify(value)} is not a valid ${what} name. Names start with a letter and contain only letters, digits and "_".`,
    );
  }
  return value;
}

/** A reference an argument makes, or null for a fixed value. */
export function argReference(
  value: unknown,
): { input: string } | { step: string; output: string } | null {
  if (!isObject(value)) return null;
  if (Object.hasOwn(value, "$input")) return { input: value.$input as string };
  if (Object.hasOwn(value, "$step")) {
    return { step: value.$step as string, output: value.output as string };
  }
  return null;
}

/**
 * One argument of a step, checked: a fixed value (a number, a string, true
 * or false, a list, or an object of an action's own, such as a fit's
 * bounds), a reference, or a list or object holding references. Null is a
 * value only inside a list or an object ({"A": [0, null]}): an argument that
 * is null is left out instead.
 */
function checkArg(
  value: unknown,
  where: string,
  slots: ReadonlySet<string>,
  earlier: ReadonlySet<string>,
  inside = false,
): Json {
  if (value === null && inside) return null;
  if (value === null || value === undefined) {
    throw new DocError(`${where} cannot be null: leave the argument out instead.`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DocError(`${where} must be a finite number.`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => checkArg(item, `${where}[${index}]`, slots, earlier, true));
  }
  if (!isObject(value)) throw new DocError(`${where} is not a value a template can hold.`);
  const keys = Object.keys(value).sort();
  if (!keys.some((key) => key.startsWith("$"))) {
    const plain: JsonObject = {};
    for (const key of keys) {
      plain[key] = checkArg(value[key], `${where}.${key}`, slots, earlier, true);
    }
    return plain;
  }
  if (keys.length === 1 && keys[0] === "$input") {
    const slot = value.$input;
    if (typeof slot !== "string" || !slots.has(slot)) {
      throw new DocError(`${where} refers to ${JSON.stringify(slot)}, which is not an input.`);
    }
    return { $input: slot };
  }
  if (keys.length === 2 && keys[0] === "$step" && keys[1] === "output") {
    const { $step: step, output } = value;
    if (typeof step !== "string" || !earlier.has(step)) {
      throw new DocError(
        `${where} refers to step ${JSON.stringify(step)}, which is not an earlier step.`,
      );
    }
    if (typeof output !== "string" || output === "") {
      throw new DocError(`${where}: output must name something step ${step} returns.`);
    }
    return { $step: step, output };
  }
  throw new DocError(
    `${where}: a reference must be {"$input": slot} or {"$step": step, "output": key}, with nothing else.`,
  );
}

/**
 * A template as it comes from Python or a file, checked and put in a fixed
 * shape. Refused: names that are not names, a slot or step id used twice, a
 * reference to a slot that does not exist or to a step that is not earlier
 * (so the steps cannot refer to each other in a circle).
 */
export function checkAnalysisTemplate(value: unknown): AnalysisTemplate {
  if (!isObject(value)) throw new DocError("A template must be an object.");
  for (const key of Object.keys(value)) {
    if (!["description", "inputs", "steps"].includes(key)) {
      throw new DocError(
        `A template has no ${JSON.stringify(key)}. It has description, inputs and steps.`,
      );
    }
  }
  const description = value.description ?? "";
  if (typeof description !== "string") throw new DocError("A template's description is text.");
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    throw new DocError("A template needs at least one input: the wave given for each sample.");
  }
  const inputs: TemplateInput[] = [];
  const slots = new Set<string>();
  for (const [index, input] of (value.inputs as unknown[]).entries()) {
    const item = typeof input === "string" ? { name: input } : input;
    if (!isObject(item)) throw new DocError(`Input ${index + 1} must be an object with a name.`);
    const name = checkTemplateName(item.name, "input");
    if (slots.has(name)) throw new DocError(`Two inputs are named ${name}.`);
    if (item.kind !== undefined && item.kind !== "wave") {
      throw new DocError(`Input ${name}: the kind of an input is "wave".`);
    }
    if (item.title !== undefined && typeof item.title !== "string") {
      throw new DocError(`Input ${name}: its title is text.`);
    }
    slots.add(name);
    inputs.push({ name, title: (item.title as string | undefined) ?? "", kind: "wave" });
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new DocError("A template needs at least one step.");
  }
  const steps: TemplateStep[] = [];
  const earlier = new Set<string>();
  for (const [index, step] of (value.steps as unknown[]).entries()) {
    if (!isObject(step)) throw new DocError(`Step ${index + 1} must be an object.`);
    for (const key of Object.keys(step)) {
      if (!["id", "action", "version", "args"].includes(key)) {
        throw new DocError(
          `Step ${index + 1} has no ${JSON.stringify(key)}. A step has id, action, version and args.`,
        );
      }
    }
    const id = checkTemplateName(step.id, "step");
    if (earlier.has(id)) throw new DocError(`Two steps are named ${id}.`);
    if (typeof step.action !== "string" || !ACTION_ID.test(step.action)) {
      throw new DocError(
        `Step ${id}: ${JSON.stringify(step.action)} is not an action id, such as "core.fit".`,
      );
    }
    const version = step.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new DocError(`Step ${id}: the version of its action is a whole number from 1.`);
    }
    const given = step.args ?? {};
    if (!isObject(given)) throw new DocError(`Step ${id}: args are an object of name: value.`);
    const args: JsonObject = {};
    for (const [name, arg] of Object.entries(given)) {
      // Parameter names are Python identifiers that do not start with "_".
      if (!PARAM.test(name)) {
        throw new DocError(`Step ${id}: ${JSON.stringify(name)} is not a parameter name.`);
      }
      args[name] = checkArg(arg, `Step ${id}: ${name}`, slots, earlier);
    }
    steps.push({ id, action: step.action, version, args });
    earlier.add(id);
  }
  return { description, inputs, steps };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!isObject(value)) return record;
  for (const [key, item] of Object.entries(value)) {
    if (NAME.test(key) && typeof item === "string") record[key] = item;
  }
  return record;
}

/** The waves given for a sample: one for each input of the template, by name. */
export function checkSampleInputs(
  value: unknown,
  template: AnalysisTemplate,
  where: string,
): Record<string, string> {
  if (!isObject(value)) throw new DocError(`${where} must give a wave for each input.`);
  const inputs: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (!template.inputs.some((input) => input.name === key)) {
      throw new DocError(`${where}: the template has no input ${JSON.stringify(key)}.`);
    }
  }
  for (const input of template.inputs) {
    const wave = value[input.name];
    if (typeof wave !== "string" || wave === "") {
      throw new DocError(`${where} needs a wave for ${input.name}.`);
    }
    inputs[input.name] = wave.startsWith("root:") ? wave.slice(5) : wave;
  }
  return inputs;
}

/**
 * A run as it comes from Python or a file, checked. Samples coming from
 * Python are new (pending); one read from a file has its states as saved.
 */
export function checkRun(value: unknown, name: string): TemplateRun {
  if (!isObject(value)) throw new DocError("A run must be an object.");
  const copy = checkAnalysisTemplate(value.copy);
  const onError = ON_ERROR.find((item) => item === (value.onError ?? "continue"));
  if (!onError) throw new DocError(`A run's onError is "continue" or "stop".`);
  if (!Array.isArray(value.samples) || value.samples.length === 0) {
    throw new DocError("A run needs at least one sample.");
  }
  const samples = (value.samples as unknown[]).map((sample, index): RunSample => {
    const where = `Sample ${index + 1}`;
    const given = isObject(sample) && isObject(sample.inputs) ? sample.inputs : sample;
    const inputs = checkSampleInputs(given, copy, where);
    const item = isObject(sample) && isObject(sample.inputs) ? sample : {};
    const state = RUN_STATES.find((each) => each === (item.state ?? "pending")) ?? "pending";
    const attempts = item.attempts;
    const finished = item.finished;
    return {
      inputs,
      fingerprints: stringRecord(item.fingerprints),
      state,
      error: typeof item.error === "string" ? item.error : "",
      results: strings(item.results),
      waves: strings(item.waves),
      attempts:
        typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
      finished: typeof finished === "number" && Number.isFinite(finished) ? finished : null,
    };
  });
  return {
    name,
    template: typeof value.template === "string" ? value.template : "",
    copy,
    onError,
    created:
      typeof value.created === "number" && Number.isFinite(value.created) ? value.created : 0,
    samples,
  };
}

/** What a sample is told when it is done, or not: see the updateRunSample command. */
export interface SampleOutcome {
  state: RunState;
  error?: string;
  results?: readonly string[];
  waves?: readonly string[];
  /** Whether the sample was done (or begun) this time, which counts as an attempt. */
  attempted?: boolean;
  /** When, in milliseconds since the epoch. */
  finished?: number;
}

/**
 * A run with one sample's outcome recorded. The fingerprints are of the
 * input waves as they are in `state`, which is what the sample just used.
 */
export function withSampleOutcome(
  state: DocState,
  run: TemplateRun,
  index: number,
  outcome: SampleOutcome,
): TemplateRun {
  const sample = run.samples[index];
  if (!sample || !Number.isInteger(index)) {
    throw new DocError(`${run.name} has no sample ${index + 1}.`, "NOT_FOUND", {
      kind: "sample",
      index,
    });
  }
  if (!RUN_STATES.includes(outcome.state)) {
    throw new DocError(`A sample's state is one of ${RUN_STATES.join(", ")}.`);
  }
  const fingerprints: Record<string, string> = {};
  if (outcome.attempted) {
    for (const [slot, wave] of Object.entries(sample.inputs)) {
      const now = Object.hasOwn(state.waves, wave) ? state.waves[wave] : undefined;
      if (now) fingerprints[slot] = waveFingerprint(now);
    }
  }
  const next: RunSample = {
    ...sample,
    state: outcome.state,
    error: typeof outcome.error === "string" ? outcome.error : "",
    results: outcome.results ? strings(outcome.results) : sample.results,
    waves: outcome.waves ? strings(outcome.waves) : sample.waves,
    fingerprints: outcome.attempted ? fingerprints : sample.fingerprints,
    attempts: sample.attempts + (outcome.attempted ? 1 : 0),
    finished:
      typeof outcome.finished === "number" && Number.isFinite(outcome.finished)
        ? outcome.finished
        : sample.finished,
  };
  // A sample that is done again starts afresh: what an earlier attempt made is not its doing.
  if (outcome.attempted && outcome.state !== "succeeded") {
    next.results = outcome.results ? next.results : [];
    next.waves = outcome.waves ? next.waves : [];
  }
  return { ...run, samples: run.samples.map((item, at) => (at === index ? next : item)) };
}

/** How many samples of a run are in each state. */
export function runCounts(run: TemplateRun): Record<RunState, number> {
  const counts: Record<RunState, number> = { pending: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const sample of run.samples) counts[sample.state] += 1;
  return counts;
}

/** The samples a retry does again: those that failed, were cancelled or were never done. */
export const retryable = (run: TemplateRun): number[] =>
  run.samples.flatMap((sample, index) => (sample.state === "succeeded" ? [] : [index]));

/** The inputs of a sample whose waves are no longer what they were when it was done. */
export function changedSampleInputs(state: DocState, sample: RunSample): string[] {
  return Object.entries(sample.fingerprints)
    .filter(([slot, fingerprint]) => {
      const wave = sample.inputs[slot];
      const now = wave && Object.hasOwn(state.waves, wave) ? state.waves[wave] : undefined;
      return !now || waveFingerprint(now) !== fingerprint;
    })
    .map(([slot]) => sample.inputs[slot]!);
}

/** A run with a wave's name changed wherever a sample names the wave. */
export function renameInRun(run: TemplateRun, rename: (name: string) => string): TemplateRun {
  let touched = false;
  const samples = run.samples.map((sample) => {
    const inputs = Object.fromEntries(
      Object.entries(sample.inputs).map(([slot, wave]) => [slot, rename(wave)]),
    );
    const waves = sample.waves.map(rename);
    const same =
      Object.entries(inputs).every(([slot, wave]) => sample.inputs[slot] === wave) &&
      waves.every((wave, index) => sample.waves[index] === wave);
    if (same) return sample;
    touched = true;
    return { ...sample, inputs, waves };
  });
  return touched ? { ...run, samples } : run;
}

/** A run with a result's new name where a sample lists the result. */
export function renameResultInRun(run: TemplateRun, from: string, to: string): TemplateRun {
  if (!run.samples.some((sample) => sample.results.includes(from))) return run;
  return {
    ...run,
    samples: run.samples.map((sample) =>
      sample.results.includes(from)
        ? { ...sample, results: sample.results.map((name) => (name === from ? to : name)) }
        : sample,
    ),
  };
}

/** An argument as it reads in a list of steps: `$spectrum`, `bg.subtracted`, or the value. */
export function argText(value: Json): string {
  const reference = argReference(value);
  if (reference && "input" in reference) return `$${reference.input}`;
  if (reference) return `${reference.step}.${reference.output}`;
  if (Array.isArray(value)) return `[${value.map(argText).join(", ")}]`;
  return JSON.stringify(value);
}

import { pyLiteral } from "./doc/echo";

/**
 * Actions: Python functions registered under a name with `@op.action`, which
 * panels, templates and plugins call with plain values instead of Python
 * code. The list of them (the catalog) comes from Python; Python checks
 * every call again, so what is here only lets the GUI catch a mistake before
 * it sends anything.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The kinds of value an argument of an action takes. */
export type ParamType =
  | "wave"
  | "waves"
  | "number"
  | "integer"
  | "string"
  | "boolean"
  | "choice"
  | "numbers"
  /** Samples for a template: a list of objects giving a wave name for each input. */
  | "samples"
  /**
   * A value with a structure of its own, as JSON (a fit's hold, bounds or
   * exclude), which the action checks itself.
   */
  | "json";

/** The description of one argument, as `op.action` keeps it. */
export interface ParamSpec {
  type: ParamType;
  title?: string;
  description?: string;
  /** May be left out; the function's own default then applies. */
  optional: boolean;
  /** The value used when it is left out, if the action says. */
  default?: JsonValue;
  /** For a choice: the values allowed. */
  choices?: (string | number)[];
  /** For number, integer and numbers (each item): inclusive limits. */
  min?: number;
  max?: number;
  /** For waves and numbers: the exact number of items. */
  length?: number;
  /** For wave and waves: text waves may be chosen too, not only numeric ones. */
  text?: boolean;
}

export interface ActionSpec {
  /** A dotted name: `core.` for the application's own, `plugin.` for plugins. */
  id: string;
  version: number;
  title: string;
  description: string | null;
  /** By argument name, in the order the action lists them. */
  params: Record<string, ParamSpec>;
}

export type ActionArgs = Record<string, JsonValue>;

/** The action with this id: the version asked for, or else the highest. */
export function findAction(
  catalog: readonly ActionSpec[],
  id: string,
  version?: number,
): ActionSpec | undefined {
  let found: ActionSpec | undefined;
  for (const spec of catalog) {
    if (spec.id !== id) continue;
    if (version !== undefined) {
      if (spec.version === version) return spec;
    } else if (!found || spec.version > found.version) {
      found = spec;
    }
  }
  return found;
}

export interface ValidateOptions {
  /** Whether a wave of this name exists; waves are not checked without it. */
  waveExists?: (name: string) => boolean;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Whether a value is plain JSON: objects, lists, text, finite numbers, booleans and null. */
export function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return (
      (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson)
    );
  }
  return false;
}

function checkValue(
  spec: ParamSpec,
  value: unknown,
  where: string,
  options: ValidateOptions,
): string | null {
  if (value === null || value === undefined) {
    return `${where} cannot be null: leave it out instead.`;
  }
  const number = (item: unknown, what: string): string | null => {
    if (!isNumber(item)) return `${what} must be a finite number.`;
    if (spec.type === "integer" && !Number.isInteger(item)) {
      return `${what} must be a whole number.`;
    }
    if (spec.min !== undefined && item < spec.min) return `${what} must be at least ${spec.min}.`;
    if (spec.max !== undefined && item > spec.max) return `${what} must be at most ${spec.max}.`;
    return null;
  };
  const wave = (item: unknown, what: string): string | null => {
    if (typeof item !== "string" || !item) return `${what} must be the name of a wave.`;
    if (options.waveExists && !options.waveExists(item.replace(/^root:/, ""))) {
      return `${what}: there is no wave named ${JSON.stringify(item)}.`;
    }
    return null;
  };
  const list = (check: (item: unknown, what: string) => string | null): string | null => {
    if (!Array.isArray(value)) return `${where} must be a list.`;
    if (spec.length !== undefined && value.length !== spec.length) {
      return `${where} must have ${spec.length} items, not ${value.length}.`;
    }
    for (const [index, item] of value.entries()) {
      const problem = check(item, `${where}[${index}]`);
      if (problem) return problem;
    }
    return null;
  };
  switch (spec.type) {
    case "wave":
      return wave(value, where);
    case "waves":
      return list(wave);
    case "number":
    case "integer":
      return number(value, where);
    case "numbers":
      return list(number);
    case "string":
      return typeof value === "string" ? null : `${where} must be a string.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${where} must be true or false.`;
    case "samples":
      // Whether the waves exist is found out sample by sample, when each is done.
      return list((item, what) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return `${what} must give a wave name for each input.`;
        }
        for (const [slot, name] of Object.entries(item)) {
          if (typeof name !== "string" || !name) {
            return `${what}: ${slot} must be the name of a wave.`;
          }
        }
        return null;
      });
    case "json":
      return isJson(value)
        ? null
        : `${where} must be made of objects, lists, text, numbers and true/false.`;
    case "choice":
      return (spec.choices ?? []).includes(value as string | number)
        ? null
        : `${where} must be one of ${(spec.choices ?? []).map((item) => JSON.stringify(item)).join(", ")}.`;
  }
}

/**
 * What is wrong with a call of an action with these arguments, as the
 * Python side would refuse it; an empty list when nothing is. Arguments
 * passed as the same parameter (see `op.action`) are left to Python.
 */
export function validateArgs(
  spec: ActionSpec,
  args: unknown,
  options: ValidateOptions = {},
): string[] {
  return argProblems(spec, args, options).map((problem) => problem.message);
}

/** As {@link validateArgs}, with the argument each problem is about (null for the call as a whole). */
export function argProblems(
  spec: ActionSpec,
  args: unknown,
  options: ValidateOptions = {},
): { field: string | null; message: string }[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [{ field: null, message: `The arguments of ${spec.id} are an object of name: value.` }];
  }
  const problems: { field: string | null; message: string }[] = [];
  const given = args as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(spec.params, name)) {
      problems.push({
        field: name,
        message: `${spec.id} takes no argument ${JSON.stringify(name)}.`,
      });
    }
  }
  for (const [name, param] of Object.entries(spec.params)) {
    if (!Object.hasOwn(given, name)) {
      if (!param.optional)
        problems.push({ field: name, message: `${spec.id} needs ${JSON.stringify(name)}.` });
      continue;
    }
    const problem = checkValue(param, given[name], `${spec.id}: ${name}`, options);
    if (problem) problems.push({ field: name, message: problem });
  }
  return problems;
}

/**
 * The call as `op.invoke(...)` in Python: what the history shows for a call
 * until Python has checked it and written the call of the function itself.
 */
export function invokeCode(
  id: string,
  args: ActionArgs,
  version?: number,
  options: { replace?: boolean } = {},
): string {
  const tail =
    (version === undefined ? "" : `, version=${version}`) +
    (options.replace ? ", replace=True" : "");
  return `op.invoke(${pyLiteral(id)}, ${pyLiteral(args)}${tail})`;
}

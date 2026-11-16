import {
  findAction,
  validateArgs,
  type ActionArgs,
  type ActionSpec,
  type JsonValue,
  type ParamSpec,
} from "../actions";
import { normalizeColor } from "./colors";
import {
  checkName,
  checkPath,
  emptyGraph,
  oneOf,
  placeWindow,
  uniqueName,
  windowTaken,
  type Command,
  type CommandOutcome,
} from "./commands";
import { dict, withEntry, type Dict } from "./dict";
import {
  AUTO_SIZE,
  CONTROL_KINDS,
  DocError,
  defaultTraceStyle,
  hasValue,
  leafName,
  type ControlArg,
  type ControlKind,
  type ControlRef,
  type DocState,
  type GraphSpec,
  type PanelControl,
  type PanelSpec,
  type PlotTrace,
} from "./types";

/*
 * Panels (see PanelSpec): the checks of their controls, the commands that
 * change them, and what a press of a button calls. Nothing here runs
 * anything: a button is resolved to an action id and plain arguments, which
 * the application hands to Python's action registry.
 */

type Props = Readonly<Record<string, unknown>>;

const ACTION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** An argument name, as Python accepts it for an action's parameter. */
const ARG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_TEXT = 10_000;
const MAX_ITEMS = 1000;
/** How deep lists and dicts may be nested in an argument. */
const MAX_DEPTH = 8;

export const isControlRef = (value: unknown): value is ControlRef =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { $control?: unknown }).$control === "string";

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new DocError(`${what} must be text.`);
  if (value.length > MAX_TEXT) throw new DocError(`${what} is too long.`);
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DocError(`${what} must be a finite number.`);
  }
  return value;
}

const orNull =
  <T>(check: (value: unknown, what: string) => T) =>
  (value: unknown, what: string): T | null =>
    value === null ? null : check(value, what);

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new DocError(`${what} must be true or false.`);
  return value;
}

function option(value: unknown, what: string): string | number {
  if (typeof value === "string") return text(value, what);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new DocError(`${what} must be text or a number.`);
}

function options(value: unknown, what: string): (string | number)[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new DocError(`${what} must be a list.`);
  }
  const list = value.map((item: unknown, index) => option(item, `${what}[${index}]`));
  if (new Set(list).size !== list.length) throw new DocError(`${what} must all be different.`);
  return list;
}

function dims(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new DocError(`${what} must be a whole number from 1 to 4.`);
  }
  return value;
}

function version(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new DocError(`${what} must be a whole number from 1.`);
  }
  return value;
}

function actionId(value: unknown, what: string): string {
  if (value === "") return "";
  if (typeof value !== "string" || !ACTION_ID.test(value)) {
    throw new DocError(`${what} must be the id of an action, such as "core.fit".`);
  }
  return value;
}

/** A plain value an action takes: text, a number, true or false, or a list of texts and numbers. */
/**
 * An argument as data: text, finite numbers, true or false, and lists and
 * dicts of them (an action such as core.run_template takes a list of dicts),
 * where `{"$control": name}` and nothing else besides stands for a control.
 * Dicts are made without a prototype (see ./dict), whatever their keys.
 */
function arg(value: unknown, what: string, depth = 0): ControlArg {
  if (typeof value === "string") return text(value, what);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, what);
  if (value === null) {
    // An action is never passed null for an argument; within a value, null may mean something.
    if (depth === 0) throw new DocError(`${what} cannot be null: leave it out instead.`);
    return null;
  }
  if (depth >= MAX_DEPTH) throw new DocError(`${what} is nested too deeply.`);
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new DocError(`${what} has too many items.`);
    return value.map((item: unknown, index) => arg(item, `${what}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    if (Object.hasOwn(value, "$control")) {
      if (!isControlRef(value)) {
        throw new DocError(`${what}: a control is given as {"$control": name} and nothing else.`);
      }
      return { $control: checkName(value.$control, "control") };
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_ITEMS) throw new DocError(`${what} has too many items.`);
    return dict(entries.map(([key, item]) => [key, arg(item, `${what}.${key}`, depth + 1)]));
  }
  throw new DocError(`${what} must be text, a number, true or false, a list or a dict.`);
}

function args(value: unknown, what: string): Dict<ControlArg> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocError(`${what} must be an object of argument name: value.`);
  }
  const result = dict<ControlArg>();
  for (const [name, item] of Object.entries(value)) {
    if (!ARG_NAME.test(name))
      throw new DocError(`${JSON.stringify(name)} is not an argument name.`);
    result[name] = arg(item, `${what}: ${name}`);
  }
  return result;
}

/** A place or size in pixels, from 0 (a place) or 1 (a size) to MAX_PIXELS, rounded to a whole pixel. */
const pixels =
  (least: number) =>
  (value: unknown, what: string): number => {
    const number = Math.round(finite(value, what));
    if (number < least || number > MAX_PIXELS) {
      throw new DocError(`${what} must be from ${least} to ${MAX_PIXELS} pixels.`);
    }
    return number;
  };
const MAX_PIXELS = 20_000;

function color(value: unknown, what: string): string {
  try {
    return normalizeColor(value);
  } catch (error) {
    throw new DocError(`${what}: ${(error as Error).message}`);
  }
}

function order(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 1_000_000) {
    throw new DocError(`${what} must be a whole number.`);
  }
  return value;
}

/** The waves a list holds: names of waves, each once. */
function waveNames(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new DocError(`${what} must be a list of the names of waves.`);
  }
  const names = value.map((item: unknown, index) => checkPath(item, `${what}[${index}]`));
  if (new Set(names).size !== names.length) throw new DocError(`${what} names a wave twice.`);
  return names;
}

/**
 * The waves a plot draws: each the name of a Y wave, a pair [y, x], or
 * {"y": y, "x": x}, where x may be null for the Y wave's own X scaling.
 */
function plotTraces(value: unknown, what: string): PlotTrace[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new DocError(`${what} must be a list of at most 100 waves to plot.`);
  }
  return value.map((item: unknown, index): PlotTrace => {
    const where = `${what}[${index}]`;
    if (typeof item === "string") return { y: checkPath(item, where), x: null };
    const pair = Array.isArray(item)
      ? item.length === 2
        ? { y: item[0] as unknown, x: item[1] as unknown }
        : null
      : typeof item === "object" && item !== null
        ? (item as { y?: unknown; x?: unknown })
        : null;
    if (!pair || Object.keys(pair).some((key) => key !== "y" && key !== "x")) {
      throw new DocError(`${where} must be a wave's name, [y, x] or {"y": y, "x": x}.`);
    }
    return {
      y: checkPath(pair.y, `${where}: y`),
      x: pair.x === null || pair.x === undefined ? null : checkPath(pair.x, `${where}: x`),
    };
  });
}

type Check = (value: unknown, what: string) => unknown;

/** The properties each kind of control has besides name, kind, label and inline. */
const KIND_PROPS: Record<ControlKind, Record<string, Check>> = {
  heading: {},
  text: {},
  number: {
    value: finite,
    min: orNull(finite),
    max: orNull(finite),
    step: orNull((value, what) => {
      const number = finite(value, what);
      if (number <= 0) throw new DocError(`${what} must be greater than 0.`);
      return number;
    }),
  },
  string: { value: text },
  checkbox: { value: bool },
  choice: { value: orNull(option), options },
  wave: {
    value: orNull((value, what) => checkPath(value, what)),
    dims: orNull(dims),
    filter: text,
  },
  list: { value: waveNames, dims: orNull(dims), filter: text, multiple: bool },
  plot: { traces: plotTraces, live: bool },
  button: { action: actionId, version: orNull(version), args },
};

/**
 * The look and place every control can be given (see PanelControl), with the
 * value each has while it is left out: null takes a property back to it.
 */
const STYLE_PROPS: Record<string, { check: Check; usual: unknown }> = {
  color: { check: color, usual: null },
  background: { check: color, usual: null },
  x: { check: pixels(0), usual: null },
  y: { check: pixels(0), usual: null },
  w: { check: pixels(1), usual: null },
  h: { check: pixels(1), usual: null },
  z: { check: order, usual: 0 },
};

/** The names of the look and place properties, in the order they are written. */
export const STYLE_KEYS = Object.keys(STYLE_PROPS) as readonly (
  | "color"
  | "background"
  | "x"
  | "y"
  | "w"
  | "h"
  | "z"
)[];

const COMMON_PROPS: Record<string, Check> = {
  label: text,
  inline: bool,
  ...Object.fromEntries(
    Object.entries(STYLE_PROPS).map(([key, { check, usual }]) => [
      key,
      (value: unknown, what: string) => (value === null ? usual : check(value, what)),
    ]),
  ),
};

/** The properties a control of a kind can be given. */
export const controlProps = (kind: ControlKind): string[] => [
  "label",
  "inline",
  ...STYLE_KEYS,
  ...Object.keys(KIND_PROPS[kind]),
];

/** Whether a control has a place of its own (x and y) rather than flowing in its line. */
export const isPlaced = (control: PanelControl): boolean => control.x !== undefined;

/** A control without the look and place properties that have their usual values. */
function withoutUsual(control: Record<string, unknown>): PanelControl {
  const result = { ...control };
  for (const [key, { usual }] of Object.entries(STYLE_PROPS)) {
    if (result[key] === usual || result[key] === undefined) delete result[key];
  }
  return result as unknown as PanelControl;
}

/** A new control of a kind, with its properties as they start. */
export function newControl(kind: ControlKind, name: string): PanelControl {
  const words = kind === "heading" || kind === "text" || kind === "plot";
  const base = { name, label: words ? "" : name, inline: false };
  switch (kind) {
    case "heading":
    case "text":
      return { ...base, kind };
    case "number":
      return { ...base, kind, value: 0, min: null, max: null, step: null };
    case "string":
      return { ...base, kind, value: "" };
    case "checkbox":
      return { ...base, kind, value: false };
    case "choice":
      return { ...base, kind, value: null, options: [] };
    case "wave":
      return { ...base, kind, value: null, dims: null, filter: "" };
    case "list":
      return { ...base, kind, value: [], dims: null, filter: "", multiple: true };
    case "plot":
      return { ...base, kind, traces: [], live: false };
    case "button":
      return { ...base, kind, action: "", version: null, args: dict() };
  }
}

/**
 * A control with some of its properties changed, checked as a whole: a value
 * given must fit the limits or options; one that no longer fits them after
 * they change is moved to fit (clamped, or the first option).
 */
export function changeControl(control: PanelControl, props: Props): PanelControl {
  const known = { ...COMMON_PROPS, ...KIND_PROPS[control.kind] };
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const check = Object.hasOwn(known, key) ? known[key] : undefined;
    if (!check) {
      throw new DocError(
        `A ${control.kind} control has no property ${JSON.stringify(key)}. It has: ${Object.keys(known).join(", ")}.`,
      );
    }
    changed[key] = check(value, key);
  }
  const next = withoutUsual({ ...control, ...changed });
  const given = Object.hasOwn(changed, "value");
  const label = next.label || next.name;
  if ((next.x === undefined) !== (next.y === undefined)) {
    throw new DocError(
      `${label}: x and y are given together, to place it; both null put it back in its line.`,
    );
  }
  if (next.kind === "list" && !next.multiple && next.value.length > 1) {
    if (given) throw new DocError(`${label} holds one wave: it is not set to select several.`);
    return { ...next, value: next.value.slice(0, 1) };
  }
  if (next.kind === "number") {
    if (next.min !== null && next.max !== null && next.min > next.max) {
      throw new DocError(`${label}: min is above max.`);
    }
    let value = next.value;
    if (next.min !== null && value < next.min) {
      if (given) throw new DocError(`${label} must be at least ${next.min}.`);
      value = next.min;
    }
    if (next.max !== null && value > next.max) {
      if (given) throw new DocError(`${label} must be at most ${next.max}.`);
      value = next.max;
    }
    return value === next.value ? next : { ...next, value };
  }
  if (next.kind === "choice") {
    if (next.value !== null && next.options.includes(next.value)) return next;
    if (given && next.value !== null) {
      throw new DocError(
        `${label} must be one of ${next.options.map((item) => JSON.stringify(item)).join(", ") || "its options, and it has none"}.`,
      );
    }
    return { ...next, value: next.options[0] ?? null };
  }
  return next;
}

function propsOf(value: unknown, what: string): Props {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocError(`${what} must be an object.`);
  }
  return value as Props;
}

/** Checks a control given as data and returns it in its usual form. */
function checkControl(value: unknown, where: string): PanelControl {
  const { kind, name, ...rest } = propsOf(value, where);
  const checked = oneOf(kind, CONTROL_KINDS, `${where}: kind`);
  return changeControl(newControl(checked, checkName(name, "control")), rest);
}

/** The file format a panel is exported in; other keys of the file are its content. */
export const PANEL_FILE_FORMAT = "oresme-panel";
const PANEL_FILE_VERSION = 1;

/**
 * Checks the content of a panel given as data (from Python, a file or an
 * experiment): its title and controls. What is left out takes the value a
 * new control would have. An exported file's `format`, `version` and `name`
 * may be there too; they are checked and left behind.
 */
export function checkPanel(value: unknown): Pick<PanelSpec, "title" | "controls"> {
  const { title = "", controls = [], format, version, name, ...rest } = propsOf(value, "A panel");
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw new DocError(
      `A panel has no property ${JSON.stringify(unknown[0])}. It has: title, controls.`,
    );
  }
  if (format !== undefined && format !== PANEL_FILE_FORMAT) {
    throw new DocError(`This is not a panel: its format is ${JSON.stringify(format)}.`);
  }
  if (version !== undefined && version !== PANEL_FILE_VERSION) {
    throw new DocError(
      `This panel is of a later version (${JSON.stringify(version)}) than this app reads.`,
    );
  }
  if (name !== undefined) checkName(name, "panel");
  if (!Array.isArray(controls) || controls.length > MAX_ITEMS) {
    throw new DocError("The controls of a panel must be a list.");
  }
  const checked: PanelControl[] = [];
  for (const [index, item] of controls.entries()) {
    const control = checkControl(item, `Control ${index + 1}`);
    if (checked.some((other) => other.name === control.name)) {
      throw new DocError(`Two controls are named ${JSON.stringify(control.name)}.`);
    }
    checked.push(control);
  }
  return { title: text(title, "title"), controls: checked };
}

/** A panel as the file it is exported to, for sharing. */
export function panelFile(panel: PanelSpec) {
  return {
    format: PANEL_FILE_FORMAT,
    version: PANEL_FILE_VERSION,
    name: panel.name,
    title: panel.title,
    controls: panel.controls,
  };
}

/** Reads an exported panel: its name (as it was exported) and its content. */
export function readPanelFile(source: string): Pick<PanelSpec, "name" | "title" | "controls"> {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new DocError("The file is not JSON.");
  }
  const { format, name } = propsOf(data, "A panel file") as { format?: unknown; name?: unknown };
  if (format !== PANEL_FILE_FORMAT) throw new DocError("The file is not an exported panel.");
  return {
    name: typeof name === "string" ? checkName(name, "panel") : "Panel",
    ...checkPanel(data),
  };
}

function requirePanel(state: DocState, name: string): PanelSpec {
  const panel = Object.hasOwn(state.panels, name) ? state.panels[name] : undefined;
  if (!panel) throw new DocError(`No panel named ${JSON.stringify(name)}.`);
  return panel;
}

function requireControl(panel: PanelSpec, name: string): PanelControl {
  const control = panel.controls.find((item) => item.name === name);
  if (!control) throw new DocError(`${panel.name} has no control named ${JSON.stringify(name)}.`);
  return control;
}

const putPanel = (state: DocState, panel: PanelSpec): DocState => ({
  ...state,
  panels: withEntry(state.panels, panel.name, panel),
});

/** A panel made with its window, after checking the name is free. */
function withNewPanel(state: DocState, panel: PanelSpec): DocState {
  if (windowTaken(state)(panel.name)) {
    throw new DocError(`A window named ${JSON.stringify(panel.name)} already exists.`);
  }
  return {
    ...putPanel(state, panel),
    windows: [...state.windows, placeWindow(state, panel.name, "panel")],
  };
}

/** An argument with the references to one control renamed; the same argument if it has none. */
function renameRefs(value: ControlArg, from: string, to: string): ControlArg {
  if (isControlRef(value)) return value.$control === from ? { $control: to } : value;
  if (Array.isArray(value)) {
    const items = value.map((item: ControlArg) => renameRefs(item, from, to));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Dict<ControlArg>);
  const renamed = entries.map(([key, item]) => [key, renameRefs(item, from, to)] as const);
  return renamed.some(([, item], index) => item !== entries[index]![1]) ? dict(renamed) : value;
}

/** A button with the references to one control in its arguments renamed. */
function renameArgs(control: PanelControl, from: string, to: string): PanelControl {
  if (control.kind !== "button") return control;
  const args = renameRefs(control.args, from, to);
  return args === control.args ? control : { ...control, args: args as Dict<ControlArg> };
}

export type PanelCommand = Extract<
  Command,
  {
    op:
      | "newPanel"
      | "setPanel"
      | "modifyPanel"
      | "addControl"
      | "modifyControl"
      | "removeControl"
      | "moveControl"
      | "setControlValue";
  }
>;

/** Applies a command that changes a panel (see applyCommand). */
export function applyPanelCommand(state: DocState, command: PanelCommand): CommandOutcome {
  switch (command.op) {
    case "newPanel": {
      const name =
        command.name === undefined
          ? uniqueName("Panel", windowTaken(state))
          : checkName(command.name, "panel");
      const title = command.title === undefined ? "" : text(command.title, "title");
      return { state: withNewPanel(state, { name, title, controls: [] }), result: name };
    }
    case "setPanel": {
      const name = checkName(command.name, "panel");
      const content = checkPanel(command.panel);
      const panel = { name, ...content };
      const next = Object.hasOwn(state.panels, name)
        ? putPanel(state, panel)
        : withNewPanel(state, panel);
      return { state: next, result: name };
    }
    case "modifyPanel": {
      const panel = requirePanel(state, command.panel);
      const { title, ...rest } = propsOf(command.props, "props");
      if (Object.keys(rest).length > 0) {
        throw new DocError(`A panel has no property ${JSON.stringify(Object.keys(rest)[0])}.`);
      }
      if (title === undefined) return { state, result: null };
      return { state: putPanel(state, { ...panel, title: text(title, "title") }), result: null };
    }
    case "addControl": {
      const panel = requirePanel(state, command.panel);
      const kind = oneOf(command.kind, CONTROL_KINDS, "kind");
      const taken = (name: string) => panel.controls.some((item) => item.name === name);
      const name =
        command.name === undefined ? uniqueName(kind, taken) : checkName(command.name, "control");
      if (taken(name)) {
        throw new DocError(`${panel.name} already has a control named ${JSON.stringify(name)}.`);
      }
      const control = changeControl(newControl(kind, name), propsOf(command.props ?? {}, "props"));
      return {
        state: putPanel(state, { ...panel, controls: [...panel.controls, control] }),
        result: name,
      };
    }
    case "modifyControl": {
      const panel = requirePanel(state, command.panel);
      const control = requireControl(panel, command.control);
      const { name, kind, ...props } = propsOf(command.props, "props");
      if (kind !== undefined && kind !== control.kind) {
        throw new DocError("A control's kind cannot change: remove it and add another.");
      }
      let changed = changeControl(control, props);
      let controls = panel.controls.map((item) => (item === control ? changed : item));
      if (name !== undefined && name !== control.name) {
        const newName = checkName(name, "control");
        if (panel.controls.some((item) => item.name === newName)) {
          throw new DocError(
            `${panel.name} already has a control named ${JSON.stringify(newName)}.`,
          );
        }
        // Buttons that pass its value go on passing it under its new name.
        changed = { ...changed, name: newName };
        controls = controls.map((item) =>
          renameArgs(item.name === control.name ? changed : item, control.name, newName),
        );
      }
      return { state: putPanel(state, { ...panel, controls }), result: null };
    }
    case "removeControl": {
      const panel = requirePanel(state, command.panel);
      const control = requireControl(panel, command.control);
      // Buttons that pass its value keep the reference; pressing them says it is gone.
      const controls = panel.controls.filter((item) => item !== control);
      return { state: putPanel(state, { ...panel, controls }), result: null };
    }
    case "moveControl": {
      const panel = requirePanel(state, command.panel);
      const control = requireControl(panel, command.control);
      if (typeof command.to !== "number" || !Number.isInteger(command.to)) {
        throw new DocError("to must be a whole number.");
      }
      const rest = panel.controls.filter((item) => item !== control);
      const to = Math.max(0, Math.min(rest.length, command.to));
      if (panel.controls[to] === control) return { state, result: null };
      const controls = [...rest.slice(0, to), control, ...rest.slice(to)];
      return { state: putPanel(state, { ...panel, controls }), result: null };
    }
    case "setControlValue": {
      const panel = requirePanel(state, command.panel);
      const control = requireControl(panel, command.control);
      if (!hasValue(control)) {
        throw new DocError(`${control.name} is a ${control.kind}, which has no value.`);
      }
      const changed = changeControl(control, { value: command.value });
      if (changed.kind === control.kind && changed.value === control.value) {
        return { state, result: null };
      }
      const controls = panel.controls.map((item) => (item === control ? changed : item));
      return { state: putPanel(state, { ...panel, controls }), result: null };
    }
  }
}

/** A control with the waves it holds renamed; the same control when none of them is. */
function renameWaves(control: PanelControl, rename: (name: string) => string): PanelControl {
  const names = (list: readonly string[]) => list.map(rename);
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    a.every((item, index) => item === b[index]);
  switch (control.kind) {
    case "wave":
      return control.value === null || rename(control.value) === control.value
        ? control
        : { ...control, value: rename(control.value) };
    case "list": {
      const value = names(control.value);
      return same(value, control.value) ? control : { ...control, value };
    }
    case "plot": {
      const traces = control.traces.map((trace) => ({
        y: rename(trace.y),
        x: trace.x === null ? null : rename(trace.x),
      }));
      const moved = traces.some(
        (trace, index) =>
          trace.y !== control.traces[index]!.y || trace.x !== control.traces[index]!.x,
      );
      return moved ? { ...control, traces } : control;
    }
    default:
      return control;
  }
}

/** The panels with the waves their pickers, lists and plots hold renamed. */
export function renameInPanels(
  panels: Dict<PanelSpec>,
  rename: (name: string) => string,
): Dict<PanelSpec> {
  let result = panels;
  for (const panel of Object.values(panels)) {
    const controls = panel.controls.map((control) => renameWaves(control, rename));
    if (controls.every((control, index) => control === panel.controls[index])) continue;
    result = withEntry(result, panel.name, { ...panel, controls });
  }
  return result;
}

/**
 * The z that brings a control in front of the others of its panel ("front")
 * or behind them ("back"); its own z when it is there already.
 */
export function stackingZ(panel: PanelSpec, name: string, to: "front" | "back"): number {
  const control = panel.controls.find((item) => item.name === name);
  const own = control?.z ?? 0;
  const others = panel.controls.filter((item) => item !== control).map((item) => item.z ?? 0);
  if (others.length === 0) return own;
  if (to === "front") {
    const top = Math.max(...others);
    return own > top ? own : top + 1;
  }
  const bottom = Math.min(...others);
  return own < bottom ? own : bottom - 1;
}

/** The waves a graph draws, as a plot of a panel keeps them. */
export const tracesOf = (graph: GraphSpec): PlotTrace[] =>
  graph.traces.map((trace) => ({ y: trace.y, x: trace.x }));

/** The graph whose window is frontmost, or null. */
export function activeGraph(state: Pick<DocState, "windows" | "graphs">): GraphSpec | null {
  const window = state.windows.findLast((item) => item.kind === "graph" && !item.hidden);
  return window && Object.hasOwn(state.graphs, window.name) ? state.graphs[window.name]! : null;
}

/**
 * What a panel's plot draws, as a graph that follows its box: the frontmost
 * graph when it is live (null when there is none), or else its own traces
 * in the usual colors.
 */
export function plotGraph(
  control: Extract<PanelControl, { kind: "plot" }>,
  state: Pick<DocState, "windows" | "graphs">,
): GraphSpec | null {
  if (control.live) {
    const graph = activeGraph(state);
    return graph && { ...graph, width: AUTO_SIZE, height: AUTO_SIZE, magnification: 1 };
  }
  const graph = emptyGraph(control.name);
  const traces = control.traces.map((trace, index) => ({
    ...defaultTraceStyle(index),
    // Unique as a graph wants them: a wave plotted twice is named twice.
    name: `${leafName(trace.y)}#${index}`,
    y: trace.y,
    x: trace.x,
    vAxis: "left",
    hAxis: "bottom",
  }));
  return { ...graph, fontSize: 10, traces };
}

/** Whether an action id belongs to the application (core) or to a plugin, which runs sandboxed. */
const isTrustedAction = (id: string): boolean => id.startsWith("core.") || id.startsWith("plugin.");

/**
 * The actions a panel's buttons call that run the user's own Python: those
 * that procedures registered with `@op.action`, which can do anything Python
 * can. The application's (`core.`) and plugins' (`plugin.`, run apart from
 * the experiment) are left out.
 */
export function codeActions(panel: PanelSpec): string[] {
  const ids = panel.controls
    .filter((control) => control.kind === "button")
    .map((control) => (control.kind === "button" ? control.action : ""))
    .filter((id) => id !== "" && !isTrustedAction(id));
  return [...new Set(ids)];
}

/**
 * How far a panel must be trusted: "data" when its buttons call only the
 * application's and plugins' actions, so that opening and pressing it runs
 * nothing the user did not install; "code" when a button calls an action of
 * the user's procedures.
 */
export const panelTrust = (panel: PanelSpec): "data" | "code" =>
  codeActions(panel).length > 0 ? "code" : "data";

/** What a press of a button calls: an action and the arguments resolved from the panel. */
export interface ButtonCall {
  action: string;
  version: number | null;
  args: ActionArgs;
}

export interface ResolvedButton {
  /** The call, or null when something is wrong with it. */
  call: ButtonCall | null;
  /** What is wrong, in words for the person pressing the button; empty when nothing is. */
  problems: string[];
}

export interface ResolveOptions {
  /** Whether a wave of this name exists. */
  waveExists: (name: string) => boolean;
  /**
   * The actions there are, to check the call against before it is made.
   * Left out (Python is not up to say), the call is checked only by Python.
   */
  catalog?: readonly ActionSpec[];
}

/** The name a control is shown by. */
const shown = (control: PanelControl): string => control.label || control.name;

/**
 * Resolves a press of a button: each argument bound to a control takes the
 * control's value now, so that changing the panel while the call runs does
 * not change the call. Says what is wrong in the panel's own words (the
 * control's label) rather than the action's when it can.
 */
export function resolveButton(
  panel: PanelSpec,
  button: string,
  options: ResolveOptions,
): ResolvedButton {
  const control = panel.controls.find((item) => item.name === button);
  if (!control || control.kind !== "button") {
    return {
      call: null,
      problems: [`${panel.name} has no button named ${JSON.stringify(button)}.`],
    };
  }
  if (!control.action) return { call: null, problems: [`${shown(control)} calls no action yet.`] };
  const problems: string[] = [];
  const args: ActionArgs = {};
  /** The control each argument is bound to, to name it in what is wrong. */
  const bound = new Map<string, PanelControl>();
  const failed = new Set<string>();
  /** The value of a control a reference names, or undefined (and why, in problems). */
  const valueOf = (ref: ControlRef, name: string): JsonValue | undefined => {
    const source = panel.controls.find((item) => item.name === ref.$control);
    if (!source) {
      problems.push(`${name}: there is no control named ${JSON.stringify(ref.$control)}.`);
      return undefined;
    }
    if (!hasValue(source)) {
      problems.push(`${name}: ${shown(source)} is a ${source.kind}, which has no value.`);
      return undefined;
    }
    if (source.kind === "list") {
      if (source.value.length === 0) {
        problems.push(`Select a wave in ${shown(source)}.`);
        return undefined;
      }
      const gone = source.value.filter((wave) => !options.waveExists(wave));
      if (gone.length > 0) {
        problems.push(`${shown(source)} is missing: there is no wave ${gone.join(", ")}.`);
        return undefined;
      }
      return [...source.value];
    }
    if (source.kind === "wave") {
      if (source.value === null) {
        problems.push(`Choose a wave for ${shown(source)}.`);
        return undefined;
      }
      if (!options.waveExists(source.value)) {
        problems.push(`${shown(source)} is missing: there is no wave ${source.value}.`);
        return undefined;
      }
    }
    if (source.value === null) {
      problems.push(`${shown(source)} has no options to choose from.`);
      return undefined;
    }
    return source.value;
  };
  /** An argument with each reference replaced by its control's value; undefined if one has none. */
  const resolve = (value: ControlArg, name: string): JsonValue | undefined => {
    if (isControlRef(value)) return valueOf(value, name);
    if (Array.isArray(value)) {
      const items = value.map((item: ControlArg) => resolve(item, name));
      return items.includes(undefined) ? undefined : (items as JsonValue[]);
    }
    if (typeof value !== "object" || value === null) return value;
    const entries = Object.entries(value as Dict<ControlArg>).map(
      ([key, item]) => [key, resolve(item, name)] as const,
    );
    if (entries.some(([, item]) => item === undefined)) return undefined;
    return Object.fromEntries(entries) as JsonValue;
  };
  for (const [name, value] of Object.entries(control.args)) {
    const resolved = resolve(value, name);
    if (resolved === undefined) {
      failed.add(name);
      continue;
    }
    args[name] = resolved;
    if (isControlRef(value)) {
      const source = panel.controls.find((item) => item.name === value.$control);
      if (source) bound.set(name, source);
    }
  }
  const catalog = options.catalog;
  if (catalog && catalog.length > 0) {
    const spec = findAction(catalog, control.action, control.version ?? undefined);
    if (!spec) {
      const plugin = /^plugin\.([a-z][a-z0-9_]*)\./.exec(control.action)?.[1];
      problems.push(
        control.version !== null
          ? `There is no version ${control.version} of the action ${control.action}.`
          : plugin
            ? `There is no action ${control.action}: install the plugin ${plugin}, or turn it on (Python › Plugins…).`
            : `There is no action ${control.action}. If a procedure registers it, run the procedure.`,
      );
    } else {
      const prefix = `${spec.id}: `;
      for (const problem of validateArgs(spec, args, { waveExists: options.waveExists })) {
        // An argument that could not be resolved has been reported already.
        if ([...failed].some((name) => problem === `${spec.id} needs ${JSON.stringify(name)}.`)) {
          continue;
        }
        let message = problem;
        for (const [name, source] of bound) {
          if (problem.startsWith(`${prefix}${name} `) || problem.startsWith(`${prefix}${name}:`)) {
            message = `${shown(source)}${problem.slice(prefix.length + name.length)}`;
          }
        }
        problems.push(message);
      }
    }
  }
  if (problems.length > 0) return { call: null, problems };
  return { call: { action: control.action, version: control.version, args }, problems };
}

/**
 * Whether a wave's name passes a picker's filter: it contains the text, or,
 * when the filter has a "*", matches it as a pattern ("*_I"). Either way
 * without regard to case.
 */
export function matchesFilter(name: string, filter: string): boolean {
  if (!filter) return true;
  if (!filter.includes("*")) return name.toLowerCase().includes(filter.toLowerCase());
  const pattern = filter
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "i").test(name);
}

/** The waves a wave picker offers: numeric ones of its dimensions that pass its filter. */
export function pickerWaves(
  state: Pick<DocState, "waves" | "waveOrder">,
  control: { readonly dims: number | null; readonly filter: string },
): string[] {
  return state.waveOrder.filter((name) => {
    const wave = state.waves[name];
    if (!wave || wave.text) return false;
    if (control.dims !== null && wave.shape.length !== control.dims) return false;
    return matchesFilter(name, control.filter);
  });
}

/**
 * A control made for an argument of an action, to bind a button's argument
 * to: a wave picker for a wave, a menu of the choices for a choice, and so on,
 * labelled and limited as the argument is. Null for an argument no control
 * holds (a list).
 */
export function controlForParam(
  name: string,
  param: ParamSpec,
): { kind: ControlKind; props: Record<string, unknown> } | null {
  const label = param.title ?? name;
  const given = param.default;
  switch (param.type) {
    case "wave":
      return { kind: "wave", props: { label } };
    case "number":
    case "integer": {
      const props: Record<string, unknown> = { label };
      if (param.min !== undefined) props.min = param.min;
      if (param.max !== undefined) props.max = param.max;
      if (param.type === "integer") props.step = 1;
      if (typeof given === "number") props.value = given;
      else if (param.min !== undefined && param.min > 0) props.value = param.min;
      return { kind: "number", props };
    }
    case "string":
      return {
        kind: "string",
        props: typeof given === "string" ? { label, value: given } : { label },
      };
    case "boolean":
      return {
        kind: "checkbox",
        props: typeof given === "boolean" ? { label, value: given } : { label },
      };
    case "choice": {
      const options = param.choices ?? [];
      const props: Record<string, unknown> = { label, options };
      if ((typeof given === "string" || typeof given === "number") && options.includes(given)) {
        props.value = given;
      }
      return { kind: "choice", props };
    }
    case "waves":
      return { kind: "list", props: { label } };
    case "numbers":
    // A template's samples: rows of waves, which no one control holds.
    case "samples":
    // A structure of its own, which no control edits.
    case "json":
      return null;
  }
}

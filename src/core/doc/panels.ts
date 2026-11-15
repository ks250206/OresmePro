import { findAction, validateArgs, type ActionArgs, type ActionSpec } from "../actions";
import {
  checkName,
  checkPath,
  oneOf,
  placeWindow,
  uniqueName,
  windowTaken,
  type Command,
  type CommandOutcome,
} from "./commands";
import { dict, withEntry, type Dict } from "./dict";
import {
  CONTROL_KINDS,
  DocError,
  hasValue,
  type ControlArg,
  type ControlKind,
  type ControlRef,
  type DocState,
  type PanelControl,
  type PanelSpec,
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
function literal(value: unknown, what: string): ControlArg {
  if (typeof value === "string") return text(value, what);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, what);
  if (Array.isArray(value) && value.length <= MAX_ITEMS) {
    return value.map((item: unknown, index) => option(item, `${what}[${index}]`));
  }
  if (value === null) throw new DocError(`${what} cannot be null: leave it out instead.`);
  throw new DocError(
    `${what} must be text, a number, true or false, a list, or a control as {"$control": name}.`,
  );
}

function arg(value: unknown, what: string): ControlArg {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (!isControlRef(value)) {
      throw new DocError(`${what}: a control is given as {"$control": name} and nothing else.`);
    }
    return { $control: checkName(value.$control, "control") };
  }
  return literal(value, what);
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
  button: { action: actionId, version: orNull(version), args },
};

const COMMON_PROPS: Record<string, Check> = { label: text, inline: bool };

/** The properties a control of a kind can be given. */
export const controlProps = (kind: ControlKind): string[] => [
  "label",
  "inline",
  ...Object.keys(KIND_PROPS[kind]),
];

/** A new control of a kind, with its properties as they start. */
export function newControl(kind: ControlKind, name: string): PanelControl {
  const base = { name, label: kind === "heading" || kind === "text" ? "" : name, inline: false };
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
  const next = { ...control, ...changed } as PanelControl;
  const given = Object.hasOwn(changed, "value");
  const label = next.label || next.name;
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

/** The arguments of a button with references to one control renamed. */
function renameArgs(control: PanelControl, from: string, to: string): PanelControl {
  if (control.kind !== "button") return control;
  const entries = Object.entries(control.args);
  if (!entries.some(([, value]) => isControlRef(value) && value.$control === from)) return control;
  return {
    ...control,
    args: dict(
      entries.map(([key, value]) => [
        key,
        isControlRef(value) && value.$control === from ? { $control: to } : value,
      ]),
    ),
  };
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

/** The panels with the waves their pickers hold renamed. */
export function renameInPanels(
  panels: Dict<PanelSpec>,
  rename: (name: string) => string,
): Dict<PanelSpec> {
  let result = panels;
  for (const panel of Object.values(panels)) {
    const follows = (control: PanelControl) =>
      control.kind === "wave" && control.value !== null && rename(control.value) !== control.value;
    if (!panel.controls.some(follows)) continue;
    const controls = panel.controls.map((control) =>
      control.kind === "wave" && follows(control)
        ? { ...control, value: rename(control.value!) }
        : control,
    );
    result = withEntry(result, panel.name, { ...panel, controls });
  }
  return result;
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
  for (const [name, value] of Object.entries(control.args)) {
    if (!isControlRef(value)) {
      args[name] = value;
      continue;
    }
    const source = panel.controls.find((item) => item.name === value.$control);
    failed.add(name);
    if (!source) {
      problems.push(`${name}: there is no control named ${JSON.stringify(value.$control)}.`);
      continue;
    }
    if (!hasValue(source)) {
      problems.push(`${name}: ${shown(source)} is a ${source.kind}, which has no value.`);
      continue;
    }
    if (source.kind === "wave") {
      if (source.value === null) {
        problems.push(`Choose a wave for ${shown(source)}.`);
        continue;
      }
      if (!options.waveExists(source.value)) {
        problems.push(`${shown(source)} is missing: there is no wave ${source.value}.`);
        continue;
      }
    }
    if (source.value === null) {
      problems.push(`${shown(source)} has no options to choose from.`);
      continue;
    }
    failed.delete(name);
    bound.set(name, source);
    args[name] = source.value;
  }
  const catalog = options.catalog;
  if (catalog && catalog.length > 0) {
    const spec = findAction(catalog, control.action, control.version ?? undefined);
    if (!spec) {
      problems.push(
        control.version === null
          ? `There is no action ${control.action}. If a procedure registers it, run the procedure.`
          : `There is no version ${control.version} of the action ${control.action}.`,
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

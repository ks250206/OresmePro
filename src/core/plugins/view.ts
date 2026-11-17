import { PluginError } from "./manifest";

/**
 * Plugin views (docs/design/plugin-views.md): windows a plugin's Python
 * builds out of the app's own components and answers the events of. What
 * the Python returns is data, checked here node by node before anything is
 * drawn: only the components and props below, within bounds. No HTML, no
 * script, nothing evaluated.
 */

export type ViewNode =
  | { type: "column" | "row"; children: ViewNode[]; gap: number }
  | {
      type: "split";
      children: [ViewNode, ViewNode];
      direction: "horizontal" | "vertical";
      ratio: number;
    }
  | { type: "tabs"; tabs: { title: string; body: ViewNode }[] }
  | { type: "group"; title: string; body: ViewNode }
  | { type: "text"; text: string; tone: "normal" | "muted" | "danger" | "success"; mono: boolean }
  | {
      type: "number";
      label: string;
      bind: string;
      min: number | null;
      max: number | null;
      step: number | null;
      unit: string;
    }
  | { type: "string"; label: string; bind: string; placeholder: string; suggestions: string[] }
  | { type: "choice"; label: string; bind: string; choices: [string, ViewChoice][] }
  | { type: "checkbox"; label: string; bind: string }
  | { type: "wave"; label: string; bind: string; optional: boolean }
  | {
      type: "table";
      bind: string;
      columns: ViewColumn[];
      add: boolean;
      remove: boolean;
    }
  | {
      type: "plot";
      series: ViewSeries[];
      xLabel: string;
      yLabel: string;
      xLog: boolean;
      yLog: boolean;
      equal: boolean;
      xReverse: boolean;
      height: number;
    }
  | {
      type: "button";
      label: string;
      on: string | null;
      action: string | null;
      args: Record<string, ViewValue>;
      replace: boolean;
      primary: boolean;
      disabled: boolean;
    };

export type ViewChoice = string | number;

export interface ViewColumn {
  key: string;
  title: string;
  type: "text" | "number" | "checkbox" | "choice";
  choices: [string, ViewChoice][];
  editable: boolean;
  width: number | null;
}

export interface ViewSeries {
  /** Roles of the arrays the view returned; no x for the point numbers. */
  x: string | null;
  y: string;
  mode: "lines" | "markers" | "lines+markers";
  color: string | null;
  label: string;
}

/** An argument of a button's action: a plain value, or the value at a path of the state. */
export type ViewValue = JsonValue | { $bind: string };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ViewDefinition {
  version: 1;
  body: ViewNode;
}

export const VIEW_LIMITS = {
  nodes: 2000,
  depth: 32,
  text: 4000,
  label: 200,
  columns: 40,
  rows: 2000,
  series: 32,
  /** The state and the definition, as JSON text. */
  bytes: 1024 * 1024,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,15}$/;
const HANDLER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_]{0,39}$/;
const COLOR = /^(#[0-9a-fA-F]{6}|black|white|gray|red|green|blue|orange|purple|brown|pink|teal)$/;

const KEYS: Record<string, readonly string[]> = {
  column: ["children", "gap"],
  row: ["children", "gap"],
  split: ["children", "direction", "ratio"],
  tabs: ["tabs"],
  group: ["title", "body"],
  text: ["text", "tone", "mono"],
  number: ["label", "bind", "min", "max", "step", "unit"],
  string: ["label", "bind", "placeholder", "suggestions"],
  choice: ["label", "bind", "choices"],
  checkbox: ["label", "bind"],
  wave: ["label", "bind", "optional"],
  table: ["bind", "columns", "add", "remove"],
  plot: ["series", "x_label", "y_label", "x_log", "y_log", "equal", "x_reverse", "height"],
  button: ["label", "on", "action", "args", "replace", "primary", "disabled"],
};

/** Reads a view's definition, as its Python returned it; refuses all of it if any part is off. */
export function checkView(raw: unknown): ViewDefinition {
  if (!isRecord(raw)) throw new PluginError('A view is {"version": 1, "body": ...}.');
  if (raw.version !== 1)
    throw new PluginError(
      `A view of version ${JSON.stringify(raw.version)} is not one this app draws (1).`,
    );
  let count = 0;

  const text = (
    value: unknown,
    what: string,
    limit: number = VIEW_LIMITS.label,
    fallback?: string,
  ) => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string") throw new PluginError(`${what} is text.`);
    if (value.length > limit) throw new PluginError(`${what} is longer than ${limit} characters.`);
    return value;
  };
  const flag = (value: unknown, what: string, fallback: boolean) => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new PluginError(`${what} is true or false.`);
    return value;
  };
  const number = (value: unknown, what: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new PluginError(`${what} is a number.`);
    return value;
  };
  const path = (value: unknown, what: string) => {
    const given = text(value, what, 200);
    if (!PATH.test(given))
      throw new PluginError(`${what} ${JSON.stringify(given)} is not a path of the state (a.b.0).`);
    return given;
  };
  const choices = (value: unknown, what: string): [string, ViewChoice][] => {
    if (!Array.isArray(value) || value.length > 500) throw new PluginError(`${what} are a list.`);
    return value.map((item) => {
      if (typeof item === "string" || typeof item === "number") return [String(item), item];
      if (
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "string" &&
        (typeof item[1] === "string" || typeof item[1] === "number")
      )
        return [text(item[0], `A choice of ${what}`), item[1]];
      throw new PluginError(`A choice of ${what} is a value or [title, value].`);
    });
  };

  const node = (value: unknown, depth: number): ViewNode => {
    count += 1;
    if (count > VIEW_LIMITS.nodes)
      throw new PluginError(`A view has more than ${VIEW_LIMITS.nodes} parts.`);
    if (depth > VIEW_LIMITS.depth)
      throw new PluginError(`A view nests more than ${VIEW_LIMITS.depth} deep.`);
    if (!isRecord(value)) throw new PluginError('A part of a view is {"type": ..., ...}.');
    const type = value.type;
    if (typeof type !== "string" || !Object.hasOwn(KEYS, type))
      throw new PluginError(
        `${JSON.stringify(type)} is not a part this app draws: ${Object.keys(KEYS).join(", ")}.`,
      );
    const what = `A ${type}`;
    for (const key of Object.keys(value))
      if (key !== "type" && !KEYS[type]!.includes(key))
        throw new PluginError(`${what} has no ${JSON.stringify(key)}.`);
    const children = (list: unknown) => {
      if (!Array.isArray(list))
        throw new PluginError(`The children of ${what.toLowerCase()} are a list.`);
      return list.map((child) => node(child, depth + 1));
    };
    switch (type) {
      case "column":
      case "row":
        return {
          type,
          children: children(value.children),
          gap: number(value.gap, `The gap of ${what}`) ?? 8,
        };
      case "split": {
        const parts = children(value.children);
        if (parts.length !== 2) throw new PluginError("A split has two children.");
        const direction = value.direction ?? "horizontal";
        if (direction !== "horizontal" && direction !== "vertical")
          throw new PluginError("A split's direction is horizontal or vertical.");
        const ratio = number(value.ratio, "A split's ratio") ?? 0.5;
        if (!(ratio >= 0.1 && ratio <= 0.9))
          throw new PluginError("A split's ratio is from 0.1 to 0.9.");
        return { type, children: [parts[0]!, parts[1]!], direction, ratio };
      }
      case "tabs": {
        if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 20)
          throw new PluginError("Tabs are a list of 1 to 20 {title, body}.");
        return {
          type,
          tabs: value.tabs.map((tab) => {
            if (!isRecord(tab)) throw new PluginError("A tab is {title, body}.");
            return { title: text(tab.title, "A tab's title"), body: node(tab.body, depth + 1) };
          }),
        };
      }
      case "group":
        return {
          type,
          title: text(value.title, "A group's title", VIEW_LIMITS.label, ""),
          body: node(value.body, depth + 1),
        };
      case "text": {
        const tone = value.tone ?? "normal";
        if (!["normal", "muted", "danger", "success"].includes(tone as string))
          throw new PluginError("A text's tone is normal, muted, danger or success.");
        return {
          type,
          text: text(value.text, "A text", VIEW_LIMITS.text),
          tone: tone as "normal",
          mono: flag(value.mono, "A text's mono", false),
        };
      }
      case "number":
        return {
          type,
          label: text(value.label, `${what}'s label`, VIEW_LIMITS.label, ""),
          bind: path(value.bind, `${what}'s bind`),
          min: number(value.min, `${what}'s min`),
          max: number(value.max, `${what}'s max`),
          step: number(value.step, `${what}'s step`),
          unit: text(value.unit, `${what}'s unit`, 40, ""),
        };
      case "string": {
        const suggestions = value.suggestions ?? [];
        if (!Array.isArray(suggestions) || suggestions.length > 200)
          throw new PluginError("A string's suggestions are a list.");
        return {
          type,
          label: text(value.label, `${what}'s label`, VIEW_LIMITS.label, ""),
          bind: path(value.bind, `${what}'s bind`),
          placeholder: text(value.placeholder, `${what}'s placeholder`, VIEW_LIMITS.label, ""),
          suggestions: suggestions.map((item) => text(item, "A suggestion")),
        };
      }
      case "choice":
        return {
          type,
          label: text(value.label, `${what}'s label`, VIEW_LIMITS.label, ""),
          bind: path(value.bind, `${what}'s bind`),
          choices: choices(value.choices, "The choices of a choice"),
        };
      case "checkbox":
        return {
          type,
          label: text(value.label, `${what}'s label`),
          bind: path(value.bind, `${what}'s bind`),
        };
      case "wave":
        return {
          type,
          label: text(value.label, `${what}'s label`, VIEW_LIMITS.label, ""),
          bind: path(value.bind, `${what}'s bind`),
          optional: flag(value.optional, `${what}'s optional`, false),
        };
      case "table": {
        if (
          !Array.isArray(value.columns) ||
          value.columns.length === 0 ||
          value.columns.length > VIEW_LIMITS.columns
        )
          throw new PluginError(`A table has 1 to ${VIEW_LIMITS.columns} columns.`);
        const columns = value.columns.map((column): ViewColumn => {
          if (!isRecord(column)) throw new PluginError("A column is {key, title, type, ...}.");
          for (const key of Object.keys(column))
            if (!["key", "title", "type", "choices", "editable", "width"].includes(key))
              throw new PluginError(`A column has no ${JSON.stringify(key)}.`);
          const key = text(column.key, "A column's key", 64);
          if (!/^[A-Za-z0-9_]+$/.test(key))
            throw new PluginError(`${JSON.stringify(key)} is not a column key.`);
          const type_ = column.type ?? "text";
          if (!["text", "number", "checkbox", "choice"].includes(type_ as string))
            throw new PluginError("A column's type is text, number, checkbox or choice.");
          return {
            key,
            title: text(column.title, "A column's title", VIEW_LIMITS.label, key),
            type: type_ as ViewColumn["type"],
            choices:
              column.choices === undefined
                ? []
                : choices(column.choices, "The choices of a column"),
            editable: flag(column.editable, "A column's editable", true),
            width: number(column.width, "A column's width"),
          };
        });
        return {
          type,
          bind: path(value.bind, `${what}'s bind`),
          columns,
          add: flag(value.add, "A table's add", false),
          remove: flag(value.remove, "A table's remove", false),
        };
      }
      case "plot": {
        if (!Array.isArray(value.series) || value.series.length > VIEW_LIMITS.series)
          throw new PluginError(`A plot has at most ${VIEW_LIMITS.series} series.`);
        const series = value.series.map((item): ViewSeries => {
          if (!isRecord(item)) throw new PluginError("A series is {x, y, mode, color, label}.");
          for (const key of Object.keys(item))
            if (!["x", "y", "mode", "color", "label"].includes(key))
              throw new PluginError(`A series has no ${JSON.stringify(key)}.`);
          const mode = item.mode ?? "lines";
          if (!["lines", "markers", "lines+markers"].includes(mode as string))
            throw new PluginError("A series' mode is lines, markers or lines+markers.");
          const color =
            item.color === undefined || item.color === null
              ? null
              : text(item.color, "A series' color", 20);
          if (color !== null && !COLOR.test(color))
            throw new PluginError(`${JSON.stringify(color)} is not a color (#rrggbb).`);
          return {
            x: item.x === undefined || item.x === null ? null : text(item.x, "A series' x", 32),
            y: text(item.y, "A series' y", 32),
            mode: mode as ViewSeries["mode"],
            color,
            label: text(item.label, "A series' label", VIEW_LIMITS.label, ""),
          };
        });
        const height = number(value.height, "A plot's height") ?? 240;
        if (!(height >= 80 && height <= 1200))
          throw new PluginError("A plot's height is from 80 to 1200.");
        return {
          type,
          series,
          xLabel: text(value.x_label, "A plot's x label", VIEW_LIMITS.label, ""),
          yLabel: text(value.y_label, "A plot's y label", VIEW_LIMITS.label, ""),
          xLog: flag(value.x_log, "A plot's x_log", false),
          yLog: flag(value.y_log, "A plot's y_log", false),
          equal: flag(value.equal, "A plot's equal", false),
          xReverse: flag(value.x_reverse, "A plot's x_reverse", false),
          height,
        };
      }
      default: {
        const on =
          value.on === undefined || value.on === null ? null : text(value.on, "A button's on", 64);
        const action =
          value.action === undefined || value.action === null
            ? null
            : text(value.action, "A button's action", 40);
        if ((on === null) === (action === null))
          throw new PluginError("A button has either on (a handler) or action.");
        if (on !== null && !HANDLER.test(on))
          throw new PluginError(`${JSON.stringify(on)} is not a handler's name.`);
        if (action !== null && !ACTION.test(action))
          throw new PluginError(`${JSON.stringify(action)} is not an action's name.`);
        const args = value.args ?? {};
        if (!isRecord(args)) throw new PluginError("A button's args are a dict.");
        const checked: Record<string, ViewValue> = {};
        for (const [key, item] of Object.entries(args)) {
          if (isRecord(item) && Object.keys(item).length === 1 && "$bind" in item)
            checked[key] = { $bind: path(item.$bind, "A button's $bind") };
          else checked[key] = item as JsonValue;
        }
        return {
          type: "button",
          label: text(value.label, "A button's label"),
          on,
          action,
          args: checked,
          replace: flag(value.replace, "A button's replace", false),
          primary: flag(value.primary, "A button's primary", false),
          disabled: flag(value.disabled, "A button's disabled", false),
        };
      }
    }
  };
  for (const key of Object.keys(raw))
    if (key !== "version" && key !== "body")
      throw new PluginError(`A view has no ${JSON.stringify(key)}.`);
  return { version: 1, body: node(raw.body, 0) };
}

/** Reads JSON text a view returned, refusing what is too large or too deep. */
export function readViewJson(text: unknown, what: string): unknown {
  if (typeof text !== "string") throw new PluginError(`The view's ${what} is missing.`);
  if (text.length > VIEW_LIMITS.bytes)
    throw new PluginError(`The view's ${what} is larger than ${VIEW_LIMITS.bytes / 1024} KiB.`);
  const value = JSON.parse(text) as unknown;
  const deepest = (item: unknown, depth: number): number => {
    if (depth > VIEW_LIMITS.depth + 8)
      throw new PluginError(`The view's ${what} nests too deeply.`);
    if (Array.isArray(item))
      return Math.max(depth, ...item.map((each) => deepest(each, depth + 1)));
    if (isRecord(item))
      return Math.max(depth, ...Object.values(item).map((each) => deepest(each, depth + 1)));
    return depth;
  };
  deepest(value, 0);
  return value;
}

/** The value at a path of the state ("params.2.value"), or undefined. */
export function getPath(state: unknown, path: string): unknown {
  let at: unknown = state;
  for (const part of path.split(".")) {
    if (Array.isArray(at)) at = at[Number(part)];
    else if (isRecord(at) && Object.hasOwn(at, part)) at = at[part];
    else return undefined;
  }
  return at;
}

/** A copy of the state with the value at a path set, making the objects on the way. */
export function setPath(state: unknown, path: string, value: unknown): unknown {
  const [head, ...rest] = path.split(".");
  const key = head!;
  const inner = rest.join(".");
  if (Array.isArray(state)) {
    const copy = [...(state as unknown[])];
    const index = Number(key);
    copy[index] = rest.length === 0 ? value : setPath(copy[index], inner, value);
    return copy;
  }
  const base = isRecord(state) ? state : {};
  return { ...base, [key]: rest.length === 0 ? value : setPath(base[key], inner, value) };
}

/** Every node of a view, depth first. */
export function* viewNodes(node: ViewNode): Generator<ViewNode> {
  yield node;
  if (node.type === "column" || node.type === "row" || node.type === "split")
    for (const child of node.children) yield* viewNodes(child);
  else if (node.type === "tabs") for (const tab of node.tabs) yield* viewNodes(tab.body);
  else if (node.type === "group") yield* viewNodes(node.body);
}

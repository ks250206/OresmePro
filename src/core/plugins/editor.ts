import type { ParamSpec } from "../actions";
import { PluginError, type PluginAction } from "./manifest";

/**
 * A model editor a plugin describes in its manifest ("editors"): a window,
 * drawn by the app, for building a model of a spectrum out of items (peaks,
 * components) by dragging them on the plot and writing them in a table, then
 * fitting it. The plugin brings only the arithmetic, as two of its actions:
 *
 * - `preview`, called while the model is edited and never recorded: it is
 *   given the same arguments as the fit and returns what to draw;
 * - `fit`, called when the user fits: an ordinary run of an action, kept in
 *   the history and among the results.
 *
 * No code of the plugin runs in the app: the window is the app's, and this
 * description is data, checked here field by field like the rest of the
 * manifest. What the two actions return is described in docs (guides/plugins).
 *
 * Items are lettered A, B, C ... In the text of a constraint, a capital
 * letter standing alone names an item: the window renames those when an
 * item is taken out, and leaves every other meaning to the plugin.
 */

export interface EditorField {
  key: string;
  title: string;
  kind: "text" | "number";
  default: string | number;
  /** Suggestions for a text field. */
  choices: string[];
  /** Whether the field has a constraint, written as text under it. */
  constraint: boolean;
  /** What the constraint's field shows when it is empty. */
  hint: string;
  min: number | null;
}

export interface EditorPartner {
  /** The button's title ("Doublet"). */
  title: string;
  /** The title of the offset asked for ("Δ (eV)"). */
  offset: string;
  /** The choices of ratio, as [title, ratio]. */
  ratios: [string, number][];
  /** The constraint each field of the partner gets: {ref}, {offset} and {ratio} are filled in. */
  ties: Record<string, string>;
}

/**
 * What dragging an item on the plot changes, as the plugin says: the app
 * applies these rules and knows nothing of what the fields mean.
 *
 * - `x`: the number field set to where the square at the item's top is dropped.
 * - `height`: what moving that square up and down changes: `proportional`
 *   multiplies the field by the new height over the old (an area, which
 *   grows with the height), `value` sets it to the height itself. The height
 *   is the item's top above its base, as the preview says.
 * - `width`: the field the half-width handles change: `full` is the distance
 *   between them (a FWHM), `half` from the item's X to one of them; the
 *   fields in `scale` are multiplied by the new width over the old (to keep
 *   the height of a shape whose area grows with its width).
 */
export interface EditorDrag {
  x: string;
  height: { field: string; rule: "proportional" | "value" } | null;
  width: { field: string; rule: "full" | "half"; scale: string[] } | null;
}

/**
 * The kinds of editor this app draws: "spectrum-fit", a window of a fixed
 * layout (data, a range, items on a background) described here field by
 * field; and "view", a window the plugin's Python builds out of the app's
 * components and answers the events of (see src/core/plugins/view.ts).
 */
export const EDITOR_KINDS = ["spectrum-fit", "view"] as const;
export type EditorKind = (typeof EDITOR_KINDS)[number];

/** A view: its Python, registered with @view(name), builds its window and answers its events. */
export interface ViewSpec {
  kind: "view";
  name: string;
  title: string;
  description: string;
}

export type EditorSpec = SpectrumFitSpec | ViewSpec;

export interface SpectrumFitSpec {
  kind: "spectrum-fit";
  name: string;
  title: string;
  description: string;
  /** Names of the plugin's actions. */
  preview: string;
  fit: string;
  /** The wave argument with the data. */
  data: string;
  /** A wave argument with the data's X values, if the actions take one. */
  x: string | null;
  /** A numbers argument of length 2: the range of X fitted, dragged on the plot. */
  range: string | null;
  items: {
    /** The json argument the items are passed as: a list of {field: value, constraints: {field: text}}. */
    param: string;
    title: string;
    max: number;
    fields: EditorField[];
    /** What dragging an item on the plot does to its fields (see EditorDrag). */
    drag: EditorDrag;
    /** How the fit's result names a field of an item: "{letter}_{key}" (A_position). */
    coef: string | null;
  };
  partner: EditorPartner | null;
  /** Other arguments of both actions, set in the window's Settings. */
  settings: string[];
  axis: { label: string; reverse: boolean };
}

export const EDITOR_LIMITS = { editors: 8, fields: 24, items: 26 } as const;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, what: string, limit = 200, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new PluginError(`${what} must be text.`);
  if (value.length > limit) throw new PluginError(`${what} is longer than ${limit} characters.`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new PluginError(`${what} has an unknown key ${JSON.stringify(key)}.`);
  }
}

function field(value: unknown, where: string): EditorField {
  if (!isRecord(value)) throw new PluginError(`${where} is not described.`);
  onlyKeys(
    value,
    ["key", "title", "type", "default", "choices", "constraint", "hint", "min"],
    where,
  );
  const key = text(value.key, `The key of ${where}`, 40);
  if (!KEY.test(key) || key === "constraints")
    throw new PluginError(`${JSON.stringify(key)} is not a usable key for ${where}.`);
  const kind = value.type ?? "number";
  if (kind !== "text" && kind !== "number")
    throw new PluginError(`The type of ${where} is "text" or "number".`);
  const fallback = kind === "number" ? 0 : "";
  const given = value.default ?? fallback;
  if (
    kind === "number"
      ? typeof given !== "number" || !Number.isFinite(given)
      : typeof given !== "string"
  )
    throw new PluginError(
      `The default of ${where} is not a ${kind === "number" ? "number" : "text"}.`,
    );
  const choices = value.choices ?? [];
  if (
    !Array.isArray(choices) ||
    choices.length > 50 ||
    !choices.every((item) => typeof item === "string" && item.length <= 100)
  ) {
    throw new PluginError(`The choices of ${where} must be a list of texts.`);
  }
  if (value.constraint !== undefined && typeof value.constraint !== "boolean")
    throw new PluginError(`The constraint of ${where} is true or false.`);
  if (value.min !== undefined && (typeof value.min !== "number" || !Number.isFinite(value.min)))
    throw new PluginError(`The min of ${where} is not a number.`);
  return {
    key,
    title: text(value.title, `The title of ${where}`, 60, key),
    kind,
    default: given as string | number,
    choices: choices as string[],
    constraint: value.constraint === true,
    hint: text(value.hint, `The hint of ${where}`, 60, ""),
    min: typeof value.min === "number" ? value.min : null,
  };
}

/** Checks one editor of a manifest against the plugin's actions; refuses it whole if anything is off. */
export function parseEditor(
  value: unknown,
  index: number,
  actions: readonly PluginAction[],
): EditorSpec {
  const where = `Editor ${index + 1}`;
  if (!isRecord(value)) throw new PluginError(`${where} is not described.`);
  if (value.kind === "view") {
    onlyKeys(value, ["kind", "name", "title", "description"], where);
    const name = text(value.name, `The name of ${where}`, 40);
    if (!NAME.test(name))
      throw new PluginError(
        `${JSON.stringify(name)} is not a usable editor name (a-z, 0-9 and _).`,
      );
    return {
      kind: "view",
      name,
      title: text(value.title, `The title of the editor ${name}`, 80),
      description: text(value.description, `The description of the editor ${name}`, 2000, ""),
    };
  }
  onlyKeys(
    value,
    [
      "kind",
      "name",
      "title",
      "description",
      "preview",
      "fit",
      "data",
      "x",
      "range",
      "items",
      "partner",
      "settings",
      "axis",
    ],
    where,
  );
  const kind = value.kind;
  if (typeof kind !== "string")
    throw new PluginError(`${where} must say its kind ("kind": "spectrum-fit").`);
  if (!(EDITOR_KINDS as readonly string[]).includes(kind))
    throw new PluginError(
      `${where} is of a kind this app does not draw (${JSON.stringify(kind)}); it draws ${EDITOR_KINDS.join(", ")}.`,
      "UNSUPPORTED",
    );
  const name = text(value.name, `The name of ${where}`, 40);
  if (!NAME.test(name))
    throw new PluginError(`${JSON.stringify(name)} is not a usable editor name (a-z, 0-9 and _).`);
  const what = `The editor ${name}`;
  const action = (key: "preview" | "fit"): PluginAction => {
    const named = text(value[key], `The ${key} action of ${what}`, 40);
    const found = actions.find((item) => item.name === named);
    if (!found)
      throw new PluginError(`${what} uses the action ${named}, which the plugin does not have.`);
    return found;
  };
  const preview = action("preview");
  const fit = action("fit");
  /** A parameter both actions take, of one of these types. */
  const param = (key: string, types: readonly ParamSpec["type"][], role: string): string => {
    const named = text(value[key] ?? key, `The ${role} of ${what}`, 40);
    for (const used of [preview, fit]) {
      const spec = used.params[named];
      if (!spec || !types.includes(spec.type)) {
        throw new PluginError(
          `${what}: the action ${used.name} has no ${types.join(" or ")} argument ${named} for the ${role}.`,
        );
      }
    }
    return named;
  };
  const data = param("data", ["wave"], "data");
  const x = value.x === undefined ? null : param("x", ["wave"], "X values");
  const range = value.range === undefined ? null : param("range", ["numbers"], "range");

  if (!isRecord(value.items)) throw new PluginError(`${what} must describe its items.`);
  const rawItems = value.items;
  onlyKeys(rawItems, ["param", "title", "max", "fields", "drag", "coef"], `The items of ${what}`);
  const itemsParam = (() => {
    const named = text(rawItems.param, `The items' argument of ${what}`, 40);
    for (const used of [preview, fit]) {
      if (used.params[named]?.type !== "json") {
        throw new PluginError(
          `${what}: the action ${used.name} has no json argument ${named} for the items.`,
        );
      }
    }
    return named;
  })();
  if (
    !Array.isArray(rawItems.fields) ||
    rawItems.fields.length === 0 ||
    rawItems.fields.length > EDITOR_LIMITS.fields
  )
    throw new PluginError(`${what} must list 1 to ${EDITOR_LIMITS.fields} fields of its items.`);
  const fields = rawItems.fields.map((item, at) => field(item, `field ${at + 1} of ${what}`));
  if (new Set(fields.map((item) => item.key)).size !== fields.length)
    throw new PluginError(`${what} has two fields with the same key.`);
  const numberField = (named: unknown, what_: string): string => {
    const key = text(named, what_, 40);
    if (fields.find((item) => item.key === key)?.kind !== "number")
      throw new PluginError(
        `${what}: ${what_.toLowerCase()} ${key} is not one of its number fields.`,
      );
    return key;
  };
  if (!isRecord(rawItems.drag))
    throw new PluginError(`${what} must say what dragging an item does (items.drag).`);
  const rawDrag = rawItems.drag;
  onlyKeys(rawDrag, ["x", "height", "width"], `The drag of ${what}`);
  const ruleOf = <T extends string>(raw: unknown, rules: readonly T[], where: string): T => {
    if (typeof raw !== "string" || !(rules as readonly string[]).includes(raw))
      throw new PluginError(`${where} is one of ${rules.join(", ")}.`);
    return raw as T;
  };
  let height: EditorDrag["height"] = null;
  if (rawDrag.height !== undefined) {
    if (!isRecord(rawDrag.height))
      throw new PluginError(`The drag height of ${what} is not described.`);
    onlyKeys(rawDrag.height, ["field", "rule"], `The drag height of ${what}`);
    height = {
      field: numberField(rawDrag.height.field, "The height field"),
      rule: ruleOf(
        rawDrag.height.rule ?? "proportional",
        ["proportional", "value"],
        `The height rule of ${what}`,
      ),
    };
  }
  let width: EditorDrag["width"] = null;
  if (rawDrag.width !== undefined) {
    if (!isRecord(rawDrag.width))
      throw new PluginError(`The drag width of ${what} is not described.`);
    onlyKeys(rawDrag.width, ["field", "rule", "scale"], `The drag width of ${what}`);
    const scale = rawDrag.width.scale ?? [];
    if (!Array.isArray(scale) || scale.length > EDITOR_LIMITS.fields)
      throw new PluginError(`The fields the width of ${what} scales are a list.`);
    width = {
      field: numberField(rawDrag.width.field, "The width field"),
      rule: ruleOf(rawDrag.width.rule ?? "full", ["full", "half"], `The width rule of ${what}`),
      scale: scale.map((item) => numberField(item, "A field the width scales")),
    };
  }
  const drag: EditorDrag = { x: numberField(rawDrag.x, "The x field"), height, width };
  const max = rawItems.max ?? EDITOR_LIMITS.items;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > EDITOR_LIMITS.items)
    throw new PluginError(`${what}: max is a whole number from 1 to ${EDITOR_LIMITS.items}.`);
  const coef = rawItems.coef === undefined ? null : text(rawItems.coef, `The coef of ${what}`, 60);
  if (coef !== null && !coef.includes("{key}"))
    throw new PluginError(`${what}: coef names each field, so it must hold {key}.`);

  let partner: EditorPartner | null = null;
  if (value.partner !== undefined) {
    const raw = value.partner;
    if (!isRecord(raw)) throw new PluginError(`The partner of ${what} is not described.`);
    onlyKeys(raw, ["title", "offset", "ratios", "ties"], `The partner of ${what}`);
    const ratios = raw.ratios;
    if (
      !Array.isArray(ratios) ||
      ratios.length === 0 ||
      ratios.length > 20 ||
      !ratios.every(
        (item) =>
          Array.isArray(item) &&
          item.length === 2 &&
          typeof item[0] === "string" &&
          typeof item[1] === "number" &&
          Number.isFinite(item[1]),
      )
    )
      throw new PluginError(`The ratios of ${what}'s partner are a list of [title, number].`);
    if (!isRecord(raw.ties))
      throw new PluginError(`The ties of ${what}'s partner are not described.`);
    const ties: Record<string, string> = {};
    for (const [key, tie] of Object.entries(raw.ties)) {
      const known = fields.find((item) => item.key === key);
      if (!known?.constraint)
        throw new PluginError(
          `${what}'s partner ties ${key}, which is not a field with a constraint.`,
        );
      ties[key] = text(tie, `The tie of ${key} in ${what}'s partner`, 60);
    }
    partner = {
      title: text(raw.title, `The title of ${what}'s partner`, 40),
      offset: text(raw.offset, `The offset of ${what}'s partner`, 40, "Offset"),
      ratios: ratios as [string, number][],
      ties,
    };
  }

  const taken = new Set([data, x, range, itemsParam].filter((item) => item !== null));
  const settingsRaw = value.settings ?? [];
  if (!Array.isArray(settingsRaw) || settingsRaw.length > 32)
    throw new PluginError(`The settings of ${what} are a list of arguments.`);
  const settings = settingsRaw.map((item) => {
    const named = text(item, `A setting of ${what}`, 40);
    if (taken.has(named)) throw new PluginError(`${what} lists ${named} twice.`);
    taken.add(named);
    for (const used of [preview, fit]) {
      const spec = used.params[named];
      if (!spec || spec.type === "wave" || spec.type === "waves" || spec.type === "json")
        throw new PluginError(
          `${what}: the setting ${named} is not a plain argument of ${used.name}.`,
        );
    }
    return named;
  });

  const axis = value.axis ?? {};
  if (!isRecord(axis)) throw new PluginError(`The axis of ${what} is not described.`);
  onlyKeys(axis, ["label", "reverse"], `The axis of ${what}`);
  if (axis.reverse !== undefined && typeof axis.reverse !== "boolean")
    throw new PluginError(`The axis of ${what}: reverse is true or false.`);

  return {
    kind: "spectrum-fit",
    name,
    title: text(value.title, `The title of ${what}`, 80),
    description: text(value.description, `The description of ${what}`, 2000, ""),
    preview: preview.name,
    fit: fit.name,
    data,
    x,
    range,
    items: {
      param: itemsParam,
      title: text(rawItems.title, `The items' title of ${what}`, 40, "Item"),
      max,
      fields,
      drag,
      coef,
    },
    partner,
    settings,
    axis: {
      label: text(axis.label, `The axis label of ${what}`, 80, "X"),
      reverse: axis.reverse === true,
    },
  };
}

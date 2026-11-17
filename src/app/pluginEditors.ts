import type { ActionArgs, JsonValue, ParamSpec } from "../core/actions";
import type { AnalysisResult } from "../core/doc/results";
import type { DocState } from "../core/doc/types";
import type {
  EditorSpec as AnyEditorSpec,
  SpectrumFitSpec as EditorSpec,
} from "../core/plugins/editor";
import { pluginActionId, type PluginAction } from "../core/plugins/manifest";
import type { CheckedResult } from "../core/sandbox/validate";
import type { PluginRunOutcome } from "./plugins/host";
import type { InstalledPlugin } from "./plugins/store";
import { doc, invokeAction, pluginStore, plugins } from "./session";
import { createStore, type Store } from "./store";
import { openTool, type EditorTool } from "./toolWindows";

/**
 * The state of the model editors that plugins describe (see
 * src/core/plugins/editor.ts): for each, the data being modelled, the items
 * of the model with their constraints, the settings, what the plugin's
 * preview last drew, and what its last fit said. Like the other tool windows
 * an editor is not part of the experiment; each fit is, as a run of the
 * plugin's action in the history and among the results, which the editor
 * reads back when it opens on the same data again.
 */

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface EditorItem {
  /** By field key: text or a number. */
  values: Record<string, string | number>;
  /** By field key, for the fields with a constraint: the constraint's text ("" for free). */
  constraints: Record<string, string>;
}

export interface EditorSetup {
  data: string;
  x: string | null;
  range: [number, number] | null;
  /** The settings that differ from their defaults are passed; all are kept here. */
  settings: Record<string, JsonValue>;
  items: EditorItem[];
}

export interface EditorReport {
  result: string | null;
  columns: string[];
  rows: string[][];
  lines: string[];
  warnings: string[];
}

export interface PreviewItem {
  /** The number fields as the constraints leave them. */
  values: Record<string, number>;
  /** The fields tied to another item, which follow it rather than being dragged. */
  tied: string[];
  /** Where its top is: [x, the top, the background under it]. */
  peak: [number, number, number] | null;
}

export interface EditorPreview {
  x: Float64Array;
  data: Float64Array | null;
  background: Float64Array | null;
  fit: Float64Array | null;
  residual: Float64Array | null;
  items: (Float64Array | null)[];
  allX: Float64Array | null;
  allY: Float64Array | null;
  itemValues: PreviewItem[];
  errors: { item: number | null; field: string | null; message: string }[];
  problem: string | null;
}

export interface EditorState {
  setup: EditorSetup | null;
  selected: number;
  report: EditorReport | null;
  busy: boolean;
  error: string | null;
  past: EditorSetup[];
  future: EditorSetup[];
  kept: Record<string, { setup: EditorSetup; report: EditorReport | null }>;
  preview: EditorPreview | null;
  /** Why the preview failed, if it did. */
  previewError: string | null;
  /** An item just made, to be given this height once the preview says how tall it is. */
  sizing: { index: number; height: number } | null;
}

const LIMIT = 100;

export const editorKey = (plugin: string, editor: string): string => `${plugin}/${editor}`;
export const editorTool = (plugin: string, editor: string): EditorTool =>
  `editor:${editorKey(plugin, editor)}`;

const stores = new Map<string, Store<EditorState>>();

/** The state of one editor, made when first asked for. */
export function editorStore(key: string): Store<EditorState> {
  let store = stores.get(key);
  if (!store) {
    store = createStore<EditorState>({
      setup: null,
      selected: -1,
      report: null,
      busy: false,
      error: null,
      past: [],
      future: [],
      kept: {},
      preview: null,
      previewError: null,
      sizing: null,
    });
    stores.set(key, store);
  }
  return store;
}

export interface EditorContext {
  key: string;
  plugin: InstalledPlugin;
  spec: EditorSpec;
  preview: PluginAction;
  fit: PluginAction;
}

/** The installed plugin and the editor (of any kind) a key names, or why it cannot be used. */
export function findEditorSpec(
  key: string,
): { plugin: InstalledPlugin; spec: AnyEditorSpec } | string {
  const [pluginName, editorName] = key.split("/");
  const plugin = pluginStore.list().find((item) => item.manifest.name === pluginName);
  if (!plugin) return "The plugin of this editor is not installed.";
  if (!plugin.enabled) return `${plugin.manifest.title} is turned off.`;
  const spec = plugin.manifest.editors.find((item) => item.name === editorName);
  if (!spec) return `${plugin.manifest.title} has no editor ${editorName}.`;
  return { plugin, spec };
}

/** The spectrum-fit editor a key names, with its actions, or why it cannot be used. */
export function findEditor(key: string): EditorContext | string {
  const found = findEditorSpec(key);
  if (typeof found === "string") return found;
  const { plugin, spec } = found;
  if (spec.kind !== "spectrum-fit") return `${spec.title} is not a spectrum-fit editor.`;
  const action = (name: string) => plugin.manifest.actions.find((item) => item.name === name)!;
  return { key, plugin, spec, preview: action(spec.preview), fit: action(spec.fit) };
}

/** A setting's value when none is given. */
export function settingDefault(spec: ParamSpec): JsonValue {
  if (spec.default !== undefined) return spec.default as JsonValue;
  if (spec.type === "choice") return spec.choices?.[0] ?? null;
  if (spec.type === "boolean") return false;
  return null;
}

function plainSetup(context: EditorContext, data: string): EditorSetup {
  return {
    data,
    x: null,
    range: null,
    settings: Object.fromEntries(
      context.spec.settings.map((name) => [name, settingDefault(context.fit.params[name]!)]),
    ),
    items: [],
  };
}

/** A new item with the fields' defaults. */
export function blankItem(spec: EditorSpec): EditorItem {
  return {
    values: Object.fromEntries(spec.items.fields.map((field) => [field.key, field.default])),
    constraints: Object.fromEntries(
      spec.items.fields.filter((field) => field.constraint).map((field) => [field.key, ""]),
    ),
  };
}

/** The last result the editor's fit kept for this data, if there is one. */
export function latestResult(
  state: DocState,
  context: EditorContext,
  data: string,
): AnalysisResult | null {
  const id = pluginActionId(context.plugin.manifest.name, context.spec.fit);
  let latest: AnalysisResult | null = null;
  for (const result of Object.values(state.results)) {
    const settings = result.settings as { inputs?: Record<string, unknown> };
    if (result.kind !== "plugin" || result.source?.action !== id) continue;
    if (settings.inputs?.[context.spec.data] !== data) continue;
    if (!latest || result.created >= latest.created) latest = result;
  }
  return latest;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a kept result was fitted with, its fitted values as the items' values. */
export function fromResult(
  context: EditorContext,
  result: AnalysisResult,
): { setup: EditorSetup; report: EditorReport | null } {
  const { spec } = context;
  const settings = result.settings as {
    inputs?: Record<string, unknown>;
    params?: Record<string, JsonValue>;
  };
  const args: Record<string, unknown> = { ...settings.params, ...settings.inputs };
  const setup = plainSetup(context, String(args[spec.data]));
  if (spec.x && typeof args[spec.x] === "string") setup.x = args[spec.x] as string;
  const range = spec.range ? args[spec.range] : null;
  if (Array.isArray(range) && range.length === 2 && range.every((item) => typeof item === "number"))
    setup.range = [range[0] as number, range[1] as number];
  for (const name of spec.settings)
    if (args[name] !== undefined) setup.settings[name] = args[name] as JsonValue;
  const given = args[spec.items.param];
  if (Array.isArray(given)) {
    setup.items = given
      .flatMap((entry: unknown) => (isObject(entry) ? [entry] : []))
      .map((raw, index) => {
        const item = blankItem(spec);
        for (const field of spec.items.fields) {
          const value = raw[field.key];
          if (typeof value === (field.kind === "number" ? "number" : "string"))
            item.values[field.key] = value as string | number;
          const fitted = spec.items.coef
            ? result.names.indexOf(
                spec.items.coef.replace("{letter}", LETTERS[index]!).replace("{key}", field.key),
              )
            : -1;
          const coef = fitted >= 0 ? result.coef[fitted] : null;
          if (field.kind === "number" && typeof coef === "number") item.values[field.key] = coef;
          const constraints = isObject(raw.constraints) ? raw.constraints : {};
          if (field.constraint && typeof constraints[field.key] === "string")
            item.constraints[field.key] = constraints[field.key] as string;
        }
        return item;
      });
  }
  return { setup, report: null };
}

/** Starts work on data: where it was left this session, else its last fit, else afresh. */
export function chooseData(context: EditorContext, data: string): void {
  const store = editorStore(context.key);
  const now = store.get();
  if (now.setup?.data === data) return;
  const kept = { ...now.kept };
  if (now.setup) kept[now.setup.data] = { setup: now.setup, report: now.report };
  const earlier = kept[data];
  const result = earlier ? null : latestResult(doc.getState(), context, data);
  const restored =
    earlier ??
    (result ? fromResult(context, result) : { setup: plainSetup(context, data), report: null });
  store.set({
    setup: restored.setup,
    report: restored.report,
    selected: restored.setup.items.length > 0 ? 0 : -1,
    error: null,
    past: [],
    future: [],
    kept,
    preview: null,
    previewError: null,
    sizing: null,
  });
}

/** Opens an editor's window, on the data given if any (else where it was, else the first 1-D wave). */
export function openEditor(plugin: string, editor: string, data?: string): void {
  openTool(editorTool(plugin, editor));
  const context = findEditor(editorKey(plugin, editor));
  if (typeof context === "string") return;
  const state = doc.getState();
  const name =
    data ??
    editorStore(context.key).get().setup?.data ??
    state.waveOrder.find((item) => {
      const wave = state.waves[item]!;
      return !wave.text && wave.shape.length === 1;
    });
  if (name) chooseData(context, name);
}

/** A change that can be undone. */
export function editSetup(key: string, change: (setup: EditorSetup) => EditorSetup): void {
  const store = editorStore(key);
  const { setup, past } = store.get();
  if (!setup) return;
  const next = change(setup);
  if (next === setup) return;
  store.set({ setup: next, past: [...past, setup].slice(-LIMIT), future: [], error: null });
}

/** The first step of a drag, undoable as one however many live changes follow. */
export function beginDrag(key: string): void {
  const store = editorStore(key);
  const { setup, past } = store.get();
  if (setup) store.set({ past: [...past, setup].slice(-LIMIT), future: [] });
}

/** A change while dragging (or one that belongs to the edit before it): not a step of its own. */
export function dragSetup(key: string, change: (setup: EditorSetup) => EditorSetup): void {
  const store = editorStore(key);
  const { setup } = store.get();
  if (setup) store.set({ setup: change(setup) });
}

export function undo(key: string): void {
  const store = editorStore(key);
  const { setup, past, future } = store.get();
  if (!setup || past.length === 0) return;
  store.set({
    setup: past.at(-1)!,
    past: past.slice(0, -1),
    future: [setup, ...future],
    sizing: null,
  });
  clampSelection(store);
}

export function redo(key: string): void {
  const store = editorStore(key);
  const { setup, past, future } = store.get();
  if (!setup || future.length === 0) return;
  store.set({ setup: future[0]!, past: [...past, setup], future: future.slice(1), sizing: null });
  clampSelection(store);
}

function clampSelection(store: Store<EditorState>): void {
  const { setup, selected } = store.get();
  const count = setup?.items.length ?? 0;
  if (selected >= count) store.set({ selected: count - 1 });
}

/** Changes the values or constraints of an item. */
export function editItem(
  key: string,
  index: number,
  change: { values?: Record<string, string | number>; constraints?: Record<string, string> },
): void {
  editSetup(key, (setup) => ({
    ...setup,
    items: setup.items.map((item, at) =>
      at === index
        ? {
            values: { ...item.values, ...change.values },
            constraints: { ...item.constraints, ...change.constraints },
          }
        : item,
    ),
  }));
}

/** A capital letter standing alone: an item, in the text of a constraint. */
const REFERENCE = /(?<![A-Za-z])([A-Z])(?![A-Za-z])/g;

/**
 * The items after one is taken out: a constraint that named it is let go (the
 * value it gave kept), and the letters of those after it move up by one.
 */
export function removeItem(
  items: readonly EditorItem[],
  index: number,
  resolved: readonly (PreviewItem | undefined)[],
): EditorItem[] {
  const removed = LETTERS[index]!;
  return items
    .map((item, at) => {
      const values = { ...item.values };
      const constraints: Record<string, string> = {};
      for (const [field, text] of Object.entries(item.constraints)) {
        if ([...text.matchAll(REFERENCE)].some((match) => match[1] === removed)) {
          constraints[field] = "";
          const value = resolved[at]?.values[field];
          if (value !== undefined && Number.isFinite(value)) values[field] = value;
        } else {
          constraints[field] = text.replace(REFERENCE, (letter) =>
            LETTERS.indexOf(letter) > index ? LETTERS[LETTERS.indexOf(letter) - 1]! : letter,
          );
        }
      }
      return { values, constraints };
    })
    .filter((_, at) => at !== index);
}

/** The fields dragging changes: always passed to the plugin, whatever their value. */
export function draggedFields(spec: EditorSpec): string[] {
  const { drag } = spec.items;
  return [drag.x, drag.height?.field, drag.width?.field, ...(drag.width?.scale ?? [])].filter(
    (field): field is string => field !== undefined,
  );
}

/**
 * The fields of an item after a drag, by the plugin's rules (see EditorDrag):
 * of its top to (x, height above its base), or of a half-width handle to x.
 * `start` is the item's values when the drag began, and `tied` the fields that
 * follow another item, which dragging leaves alone.
 */
export function dragged(
  spec: EditorSpec,
  start: Record<string, string | number>,
  tied: readonly string[],
  drop:
    | { kind: "top"; x: number; height: number; startHeight: number }
    | { kind: "width"; x: number; centre: number; startWidth: number },
): Record<string, number> {
  const { drag } = spec.items;
  const change: Record<string, number> = {};
  const free = (field: string) => !tied.includes(field) && typeof start[field] === "number";
  if (drop.kind === "top") {
    if (!tied.includes(drag.x)) change[drag.x] = drop.x;
    const rule = drag.height;
    if (rule && free(rule.field)) {
      if (rule.rule === "value") change[rule.field] = drop.height;
      else if (drop.startHeight > 0)
        change[rule.field] = ((start[rule.field] as number) * drop.height) / drop.startHeight;
    }
    return change;
  }
  const rule = drag.width;
  if (!rule || !free(rule.field)) return change;
  const least = spec.items.fields.find((field) => field.key === rule.field)?.min ?? 0;
  const distance = Math.abs(drop.x - drop.centre);
  const width = Math.max(least, 1e-12, rule.rule === "full" ? 2 * distance : distance);
  change[rule.field] = width;
  if (drop.startWidth > 0)
    for (const field of rule.scale)
      if (free(field)) change[field] = ((start[field] as number) * width) / drop.startWidth;
  return change;
}

/** Ten significant digits: enough to start a fit where it was, short enough to read in the history. */
const round = (value: number): number =>
  Number.isFinite(value) ? Number(value.toPrecision(10)) : value;

/** The arguments of the editor's actions for a setup; settings as by default are left out. */
export function editorArgs(context: EditorContext, setup: EditorSetup): ActionArgs {
  const { spec, fit } = context;
  const args: ActionArgs = { [spec.data]: setup.data };
  if (spec.x && setup.x) args[spec.x] = setup.x;
  if (spec.range && setup.range) args[spec.range] = [...setup.range].sort((a, b) => a - b);
  args[spec.items.param] = setup.items.map((item) => {
    const out: Record<string, JsonValue> = {};
    // The fields dragged on the plot always go; the others only when they differ from their defaults.
    const placed = draggedFields(spec);
    for (const field of spec.items.fields) {
      const value = item.values[field.key];
      if (!placed.includes(field.key) && value === field.default) continue;
      if (field.kind === "number") {
        if (typeof value === "number" && Number.isFinite(value)) out[field.key] = round(value);
      } else if (typeof value === "string" && value !== "") out[field.key] = value;
    }
    const constraints = Object.fromEntries(
      Object.entries(item.constraints)
        .map(([field, text]) => [field, text.trim()] as const)
        .filter(([, text]) => text !== ""),
    );
    if (Object.keys(constraints).length > 0) out.constraints = constraints;
    return out;
  });
  for (const name of spec.settings) {
    const value = setup.settings[name];
    if (
      value !== null &&
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(settingDefault(fit.params[name]!))
    )
      args[name] = value;
  }
  return args;
}

const array = (waves: Map<string, CheckedResult["waves"][number][1]>, role: string) => {
  const wave = waves.get(role);
  return wave && !wave.text ? Float64Array.from(wave.data as ArrayLike<number>) : null;
};

/** What the plugin's preview returned, as the window draws it. */
export function readPreview(outcome: CheckedResult, count: number): EditorPreview {
  const waves = new Map(outcome.waves);
  const values = isObject(outcome.values) ? outcome.values : {};
  const items = Array.isArray(values.items) ? values.items : [];
  const errors = Array.isArray(values.errors) ? values.errors : [];
  return {
    x: array(waves, "x") ?? new Float64Array(0),
    data: array(waves, "data"),
    background: array(waves, "background"),
    fit: array(waves, "fit"),
    residual: array(waves, "residual"),
    items: Array.from({ length: count }, (_, index) => array(waves, `item${index}`)),
    allX: array(waves, "all_x"),
    allY: array(waves, "all_y"),
    itemValues: items.map((raw): PreviewItem => {
      const item = isObject(raw) ? raw : {};
      const numbers = isObject(item.values) ? item.values : {};
      const peak = Array.isArray(item.peak) ? item.peak : null;
      return {
        values: Object.fromEntries(
          Object.entries(numbers).filter(([, value]) => typeof value === "number"),
        ) as Record<string, number>,
        tied: Array.isArray(item.tied)
          ? item.tied.filter((field) => typeof field === "string")
          : [],
        peak:
          peak && peak.length === 3 && peak.every((value) => typeof value === "number")
            ? (peak as [number, number, number])
            : null,
      };
    }),
    errors: errors.flatMap((raw: unknown) =>
      isObject(raw)
        ? [
            {
              item: typeof raw.item === "number" ? raw.item : null,
              field: typeof raw.field === "string" ? raw.field : null,
              message: typeof raw.message === "string" ? raw.message : "",
            },
          ]
        : [],
    ),
    problem: typeof values.problem === "string" ? values.problem : null,
  };
}

const running = new Map<string, { again: boolean }>();

/**
 * Asks the plugin to draw the setup as it is now. Only the latest matters:
 * while one preview runs, more requests make one more run when it ends.
 */
export function requestPreview(key: string): void {
  const busy = running.get(key);
  if (busy) {
    busy.again = true;
    return;
  }
  const state = { again: false };
  running.set(key, state);
  void (async () => {
    try {
      do {
        state.again = false;
        const context = findEditor(key);
        const store = editorStore(key);
        const setup = store.get().setup;
        if (typeof context === "string" || !setup) break;
        try {
          const outcome = await plugins.preview(
            pluginActionId(context.plugin.manifest.name, context.spec.preview),
            editorArgs(context, setup),
          );
          if (store.get().setup?.data !== setup.data) continue;
          const preview = readPreview(outcome, setup.items.length);
          store.set({ preview, previewError: null });
          if (sizeNewItem(context, store, preview, setup)) state.again = true;
        } catch (error) {
          store.set({ previewError: error instanceof Error ? error.message : String(error) });
        }
      } while (state.again);
    } finally {
      running.delete(key);
    }
  })();
}

/** Gives an item just made the height asked for, now that the preview says how tall it came out. */
function sizeNewItem(
  context: EditorContext,
  store: Store<EditorState>,
  preview: EditorPreview,
  drawn: EditorSetup,
): boolean {
  const { sizing, setup } = store.get();
  const rule = context.spec.items.drag.height;
  if (!sizing || rule?.rule !== "proportional" || setup !== drawn) return false;
  const amount = rule.field;
  store.set({ sizing: null });
  const peak = preview.itemValues[sizing.index]?.peak;
  const item = setup.items[sizing.index];
  if (!peak || !item || !(peak[1] - peak[2] > 0)) return false;
  const value = item.values[amount];
  if (typeof value !== "number") return false;
  const scaled = (value * sizing.height) / (peak[1] - peak[2]);
  dragSetup(context.key, (current) => ({
    ...current,
    items: current.items.map((each, at) =>
      at === sizing.index ? { ...each, values: { ...each.values, [amount]: scaled } } : each,
    ),
  }));
  return true;
}

/** Interpolates (x, y) at `at`, x in either order. */
export function interpolate(x: ArrayLike<number>, y: ArrayLike<number>, at: number): number {
  const n = x.length;
  if (n === 0) return NaN;
  const rising = x[n - 1]! >= x[0]!;
  const before = (value: number) => (rising ? value <= at : value >= at);
  if (!before(x[0]!)) return y[0]!;
  if (before(x[n - 1]!)) return y[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (before(x[mid]!)) lo = mid;
    else hi = mid;
  }
  const span = x[hi]! - x[lo]!;
  return span === 0 ? y[lo]! : y[lo]! + ((y[hi]! - y[lo]!) * (at - x[lo]!)) / span;
}

/** Adds an item at X, to be as tall as the data stands there above the background and the others. */
export function addItemAt(context: EditorContext, position: number): void {
  const store = editorStore(context.key);
  const { setup, preview } = store.get();
  const { spec } = context;
  if (!setup || !preview || setup.items.length >= spec.items.max) return;
  const item = blankItem(spec);
  const { drag } = spec.items;
  const last = setup.items.at(-1);
  // A new item looks like the one made before it: its widths and the like, and its kind (a
  // text field with choices, such as a line shape); not its name, place or size.
  if (last) {
    for (const field of spec.items.fields) {
      const like =
        field.kind === "number"
          ? field.key !== drag.x && field.key !== drag.height?.field
          : field.choices.length > 0;
      const value = last.values[field.key];
      if (like && value !== undefined) item.values[field.key] = value;
    }
  }
  item.values[drag.x] = position;
  let height = 0;
  if (preview.data) {
    let others = preview.background ? interpolate(preview.x, preview.background, position) : 0;
    for (const part of preview.items) if (part) others += interpolate(preview.x, part, position);
    let peak = 0;
    for (let i = 0; i < preview.data.length; i += 1)
      peak = Math.max(peak, Math.abs(preview.data[i]! - (preview.background?.[i] ?? 0)));
    height = Math.max(interpolate(preview.x, preview.data, position) - others, 0.05 * peak);
  }
  // A height field is the height itself, or grows with it: then the preview says by how much,
  // and the item is sized once it has drawn it (see sizeNewItem).
  const width = drag.width ? item.values[drag.width.field] : 1;
  if (drag.height?.rule === "value") item.values[drag.height.field] = height;
  else if (drag.height)
    item.values[drag.height.field] = height * (typeof width === "number" ? width : 1);
  const index = setup.items.length;
  editSetup(context.key, (current) => ({ ...current, items: [...current.items, item] }));
  store.set({
    selected: index,
    sizing: drag.height?.rule === "proportional" && height > 0 ? { index, height } : null,
  });
}

/**
 * Fits the model as it stands with the plugin's fit, as a run that replaces
 * what its last fit of the same data made (see planOutcome), and takes the
 * values it found back into the items. The fit can be undone in the window
 * like an edit; the experiment keeps it as a result.
 */
export async function runFit(context: EditorContext): Promise<void> {
  const store = editorStore(context.key);
  const { setup, busy } = store.get();
  if (!setup || busy) return;
  if (setup.items.length === 0) {
    store.set({
      error: `Add a ${context.spec.items.title.toLowerCase()} first: Create, or double-click the plot.`,
    });
    return;
  }
  store.set({ busy: true, error: null });
  try {
    const outcome = (await invokeAction(
      pluginActionId(context.plugin.manifest.name, context.spec.fit),
      editorArgs(context, setup),
      undefined,
      { replace: true },
    )) as PluginRunOutcome;
    const values = isObject(outcome.values) ? outcome.values : {};
    const found = Array.isArray(values.items) ? values.items : [];
    const now = store.get().setup;
    const base = now && now.data === setup.data ? now : setup;
    const numbers = new Set(
      context.spec.items.fields
        .filter((field) => field.kind === "number")
        .map((field) => field.key),
    );
    const items = base.items.map((item, index) => {
      const row = found[index];
      if (!isObject(row) || index >= setup.items.length) return item;
      const fitted = Object.fromEntries(
        Object.entries(row).filter(([key, value]) => numbers.has(key) && typeof value === "number"),
      ) as Record<string, number>;
      return { ...item, values: { ...item.values, ...fitted } };
    });
    const report = isObject(values.report) ? values.report : null;
    const texts = (value: unknown) =>
      Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    store.set({
      setup: { ...base, items },
      past: [...store.get().past, base].slice(-LIMIT),
      future: [],
      busy: false,
      report: report
        ? {
            result: outcome.result,
            columns: texts(report.columns),
            rows: Array.isArray(report.rows) ? report.rows.map(texts) : [],
            lines: texts(report.lines),
            warnings: texts(report.warnings),
          }
        : { result: outcome.result, columns: [], rows: [], lines: [], warnings: [] },
    });
  } catch (error) {
    store.set({ busy: false, error: error instanceof Error ? error.message : String(error) });
  }
}

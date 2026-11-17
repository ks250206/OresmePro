import type { ActionArgs, JsonValue } from "../core/actions";
import { pluginActionId } from "../core/plugins/manifest";
import {
  checkView,
  getPath,
  readViewJson,
  setPath,
  viewNodes,
  type ViewDefinition,
  type ViewNode,
} from "../core/plugins/view";
import type { CheckedResult } from "../core/sandbox/validate";
import type { PluginRunOutcome } from "./plugins/host";
import { doc, invokeAction, plugins } from "./session";
import { createStore, type Store } from "./store";

/**
 * The state of the windows of plugin views (docs/design/plugin-views.md).
 * The app keeps each view's state and what it last drew; every change goes
 * to the view's Python as an event, one at a time, and what it returns
 * replaces the state, with the edits made meanwhile put back on top. Only
 * the buttons that run an action change the experiment, as runs of it.
 */

export interface ViewWindowState {
  state: unknown;
  ui: ViewDefinition | null;
  /** The arrays the view returned, by role, for its plots. */
  arrays: Record<string, Float64Array>;
  message: string | null;
  /** Why the last event or action failed. */
  error: string | null;
  /** Whether the view's Python, or an action, is working. */
  busy: boolean;
  past: unknown[];
  future: unknown[];
}

type Pending = { type: "change"; paths: Set<string> } | { type: "command"; id: string } | DoneEvent;

interface DoneEvent {
  type: "done";
  id: string;
  /** The arguments the action ran with: a view checks them against what it shows now. */
  args: ActionArgs;
  ok: boolean;
  values: JsonValue;
  result: string | null;
  error: string | null;
}

interface Runner {
  queue: Pending[];
  running: boolean;
  /**
   * What was done to the state while an event was out, in order, to do again
   * over the state it returns: a value set at a path, or the whole state put
   * back (an undo or a redo).
   */
  edits: ({ path: string; value: unknown } | { whole: unknown })[];
}

const LIMIT = 100;
const stores = new Map<string, Store<ViewWindowState>>();
const runners = new Map<string, Runner>();

export function viewStore(key: string): Store<ViewWindowState> {
  let store = stores.get(key);
  if (!store) {
    store = createStore<ViewWindowState>({
      state: null,
      ui: null,
      arrays: {},
      message: null,
      error: null,
      busy: false,
      past: [],
      future: [],
    });
    stores.set(key, store);
  }
  return store;
}

function runnerOf(key: string): Runner {
  let runner = runners.get(key);
  if (!runner) {
    runner = { queue: [], running: false, edits: [] };
    runners.set(key, runner);
  }
  return runner;
}

const split = (key: string) => key.split("/") as [string, string];

/** The waves the view's wave parts have chosen, by the paths they are bound to. */
export function chosenWaves(ui: ViewDefinition | null, state: unknown): Record<string, string> {
  const chosen: Record<string, string> = {};
  if (!ui) return chosen;
  for (const node of viewNodes(ui.body)) {
    if (node.type !== "wave") continue;
    const name = getPath(state, node.bind);
    if (typeof name === "string" && name) chosen[node.bind] = name;
  }
  return chosen;
}

/** The last result this plugin kept, for a view opened again to start from. */
function lastResult(plugin: string): JsonValue {
  let latest = null;
  for (const result of Object.values(doc.getState().results)) {
    if (result.kind !== "plugin" || result.source?.plugin !== plugin) continue;
    if (!latest || result.created >= latest.created) latest = result;
  }
  if (!latest) return null;
  const settings = latest.settings as { inputs?: JsonValue; params?: JsonValue };
  return {
    result: latest.name,
    action: latest.source!.action.split(".").at(-1)!,
    inputs: settings.inputs ?? {},
    params: settings.params ?? {},
    names: latest.names,
    coef: latest.coef,
    sigma: latest.sigma,
  };
}

/** Opens a view: asks its Python for its window the first time. */
export function openView(key: string): void {
  const store = viewStore(key);
  if (store.get().ui || runnerOf(key).running) return;
  void send(key, { type: "open", last: lastResult(split(key)[0]) });
}

function enqueue(key: string, event: Pending, start = true): void {
  const runner = runnerOf(key);
  const last = runner.queue.at(-1);
  if (event.type === "change" && last?.type === "change") {
    for (const path of event.paths) last.paths.add(path);
  } else runner.queue.push(event);
  if (start) void drain(key);
}

async function drain(key: string): Promise<void> {
  const runner = runnerOf(key);
  if (runner.running) return;
  while (runner.queue.length > 0) {
    const next = runner.queue.shift()!;
    const event =
      next.type === "change"
        ? { type: "change", paths: [...next.paths] }
        : (next as unknown as JsonValue);
    await send(key, event);
  }
}

/** Sends one event and takes in what the view returns. */
async function send(key: string, event: unknown): Promise<void> {
  const runner = runnerOf(key);
  const store = viewStore(key);
  const [plugin, view] = split(key);
  runner.running = true;
  runner.edits = [];
  store.set({ busy: true });
  try {
    const { state, ui } = store.get();
    const sent = chosenWaves(ui, state);
    const outcome = await plugins.runView(plugin, view, { state, event, waves: sent });
    takeIn(store, runner, outcome);
    // Waves the view chose itself (a view opened again, restoring its choices) were not sent
    // with this event: it is told of them, and given them, with the next.
    const now = store.get();
    const chosen = chosenWaves(now.ui, now.state);
    const unsent = Object.keys(chosen).filter((path) => sent[path] !== chosen[path]);
    if (unsent.length > 0) enqueue(key, { type: "change", paths: new Set(unsent) }, false);
  } catch (error) {
    store.set({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    runner.running = false;
    store.set({ busy: runner.queue.length > 0 });
  }
  if (runner.queue.length > 0) void drain(key);
}

function takeIn(store: Store<ViewWindowState>, runner: Runner, outcome: CheckedResult): void {
  const values = (outcome.values ?? {}) as { state?: unknown; ui?: unknown; message?: unknown };
  const now = store.get();
  let state =
    values.state === null || values.state === undefined
      ? now.state
      : readViewJson(values.state, "state");
  // What was done while the view worked stays, in order: it goes to the view next.
  for (const edit of runner.edits)
    state = "whole" in edit ? edit.whole : setPath(state, edit.path, edit.value);
  const ui =
    values.ui === null || values.ui === undefined
      ? now.ui
      : checkView(readViewJson(values.ui, "view"));
  // The arrays are what this answer draws: those of the one before go.
  const arrays: Record<string, Float64Array> = {};
  for (const [role, wave] of outcome.waves)
    if (!wave.text) arrays[role] = Float64Array.from(wave.data as ArrayLike<number>);
  store.set({
    state,
    ui,
    arrays,
    // "" takes the message away; none given keeps it.
    message: typeof values.message === "string" ? values.message || null : now.message,
    error: null,
  });
}

/** Puts a value at a path of the state, as a part of the window does: undoable, and told to the view. */
export function setValue(key: string, path: string, value: unknown): void {
  const store = viewStore(key);
  const { state, past } = store.get();
  store.set({
    state: setPath(state, path, value),
    past: [...past, state].slice(-LIMIT),
    future: [],
  });
  const runner = runnerOf(key);
  if (runner.running) runner.edits.push({ path, value });
  enqueue(key, { type: "change", paths: new Set([path]) });
}

/** Changes the list at a path (a table's rows): undoable, and told to the view. */
export function setList(key: string, path: string, rows: unknown[]): void {
  setValue(key, path, rows);
}

export function undoView(key: string): void {
  const store = viewStore(key);
  const { state, past, future } = store.get();
  if (past.length === 0) return;
  store.set({ state: past.at(-1), past: past.slice(0, -1), future: [state, ...future] });
  const runner = runnerOf(key);
  if (runner.running) runner.edits.push({ whole: past.at(-1) });
  enqueue(key, { type: "change", paths: new Set(["*"]) });
}

export function redoView(key: string): void {
  const store = viewStore(key);
  const { state, past, future } = store.get();
  if (future.length === 0) return;
  store.set({ state: future[0], past: [...past, state], future: future.slice(1) });
  const runner = runnerOf(key);
  if (runner.running) runner.edits.push({ whole: future[0] });
  enqueue(key, { type: "change", paths: new Set(["*"]) });
}

/** A button: a command for the view, or a run of one of the plugin's actions, told to the view when it ends. */
export async function press(
  key: string,
  node: Extract<ViewNode, { type: "button" }>,
): Promise<void> {
  if (node.on !== null) {
    enqueue(key, { type: "command", id: node.on });
    return;
  }
  const store = viewStore(key);
  const [plugin] = split(key);
  const { state } = store.get();
  const args: ActionArgs = {};
  for (const [name, value] of Object.entries(node.args)) {
    const given =
      value !== null && typeof value === "object" && !Array.isArray(value) && "$bind" in value
        ? getPath(state, value.$bind as string)
        : value;
    // A value not set (a wave not chosen yet) is left out: the action's default, or its refusal.
    if (given !== undefined && given !== null) args[name] = given as JsonValue;
  }
  store.set({ busy: true, error: null });
  let done: DoneEvent;
  try {
    const outcome = (await invokeAction(pluginActionId(plugin, node.action!), args, undefined, {
      replace: node.replace,
    })) as PluginRunOutcome;
    done = {
      type: "done",
      id: node.action!,
      args,
      ok: true,
      values: outcome.values,
      result: outcome.result,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.set({ error: message });
    done = {
      type: "done",
      id: node.action!,
      args,
      ok: false,
      values: null,
      result: null,
      error: message,
    };
  }
  store.set({ busy: false });
  enqueue(key, done);
}

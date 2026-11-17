import { argProblems, type ActionArgs, type ActionSpec, type JsonValue } from "../../core/actions";
import type { Doc, DocWriter } from "../../core/doc/doc";
import type { ResultSource } from "../../core/doc/results";
import { DocError, type DocState, type Wave } from "../../core/doc/types";
import {
  describeSource,
  PluginError,
  pluginActionId,
  splitPluginActionId,
  type PluginAction,
} from "../../core/plugins/manifest";
import {
  dropStale,
  makePluginGraph,
  planOutcome,
  updatePluginGraphs,
  waveArgs,
} from "../../core/plugins/outcome";
import type { SandboxDtype, SandboxWave } from "../../core/sandbox/protocol";
import { SandboxError, type CheckedResult } from "../../core/sandbox/validate";
import { Sandbox } from "../../sandbox/host";
import type { InstalledPlugin, PluginStore } from "./store";

/**
 * Runs the actions of installed plugins. Each plugin with code gets a
 * sandbox of its own (src/sandbox/host.ts), started when one of its actions
 * is first run and stopped when the plugin is turned off or removed. A run
 * reads the waves it is given from the experiment, hands copies to the
 * sandbox, checks what comes back and puts it in as one change.
 */

export interface PluginRunOutcome {
  /** The names the returned waves were given, by role. */
  waves: Record<string, string>;
  values: JsonValue;
  /** The name of the analysis result kept, if the action kept one. */
  result: string | null;
  /** The name of the graph made, if the action asked for one. */
  graph: string | null;
  /** What the plugin printed. */
  log: string;
}

export interface RunOptions {
  /**
   * Make again, under their names, the waves the last run of this action on
   * the same inputs made, where they are still as it left them, and update
   * its graph (see planOutcome). The app's choice: a model editor fitting
   * again, or op.invoke(..., replace=True).
   */
  replace?: boolean;
  /**
   * Stops the run: its sandbox is stopped, and what it computed, should it
   * be done already, is not kept. The run then fails as stopped.
   */
  signal?: AbortSignal;
}

/** How long a preview may take before the plugin's sandbox is stopped. */
const PREVIEW_TIMEOUT_MS = 30_000;

export interface PluginHostOptions {
  store: PluginStore;
  doc: Doc;
  pyodideURL: string;
  /** How long one run may take before the plugin's sandbox is stopped. */
  timeoutMs?: number;
  /** Starts a sandbox; replaced in tests. */
  createSandbox?: (packages: readonly string[]) => Promise<Sandbox>;
}

/**
 * A wave as the sandbox is given it: copies of its numbers or its text, never
 * the document's own arrays.
 */
export function sandboxWave(wave: Wave): SandboxWave {
  const scaling = {
    x0: wave.x0,
    dx: wave.dx,
    xUnit: wave.xUnit,
    y0: wave.y0,
    dy: wave.dy,
    yUnit: wave.yUnit,
    unit: wave.unit,
    note: wave.note,
  };
  if (wave.text) {
    return {
      name: wave.name,
      dtype: "text",
      shape: [wave.text.length],
      data: new ArrayBuffer(0),
      text: [...wave.text],
      imag: null,
      ...scaling,
    };
  }
  const dtype: SandboxDtype =
    wave.type === "complex128" ? "float64" : wave.type === "complex64" ? "float32" : wave.type;
  const copy = (array: ArrayBufferView) =>
    (array.buffer as ArrayBuffer).slice(array.byteOffset, array.byteOffset + array.byteLength);
  return {
    name: wave.name,
    dtype,
    shape: [...wave.shape],
    data: copy(wave.data),
    imag: wave.imag ? copy(wave.imag) : null,
    ...scaling,
  };
}

export class PluginHost {
  private readonly options: PluginHostOptions;
  private readonly sandboxes = new Map<string, Promise<Sandbox>>();
  /** The package each running sandbox was started from. */
  private readonly sandboxDigest = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private catalogCache: ActionSpec[] | null = null;

  constructor(options: PluginHostOptions) {
    this.options = options;
    options.store.subscribe(() => {
      this.catalogCache = null;
      // A plugin turned off, removed or replaced stops its sandbox now.
      // Deleting from a map while going through it is safe: what is left is still visited.
      for (const name of this.sandboxes.keys()) {
        const plugin = options.store.find(name);
        if (!plugin?.enabled || this.sandboxDigest.get(name) !== plugin.lock.digest)
          this.stop(name);
      }
      for (const listener of this.listeners) listener();
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The actions of the plugins that are on, as the app's own actions are described. */
  catalog(): ActionSpec[] {
    this.catalogCache ??= this.options.store
      .list()
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) =>
        plugin.manifest.actions.map((action): ActionSpec => ({
          id: pluginActionId(plugin.manifest.name, action.name),
          version: 1,
          title: action.title,
          description: action.description || null,
          params: action.params,
        })),
      );
    return this.catalogCache;
  }

  /** The installed plugin and action an id names, whether the plugin is on or not. */
  resolve(id: string): { plugin: InstalledPlugin; action: PluginAction } | null {
    const parts = splitPluginActionId(id);
    if (!parts) return null;
    const plugin = this.options.store.find(parts.plugin);
    const action = plugin?.manifest.actions.find((item) => item.name === parts.action);
    return plugin && action ? { plugin, action } : null;
  }

  /** Checks a call and reads the copies of the waves it is given; nothing runs yet. */
  private prepare(id: string, args: ActionArgs, before: DocState, writer: DocWriter | null) {
    const found = this.resolve(id);
    if (!found) {
      throw new PluginError(`No installed plugin has the action ${id}.`, "NOT_FOUND", {
        kind: "action",
        name: id,
      });
    }
    const { plugin, action } = found;
    if (!plugin.enabled)
      throw new PluginError(`The plugin ${plugin.manifest.title} is turned off.`);
    const spec = this.catalog().find((item) => item.id === id)!;
    const problems = argProblems(spec, args, {
      waveExists: (name) => Object.hasOwn(before.waves, name),
    });
    if (problems.length > 0) {
      const field = problems[0]!.field;
      throw new PluginError(
        problems.map((problem) => problem.message).join(" "),
        "INVALID_ARGUMENT",
        field === null ? {} : { field },
      );
    }

    const named = waveArgs(action, args);
    const inputs: Record<string, SandboxWave | SandboxWave[]> = {};
    const revisions = new Map<string, number>();
    const take = (name: string, param: string): SandboxWave => {
      const key = name.replace(/^root:/, "");
      const wave = before.waves[key]!;
      if (wave.text && !action.params[param]!.text) {
        const title = action.params[param]!.title ?? param;
        throw new PluginError(
          `${key} is a text wave; ${title} takes numeric waves.`,
          "INVALID_ARGUMENT",
          { field: param },
        );
      }
      revisions.set(key, wave.rev);
      (writer as { read?: (name: string) => void } | null)?.read?.(key);
      return sandboxWave(wave);
    };
    for (const [key, value] of Object.entries(named)) {
      inputs[key] = Array.isArray(value) ? value.map((name) => take(name, key)) : take(value, key);
    }
    const params: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(args)) if (!(key in named)) params[key] = value;
    return { plugin, action, inputs, params, revisions };
  }

  /**
   * Runs an action to see what it returns, as a model editor does while its
   * model is edited: the plugin is given copies of the waves as for a run,
   * and what it returns is checked as for a run, but nothing of it goes into
   * the experiment and nothing is recorded.
   */
  async preview(id: string, args: ActionArgs): Promise<CheckedResult> {
    const { plugin, action, inputs, params } = this.prepare(
      id,
      args,
      this.options.doc.getState(),
      null,
    );
    const sandbox = await this.sandbox(plugin);
    return sandbox.run({
      action: action.name,
      inputs,
      params,
      timeoutMs: Math.min(this.options.timeoutMs ?? PREVIEW_TIMEOUT_MS, PREVIEW_TIMEOUT_MS),
    });
  }

  /**
   * Runs an action. `writer` is where its waves and result go: the open
   * `op.atomic()` block of Python that asked for it, or (by default) the
   * document, as one change. The inputs are read from the same place.
   */
  async run(
    id: string,
    args: ActionArgs,
    writer: DocWriter | null = null,
    options: RunOptions = {},
  ): Promise<PluginRunOutcome> {
    const read = (): DocState => (writer ? writer.getState() : this.options.doc.getState());
    const { plugin, action, inputs, params, revisions } = this.prepare(id, args, read(), writer);

    const { signal } = options;
    const stopped = () => new SandboxError("Stopped.", "stopped");
    if (signal?.aborted) throw stopped();
    const sandbox = await this.sandbox(plugin);
    const outcome = await sandbox.run({
      action: action.name,
      inputs,
      params,
      timeoutMs: this.options.timeoutMs ?? 5 * 60_000,
      signal,
    });
    // Stopped as it ended (Python restarted, say): nothing of it is kept.
    if (signal?.aborted) throw stopped();

    const source: ResultSource = {
      action: id,
      plugin: plugin.manifest.name,
      version: plugin.manifest.version,
      origin: describeSource(plugin.lock.source),
      commit: plugin.lock.commit,
      digest: plugin.lock.digest,
    };
    const apply = (target: DocWriter): PluginRunOutcome => {
      const state = target.getState();
      // The run took time; what it computed from must still be what is there.
      for (const [name, rev] of revisions) {
        if (state.waves[name]?.rev !== rev) {
          throw new DocError(
            `${name} changed while the plugin was running, so nothing it made was kept. Run it again.`,
            "CONFLICT",
            { name },
          );
        }
      }
      const plan = planOutcome(
        state,
        action,
        args,
        outcome,
        source,
        Date.now(),
        options.replace === true,
      );
      let result: string | null = null;
      for (const command of plan.commands) {
        const made = target.dispatch(command);
        if (command.op === "addResult") result = made;
      }
      let graph: string | null = null;
      if (plan.graph) {
        graph = plan.replaced
          ? updatePluginGraphs(target, plan.graph, plan.waves, plan.replaced, plugin.manifest.name)
          : null;
        graph ??= makePluginGraph(target, plan.graph, plan.waves, plugin.manifest.name);
      }
      if (plan.replaced) dropStale(target, plan.replaced);
      return { waves: plan.waves, values: plan.values, result, graph, log: outcome.log };
    };
    return writer ? apply(writer) : this.options.doc.transact(apply);
  }

  /**
   * Calls a plugin's view with an event (see docs/design/plugin-views.md):
   * the state, the event, and copies of the waves the view's wave parts have
   * chosen, by the paths they are bound to. Nothing of what comes back goes
   * into the experiment; the caller checks it (src/core/plugins/view.ts).
   */
  async runView(
    pluginName: string,
    view: string,
    request: { state: unknown; event: unknown; waves: Record<string, string> },
  ): Promise<CheckedResult> {
    const plugin = this.options.store.find(pluginName);
    if (!plugin) throw new PluginError(`No installed plugin is named ${pluginName}.`, "NOT_FOUND");
    if (!plugin.enabled)
      throw new PluginError(`The plugin ${plugin.manifest.title} is turned off.`);
    if (!plugin.manifest.editors.some((editor) => editor.kind === "view" && editor.name === view))
      throw new PluginError(`${plugin.manifest.title} has no view ${view}.`, "NOT_FOUND");
    const state = this.options.doc.getState();
    const inputs: Record<string, SandboxWave> = {};
    const paths: Record<string, string> = {};
    Object.entries(request.waves).forEach(([path, name], index) => {
      const wave = Object.hasOwn(state.waves, name) ? state.waves[name] : undefined;
      // Only numeric waves that are there; one chosen and gone since is left out.
      if (!wave || wave.text) return;
      inputs[`w${index}`] = sandboxWave(wave);
      paths[`w${index}`] = path;
    });
    const sandbox = await this.sandbox(plugin);
    return sandbox.run({
      action: `view:${view}`,
      inputs,
      params: {
        state: JSON.stringify(request.state ?? null),
        event: JSON.stringify(request.event),
        paths: JSON.stringify(paths),
      },
      timeoutMs: Math.min(this.options.timeoutMs ?? PREVIEW_TIMEOUT_MS, PREVIEW_TIMEOUT_MS),
    });
  }

  /** Stops a plugin's sandbox, if it has one. */
  stop(name: string): void {
    const sandbox = this.sandboxes.get(name);
    this.sandboxes.delete(name);
    this.sandboxDigest.delete(name);
    void sandbox?.then(
      (started) => started.destroy(),
      () => {},
    );
  }

  stopAll(): void {
    for (const name of this.sandboxes.keys()) this.stop(name);
  }

  private sandbox(plugin: InstalledPlugin): Promise<Sandbox> {
    const name = plugin.manifest.name;
    const running = this.sandboxes.get(name);
    if (running && this.sandboxDigest.get(name) === plugin.lock.digest) {
      return running.then((sandbox) => {
        if (!sandbox.isDestroyed) return sandbox;
        // Stopped after a run that took too long: start afresh.
        this.sandboxes.delete(name);
        return this.sandbox(plugin);
      });
    }
    const started = this.start(plugin);
    this.sandboxes.set(name, started);
    this.sandboxDigest.set(name, plugin.lock.digest);
    started.catch(() => {
      if (this.sandboxes.get(name) === started) this.sandboxes.delete(name);
    });
    return started;
  }

  private async start(plugin: InstalledPlugin): Promise<Sandbox> {
    const { manifest } = plugin;
    if (!manifest.python) throw new PluginError(`${manifest.title} has no code to run.`);
    // Read back and checked against the lock before anything of it runs.
    const files = await this.options.store.files(plugin);
    const create =
      this.options.createSandbox ??
      ((packages: readonly string[]) =>
        Sandbox.create({ pyodideURL: this.options.pyodideURL, packages }));
    const sandbox = await create(manifest.python.packages);
    try {
      // All its files: its Python may read data it ships with (reference spectra, say).
      const given: Record<string, ArrayBuffer> = {};
      for (const [path, bytes] of files) given[path] = bytes.slice().buffer;
      await sandbox.load({
        key: manifest.name,
        files: given,
        entry: manifest.python.entry,
        // Its views are registered beside its actions, as view:<name>.
        actions: [
          ...manifest.actions.map((action) => action.name),
          ...manifest.editors
            .filter((editor) => editor.kind === "view")
            .map((editor) => `view:${editor.name}`),
        ],
      });
      return sandbox;
    } catch (error) {
      sandbox.destroy();
      throw error;
    }
  }
}

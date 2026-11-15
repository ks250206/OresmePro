import { validateArgs, type ActionArgs, type ActionSpec, type JsonValue } from "../../core/actions";
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
import { planOutcome, waveArgs } from "../../core/plugins/outcome";
import type { SandboxDtype, SandboxWave } from "../../core/sandbox/protocol";
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
  /** What the plugin printed. */
  log: string;
}

export interface PluginHostOptions {
  store: PluginStore;
  doc: Doc;
  pyodideURL: string;
  /** How long one run may take before the plugin's sandbox is stopped. */
  timeoutMs?: number;
  /** Starts a sandbox; replaced in tests. */
  createSandbox?: (packages: readonly string[]) => Promise<Sandbox>;
}

/** A wave as the sandbox is given it: copies of its numbers, never the document's own arrays. */
export function sandboxWave(wave: Wave): SandboxWave {
  if (wave.text) throw new DocError(`${wave.name} is a text wave; plugins take numbers.`);
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
    x0: wave.x0,
    dx: wave.dx,
    xUnit: wave.xUnit,
    y0: wave.y0,
    dy: wave.dy,
    yUnit: wave.yUnit,
    unit: wave.unit,
    note: wave.note,
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

  /**
   * Runs an action. `writer` is where its waves and result go: the open
   * `op.atomic()` block of Python that asked for it, or (by default) the
   * document, as one change. The inputs are read from the same place.
   */
  async run(
    id: string,
    args: ActionArgs,
    writer: DocWriter | null = null,
  ): Promise<PluginRunOutcome> {
    const found = this.resolve(id);
    if (!found) throw new PluginError(`No installed plugin has the action ${id}.`);
    const { plugin, action } = found;
    if (!plugin.enabled)
      throw new PluginError(`The plugin ${plugin.manifest.title} is turned off.`);
    const spec = this.catalog().find((item) => item.id === id)!;
    const read = (): DocState => (writer ? writer.getState() : this.options.doc.getState());
    const before = read();
    const problems = validateArgs(spec, args, {
      waveExists: (name) => Object.hasOwn(before.waves, name),
    });
    if (problems.length > 0) throw new PluginError(problems.join(" "));

    const named = waveArgs(action, args);
    const inputs: Record<string, SandboxWave | SandboxWave[]> = {};
    const revisions = new Map<string, number>();
    const take = (name: string): SandboxWave => {
      const key = name.replace(/^root:/, "");
      const wave = before.waves[key]!;
      revisions.set(key, wave.rev);
      (writer as { read?: (name: string) => void } | null)?.read?.(key);
      return sandboxWave(wave);
    };
    for (const [key, value] of Object.entries(named)) {
      inputs[key] = Array.isArray(value) ? value.map(take) : take(value);
    }
    const params: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(args)) if (!(key in named)) params[key] = value;

    const sandbox = await this.sandbox(plugin);
    const outcome = await sandbox.run({
      action: action.name,
      inputs,
      params,
      timeoutMs: this.options.timeoutMs ?? 5 * 60_000,
    });

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
          );
        }
      }
      const plan = planOutcome(state, action, args, outcome, source, Date.now());
      let result: string | null = null;
      for (const command of plan.commands) {
        const made = target.dispatch(command);
        if (command.op === "addResult") result = made;
      }
      return { waves: plan.waves, values: plan.values, result, log: outcome.log };
    };
    return writer ? apply(writer) : this.options.doc.transact(apply);
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
        actions: manifest.actions.map((action) => action.name),
      });
      return sandbox;
    } catch (error) {
      sandbox.destroy();
      throw error;
    }
  }
}

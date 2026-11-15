import {
  MANIFEST_FILE,
  parseManifest,
  PluginError,
  type PluginManifest,
} from "../../core/plugins/manifest";
import {
  checkAgainstLock,
  type PluginLock,
  type VerifiedPackage,
} from "../../core/plugins/package";

/**
 * The plugins installed in this browser, kept apart from any experiment.
 *
 * Files are kept by their SHA-256 and listed in index.json, which is written
 * last: an install that stops half way leaves files nothing lists (cleared
 * on the next change) and the plugins as they were. Files are checked
 * against their hashes each time they are read back, so a file changed in
 * storage (by code that can reach the app's storage) is refused, not run.
 */

export interface InstalledPlugin {
  manifest: PluginManifest;
  lock: PluginLock;
  enabled: boolean;
  installedAt: number;
}

/** Where the files go: the browser's private file system, or memory. */
export interface PluginStorage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export class MemoryPluginStorage implements PluginStorage {
  readonly files = new Map<string, Uint8Array>();

  read(name: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(name) ?? null);
  }

  write(name: string, bytes: Uint8Array): Promise<void> {
    this.files.set(name, bytes.slice());
    return Promise.resolve();
  }

  remove(name: string): Promise<void> {
    this.files.delete(name);
    return Promise.resolve();
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
}

/** The plugins' folder in the origin private file system. */
export class OpfsPluginStorage implements PluginStorage {
  private folder: Promise<FileSystemDirectoryHandle> | null = null;

  private directory(): Promise<FileSystemDirectoryHandle> {
    this.folder ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle("oresme-plugins", { create: true }));
    return this.folder;
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      const handle = await (await this.directory()).getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await (await this.directory()).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async remove(name: string): Promise<void> {
    await (await this.directory()).removeEntry(name).catch(() => {});
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of (await this.directory()).keys()) names.push(name);
    return names;
  }
}

/**
 * Keeps changes to the plugins one at a time across the browser's tabs: each
 * reads the list as storage has it, changes it and writes it back while no
 * other tab can, so no tab writes a list made from an outdated copy (and
 * then clears away the files of a plugin another tab installed meanwhile).
 */
export interface PluginLocks {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** One change at a time within this page: where the browser has no Web Locks, and in tests. */
export function pageLocks(): PluginLocks {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const next = queue.then(task, task);
      queue = next.catch(() => {});
      return next;
    },
  };
}

/** One change at a time across the tabs of this browser, with the Web Locks API. */
export function browserLocks(): PluginLocks {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return pageLocks();
  return { run: (task) => locks.request("oresme-plugins", task) };
}

export interface PluginStoreOptions {
  locks?: PluginLocks;
  /**
   * A BroadcastChannel name on which tabs tell each other that the plugins
   * changed, so each reads the list again. Left out, nothing is told.
   */
  channel?: string;
}

const INDEX = "index.json";
const BLOB = /^[0-9a-f]{64}$/;

interface IndexFile {
  version: 1;
  plugins: { lock: PluginLock; enabled: boolean; installedAt: number }[];
}

export class PluginStore {
  private plugins: InstalledPlugin[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly storage: PluginStorage;
  private readonly locks: PluginLocks;
  private readonly channel: BroadcastChannel | null;

  constructor(storage: PluginStorage, options: PluginStoreOptions = {}) {
    this.storage = storage;
    this.locks = options.locks ?? pageLocks();
    this.channel =
      options.channel && typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(options.channel)
        : null;
    // Another tab changed the plugins: read the list again.
    if (this.channel) {
      this.channel.onmessage = () => void this.load().catch(() => {});
      // Outside a browser (in tests) the channel must not keep the process alive.
      (this.channel as { unref?: () => void }).unref?.();
    }
  }

  readonly list = (): readonly InstalledPlugin[] => this.plugins;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  find(name: string): InstalledPlugin | undefined {
    return this.plugins.find((plugin) => plugin.manifest.name === name);
  }

  /** Reads the list of installed plugins. One whose manifest cannot be read back is left out. */
  async load(): Promise<void> {
    this.plugins = await this.read();
    this.emit();
  }

  /** The list of installed plugins as storage has it now. */
  private async read(): Promise<InstalledPlugin[]> {
    const bytes = await this.storage.read(INDEX);
    if (!bytes) return [];
    let index: IndexFile;
    try {
      index = JSON.parse(new TextDecoder().decode(bytes)) as IndexFile;
    } catch {
      return [];
    }
    const plugins: InstalledPlugin[] = [];
    for (const entry of index.plugins ?? []) {
      const manifestBytes = await this.storage.read(entry.lock.manifestSha256);
      if (!manifestBytes) continue;
      try {
        plugins.push({
          manifest: parseManifest(manifestBytes),
          lock: entry.lock,
          enabled: entry.enabled,
          installedAt: entry.installedAt,
        });
      } catch {
        // Not readable any more; its results stay in the experiments.
      }
    }
    return plugins;
  }

  /**
   * Changes the list: with no other tab changing it meanwhile, from the list
   * as storage has it (not this tab's copy, which another tab may have made
   * outdated), and clearing away only files that list no longer needs.
   */
  private change<T>(
    make: (current: InstalledPlugin[]) => Promise<{ plugins: InstalledPlugin[]; value: T }>,
  ): Promise<T> {
    return this.locks.run(async () => {
      const { plugins, value } = await make(await this.read());
      await this.writeIndex(plugins);
      this.plugins = plugins;
      this.emit();
      await this.collect(plugins);
      this.channel?.postMessage("changed");
      return value;
    });
  }

  /**
   * Installs a checked package, or replaces the plugin of the same name from
   * the same place (an update). A plugin of the same name from somewhere
   * else is refused: one source cannot take another's place by its name.
   */
  install(pkg: VerifiedPackage, enabled = true): Promise<InstalledPlugin> {
    return this.change(async (current) => {
      const existing = current.find((plugin) => plugin.manifest.name === pkg.manifest.name);
      if (existing && JSON.stringify(existing.lock.source) !== JSON.stringify(pkg.lock.source)) {
        const { source } = existing.lock;
        const from = source.kind === "github" ? `${source.owner}/${source.repo}` : source.label;
        throw new PluginError(
          `A plugin named ${pkg.manifest.name} is already installed from ${from}. Remove it first to install this one.`,
        );
      }
      await this.storage.write(pkg.lock.manifestSha256, pkg.manifestBytes);
      for (const file of pkg.lock.files) {
        await this.storage.write(file.sha256, pkg.files.get(file.path)!);
      }
      const installed: InstalledPlugin = {
        manifest: pkg.manifest,
        lock: pkg.lock,
        enabled,
        installedAt: Date.now(),
      };
      const plugins = [...current.filter((plugin) => plugin !== existing), installed];
      return { plugins, value: installed };
    });
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.change((current) =>
      Promise.resolve({
        plugins: current.map((plugin) =>
          plugin.manifest.name === name ? { ...plugin, enabled } : plugin,
        ),
        value: undefined,
      }),
    );
  }

  /** Removes a plugin and its files. Experiments keep what it made. */
  remove(name: string): Promise<void> {
    return this.change((current) =>
      Promise.resolve({
        plugins: current.filter((plugin) => plugin.manifest.name !== name),
        value: undefined,
      }),
    );
  }

  /** The files of a plugin, checked against its lock. */
  async files(plugin: InstalledPlugin): Promise<Map<string, Uint8Array>> {
    const manifestBytes = await this.storage.read(plugin.lock.manifestSha256);
    const files = new Map<string, Uint8Array>();
    for (const file of plugin.lock.files) {
      const bytes = await this.storage.read(file.sha256);
      if (bytes) files.set(file.path, bytes);
    }
    if (!manifestBytes)
      throw new PluginError(`${MANIFEST_FILE} of ${plugin.manifest.name} is missing.`);
    await checkAgainstLock(plugin.lock, manifestBytes, files);
    return files;
  }

  private async writeIndex(plugins: readonly InstalledPlugin[]): Promise<void> {
    const index: IndexFile = {
      version: 1,
      plugins: plugins.map(({ lock, enabled, installedAt }) => ({ lock, enabled, installedAt })),
    };
    await this.storage.write(INDEX, new TextEncoder().encode(JSON.stringify(index)));
  }

  /** Removes files no installed plugin needs: left by removals, updates and installs that stopped. */
  private async collect(plugins: readonly InstalledPlugin[]): Promise<void> {
    const needed = new Set<string>();
    for (const plugin of plugins) {
      needed.add(plugin.lock.manifestSha256);
      for (const file of plugin.lock.files) needed.add(file.sha256);
    }
    for (const name of await this.storage.list()) {
      if (BLOB.test(name) && !needed.has(name)) await this.storage.remove(name);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

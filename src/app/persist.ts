import type { Doc } from "../core/doc/doc";
import type { FileStore } from "../core/files/files";
import type { History, HistoryEntry } from "../core/history/history";
import {
  buildState,
  describeExperiment,
  trimHistory,
  type SavedExperiment,
} from "../core/io/experiment";
import { encodeNpy } from "../core/io/npy";

/**
 * Keeps the experiment in the browser's Origin Private File System so it
 * survives reloads. Wave data is written only when a wave changes.
 *
 * Every tab of the app shares one directory. `experiment.json` and
 * `files.json` are indexes; the data they point to sits in files named after
 * the session (one autosave in one tab) that wrote them, so an index only
 * ever points at its own session's files and no two sessions write under the
 * same name. Each index is replaced whole when its writable closes, so the
 * last index written wins. A session holds a Web Lock for as long as it
 * lives; data of another session is removed only once that lock is gone and
 * neither the index just written nor the one now on disk names it.
 */
const DIRECTORY = "experiment";

/** The parts of a directory handle that persistence uses. */
export interface StorageDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StorageFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

export interface StorageFileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<StorageWritable>;
}

export interface StorageWritable {
  write(data: string | Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** The parts of the Web Locks API that persistence uses. */
export interface SessionLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>;
}

export interface PersistOptions {
  /** Where the experiment is kept, or null to run without persistence. Defaults to OPFS. */
  directory?: () => Promise<StorageDirectory | null>;
  /** Null where the browser has no Web Locks. Defaults to navigator.locks. */
  locks?: SessionLocks | null;
  intervalMs?: number;
  /** Told each time saving starts, succeeds or fails. */
  onState?: (state: SaveState) => void;
  /**
   * Asked before each index is replaced; false stops the save with an error.
   * For a tab that has handed the saving of the experiment to another.
   */
  mayWrite?: () => boolean;
}

/** How the last attempt to save went. */
export type SaveState =
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  /** `retryInMs` is how long until it is tried again by itself. */
  | { kind: "failed"; error: string; retryInMs: number };

/** What `autosave` hands back to its caller. */
export interface Autosaver {
  /** Stops saving and lets go of the session's lock once a save in flight has ended. */
  stop: () => void;
  /**
   * Saves what is unsaved now instead of at the next interval or retry.
   * Resolves when it has been written, or when writing it has failed.
   */
  saveNow: () => Promise<void>;
  /** Counts everything as unsaved: the document, the files and the history. */
  markAll: () => void;
}

/** Which of the two saved states is read: the current one, or the one kept from the session before. */
export type Generation = "current" | "backup";

/** How restoring went: whether there was anything, and what could not be read. */
export interface RestoreReport {
  /** True if a saved document was found and loaded. */
  loaded: boolean;
  /** Why the document, the files or the history could not be read; empty if all went well. */
  errors: string[];
  /**
   * True if the document or the files could not be read: saving now would
   * replace them with what little was restored.
   */
  incomplete: boolean;
}

async function opfsDirectory(): Promise<StorageDirectory | null> {
  try {
    const root = await navigator.storage.getDirectory();
    // The DOM typings leave out keys(), which every browser with OPFS has.
    return (await root.getDirectoryHandle(DIRECTORY, {
      create: true,
    })) as unknown as StorageDirectory;
  } catch {
    // No OPFS (private window, old browser): run without persistence.
    return null;
  }
}

function defaultLocks(): SessionLocks | null {
  return typeof navigator !== "undefined" ? (navigator.locks ?? null) : null;
}

async function writeFile(
  dir: StorageDirectory,
  name: string,
  data: string | Uint8Array<ArrayBuffer>,
) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } catch (error) {
    // Leaves the file as it was instead of holding on to a half-written copy.
    await writable.abort().catch(() => {});
    throw error;
  }
  await writable.close();
}

async function readFile(dir: StorageDirectory, name: string): Promise<Blob | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** An entry of files.json: where a file of the experiment is kept. */
interface SavedFile {
  path: string;
  file: string;
}

type Kind = "wave" | "file";

const INDEX: Record<Kind, string> = { wave: "experiment.json", file: "files.json" };
const HISTORY = "history.json";
/**
 * The indexes as they were when this session first saved: the state the
 * experiment was opened in. Their data is kept until the next session
 * replaces them, so that state can be gone back to.
 */
const BACKUP: Record<string, string> = {
  [INDEX.wave]: "experiment.backup.json",
  [INDEX.file]: "files.backup.json",
  [HISTORY]: "history.backup.json",
};

/** The data files an index names. */
function references(kind: Kind, text: string): string[] {
  if (kind === "wave") {
    const saved = JSON.parse(text) as SavedExperiment;
    return saved.waves.flatMap((wave) => (wave.file ? [wave.file] : []));
  }
  return (JSON.parse(text) as SavedFile[]).map((saved) => saved.file);
}

const PREFIX: Record<Kind, string> = { wave: "w-", file: "f-" };
/** Names written by versions without sessions; old tabs still running delete only these. */
const LEGACY_PREFIX: Record<Kind, string> = { wave: "wave-", file: "file-" };

const lockName = (session: string) => `oresme-autosave-${session}`;

/**
 * The session that wrote a data file of this kind: undefined if the file is
 * not one, null if it was written by a version that kept no locks.
 */
function ownerOf(kind: Kind, name: string): string | null | undefined {
  if (name.startsWith(LEGACY_PREFIX[kind])) return null;
  if (!name.startsWith(PREFIX[kind])) return undefined;
  const end = name.indexOf("-", PREFIX[kind].length);
  return end < 0 ? undefined : name.slice(PREFIX[kind].length, end);
}

function newSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Removes data files of one kind that no index can reach any more, after
 * `written` has become that kind's index. The order matters: a file listed
 * here was written while its session held its lock, so a session missing from
 * the lock query that follows has ended and will write nothing again; the
 * index on disk is read after that, so if a session that ended wrote the
 * newest index (it closed after ours), its files stay.
 */
async function collect(
  dir: StorageDirectory,
  kind: Kind,
  written: ReadonlySet<string>,
  session: string,
  locks: SessionLocks | null,
): Promise<void> {
  const names: string[] = [];
  for await (const name of dir.keys()) if (ownerOf(kind, name) !== undefined) names.push(name);
  let alive: Set<string> | null = null;
  if (locks) {
    const { held = [], pending = [] } = await locks.query();
    alive = new Set([...held, ...pending].map((lock) => lock.name ?? ""));
  }
  let current: string[] | null;
  try {
    const index = await readFile(dir, INDEX[kind]);
    current = index ? references(kind, await index.text()) : [];
  } catch {
    current = null;
  }
  // What the backup names is kept too. If it cannot be read, nothing of others is removed.
  let backup: string[] = [];
  try {
    const index = await readFile(dir, BACKUP[INDEX[kind]]!);
    if (index) backup = references(kind, await index.text());
  } catch {
    current = null;
  }
  const keep = new Set([...written, ...(current ?? []), ...backup]);
  for (const name of names) {
    if (keep.has(name)) continue;
    const owner = ownerOf(kind, name);
    // Only this session's own indexes name its files, and the newest of them was just
    // written. Files of versions without sessions belong to no living session of this
    // version. Without knowing what the newest index needs, or without Web Locks to tell
    // that a session has ended, the files of others are left behind.
    const ended =
      owner === session ||
      (current !== null && (owner === null || (alive !== null && !alive.has(lockName(owner!)))));
    if (!ended) continue;
    // Another tab collecting at the same moment may have removed it first.
    await dir.removeEntry(name).catch(() => {});
  }
}

/** How often restore re-reads an index that changed while its data was being read. */
const RESTORE_ATTEMPTS = 20;

/**
 * Reads an index and the data it names. Another tab may replace the index
 * and remove the data of the old one while this reads; a missing file under
 * an index that has since changed means exactly that, so it reads again.
 */
async function readIndexed(
  dir: StorageDirectory,
  kind: Kind,
  generation: Generation,
): Promise<{ text: string; data: Map<string, Uint8Array> } | null> {
  const name = generation === "backup" ? BACKUP[INDEX[kind]]! : INDEX[kind];
  let previous: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    const index = await readFile(dir, name);
    if (!index) return null;
    const text = await index.text();
    const data = new Map<string, Uint8Array>();
    let complete = true;
    for (const name of references(kind, text)) {
      const file = await readFile(dir, name);
      if (!file) {
        complete = false;
        break;
      }
      data.set(name, new Uint8Array(await file.arrayBuffer()));
    }
    if (complete || text === previous || attempt + 1 >= RESTORE_ATTEMPTS) return { text, data };
    previous = text;
  }
}

/**
 * Loads what was saved into the document and the history. The parts are
 * restored independently: a session that only ran commands has a history
 * to bring back even though no document was ever written. With "backup" it
 * loads the state kept from when the session before this one began.
 */
export async function restore(
  doc: Doc,
  history: History,
  files: FileStore,
  options: Pick<PersistOptions, "directory"> = {},
  generation: Generation = "current",
): Promise<RestoreReport> {
  const report: RestoreReport = { loaded: false, errors: [], incomplete: false };
  const dir = await (options.directory ?? opfsDirectory)();
  if (!dir) return report;
  const failed = (what: string, error: unknown) => {
    console.warn(`Could not restore ${what}:`, error);
    report.errors.push(error instanceof Error ? error.message : String(error));
  };
  try {
    const read = await readIndexed(dir, "wave", generation);
    if (read) {
      doc.load(buildState(JSON.parse(read.text) as SavedExperiment, read.data));
      report.loaded = true;
    }
  } catch (error) {
    failed("the saved experiment", error);
    report.incomplete = true;
  }
  try {
    const read = await readIndexed(dir, "file", generation);
    if (read) {
      const loaded: [string, Uint8Array][] = [];
      for (const { path, file } of JSON.parse(read.text) as SavedFile[]) {
        const bytes = read.data.get(file);
        if (bytes) loaded.push([path, bytes]);
      }
      files.load(loaded);
    }
  } catch (error) {
    failed("the experiment's files", error);
    report.incomplete = true;
  }
  try {
    const saved = await readFile(dir, generation === "backup" ? BACKUP[HISTORY]! : HISTORY);
    if (saved) history.load(JSON.parse(await saved.text()) as HistoryEntry[]);
  } catch (error) {
    failed("the command history", error);
  }
  return report;
}

/** Whether there is a state from the session before to go back to. */
export async function hasBackup(options: Pick<PersistOptions, "directory"> = {}): Promise<boolean> {
  const dir = await (options.directory ?? opfsDirectory)();
  return dir !== null && (await readFile(dir, BACKUP[INDEX.wave]!)) !== null;
}

/** The longest wait before trying again after saves keep failing. */
const MAX_RETRY_MS = 60_000;

/**
 * Holds the session's lock until released. Resolves once it is held: nothing
 * of the session may be written before, or another tab could collect it.
 */
function holdLock(locks: SessionLocks | null, name: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const held = locks
    ? new Promise<void>((resolve, reject) => {
        locks
          .request(name, () => {
            resolve();
            return released;
          })
          .catch(reject);
      })
    : Promise.resolve();
  // A refused lock surfaces as a failed save, which is retried.
  held.catch(() => {});
  return { held, release };
}

/** Saves after changes, at most once per interval, writing only waves that changed. */
export function autosave(
  doc: Doc,
  history: History,
  files: FileStore,
  options: PersistOptions = {},
): Autosaver {
  const intervalMs = options.intervalMs ?? 800;
  const directory = options.directory ?? opfsDirectory;
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let stopped = false;
  let failures = 0;
  let dirtyDoc = false;
  let dirtyHistory = false;
  let dirtyFiles = false;
  /** Wave revision -> file already written for it. */
  const written = new Map<number, string>();
  /** File version -> where it was written. */
  const writtenFiles = new Map<number, string>();
  // Random rather than the clock: two tabs opened in the same millisecond must not share it.
  const session = newSession();
  const lock = holdLock(locks, lockName(session));

  /** Indexes this session has replaced: each is copied aside before its first replacement. */
  const backedUp = new Set<string>();

  /**
   * Replaces an index. The first time, what was there (the state this
   * session started from) is kept as the backup, replacing the one before.
   */
  const writeIndex = async (dir: StorageDirectory, name: string, text: string) => {
    if (options.mayWrite && !options.mayWrite()) {
      throw new Error("Another tab now saves this experiment.");
    }
    if (!backedUp.has(name)) {
      const before = await readFile(dir, name);
      if (before) await writeFile(dir, BACKUP[name]!, await before.text());
      backedUp.add(name);
    }
    await writeFile(dir, name, text);
  };

  const saveDoc = async (dir: StorageDirectory) => {
    const state = doc.getState();
    const live = new Set<string>();
    for (const wave of Object.values(state.waves)) {
      if (wave.text) continue;
      let file = written.get(wave.rev);
      if (!file) {
        file = `${PREFIX.wave}${session}-${wave.rev}.npy`;
        await writeFile(dir, file, encodeNpy(wave.data, wave.shape, wave.type, wave.imag));
        written.set(wave.rev, file);
      }
      live.add(file);
    }
    const saved = describeExperiment(state, (wave) => written.get(wave.rev)!);
    // The index is written after the data it points to, then stale data is removed.
    await writeIndex(dir, INDEX.wave, JSON.stringify(saved));
    await collect(dir, "wave", live, session, locks);
    for (const [rev, file] of written) if (!live.has(file)) written.delete(rev);
  };

  const saveFiles = async (dir: StorageDirectory) => {
    const live = new Set<string>();
    const saved: SavedFile[] = [];
    for (const { path, bytes, version } of files.list()) {
      let file = writtenFiles.get(version);
      if (!file) {
        file = `${PREFIX.file}${session}-${version}`;
        await writeFile(dir, file, bytes as Uint8Array<ArrayBuffer>);
        writtenFiles.set(version, file);
      }
      live.add(file);
      saved.push({ path, file });
    }
    await writeIndex(dir, INDEX.file, JSON.stringify(saved));
    await collect(dir, "file", live, session, locks);
    for (const [version, file] of writtenFiles) {
      if (!live.has(file)) writtenFiles.delete(version);
    }
  };

  const run = async () => {
    try {
      const dir = await directory();
      if (!dir) return;
      if (!announced) options.onState?.({ kind: "saving" });
      announced = false;
      await lock.held;
      // A part is marked clean before it is written so that changes made
      // meanwhile mark it again, and marked again if writing it fails.
      if (dirtyDoc) {
        dirtyDoc = false;
        await saveDoc(dir).catch((error: unknown) => {
          dirtyDoc = true;
          throw error;
        });
      }
      if (dirtyFiles) {
        dirtyFiles = false;
        await saveFiles(dir).catch((error: unknown) => {
          dirtyFiles = true;
          throw error;
        });
      }
      if (dirtyHistory) {
        dirtyHistory = false;
        const entries = trimHistory(history.getEntries());
        await writeIndex(dir, HISTORY, JSON.stringify(entries)).catch((error: unknown) => {
          dirtyHistory = true;
          throw error;
        });
      }
      failures = 0;
      // Changes made while this was written are still to be saved.
      if (!announced) options.onState?.({ kind: "saved", at: Date.now() });
    } catch (error) {
      console.warn("Autosave failed:", error);
      failures += 1;
      const retryInMs = Math.min(intervalMs * 2 ** failures, MAX_RETRY_MS);
      options.onState?.({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
        retryInMs,
      });
      schedule(retryInMs);
    }
  };

  const save = () => {
    timer = null;
    if (stopped) return;
    if (saving) {
      schedule();
      return;
    }
    saving = run().finally(() => (saving = null));
  };

  function schedule(delay = intervalMs) {
    if (!stopped) timer ??= setTimeout(save, delay);
  }

  /** Says that there is something unsaved, once per save: until it is written, it is not saved. */
  let announced = false;
  const changed = () => {
    if (!announced) options.onState?.({ kind: "saving" });
    announced = true;
    schedule();
  };
  const offDoc = doc.subscribe(() => {
    dirtyDoc = true;
    changed();
  });
  const offHistory = history.subscribe(() => {
    dirtyHistory = true;
    changed();
  });
  const offFiles = files.subscribe(() => {
    dirtyFiles = true;
    changed();
  });
  const flush = () => {
    if (document.visibilityState === "hidden" && timer) {
      clearTimeout(timer);
      save();
    }
  };
  const hasDocument = typeof document !== "undefined";
  if (hasDocument) document.addEventListener("visibilitychange", flush);
  // A reload or a closing tab does not always hide the page first.
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  const leave = () => {
    if (timer) {
      clearTimeout(timer);
      save();
    }
  };
  if (hasWindow) window.addEventListener("pagehide", leave);
  return {
    stop: () => {
      stopped = true;
      offDoc();
      offHistory();
      offFiles();
      if (hasDocument) document.removeEventListener("visibilitychange", flush);
      if (hasWindow) window.removeEventListener("pagehide", leave);
      if (timer) clearTimeout(timer);
      // Other tabs may collect this session's files once the lock is gone, so not before a save in flight ends.
      void (saving ?? Promise.resolve()).finally(lock.release);
    },
    saveNow: async () => {
      // A save in flight may have started before the last change: go round again after it.
      for (let round = 0; round < 3; round += 1) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!saving) save();
        await saving;
        if (failures > 0 || !(dirtyDoc || dirtyFiles || dirtyHistory)) break;
      }
    },
    markAll: () => {
      dirtyDoc = dirtyFiles = dirtyHistory = true;
      changed();
    },
  };
}

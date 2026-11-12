import type { Doc } from "../core/doc/doc";
import type { FileStore } from "../core/files/files";
import type { History } from "../core/history/history";
import {
  autosave,
  hasBackup,
  restore,
  type Autosaver,
  type SessionLocks,
  type StorageDirectory,
} from "./persist";

/**
 * The experiments kept in this browser and the one this tab works on.
 *
 * Each experiment has a directory of its own in the Origin Private File
 * System and a line in a registry (its name and when it was last saved).
 * One tab at a time saves an experiment: it holds a Web Lock for it. A tab
 * that opens an experiment another tab is saving shows it but does not save,
 * until the user tells it to take over; then the other tab stops. So the
 * work of one tab is never replaced by another without someone deciding it.
 */

export interface ExperimentInfo {
  id: string;
  name: string;
  /** Milliseconds since the epoch; 0 if it was never saved. */
  savedAt: number;
}

/** Where saving stands, for the status bar. */
export type PersistState =
  | { kind: "starting" }
  /** The browser gives the page no storage: nothing is kept. */
  | { kind: "off" }
  /** Nothing has been changed since the experiment was opened. */
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "failed"; error: string }
  /** Another tab is saving this experiment; this one is not. */
  | { kind: "elsewhere" }
  /**
   * What is saved could not be read. It is left alone, not saved over,
   * until the user goes back to the backup or decides to start afresh.
   */
  | { kind: "unread"; error: string; backup: boolean };

/** The root of the storage: holds the registry and a directory per experiment. */
export interface StorageRoot extends StorageDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<StorageDirectory>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The parts of the Web Locks API used to decide which tab saves. */
export interface WriterLocks extends SessionLocks {
  request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean; steal?: boolean } | (() => Promise<void>),
    callback?: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
}

export interface ExperimentEnvironment {
  /** Null where the browser gives no storage. */
  root: () => Promise<StorageRoot | null>;
  /** Null where the browser has no Web Locks: then every tab saves, as before there were any. */
  locks: WriterLocks | null;
}

export const DEFAULT_EXPERIMENT = "default";
const REGISTRY = "experiments.json";
const REGISTRY_LOCK = "oresme-experiments";
/** How often, at most, the registry is told that the experiment was saved. */
const REGISTRY_INTERVAL_MS = 20_000;

/** The first experiment keeps the directory it had before there were several. */
const directoryName = (id: string) =>
  id === DEFAULT_EXPERIMENT ? "experiment" : `experiment-${id}`;
const writerLock = (id: string) => `oresme-writer-${id}`;
const defaultName = (id: string) => (id === DEFAULT_EXPERIMENT ? "Experiment" : "Untitled");

export function newExperimentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An id as it may come from the address bar: checked before it names a directory. */
export const isExperimentId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9]{1,32}$/.test(id);

async function browserRoot(): Promise<StorageRoot | null> {
  try {
    return (await navigator.storage.getDirectory()) as unknown as StorageRoot;
  } catch {
    return null;
  }
}

export function browserEnvironment(): ExperimentEnvironment {
  const locks =
    typeof navigator !== "undefined" && navigator.locks
      ? (navigator.locks as unknown as WriterLocks)
      : null;
  return { root: browserRoot, locks };
}

async function readRegistry(root: StorageRoot): Promise<ExperimentInfo[]> {
  try {
    const file = await (await root.getFileHandle(REGISTRY)).getFile();
    const list = JSON.parse(await file.text()) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is ExperimentInfo =>
        typeof item === "object" &&
        item !== null &&
        isExperimentId((item as ExperimentInfo).id) &&
        typeof (item as ExperimentInfo).name === "string" &&
        typeof (item as ExperimentInfo).savedAt === "number",
    );
  } catch {
    // No registry yet, or one that cannot be read: the experiments re-enter it as they are opened.
    return [];
  }
}

/** Changes the registry. Tabs take turns, so that none writes over another's change. */
async function updateRegistry(
  env: ExperimentEnvironment,
  root: StorageRoot,
  change: (list: ExperimentInfo[]) => ExperimentInfo[],
): Promise<void> {
  const update = async () => {
    const list = change(await readRegistry(root));
    const writable = await (await root.getFileHandle(REGISTRY, { create: true })).createWritable();
    await writable.write(JSON.stringify(list));
    await writable.close();
  };
  if (env.locks) await env.locks.request(REGISTRY_LOCK, update);
  else await update();
}

/** The experiments kept in this browser, the one saved last first. */
export async function listExperiments(env: ExperimentEnvironment): Promise<ExperimentInfo[]> {
  const root = await env.root();
  if (!root) return [];
  return (await readRegistry(root)).sort((a, b) => b.savedAt - a.savedAt);
}

/** Deletes an experiment from this browser. Refused while a tab is saving it. */
export async function deleteExperiment(env: ExperimentEnvironment, id: string): Promise<void> {
  const root = await env.root();
  if (!root) return;
  const remove = async () => {
    await root.removeEntry(directoryName(id), { recursive: true }).catch(() => {});
    await updateRegistry(env, root, (list) => list.filter((item) => item.id !== id));
  };
  if (!env.locks) {
    await remove();
    return;
  }
  let open = false;
  await env.locks.request(writerLock(id), { ifAvailable: true }, async (lock) => {
    if (lock) await remove();
    else open = true;
  });
  if (open) throw new Error("This experiment is open in another tab. Close it there first.");
}

export class ExperimentSession {
  readonly id: string;
  private state: PersistState = { kind: "starting" };
  private info: ExperimentInfo;
  private readonly listeners = new Set<() => void>();
  private started: Promise<void> | null = null;
  private dir: StorageDirectory | null = null;
  private root: StorageRoot | null = null;
  private saver: Autosaver | null = null;
  /** True while this tab holds the experiment's lock (or there are no locks to hold). */
  private writer = false;
  private release: (() => void) | null = null;
  private registeredAt = 0;
  private readonly parts: { doc: Doc; history: History; files: FileStore };
  private readonly env: ExperimentEnvironment;

  constructor(
    parts: { doc: Doc; history: History; files: FileStore },
    id: string = DEFAULT_EXPERIMENT,
    env: ExperimentEnvironment = browserEnvironment(),
  ) {
    this.parts = parts;
    this.env = env;
    this.id = isExperimentId(id) ? id : DEFAULT_EXPERIMENT;
    this.info = { id: this.id, name: defaultName(this.id), savedAt: 0 };
  }

  readonly getState = (): PersistState => this.state;
  readonly getInfo = (): ExperimentInfo => this.info;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: PersistState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /**
   * Opens the experiment: restores what is saved and, if no other tab is
   * saving it, begins to save. Calling it again waits for the same start.
   */
  start(): Promise<void> {
    this.started ??= this.open();
    return this.started;
  }

  private async open(): Promise<void> {
    const { doc, history, files } = this.parts;
    this.root = await this.env.root();
    if (!this.root) {
      this.set({ kind: "off" });
      return;
    }
    try {
      this.dir = await this.root.getDirectoryHandle(directoryName(this.id), { create: true });
    } catch {
      this.set({ kind: "off" });
      return;
    }
    // The lock is asked for before reading, so that no two tabs both find it free.
    this.writer = await this.acquire(false);
    const known = (await readRegistry(this.root)).find((item) => item.id === this.id);
    if (known) this.info = known;
    const report = await restore(doc, history, files, this.options());
    if (this.writer && !known) await this.register();
    if (report.incomplete) {
      this.set({
        kind: "unread",
        error: report.errors[0] ?? "It could not be read.",
        backup: await hasBackup(this.options()),
      });
      return;
    }
    if (this.writer) this.begin();
    else this.set({ kind: "elsewhere" });
  }

  private options() {
    return { directory: () => Promise.resolve(this.dir) };
  }

  /** Asks for the experiment's lock: if it is free, or (to take over) from whoever holds it. */
  private acquire(steal: boolean): Promise<boolean> {
    const { locks } = this.env;
    if (!locks) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      locks
        .request(writerLock(this.id), steal ? { steal: true } : { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return Promise.resolve();
          }
          resolve(true);
          // Held until this tab stops saving or closes.
          return new Promise<void>((release) => (this.release = release));
        })
        .catch(() => {
          // Another tab took the lock from this one (or it could not be asked for).
          resolve(false);
          this.lost();
        });
    });
  }

  private begin(): void {
    const { doc, history, files } = this.parts;
    this.saver = autosave(doc, history, files, {
      ...this.options(),
      // The session locks of the saver tell which data files are still some tab's.
      locks: this.env.locks,
      mayWrite: () => this.writer,
      onState: (state) => {
        if (!this.writer) return;
        if (state.kind === "saved") {
          this.info = { ...this.info, savedAt: state.at };
          if (state.at - this.registeredAt >= REGISTRY_INTERVAL_MS) void this.register();
        }
        this.set(state.kind === "failed" ? { kind: "failed", error: state.error } : state);
      },
    });
    this.set(this.info.savedAt > 0 ? { kind: "saved", at: this.info.savedAt } : { kind: "idle" });
  }

  /** Writes this experiment's name and time of saving into the registry. */
  private async register(): Promise<void> {
    if (!this.root) return;
    this.registeredAt = this.info.savedAt;
    const mine = this.info;
    try {
      await updateRegistry(this.env, this.root, (list) => [
        ...list.filter((item) => item.id !== mine.id),
        mine,
      ]);
    } catch (error) {
      console.warn("Could not update the list of experiments:", error);
    }
  }

  private lost(): void {
    if (!this.writer) return;
    this.writer = false;
    this.release = null;
    this.saver?.stop();
    this.saver = null;
    this.set({ kind: "elsewhere" });
  }

  /** Tries again now, after a save that failed. */
  retry(): void {
    this.saver?.saveNow();
  }

  /**
   * Makes this tab the one that saves the experiment, as it is in this tab:
   * the tab that was saving it stops, and what it had saved is replaced.
   */
  async takeOver(): Promise<void> {
    if (this.writer || this.state.kind !== "elsewhere") return;
    this.writer = await this.acquire(true);
    if (!this.writer) return;
    this.begin();
    this.saver?.markAll();
  }

  /** Whether there is a state from when the session before this one began. */
  async hasBackup(): Promise<boolean> {
    return this.dir !== null && (await hasBackup(this.options()));
  }

  /**
   * Goes back to the experiment as it was when the session before the last
   * save began. Returns false, changing nothing that is saved, if that state
   * cannot be read either.
   */
  async revert(): Promise<boolean> {
    const { doc, history, files } = this.parts;
    if (!this.dir) return false;
    const report = await restore(doc, history, files, this.options(), "backup");
    if (report.incomplete || !report.loaded) return false;
    if (this.state.kind === "unread" && this.writer) this.begin();
    this.saver?.markAll();
    return true;
  }

  /** Gives up on what could not be read: from now on this tab's state is what is saved. */
  startAfresh(): void {
    if (this.state.kind !== "unread") return;
    if (!this.writer) {
      this.set({ kind: "elsewhere" });
      return;
    }
    this.begin();
    this.saver?.markAll();
  }

  async rename(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("An experiment needs a name.");
    this.info = { ...this.info, name: trimmed };
    for (const listener of this.listeners) listener();
    await this.register();
  }

  /** Stops saving and lets another tab save the experiment. */
  stop(): void {
    this.saver?.stop();
    this.saver = null;
    this.writer = false;
    this.release?.();
    this.release = null;
  }
}

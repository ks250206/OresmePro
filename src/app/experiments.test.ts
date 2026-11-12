import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { FileStore } from "../core/files/files";
import { History } from "../core/history/history";
import {
  deleteExperiment,
  ExperimentSession,
  listExperiments,
  type ExperimentEnvironment,
  type StorageRoot,
  type WriterLocks,
} from "./experiments";
import type { StorageDirectory } from "./persist";

/** A directory in memory. A writable replaces the file when it closes, as OPFS does. */
class MemoryDirectory implements StorageDirectory {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Names of files whose writes fail, to stand for a full or broken disk. */
  readonly failing = new Set<string>();

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException(name, "NotFoundError");
      this.files.set(name, new Uint8Array());
    }
    return {
      getFile: async () => {
        const bytes = this.files.get(name);
        if (!bytes) throw new DOMException(name, "NotFoundError");
        return new Blob([bytes]);
      },
      createWritable: async () => {
        let data = new Uint8Array();
        return {
          write: async (chunk: string | Uint8Array<ArrayBuffer>) => {
            data = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice();
          },
          close: async () => {
            if (this.failing.has(name)) throw new Error("disk full");
            this.files.set(name, data);
          },
          abort: async () => {},
        };
      },
    };
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name)) throw new DOMException(name, "NotFoundError");
  }

  async *keys() {
    yield* Array.from(this.files.keys());
  }
}

class MemoryRoot extends MemoryDirectory implements StorageRoot {
  readonly directories = new Map<string, MemoryDirectory>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!options?.create) throw new DOMException(name, "NotFoundError");
      directory = new MemoryDirectory();
      this.directories.set(name, directory);
    }
    return directory;
  }

  override async removeEntry(name: string) {
    if (!this.directories.delete(name)) await super.removeEntry(name);
  }
}

/** Web Locks shared by the tabs, with the two ways of asking that deciding the writer needs. */
class MemoryLocks implements WriterLocks {
  private readonly held = new Map<string, { abort: (error: Error) => void; done: Promise<void> }>();

  async request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean; steal?: boolean } | (() => Promise<void>),
    given?: (lock: unknown) => Promise<void>,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : given!;
    while (this.held.has(name)) {
      const holder = this.held.get(name)!;
      if (options.steal) {
        this.held.delete(name);
        holder.abort(new DOMException("The lock was stolen.", "AbortError"));
      } else if (options.ifAvailable) {
        return callback(null);
      } else {
        await holder.done;
      }
    }
    let abort!: (error: Error) => void;
    let finish!: () => void;
    const aborted = new Promise<never>((_, reject) => (abort = reject));
    const entry = { abort, done: new Promise<void>((resolve) => (finish = resolve)) };
    this.held.set(name, entry);
    try {
      return await Promise.race([callback({ name }), aborted]);
    } finally {
      if (this.held.get(name) === entry) this.held.delete(name);
      finish();
    }
  }

  async query() {
    return { held: Array.from(this.held.keys(), (name) => ({ name })) };
  }
}

let root: MemoryRoot;
let env: ExperimentEnvironment;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  root = new MemoryRoot();
  env = { root: () => Promise.resolve(root), locks: new MemoryLocks() };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A tab that has opened an experiment. */
async function open(id?: string, environment = env) {
  const doc = new Doc();
  const history = new History();
  const files = new FileStore();
  const session = new ExperimentSession({ doc, history, files }, id, environment);
  const states: string[] = [];
  session.subscribe(() => {
    const { kind } = session.getState();
    if (states.at(-1) !== kind) states.push(kind);
  });
  await session.start();
  return { doc, history, files, session, states };
}

const make = (doc: Doc, name: string, values: number[]) =>
  doc.dispatch({ op: "makeWave", name, data: Float64Array.from(values) });

/** Lets every pending save run to its end. */
const settle = () => vi.advanceTimersByTimeAsync(1500);

const waves = (doc: Doc) =>
  Object.fromEntries(
    doc.getState().waveOrder.map((name) => [name, Array.from(doc.getState().waves[name]!.data)]),
  );

describe("experiments kept in the browser", () => {
  it("saves the experiment of a tab, says so, and lists it", async () => {
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const a = await open();
    expect(a.session.getState()).toEqual({ kind: "idle" });
    make(a.doc, "w", [1, 2]);
    await settle();
    expect(a.states).toEqual(["idle", "saving", "saved"]);
    expect(await listExperiments(env)).toMatchObject([{ id: "default", name: "Experiment" }]);
    a.session.stop();

    const again = await open();
    expect(waves(again.doc)).toEqual({ w: [1, 2] });
    // Opened with something saved: it says when that was.
    expect(again.session.getState().kind).toBe("saved");
  });

  it("lets one tab save an experiment, and another take over when told to", async () => {
    const a = await open();
    make(a.doc, "w", [1]);
    await settle();
    const b = await open();
    expect(b.session.getState()).toEqual({ kind: "elsewhere" });
    expect(waves(b.doc)).toEqual({ w: [1] });
    // What the second tab does is not saved, and does not disturb the first.
    make(b.doc, "b", [2]);
    make(a.doc, "a", [3]);
    await settle();
    a.session.stop();
    expect(waves((await open()).doc)).toEqual({ w: [1], a: [3] });
  });

  it("stops the tab that was saving when another takes over", async () => {
    const a = await open();
    make(a.doc, "w", [1]);
    await settle();
    const b = await open();
    make(b.doc, "b", [2]);
    await b.session.takeOver();
    await settle();
    expect(a.session.getState()).toEqual({ kind: "elsewhere" });
    expect(b.session.getState().kind).toBe("saved");
    // The first tab's later work is no longer saved; the second's is what is kept.
    make(a.doc, "late", [9]);
    await settle();
    b.session.stop();
    const reloaded = await open();
    expect(waves(reloaded.doc)).toEqual({ w: [1], b: [2] });
    reloaded.session.stop();
    await vi.advanceTimersByTimeAsync(0);
    // The first tab can take the experiment back, with its own state, from whoever has it now.
    const c = await open();
    expect(c.session.getState().kind).toBe("saved");
    await a.session.takeOver();
    await settle();
    expect(c.session.getState().kind).toBe("elsewhere");
    expect(a.session.getState().kind).toBe("saved");
    a.session.stop();
    expect(waves((await open()).doc)).toEqual({ w: [1], late: [9] });
  });

  it("keeps experiments apart, and renames and deletes them", async () => {
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const a = await open();
    make(a.doc, "first", [1]);
    await settle();
    vi.setSystemTime(new Date("2026-11-12T11:00:00Z"));
    const b = await open("abc123");
    expect(waves(b.doc)).toEqual({});
    make(b.doc, "second", [2]);
    await settle();
    await b.session.rename("  Cell 3  ");
    expect(b.session.getInfo().name).toBe("Cell 3");
    await expect(b.session.rename(" ")).rejects.toThrow(/needs a name/);
    expect((await listExperiments(env)).map((item) => [item.id, item.name])).toEqual([
      ["abc123", "Cell 3"],
      ["default", "Experiment"],
    ]);
    expect(waves((await open("abc123")).doc)).toEqual({ second: [2] });

    await expect(deleteExperiment(env, "abc123")).rejects.toThrow(/open in another tab/);
    b.session.stop();
    // The lock is let go a moment after the session stops.
    await vi.advanceTimersByTimeAsync(0);
    await deleteExperiment(env, "abc123");
    expect((await listExperiments(env)).map((item) => item.id)).toEqual(["default"]);
    expect(waves((await open("abc123")).doc)).toEqual({});
    // An id that could not name a directory falls back to the first experiment.
    expect(new ExperimentSession(a, "../etc").id).toBe("default");
  });

  it("does not save over an experiment that could not be read", async () => {
    const a = await open();
    make(a.doc, "w", [1]);
    await settle();
    a.session.stop();
    const b = await open();
    make(b.doc, "x", [2]);
    await settle();
    b.session.stop();
    // The newest index names a file that is gone: a disk that lost data.
    const directory = root.directories.get("experiment")!;
    const index = new TextDecoder().decode(directory.files.get("experiment.json"));
    const lost = (JSON.parse(index) as { waves: { name: string; file: string }[] }).waves.find(
      (wave) => wave.name === "x",
    )!.file;
    directory.files.delete(lost);

    const c = await open();
    expect(c.session.getState()).toMatchObject({ kind: "unread", backup: true });
    make(c.doc, "new", [3]);
    await settle();
    expect(new TextDecoder().decode(directory.files.get("experiment.json"))).toBe(index);

    // Going back to the backup brings the state the session before began with, and saves again.
    expect(await c.session.revert()).toBe(true);
    expect(waves(c.doc)).toEqual({ w: [1] });
    await settle();
    expect(c.session.getState().kind).toBe("saved");
    c.session.stop();
    expect(waves((await open()).doc)).toEqual({ w: [1] });
  });

  it("goes back to the state the tab opened, before and after its first save", async () => {
    const a = await open();
    expect(await a.session.hasBackup()).toBe(false);
    make(a.doc, "kept", [1]);
    await settle();
    a.session.stop();
    await vi.advanceTimersByTimeAsync(0);

    const b = await open();
    expect(await b.session.hasBackup()).toBe(true);
    // Nothing of this session is saved yet: what is saved is the state it opened.
    make(b.doc, "mistake", [2]);
    expect(b.session.getState().kind).toBe("saving");
    expect(await b.session.revert()).toBe(true);
    expect(waves(b.doc)).toEqual({ kept: [1] });
    // After a save, the backup made at that save is the state it opened.
    b.doc.dispatch({ op: "killWaves", names: ["kept"] });
    make(b.doc, "worse", [3]);
    await settle();
    make(b.doc, "more", [4]);
    await settle();
    expect(await b.session.revert()).toBe(true);
    expect(waves(b.doc)).toEqual({ kept: [1] });
    await settle();
    b.session.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(waves((await open()).doc)).toEqual({ kept: [1] });
  });

  it("starts afresh over an unreadable experiment only when told to", async () => {
    root.directories.set("experiment", new MemoryDirectory());
    root.directories
      .get("experiment")!
      .files.set("experiment.json", new TextEncoder().encode("{broken"));
    const a = await open();
    expect(a.session.getState()).toMatchObject({ kind: "unread", backup: false });
    expect(await a.session.revert()).toBe(false);
    make(a.doc, "w", [1]);
    a.session.startAfresh();
    await settle();
    expect(a.session.getState().kind).toBe("saved");
    a.session.stop();
    expect(waves((await open()).doc)).toEqual({ w: [1] });
  });

  it("reports a save that failed and saves when asked to try again", async () => {
    const a = await open();
    const directory = root.directories.get("experiment")!;
    directory.failing.add("experiment.json");
    make(a.doc, "w", [1]);
    await settle();
    expect(a.session.getState()).toEqual({ kind: "failed", error: "disk full" });
    directory.failing.clear();
    a.session.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.session.getState().kind).toBe("saved");
  });

  it("goes without saving where there is no storage, and without locks where there are none", async () => {
    const none = await open(undefined, { root: () => Promise.resolve(null), locks: null });
    expect(none.session.getState()).toEqual({ kind: "off" });
    expect(await listExperiments({ root: () => Promise.resolve(null), locks: null })).toEqual([]);

    const unlocked = { root: () => Promise.resolve(root), locks: null };
    const a = await open(undefined, unlocked);
    make(a.doc, "w", [1]);
    await settle();
    expect(a.session.getState().kind).toBe("saved");
    // Without locks a second tab cannot know of the first: it saves too.
    expect((await open(undefined, unlocked)).session.getState().kind).toBe("saved");
  });
});

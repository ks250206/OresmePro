import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { FileStore } from "../core/files/files";
import { History } from "../core/history/history";
import { encodeNpy } from "../core/io/npy";
import {
  autosave,
  hasBackup,
  restore,
  type PersistOptions,
  type SessionLocks,
  type StorageDirectory,
} from "./persist";

type Op = "read" | "write" | "remove" | "list";

/**
 * One OPFS directory shared by every tab. Each tab sees it through its own
 * view so a test can hold back or fail one tab's operations. A writable
 * replaces the file only when it closes, as OPFS does.
 */
class MemoryStore {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  hook: (tab: string, op: Op, name: string) => Promise<void> | void = () => {};

  view(tab: string): StorageDirectory {
    return MemoryStore.directory(this, tab);
  }

  private static directory(store: MemoryStore, tab: string): StorageDirectory {
    return {
      async getFileHandle(name, options) {
        if (!store.files.has(name)) {
          if (!options?.create) throw new DOMException(name, "NotFoundError");
          store.files.set(name, new Uint8Array());
        }
        return {
          async getFile() {
            await store.hook(tab, "read", name);
            const bytes = store.files.get(name);
            if (!bytes) throw new DOMException(name, "NotFoundError");
            return new Blob([bytes]);
          },
          async createWritable() {
            let data = new Uint8Array();
            return {
              async write(chunk) {
                data = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice();
              },
              async close() {
                await store.hook(tab, "write", name);
                store.files.set(name, data);
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name) {
        await store.hook(tab, "remove", name);
        if (!store.files.delete(name)) throw new DOMException(name, "NotFoundError");
      },
      async *keys() {
        await store.hook(tab, "list", "");
        // A listing taken now: entries removed while it is walked do not disturb it.
        const names = Array.from(store.files.keys());
        yield* names;
      },
    };
  }

  /** Data files written by a session. */
  of(session: string): string[] {
    return [...this.files.keys()].filter((name) => name.includes(`-${session}-`));
  }
}

/** Web Locks shared by the tabs; a crashed tab loses its lock without saying so. */
class MemoryLocks implements SessionLocks {
  readonly held = new Set<string>();
  readonly granted: string[] = [];

  async request(name: string, callback: () => Promise<void>) {
    this.held.add(name);
    this.granted.push(name);
    try {
      return await callback();
    } finally {
      this.held.delete(name);
    }
  }

  async query() {
    return { held: [...this.held].map((name) => ({ name })) };
  }
}

let store: MemoryStore;
let locks: MemoryLocks;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  store = new MemoryStore();
  locks = new MemoryLocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const options = (tab: string, withLocks = true): PersistOptions => ({
  directory: async () => store.view(tab),
  locks: withLocks ? locks : null,
  intervalMs: 100,
});

/** Opens the app in a new tab: restores what is saved, then saves its changes. */
async function open(tab: string, withLocks = true) {
  const doc = new Doc();
  const history = new History();
  const files = new FileStore();
  await restore(doc, history, files, options(tab, withLocks));
  const before = locks.granted.length;
  const { stop } = autosave(doc, history, files, options(tab, withLocks));
  await Promise.resolve();
  const lock = locks.granted[before];
  const session = lock?.replace("oresme-autosave-", "") ?? "";
  return {
    doc,
    history,
    files,
    session,
    stop,
    /** The tab is gone at once: nothing more is written and its lock is released. */
    crash() {
      stop();
      if (lock) locks.held.delete(lock);
    },
  };
}

/** Lets every pending save run to its end. */
const settle = () => vi.advanceTimersByTimeAsync(1000);

function values(doc: Doc, name: string): number[] {
  const wave = doc.getState().waves[name];
  if (!wave) throw new Error(`no wave ${name}`);
  return Array.from(wave.data);
}

/** What a reload would bring back; restoring must not fail. */
async function reload() {
  const doc = new Doc();
  const history = new History();
  const files = new FileStore();
  const before = warn.mock.calls.length;
  await restore(doc, history, files, options("reload"));
  expect(warn.mock.calls.slice(before)).toEqual([]);
  return { doc, history, files };
}

/** Lets a test hold one tab's operation until it says so. */
function hold(tab: string, op: Op, name: string) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached = false;
  const previous = store.hook;
  store.hook = async (who, what, file) => {
    if (who === tab && what === op && file === name && !reached) {
      reached = true;
      await gate;
    }
    await previous(who, what, file);
  };
  return {
    release,
    get reached() {
      return reached;
    },
  };
}

const make = (doc: Doc, name: string, data: number[]) =>
  doc.dispatch({ op: "makeWave", name, data: new Float64Array(data) });

describe("autosave shared by several tabs", () => {
  it("restores after the reported sequence: save, another tab edits, the first adds a wave", async () => {
    const a = await open("A");
    make(a.doc, "a", [1, 2]);
    await settle();
    const b = await open("B");
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([3, 4]) });
    await settle();
    make(a.doc, "b", [5]);
    await settle();

    const { doc } = await reload();
    expect(doc.getState().waveOrder).toEqual(["a", "b"]);
    expect(values(doc, "a")).toEqual([1, 2]);
    expect(values(doc, "b")).toEqual([5]);
    // B is still open, so its files stay for now.
    expect(store.of(b.session)).toHaveLength(1);
  });

  it("restores the index closed last when two tabs save at the same moment", async () => {
    for (const last of ["A", "B"]) {
      store = new MemoryStore();
      const a = await open("A");
      const b = await open("B");
      const heldA = hold("A", "write", "experiment.json");
      const heldB = hold("B", "write", "experiment.json");
      make(a.doc, "a", [1]);
      make(b.doc, "b", [2]);
      await settle();
      expect(heldA.reached && heldB.reached).toBe(true);
      const [first, second] = last === "A" ? [heldB, heldA] : [heldA, heldB];
      first.release();
      await settle();
      second.release();
      await settle();

      const { doc } = await reload();
      expect(doc.getState().waveOrder).toEqual([last === "A" ? "a" : "b"]);
      a.stop();
      b.stop();
      await settle();
    }
  });

  it("collects the files of a session that ended, but not while the newest index needs them", async () => {
    const a = await open("A");
    make(a.doc, "a", [1]);
    await settle();
    const b = await open("B");
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([9]) });
    // B has written its index and is about to collect when A saves and then dies.
    const collecting = hold("B", "list", "");
    await settle();
    expect(collecting.reached).toBe(true);
    make(a.doc, "b", [2]);
    await settle();
    a.crash();
    collecting.release();
    await settle();

    let { doc } = await reload();
    expect(values(doc, "a")).toEqual([1]);
    expect(values(doc, "b")).toEqual([2]);

    // Once B's index replaces A's, only the backup B made of the state it
    // opened (A's first index, with one wave) still needs a file of A's.
    make(b.doc, "c", [3]);
    await settle();
    expect(store.of(a.session)).toHaveLength(1);
    ({ doc } = await reload());
    expect(doc.getState().waveOrder).toEqual(["a", "c"]);
    expect(values(doc, "a")).toEqual([9]);
  });

  it("writes its own copy when it first saves an experiment restored from a tab that crashed", async () => {
    const a = await open("A");
    make(a.doc, "a", [1]);
    a.files.put("notes.txt", new TextEncoder().encode("hello"));
    await settle();
    a.crash();

    const b = await open("B");
    expect(store.of(a.session)).toHaveLength(2);
    make(b.doc, "b", [2]);
    b.files.put("more.txt", new Uint8Array([1]));
    await settle();
    // A's files are now the backup: the state B opened, kept to go back to.
    expect(store.of(a.session)).toHaveLength(2);

    const { doc, files } = await reload();
    expect(values(doc, "a")).toEqual([1]);
    expect(values(doc, "b")).toEqual([2]);
    expect(files.list().map((file) => file.path)).toEqual(["more.txt", "notes.txt"]);
    expect(new TextDecoder().decode(files.get("notes.txt")!.bytes)).toBe("hello");

    // The session after B keeps B's state as its backup, and A's is let go.
    b.crash();
    const c = await open("C");
    make(c.doc, "c", [3]);
    c.files.put("last.txt", new Uint8Array([2]));
    await settle();
    expect(store.of(a.session)).toEqual([]);
    expect(store.of(b.session)).toHaveLength(4);
  });

  it("keeps the state a session opened as a backup that can be restored", async () => {
    const a = await open("A");
    make(a.doc, "a", [1]);
    a.files.put("notes.txt", new TextEncoder().encode("first"));
    a.history.add("user", "one");
    await settle();
    // Nothing was saved before A, so there is nothing to go back to.
    expect(await hasBackup(options("A"))).toBe(false);
    a.crash();

    const b = await open("B");
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([2]) });
    make(b.doc, "b", [3]);
    b.files.put("notes.txt", new TextEncoder().encode("second"));
    b.history.add("user", "two");
    await settle();
    // Later saves of the same session leave the backup as it is.
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([4]) });
    await settle();
    expect(await hasBackup(options("B"))).toBe(true);

    const doc = new Doc();
    const history = new History();
    const files = new FileStore();
    const report = await restore(doc, history, files, options("B"), "backup");
    expect(report).toEqual({ loaded: true, errors: [], incomplete: false });
    expect(doc.getState().waveOrder).toEqual(["a"]);
    expect(values(doc, "a")).toEqual([1]);
    expect(new TextDecoder().decode(files.get("notes.txt")!.bytes)).toBe("first");
    expect(history.getEntries().map((entry) => entry.code)).toEqual(["one"]);
    // The current state is untouched by reading the backup.
    expect(values((await reload()).doc, "a")).toEqual([4]);
  });

  it("says how each save went, saves at once when asked and everything when told", async () => {
    const states: string[] = [];
    const doc = new Doc();
    const saver = autosave(doc, new History(), new FileStore(), {
      ...options("A"),
      onState: (state) =>
        states.push(state.kind === "failed" ? `failed: ${state.error}` : state.kind),
    });
    make(doc, "a", [1]);
    saver.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["saving", "saved"]);
    expect(values((await reload()).doc, "a")).toEqual([1]);

    // A write that fails is reported with its reason, then tried again.
    store.hook = (_tab, op, name) => {
      if (op === "write" && name === "experiment.json") throw new Error("disk full");
    };
    make(doc, "b", [2]);
    saver.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.slice(2)).toEqual(["saving", "failed: disk full"]);
    store.hook = () => {};
    saver.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.slice(4)).toEqual(["saving", "saved"]);

    // Told that everything is unsaved, it writes the indexes again though nothing changed.
    store.files.delete("history.json");
    saver.markAll();
    await settle();
    expect(store.files.has("history.json")).toBe(true);
    saver.stop();
  });

  it("reads again when another tab replaces the experiment during a restore", async () => {
    const a = await open("A");
    make(a.doc, "a", [1]);
    await settle();
    const [file] = store.of(a.session);
    const reading = hold("reload", "read", file!);
    const restoring = reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(reading.reached).toBe(true);
    a.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([2]) });
    await settle();
    reading.release();
    const { doc } = await restoring;
    expect(values(doc, "a")).toEqual([2]);
  });

  it("leaves the files of other sessions behind without Web Locks, and still restores", async () => {
    const waveFiles = () => [...store.files.keys()].filter((name) => name.startsWith("w-"));
    const a = await open("A", false);
    make(a.doc, "a", [1, 2]);
    await settle();
    // "w-" and the session id.
    const ofA = (name: string) => name.startsWith(waveFiles()[0]!.slice(0, 18));
    const b = await open("B", false);
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([3, 4]) });
    await settle();
    make(a.doc, "b", [5]);
    await settle();
    let { doc } = await reload();
    expect(doc.getState().waveOrder).toEqual(["a", "b"]);
    expect(values(doc, "a")).toEqual([1, 2]);

    a.stop();
    b.doc.dispatch({ op: "setWaveData", name: "a", data: new Float64Array([6]) });
    await settle();
    ({ doc } = await reload());
    expect(values(doc, "a")).toEqual([6]);
    // Nothing can tell that A has ended, so its two files stay; B's earlier copy of a is gone.
    expect(waveFiles().filter(ofA)).toHaveLength(2);
    expect(waveFiles().filter((name) => !ofA(name))).toHaveLength(1);
  });

  it("does not write before the session holds its lock", async () => {
    let grant = () => {};
    const slow: SessionLocks = {
      request: (name, callback) =>
        new Promise((resolve) => (grant = () => resolve(locks.request(name, callback)))),
      query: () => locks.query(),
    };
    const doc = new Doc();
    autosave(doc, new History(), new FileStore(), { ...options("A"), locks: slow });
    make(doc, "a", [1]);
    await settle();
    expect(store.files.size).toBe(0);
    grant();
    await settle();
    expect((await reload()).doc.getState().waveOrder).toEqual(["a"]);
  });
});

describe("autosave after a failed write", () => {
  it("writes what a failed save did not, without waiting for another change", async () => {
    const a = await open("A");
    let failures = 0;
    store.hook = (_tab, op, name) => {
      if (op === "write" && name === "files.json" && failures++ === 0) throw new Error("full");
    };
    make(a.doc, "a", [1]);
    a.files.put("x.txt", new Uint8Array([7]));
    a.history.add("user", "print(1)");
    await vi.advanceTimersByTimeAsync(100);
    expect(warn).toHaveBeenCalledWith("Autosave failed:", new Error("full"));
    expect(store.files.has("history.json")).toBe(false);
    await settle();

    const { doc, files, history } = await reload();
    expect(values(doc, "a")).toEqual([1]);
    expect(files.list().map((file) => file.path)).toEqual(["x.txt"]);
    expect(history.getEntries().map((entry) => entry.code)).toEqual(["print(1)"]);
  });

  it("writes a wave whose data failed to be written on the next attempt", async () => {
    const a = await open("A");
    let failures = 0;
    store.hook = (_tab, op, name) => {
      if (op === "write" && name.startsWith("w-") && failures++ === 0) throw new Error("full");
    };
    make(a.doc, "a", [1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.files.has("experiment.json")).toBe(false);
    await settle();
    expect(values((await reload()).doc, "a")).toEqual([1]);
  });
});

describe("experiments saved before sessions named the files", () => {
  it("restore, and their files are removed once a newer index replaces them", async () => {
    const encoder = new TextEncoder();
    const wave = { file: "wave-1.npy", x0: 0, dx: 1, xUnit: "", unit: "", note: "" };
    const experiment = {
      version: 2,
      waves: [{ name: "old", ...wave }],
      graphs: {},
      tables: {},
      windows: [],
    };
    store.files.set("experiment.json", encoder.encode(JSON.stringify(experiment)));
    store.files.set("wave-1.npy", encodeNpy(new Float64Array([4, 5]), [2], "float64"));
    store.files.set(
      "files.json",
      encoder.encode(JSON.stringify([{ path: "a.txt", file: "file-lz1-3" }])),
    );
    store.files.set("file-lz1-3", encoder.encode("kept"));

    const a = await open("A");
    expect(values(a.doc, "old")).toEqual([4, 5]);
    expect(new TextDecoder().decode(a.files.get("a.txt")!.bytes)).toBe("kept");
    make(a.doc, "new", [1]);
    a.files.put("b.txt", new Uint8Array([1]));
    await settle();

    // The old files are the backup of the state A opened, until the next session saves.
    expect(store.files.has("wave-1.npy")).toBe(true);
    a.crash();
    const b = await open("B");
    make(b.doc, "newer", [2]);
    b.files.put("c.txt", new Uint8Array([2]));
    await settle();
    expect(store.files.has("wave-1.npy")).toBe(false);
    expect(store.files.has("file-lz1-3")).toBe(false);
    b.doc.dispatch({ op: "killWaves", names: ["newer"] });
    b.files.remove("c.txt");
    await settle();
    const { doc, files } = await reload();
    expect(doc.getState().waveOrder).toEqual(["old", "new"]);
    expect(values(doc, "old")).toEqual([4, 5]);
    expect(files.list().map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
  });
});

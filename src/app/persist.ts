import type { Doc } from "../core/doc/doc";
import type { DocState, GraphSpec, TableSpec, Wave, WindowState } from "../core/doc/types";
import type { History, HistoryEntry } from "../core/history/history";
import { decodeNpy, encodeNpy } from "../core/io/npy";

/**
 * Keeps the experiment in the browser's Origin Private File System so it
 * survives reloads: `experiment.json` describes the document, each wave's
 * data is a `.npy` file next to it, and `history.json` holds the command
 * history.
 */
interface SavedWave {
  name: string;
  file: string;
  x0: number;
  dx: number;
  xUnit: string;
  unit: string;
  note: string;
}

interface SavedExperiment {
  version: 1;
  waves: SavedWave[];
  graphs: Record<string, GraphSpec>;
  tables: Record<string, TableSpec>;
  windows: WindowState[];
}

const DIRECTORY = "experiment";
const MAX_SAVED_ENTRIES = 2000;
const MAX_SAVED_IMAGE = 300_000;

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIRECTORY, { create: true });
  } catch {
    // No OPFS (private window, old browser): run without persistence.
    return null;
  }
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: string | Uint8Array<ArrayBuffer>,
) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

/** Loads the saved experiment into the document and history, if there is one. */
export async function restore(doc: Doc, history: History): Promise<boolean> {
  const dir = await directory();
  if (!dir) return false;
  const saved = await readFile(dir, "experiment.json");
  if (!saved) return false;
  try {
    const experiment = JSON.parse(await saved.text()) as SavedExperiment;
    const waves: Record<string, Wave> = {};
    for (const item of experiment.waves) {
      const file = await readFile(dir, item.file);
      if (!file) throw new Error(`Missing ${item.file}`);
      const data = decodeNpy(new Uint8Array(await file.arrayBuffer()));
      // Rebuild through makeWave so revisions are assigned by the document.
      doc.dispatch({ op: "makeWave", ...item, data });
      waves[item.name] = doc.getState().waves[item.name]!;
    }
    const state: DocState = {
      waves,
      waveOrder: experiment.waves.map((item) => item.name),
      graphs: experiment.graphs,
      tables: experiment.tables,
      windows: experiment.windows,
    };
    doc.load(state);
    const savedHistory = await readFile(dir, "history.json");
    if (savedHistory) history.load(JSON.parse(await savedHistory.text()) as HistoryEntry[]);
    return true;
  } catch (error) {
    console.warn("Could not restore the saved experiment:", error);
    return false;
  }
}

/** Saves after changes, at most once per interval, writing only waves that changed. */
export function autosave(doc: Doc, history: History, intervalMs = 800): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let dirtyDoc = false;
  let dirtyHistory = false;
  /** Wave revision -> file already written for it. */
  const written = new Map<number, string>();

  const save = async () => {
    timer = null;
    if (saving) {
      schedule();
      return;
    }
    saving = true;
    try {
      const dir = await directory();
      if (!dir) return;
      if (dirtyDoc) {
        dirtyDoc = false;
        const state = doc.getState();
        const waves: SavedWave[] = [];
        const live = new Set<string>();
        for (const name of state.waveOrder) {
          const wave = state.waves[name]!;
          let file = written.get(wave.rev);
          if (!file) {
            file = `wave-${wave.rev}.npy`;
            await writeFile(dir, file, encodeNpy(wave.data));
            written.set(wave.rev, file);
          }
          live.add(file);
          const { x0, dx, xUnit, unit, note } = wave;
          waves.push({ name, file, x0, dx, xUnit, unit, note });
        }
        const experiment: SavedExperiment = {
          version: 1,
          waves,
          graphs: { ...state.graphs },
          tables: { ...state.tables },
          windows: [...state.windows],
        };
        // The index is written after the data it points to, then stale data is removed.
        await writeFile(dir, "experiment.json", JSON.stringify(experiment));
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (name.startsWith("wave-") && !live.has(name)) await dir.removeEntry(name);
        }
        for (const [rev, file] of written) if (!live.has(file)) written.delete(rev);
      }
      if (dirtyHistory) {
        dirtyHistory = false;
        const entries = history
          .getEntries()
          .slice(-MAX_SAVED_ENTRIES)
          .map((entry) => ({
            ...entry,
            // Large inline images are not worth carrying across sessions.
            outputs: entry.outputs.map((output) =>
              output.kind === "result" &&
              (output.svg?.length ?? 0) + (output.png?.length ?? 0) > MAX_SAVED_IMAGE
                ? { kind: "result" as const, text: output.text }
                : output,
            ),
          }));
        await writeFile(dir, "history.json", JSON.stringify(entries));
      }
    } catch (error) {
      console.warn("Autosave failed:", error);
    } finally {
      saving = false;
    }
  };

  function schedule() {
    timer ??= setTimeout(() => void save(), intervalMs);
  }

  const offDoc = doc.subscribe(() => {
    dirtyDoc = true;
    schedule();
  });
  const offHistory = history.subscribe(() => {
    dirtyHistory = true;
    schedule();
  });
  const flush = () => {
    if (document.visibilityState === "hidden" && timer) {
      clearTimeout(timer);
      void save();
    }
  };
  document.addEventListener("visibilitychange", flush);
  return () => {
    offDoc();
    offHistory();
    document.removeEventListener("visibilitychange", flush);
    if (timer) clearTimeout(timer);
  };
}

import type { Doc } from "../core/doc/doc";
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
 */
const DIRECTORY = "experiment";

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
  const index = await readFile(dir, "experiment.json");
  if (!index) return false;
  try {
    const saved = JSON.parse(await index.text()) as SavedExperiment;
    const files = new Map<string, Uint8Array>();
    for (const wave of saved.waves) {
      if (!wave.file) continue;
      const file = await readFile(dir, wave.file);
      if (file) files.set(wave.file, new Uint8Array(await file.arrayBuffer()));
    }
    doc.load(buildState(saved, files));
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
        const live = new Set<string>();
        for (const wave of Object.values(state.waves)) {
          if (wave.text) continue;
          let file = written.get(wave.rev);
          if (!file) {
            file = `wave-${wave.rev}.npy`;
            await writeFile(dir, file, encodeNpy(wave.data, wave.shape));
            written.set(wave.rev, file);
          }
          live.add(file);
        }
        const saved = describeExperiment(state, (wave) => written.get(wave.rev)!);
        // The index is written after the data it points to, then stale data is removed.
        await writeFile(dir, "experiment.json", JSON.stringify(saved));
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (name.startsWith("wave-") && !live.has(name)) await dir.removeEntry(name);
        }
        for (const [rev, file] of written) if (!live.has(file)) written.delete(rev);
      }
      if (dirtyHistory) {
        dirtyHistory = false;
        await writeFile(dir, "history.json", JSON.stringify(trimHistory(history.getEntries())));
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

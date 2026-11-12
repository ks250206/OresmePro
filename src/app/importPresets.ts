import { checkSettings, type ImportSettings } from "../core/io/importData";

/**
 * A named way of reading files: for the files of one instrument, say. Kept
 * in the browser rather than in the experiment, so that it is there for the
 * next experiment too.
 */
export interface ImportPreset {
  name: string;
  /**
   * File names it is chosen for without being asked: `*` and `?` wildcards,
   * several separated by commas ("*.mpt, run_*.txt"). Empty for none.
   */
  pattern: string;
  settings: ImportSettings;
}

const KEY = "oresme.importPresets";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage can be forbidden outright (a sandboxed frame, a privacy setting).
    return null;
  }
}

/** Whether a file name fits a preset's pattern. Letter case is not told apart. */
export function matchesPattern(pattern: string, filename: string): boolean {
  return pattern
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const source = part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".");
      return new RegExp(`^${source}$`, "i").test(filename);
    });
}

/** A preset as read from storage or a file: checked, or an error saying what is wrong. */
function checkPreset(value: unknown): ImportPreset {
  if (typeof value !== "object" || value === null) throw new Error("A preset must be an object.");
  const { name, pattern, settings } = value as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") throw new Error("A preset needs a name.");
  return {
    name: name.trim(),
    pattern: typeof pattern === "string" ? pattern : "",
    settings: checkSettings(settings ?? {}),
  };
}

export class PresetStore {
  private presets: ImportPreset[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = browserStorage()) {
    this.storage = storage;
    try {
      const saved = this.storage?.getItem(KEY);
      if (saved) this.presets = this.parse(saved, true);
    } catch {
      // What is stored cannot be read: start without presets rather than fail.
    }
  }

  readonly list = (): readonly ImportPreset[] => this.presets;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(name: string): ImportPreset | undefined {
    return this.presets.find((preset) => preset.name === name);
  }

  /** The preset whose pattern the file name fits; the first in the list if several do. */
  match(filename: string): ImportPreset | undefined {
    return this.presets.find((preset) => matchesPattern(preset.pattern, filename));
  }

  /** Adds a preset, or replaces the one of the same name. */
  save(preset: ImportPreset): void {
    const checked = checkPreset(preset);
    const kept = this.presets.filter((item) => item.name !== checked.name);
    this.set([...kept, checked].sort((a, b) => a.name.localeCompare(b.name)));
  }

  remove(name: string): void {
    this.set(this.presets.filter((preset) => preset.name !== name));
  }

  /** The presets as the text of a file that `import` reads. */
  export(): string {
    return JSON.stringify({ oresmeImportPresets: 1, presets: this.presets }, null, 2);
  }

  /** Adds the presets of an exported file, replacing those of the same name. Returns how many. */
  import(text: string): number {
    const read = this.parse(text, false);
    const names = new Set(read.map((preset) => preset.name));
    const kept = this.presets.filter((preset) => !names.has(preset.name));
    this.set([...kept, ...read].sort((a, b) => a.name.localeCompare(b.name)));
    return read.length;
  }

  /** `lenient` drops presets that cannot be read (old storage); a file must be right throughout. */
  private parse(text: string, lenient: boolean): ImportPreset[] {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("This is not a file of import presets.");
    }
    const list = Array.isArray(data) ? data : (data as { presets?: unknown } | null)?.presets;
    if (!Array.isArray(list)) throw new Error("This is not a file of import presets.");
    const presets: ImportPreset[] = [];
    for (const item of list) {
      try {
        const preset = checkPreset(item);
        if (!presets.some((other) => other.name === preset.name)) presets.push(preset);
      } catch (error) {
        if (!lenient) throw error;
      }
    }
    return presets;
  }

  private set(presets: ImportPreset[]): void {
    this.presets = presets;
    try {
      this.storage?.setItem(KEY, JSON.stringify(presets));
    } catch {
      // Storage is full or forbidden: the presets last until the page is closed.
    }
    for (const listener of this.listeners) listener();
  }
}

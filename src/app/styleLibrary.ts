import { checkName, checkStyle } from "../core/doc/commands";
import { dict, type Dict } from "../core/doc/dict";
import type { StyleSpec } from "../core/doc/types";

/**
 * The browser's library of graph styles: styles kept outside any experiment,
 * to bring into the next one. It lives in localStorage, which may be missing,
 * full, turned off or hold something unreadable; the library then reads as
 * empty and writing to it fails with a message, and the rest of the app
 * carries on without it.
 */

/** The localStorage key the library is kept under. */
export const LIBRARY_KEY = "oresme.styles";

/** What the library needs of localStorage, so tests can give it another. */
export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Marks a JSON file as styles from OresmePro, and the library's own text. */
const FORMAT = "oresme-styles";

/** Styles as JSON text, for a file or the library: several in one. */
export function stylesText(styles: Iterable<readonly [string, StyleSpec]>): string {
  return `${JSON.stringify({ format: FORMAT, version: 1, styles: Object.fromEntries(styles) }, null, 2)}\n`;
}

export interface ReadStyles {
  /** The styles that could be read, in the order of the text. */
  styles: [string, StyleSpec][];
  /** Why each style that could not be read was left out. */
  skipped: string[];
}

/**
 * Reads styles from JSON text: a styles file, or the library. Throws when
 * the text is not styles at all; a style that is not valid is skipped and
 * reported, so one bad entry does not cost the others.
 */
export function readStyles(text: string): ReadStyles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This is not a styles file: it is not JSON.");
  }
  const styles =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { styles?: unknown }).styles
      : undefined;
  if (typeof styles !== "object" || styles === null || Array.isArray(styles)) {
    throw new Error("This is not a styles file: it has no styles.");
  }
  const result: ReadStyles = { styles: [], skipped: [] };
  for (const [name, style] of Object.entries(styles)) {
    try {
      // Checked as a style of the experiment is, so it can be copied there.
      result.styles.push([checkName(name, "style"), checkStyle(style)]);
    } catch (error) {
      result.skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** `name`, or the first of name_1, name_2, ... that is not taken. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 1; ; index += 1) {
    const candidate = `${name}_${index}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Two styles hold the same; checked styles are written in one order, so their JSON compares. */
export const sameStyle = (a: StyleSpec, b: StyleSpec): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export interface Imported {
  /** Names the new styles were given, which may differ from the file's. */
  added: string[];
  /** Styles the library already had under the same name. */
  present: string[];
}

export class StyleLibrary {
  private readonly storage: StyleStorage | null;
  private readonly listeners = new Set<() => void>();
  private text: string | null = null;
  private styles: Dict<StyleSpec> = dict();

  constructor(storage: StyleStorage | null) {
    this.storage = storage;
  }

  /** Whether the library can be written to at all. */
  get available(): boolean {
    return this.storage !== null;
  }

  /**
   * The styles in the library: the same object until the library changes,
   * as React's external stores need. Another tab may change it at any time,
   * so it is read again each time.
   */
  readonly list = (): Dict<StyleSpec> => {
    let text: string | null = null;
    try {
      text = this.storage?.getItem(LIBRARY_KEY) ?? null;
    } catch {
      // Storage that cannot be read holds nothing for us.
    }
    if (text !== this.text) {
      this.text = text;
      let styles: [string, StyleSpec][] = [];
      try {
        styles = text === null ? [] : readStyles(text).styles;
      } catch {
        // Unreadable text is an empty library; the next write replaces it.
      }
      this.styles = dict(styles);
    }
    return this.styles;
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Tells listeners the library may have changed: after a write, or one from another tab. */
  changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Adds a style, or replaces the one of that name. */
  put(name: string, style: StyleSpec): void {
    const entries = Object.entries(this.list());
    const at = entries.findIndex(([key]) => key === name);
    if (at === -1) entries.push([name, style]);
    else entries[at] = [name, style];
    this.write(entries);
  }

  remove(name: string): void {
    this.write(Object.entries(this.list()).filter(([key]) => key !== name));
  }

  rename(name: string, newName: string): void {
    const styles = this.list();
    if (!(name in styles)) throw new Error(`The library has no style named ${name}.`);
    if (newName === name) return;
    if (newName in styles) throw new Error(`The library already has a style named ${newName}.`);
    checkName(newName, "style");
    this.write(Object.entries(styles).map(([key, style]) => [key === name ? newName : key, style]));
  }

  /**
   * Adds styles read from a file. One whose name the library already uses
   * for another look comes in under a new name (paper_1), so nothing is
   * overwritten; one it already has, look and all, is not added twice.
   */
  add(styles: readonly (readonly [string, StyleSpec])[]): Imported {
    const entries = Object.entries(this.list());
    const taken = new Map(entries);
    const result: Imported = { added: [], present: [] };
    for (const [name, style] of styles) {
      // Under its name, or the one an earlier import of it was given.
      const isCopy = (other: string) =>
        other === name ||
        (other.startsWith(`${name}_`) && /^\d+$/.test(other.slice(name.length + 1)));
      const present = [...taken].some(
        ([other, existing]) => isCopy(other) && sameStyle(existing, style),
      );
      if (present) {
        result.present.push(name);
        continue;
      }
      const free = freeName(name, (candidate) => taken.has(candidate));
      taken.set(free, style);
      entries.push([free, style]);
      result.added.push(free);
    }
    if (result.added.length > 0) this.write(entries);
    return result;
  }

  private write(entries: readonly (readonly [string, StyleSpec])[]): void {
    if (!this.storage) {
      throw new Error("This browser keeps no style library: its storage is turned off.");
    }
    try {
      this.storage.setItem(LIBRARY_KEY, stylesText(entries));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The browser would not store the style library (${reason}).`);
    } finally {
      this.changed();
    }
  }
}

let shared: StyleLibrary | null = null;

/** The library of this browser, made on first use. */
export function browserLibrary(): StyleLibrary {
  if (!shared) {
    let storage: StyleStorage | null = null;
    try {
      // Reading the property itself throws where storage is turned off.
      storage = globalThis.localStorage ?? null;
    } catch {
      storage = null;
    }
    shared = new StyleLibrary(storage);
  }
  return shared;
}

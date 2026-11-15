import { checkGraphTemplate, checkName, checkStyle } from "../core/doc/commands";
import { dict, type Dict } from "../core/doc/dict";
import type { GraphTemplate, StyleSpec } from "../core/doc/types";

/**
 * The browser's libraries of graph styles and graph templates: kept outside
 * any experiment, to bring into the next one. They live in localStorage,
 * which may be missing, full, turned off or hold something unreadable; a
 * library then reads as empty and writing to it fails with a message, and
 * the rest of the app carries on without it.
 */

/** The localStorage key the style library is kept under. */
export const LIBRARY_KEY = "oresme.styles";
/** The localStorage key the graph template library is kept under. */
export const TEMPLATE_LIBRARY_KEY = "oresme.graphTemplates";

/** What a library needs of localStorage, so tests can give it another. */
export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What one library holds, and how its entries are told apart from anything else. */
export interface LibraryKind<T> {
  /** The localStorage key. */
  key: string;
  /** Marks a JSON file as holding these, and the library's own text. */
  format: string;
  /** The key the entries are under in that JSON. */
  entries: string;
  /** What one entry is called, in messages: "style". */
  what: string;
  /** What a file of them is called, in messages: "styles". */
  plural: string;
  /** Checks an entry read from text, as the experiment would check it. */
  check(value: unknown): T;
}

export const STYLES: LibraryKind<StyleSpec> = {
  key: LIBRARY_KEY,
  format: "oresme-styles",
  entries: "styles",
  what: "style",
  plural: "styles",
  check: checkStyle,
};

export const GRAPH_TEMPLATES: LibraryKind<GraphTemplate> = {
  key: TEMPLATE_LIBRARY_KEY,
  format: "oresme-graph-templates",
  entries: "templates",
  what: "graph template",
  plural: "graph templates",
  check: checkGraphTemplate,
};

/** Entries as JSON text, for a file or the library: several in one. */
export function libraryText<T>(
  kind: LibraryKind<T>,
  entries: Iterable<readonly [string, T]>,
): string {
  const content = { format: kind.format, version: 1, [kind.entries]: Object.fromEntries(entries) };
  return `${JSON.stringify(content, null, 2)}\n`;
}

/** Styles as JSON text, for a file or the library: several in one. */
export const stylesText = (styles: Iterable<readonly [string, StyleSpec]>): string =>
  libraryText(STYLES, styles);

export interface ReadEntries<T> {
  /** The entries that could be read, in the order of the text. */
  items: [string, T][];
  /** Why each entry that could not be read was left out. */
  skipped: string[];
}

/**
 * Reads entries from JSON text: a file, or the library. Throws when the text
 * is not of that kind at all; an entry that is not valid is skipped and
 * reported, so one bad entry does not cost the others.
 */
export function readLibrary<T>(kind: LibraryKind<T>, text: string): ReadEntries<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`This is not a ${kind.plural} file: it is not JSON.`);
  }
  const entries =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[kind.entries]
      : undefined;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error(`This is not a ${kind.plural} file: it has no ${kind.plural}.`);
  }
  const result: ReadEntries<T> = { items: [], skipped: [] };
  for (const [name, entry] of Object.entries(entries)) {
    try {
      // Checked as one of the experiment's is, so it can be copied there.
      result.items.push([checkName(name, kind.what), kind.check(entry)]);
    } catch (error) {
      result.skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export interface ReadStyles {
  /** The styles that could be read, in the order of the text. */
  styles: [string, StyleSpec][];
  /** Why each style that could not be read was left out. */
  skipped: string[];
}

/** Reads styles from JSON text: a styles file, or the library (see readLibrary). */
export function readStyles(text: string): ReadStyles {
  const { items, skipped } = readLibrary(STYLES, text);
  return { styles: items, skipped };
}

/** `name`, or the first of name_1, name_2, ... that is not taken. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 1; ; index += 1) {
    const candidate = `${name}_${index}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Two entries hold the same; checked entries are written in one order, so their JSON compares. */
export const sameEntry = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Two styles hold the same. */
export const sameStyle = (a: StyleSpec, b: StyleSpec): boolean => sameEntry(a, b);

export interface Imported {
  /** Names the new entries were given, which may differ from the file's. */
  added: string[];
  /** Entries the library already had under the same name. */
  present: string[];
}

export class Library<T> {
  readonly kind: LibraryKind<T>;
  private readonly storage: StyleStorage | null;
  private readonly listeners = new Set<() => void>();
  private text: string | null = null;
  private entries: Dict<T> = dict();

  constructor(kind: LibraryKind<T>, storage: StyleStorage | null) {
    this.kind = kind;
    this.storage = storage;
  }

  /** Whether the library can be written to at all. */
  get available(): boolean {
    return this.storage !== null;
  }

  /**
   * The entries in the library: the same object until the library changes,
   * as React's external stores need. Another tab may change it at any time,
   * so it is read again each time.
   */
  readonly list = (): Dict<T> => {
    let text: string | null = null;
    try {
      text = this.storage?.getItem(this.kind.key) ?? null;
    } catch {
      // Storage that cannot be read holds nothing for us.
    }
    if (text !== this.text) {
      this.text = text;
      let entries: [string, T][] = [];
      try {
        entries = text === null ? [] : readLibrary(this.kind, text).items;
      } catch {
        // Unreadable text is an empty library; the next write replaces it.
      }
      this.entries = dict(entries);
    }
    return this.entries;
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Tells listeners the library may have changed: after a write, or one from another tab. */
  changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Adds an entry, or replaces the one of that name. */
  put(name: string, entry: T): void {
    const entries = Object.entries(this.list());
    const at = entries.findIndex(([key]) => key === name);
    if (at === -1) entries.push([name, entry]);
    else entries[at] = [name, entry];
    this.write(entries);
  }

  remove(name: string): void {
    this.write(Object.entries(this.list()).filter(([key]) => key !== name));
  }

  rename(name: string, newName: string): void {
    const entries = this.list();
    const { what } = this.kind;
    if (!(name in entries)) throw new Error(`The library has no ${what} named ${name}.`);
    if (newName === name) return;
    if (newName in entries) throw new Error(`The library already has a ${what} named ${newName}.`);
    checkName(newName, what);
    this.write(
      Object.entries(entries).map(([key, entry]) => [key === name ? newName : key, entry]),
    );
  }

  /**
   * Adds entries read from a file. One whose name the library already uses
   * for something else comes in under a new name (paper_1), so nothing is
   * overwritten; one it already has, content and all, is not added twice.
   */
  add(entries: readonly (readonly [string, T])[]): Imported {
    const current = Object.entries(this.list());
    const taken = new Map(current);
    const result: Imported = { added: [], present: [] };
    for (const [name, entry] of entries) {
      // Under its name, or the one an earlier import of it was given.
      const isCopy = (other: string) =>
        other === name ||
        (other.startsWith(`${name}_`) && /^\d+$/.test(other.slice(name.length + 1)));
      const present = [...taken].some(
        ([other, existing]) => isCopy(other) && sameEntry(existing, entry),
      );
      if (present) {
        result.present.push(name);
        continue;
      }
      const free = freeName(name, (candidate) => taken.has(candidate));
      taken.set(free, entry);
      current.push([free, entry]);
      result.added.push(free);
    }
    if (result.added.length > 0) this.write(current);
    return result;
  }

  private write(entries: readonly (readonly [string, T])[]): void {
    const { what } = this.kind;
    if (!this.storage) {
      throw new Error(`This browser keeps no ${what} library: its storage is turned off.`);
    }
    try {
      this.storage.setItem(this.kind.key, libraryText(this.kind, entries));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The browser would not store the ${what} library (${reason}).`);
    } finally {
      this.changed();
    }
  }
}

/** The library of graph styles. */
export class StyleLibrary extends Library<StyleSpec> {
  constructor(storage: StyleStorage | null) {
    super(STYLES, storage);
  }
}

/** The library of graph templates. */
export class TemplateLibrary extends Library<GraphTemplate> {
  constructor(storage: StyleStorage | null) {
    super(GRAPH_TEMPLATES, storage);
  }
}

/** This browser's localStorage, or null where it is turned off. */
function browserStorage(): StyleStorage | null {
  try {
    // Reading the property itself throws where storage is turned off.
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let shared: StyleLibrary | null = null;
let sharedTemplates: TemplateLibrary | null = null;

/** The style library of this browser, made on first use. */
export function browserLibrary(): StyleLibrary {
  shared ??= new StyleLibrary(browserStorage());
  return shared;
}

/** The graph template library of this browser, made on first use. */
export function templateLibrary(): TemplateLibrary {
  sharedTemplates ??= new TemplateLibrary(browserStorage());
  return sharedTemplates;
}

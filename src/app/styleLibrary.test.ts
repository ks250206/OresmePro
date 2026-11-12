import { describe, expect, it } from "vite-plus/test";
import type { StyleSpec } from "../core/doc/types";
import {
  LIBRARY_KEY,
  StyleLibrary,
  freeName,
  readStyles,
  stylesText,
  type StyleStorage,
} from "./styleLibrary";

/** Storage in memory, which can be told to fail as a full or blocked localStorage does. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const storage = {
    failRead: false,
    failWrite: false,
    getItem(key: string) {
      if (storage.failRead) throw new Error("SecurityError");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (storage.failWrite) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    items,
  };
  return storage satisfies StyleStorage;
}

const paper: StyleSpec = { graph: { fontSize: 9 }, traces: [{ lineSize: 2 }] };
const talk: StyleSpec = { graph: { fontSize: 24 } };

describe("the style library", () => {
  it("starts empty, keeps styles and tells its listeners", () => {
    const storage = memory();
    const library = new StyleLibrary(storage);
    expect(Object.keys(library.list())).toEqual([]);
    let calls = 0;
    library.subscribe(() => (calls += 1));
    library.put("paper", paper);
    library.put("talk", talk);
    expect(calls).toBe(2);
    expect(library.list()).toEqual({ paper, talk });
    // The same object until something changes, as React needs.
    expect(library.list()).toBe(library.list());
    expect(Object.getPrototypeOf(library.list())).toBeNull();

    // Replacing keeps the place; renaming and removing work by name.
    library.put("paper", talk);
    library.rename("paper", "journal");
    expect(Object.keys(library.list())).toEqual(["journal", "talk"]);
    expect(() => library.rename("journal", "talk")).toThrow(/already has a style named talk/);
    expect(() => library.rename("journal", "1st")).toThrow(/not a valid style name/);
    library.remove("talk");
    expect(Object.keys(library.list())).toEqual(["journal"]);

    // Another library on the same storage (another tab) sees it.
    expect(Object.keys(new StyleLibrary(storage).list())).toEqual(["journal"]);
  });

  it("reads corrupt or foreign storage as empty, and replaces it on the next write", () => {
    for (const text of ["{not json", '"a string"', '{"styles": 3}', "[]"]) {
      const storage = memory({ [LIBRARY_KEY]: text });
      const library = new StyleLibrary(storage);
      expect(Object.keys(library.list())).toEqual([]);
      library.put("paper", paper);
      expect(readStyles(storage.items.get(LIBRARY_KEY)!).styles).toEqual([["paper", paper]]);
    }
    // One bad entry costs only itself.
    const mixed = memory({
      [LIBRARY_KEY]: JSON.stringify({
        styles: { paper, bad: { graph: { fontSize: "big" } }, "9lives": talk },
      }),
    });
    expect(Object.keys(new StyleLibrary(mixed).list())).toEqual(["paper"]);
  });

  it("works without storage, and says why it cannot write", () => {
    const none = new StyleLibrary(null);
    expect(none.available).toBe(false);
    expect(Object.keys(none.list())).toEqual([]);
    expect(() => none.put("paper", paper)).toThrow(/keeps no style library/);

    const storage = memory();
    const library = new StyleLibrary(storage);
    library.put("paper", paper);
    storage.failWrite = true;
    expect(() => library.put("talk", talk)).toThrow(/would not store the style library/);
    expect(Object.keys(library.list())).toEqual(["paper"]);
    storage.failRead = true;
    expect(Object.keys(library.list())).toEqual([]);
  });

  it("imports a file of several styles, renaming those whose names are taken", () => {
    const library = new StyleLibrary(memory());
    library.put("paper", paper);
    const file = stylesText([
      ["paper", talk],
      ["talk", talk],
      ["poster", { size: { width: 800, height: 600 } }],
    ]);
    const read = readStyles(file);
    expect(read.skipped).toEqual([]);
    expect(library.add(read.styles)).toEqual({
      added: ["paper_1", "talk", "poster"],
      present: [],
    });
    expect(library.list().paper).toEqual(paper);
    expect(library.list().paper_1).toEqual(talk);
    // The same file again adds nothing: the library has each of its styles.
    expect(library.add(readStyles(file).styles)).toEqual({
      added: [],
      present: ["paper", "talk", "poster"],
    });
    expect(Object.keys(library.list())).toEqual(["paper", "paper_1", "talk", "poster"]);
  });

  it("reads styles files strictly but skips what it cannot use", () => {
    expect(() => readStyles("nope")).toThrow(/not JSON/);
    expect(() => readStyles('{"waves": []}')).toThrow(/has no styles/);
    const read = readStyles(
      JSON.stringify({
        format: "oresme-styles",
        version: 1,
        styles: {
          ok: { traces: [{ color: "blue" }] },
          unknown: { traces: [{ y: "wave0" }] },
          __proto__: talk,
        },
      }),
    );
    expect(read.styles).toEqual([["ok", { traces: [{ color: "#0000ff" }] }]]);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]).toMatch(/^unknown: Unknown trace style property "y"/);
    // Written and read back, styles are the same.
    expect(readStyles(stylesText([["paper", paper]])).styles).toEqual([["paper", paper]]);
  });

  it("finds free names", () => {
    const taken = new Set(["paper", "paper_1"]);
    expect(freeName("talk", (name) => taken.has(name))).toBe("talk");
    expect(freeName("paper", (name) => taken.has(name))).toBe("paper_2");
  });
});

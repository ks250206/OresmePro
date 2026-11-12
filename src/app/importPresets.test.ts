import { describe, expect, it } from "vite-plus/test";
import { matchesPattern, PresetStore } from "./importPresets";

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("import presets", () => {
  it("matches file names by wildcard patterns", () => {
    expect(matchesPattern("*.mpt", "Run 3.MPT")).toBe(true);
    expect(matchesPattern("*.mpt, run_??.txt", "run_07.txt")).toBe(true);
    expect(matchesPattern("run_??.txt", "run_7.txt")).toBe(false);
    expect(matchesPattern("a+b(1).csv", "a+b(1).csv")).toBe(true);
    expect(matchesPattern("", "anything")).toBe(false);
  });

  it("keeps presets across sessions and finds the one for a file", () => {
    const storage = memory();
    const store = new PresetStore(storage);
    let changes = 0;
    store.subscribe(() => (changes += 1));
    store.save({ name: "EC-Lab", pattern: "*.mpt", settings: { decimal: ",", skip: 60 } });
    store.save({ name: "Bench", pattern: "", settings: { columns: { 0: { name: "t" } } } });
    store.save({ name: "EC-Lab", pattern: "*.mpt, *.mpr.txt", settings: { decimal: "," } });
    expect(changes).toBe(3);
    const again = new PresetStore(storage);
    expect(again.list().map((preset) => preset.name)).toEqual(["Bench", "EC-Lab"]);
    expect(again.match("cell1.mpr.txt")?.settings).toEqual({ decimal: "," });
    expect(again.match("cell1.csv")).toBeUndefined();
    again.remove("EC-Lab");
    expect(new PresetStore(storage).get("EC-Lab")).toBeUndefined();
  });

  it("exports to a file and reads one back, replacing presets of the same name", () => {
    const store = new PresetStore(memory());
    store.save({ name: "A", pattern: "*.a", settings: { skip: 1 } });
    store.save({ name: "B", pattern: "", settings: {} });
    const other = new PresetStore(memory());
    other.save({ name: "A", pattern: "", settings: { skip: 9 } });
    other.save({ name: "C", pattern: "", settings: {} });
    expect(other.import(store.export())).toBe(2);
    expect(other.list().map((preset) => [preset.name, preset.settings.skip])).toEqual([
      ["A", 1],
      ["B", undefined],
      ["C", undefined],
    ]);
    expect(() => other.import("not json")).toThrow(/not a file of import presets/);
    expect(() => other.import('{"presets": [{"name": "X", "settings": {"skip": -1}}]}')).toThrow(
      /skip must be/,
    );
    expect(other.list().length).toBe(3);
  });

  it("works without storage, and with storage that is broken or refuses", () => {
    const none = new PresetStore(null);
    none.save({ name: "A", pattern: "", settings: {} });
    expect(none.list().length).toBe(1);
    expect(new PresetStore(memory({ "oresme.importPresets": "{broken" })).list()).toEqual([]);
    // One bad preset in storage does not take the others with it.
    const partly = memory({
      "oresme.importPresets": JSON.stringify([
        { name: "ok", settings: {} },
        { name: "bad", settings: { delimiter: "pipe" } },
      ]),
    });
    expect(new PresetStore(partly).list().map((preset) => preset.name)).toEqual(["ok"]);
    const full = new PresetStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    full.save({ name: "A", pattern: "", settings: {} });
    expect(full.get("A")).toBeDefined();
  });
});

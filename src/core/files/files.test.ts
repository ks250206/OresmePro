import { describe, expect, it } from "vite-plus/test";
import { FileStore, bytesToWords, checkFilePath, wordsToBytes } from "./files";

describe("FileStore", () => {
  it("keeps files by path and gives each write a new version", () => {
    const store = new FileStore();
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    const first = store.put("b.txt", Uint8Array.of(1));
    const second = store.put("a/x.bin", Uint8Array.of(2, 3));
    const third = store.put("b.txt", Uint8Array.of(4));
    expect(new Set([first, second, third]).size).toBe(3);
    expect(store.list().map((file) => file.path)).toEqual(["a/x.bin", "b.txt"]);
    expect(Array.from(store.get("b.txt")!.bytes)).toEqual([4]);
    expect(store.remove("b.txt")).toBe(true);
    expect(store.remove("b.txt")).toBe(false);
    expect(changes).toBe(4);
    const before = store.list();
    expect(store.list()).toBe(before);
  });

  it("gives every file a new version when an experiment is loaded", () => {
    const store = new FileStore();
    const old = store.put("a", Uint8Array.of(1));
    store.load([
      ["a", Uint8Array.of(1)],
      ["dir//b", Uint8Array.of(2)],
    ]);
    expect(store.get("a")!.version).not.toBe(old);
    expect(store.list().map((file) => file.path)).toEqual(["a", "dir/b"]);
  });

  it("refuses paths that leave the experiment", () => {
    expect(checkFilePath("./a//b.txt")).toBe("a/b.txt");
    for (const bad of ["", "/", "../x", "a/../../x", 5, null]) {
      expect(() => checkFilePath(bad)).toThrow();
    }
    expect(() => new FileStore().put("../x", new Uint8Array(1))).toThrow();
  });
});

describe("bytes carried as float64 values", () => {
  it("come back bit for bit, whatever their length", () => {
    for (const length of [0, 1, 7, 8, 9, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
      const back = wordsToBytes(bytesToWords(bytes).slice(), length);
      expect(Array.from(back)).toEqual(Array.from(bytes));
    }
    // Patterns that are NaNs with a payload when read as numbers.
    const nans = Uint8Array.of(
      1,
      0,
      0,
      0,
      0,
      0,
      0xf0,
      0x7f,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    );
    expect(Array.from(wordsToBytes(bytesToWords(nans).slice(), 16))).toEqual(Array.from(nans));
  });

  it("refuses a length the data cannot have", () => {
    expect(() => wordsToBytes(new Float64Array(1), 9)).toThrow();
    expect(() => wordsToBytes(null, 1)).toThrow();
    expect(wordsToBytes(null, 0)).toHaveLength(0);
  });
});

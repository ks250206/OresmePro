import { describe, expect, it } from "vite-plus/test";
import { altKeyFor, type AltKey } from "./altKeys";

const format: AltKey = { code: "KeyF", shift: true, run: () => true };
const word: AltKey = { code: "KeyF", run: () => true };
const press = (
  key: string,
  code: string,
  mods: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {},
) => ({
  key,
  code,
  altKey: true,
  shiftKey: mods.shift ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
});

describe("Alt shortcuts by the key's place", () => {
  it("match what a Mac types with Option as well as a plain F", () => {
    // Shift+Option+F on a Mac types "Ï"; Option+F types "ƒ".
    expect(altKeyFor([word, format], press("Ï", "KeyF", { shift: true }))).toBe(format);
    expect(altKeyFor([word, format], press("ƒ", "KeyF"))).toBe(word);
    expect(altKeyFor([word, format], press("F", "KeyF", { shift: true }))).toBe(format);
  });

  it("leave other keys and other modifiers alone", () => {
    expect(altKeyFor([word, format], press("©", "KeyG"))).toBeUndefined();
    expect(altKeyFor([word], press("f", "KeyF", { ctrl: true }))).toBeUndefined();
    expect(altKeyFor([word], press("f", "KeyF", { meta: true }))).toBeUndefined();
    expect(altKeyFor([word], { ...press("f", "KeyF"), altKey: false })).toBeUndefined();
  });
});

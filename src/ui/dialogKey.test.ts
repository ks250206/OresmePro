import { describe, expect, it } from "vite-plus/test";
import type { DialogRequest } from "../app/session";
import { dialogKey } from "./dialogKey";

describe("the key of an open dialog", () => {
  it("stays the same while the dialog is open", () => {
    const dialog: DialogRequest = { kind: "about" };
    expect(dialogKey(dialog)).toBe(dialogKey(dialog));
  });

  it("is new for each dialog opened, even with the same content", () => {
    expect(dialogKey({ kind: "about" })).not.toBe(dialogKey({ kind: "about" }));
  });

  it("does not read the bytes of the files Load Data holds", () => {
    const bytes = new Proxy(new Uint8Array(4 << 20), {
      get(_target, key) {
        throw new Error(`read the bytes (${String(key)})`);
      },
    });
    const file = { name: "big.csv", bytes };
    const dialog: DialogRequest = { kind: "importData", file, rest: [file, file] };
    expect(dialogKey(dialog)).toBe(dialogKey(dialog));
  });
});

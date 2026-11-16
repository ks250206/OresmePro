import { describe, expect, it } from "vite-plus/test";
import { dropCode } from "./variables";

describe("dropping variables", () => {
  it("is del for names, and a pop from globals() for anything else", () => {
    expect(dropCode(["x"])).toBe("del x");
    expect(dropCode(["x", "_y2", "Fit"])).toBe("del x, _y2, Fit");
    expect(dropCode(["a b", "x"])).toBe('del x\nglobals().pop("a b", None)');
    expect(dropCode([])).toBe("");
  });
});

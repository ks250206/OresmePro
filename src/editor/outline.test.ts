import { describe, expect, it } from "vite-plus/test";
import { outlineOf } from "./outline";

const brief = (items: ReturnType<typeof outlineOf>): unknown[] =>
  items.map((item) => [
    item.kind,
    item.name,
    item.signature,
    item.returns,
    item.line,
    brief(item.children),
  ]);

describe("the outline of a procedure", () => {
  it("lists classes and functions, nested, with signatures and lines", () => {
    const code = [
      "import numpy as np",
      "",
      "def area(r, *, pi=3.14) -> float:",
      "    def square(x):",
      "        return x * x",
      "    return pi * square(r)",
      "",
      "@op.action('lab.norm')",
      "def normalize(wave, to=1.0):",
      "    pass",
      "",
      "class Fit(Base, metaclass=Meta):",
      "    async def run(self, n: int = 2):",
      "        pass",
      "",
      "if True:",
      "    def later():",
      "        pass",
    ].join("\n");
    expect(brief(outlineOf(code))).toEqual([
      [
        "function",
        "area",
        "(r, *, pi=3.14)",
        " -> float",
        3,
        [["function", "square", "(x)", "", 4, []]],
      ],
      ["function", "normalize", "(wave, to=1.0)", "", 8, []],
      [
        "class",
        "Fit",
        "(Base, metaclass=Meta)",
        "",
        12,
        [["function", "run", "(self, n: int = 2)", "", 13, []]],
      ],
      ["function", "later", "()", "", 17, []],
    ]);
  });

  it("reads what it can of a file with errors, and nothing of an empty one", () => {
    expect(outlineOf("")).toEqual([]);
    const broken = outlineOf("def ok(a):\n    pass\n\ndef broken(:\n");
    expect(broken[0]).toMatchObject({ name: "ok", signature: "(a)" });
  });
});

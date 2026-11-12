import wasmDataUrl from "@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url&inline";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Ruff } from "./ruff";
import { addDefinedElsewhere, definedElsewhere } from "./ruffSettings";

let ruff: Ruff;

beforeAll(async () => {
  // In the browser the module is fetched by URL; here it comes from its bytes.
  const base64 = wasmDataUrl.slice(wasmDataUrl.indexOf(",") + 1);
  ruff = await Ruff.load(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
});

const codes = (text: string) => ruff.check(text).map((problem) => problem.code);

describe("linting with Ruff", () => {
  it("knows what the app puts in Python's namespace", () => {
    expect(codes("x = np.arange(3)\nop.display(x)\ndisplay(x)\n")).toEqual([]);
  });

  it("reports undefined names, with the name", () => {
    const [problem] = ruff.check("y = np.sin(x)\n");
    expect(problem).toMatchObject({
      code: "F821",
      severity: "warning",
      from: 11,
      to: 12,
      line: 1,
      column: 12,
      undefinedName: "x",
    });
  });

  it("takes names said to be defined elsewhere as defined", () => {
    const text = "# defined elsewhere: data, fit_peaks\nfit_peaks(data)\nprint(other)\n";
    expect(definedElsewhere(text)).toEqual(["data", "fit_peaks"]);
    expect(ruff.check(text).map((problem) => problem.undefinedName)).toEqual(["other"]);
  });

  it("reports a syntax error where it is", () => {
    const [problem] = ruff.check("a = 1\ndef f(:\n    pass\n");
    expect(problem).toMatchObject({ code: "invalid-syntax", severity: "error", line: 2 });
    expect(problem!.from).toBe("a = 1\ndef f(".length);
  });

  it("offers to remove an unused import, as a safe fix", () => {
    const text = "import os\nimport math\nprint(math.pi)\n";
    const [problem] = ruff.check(text);
    expect(problem).toMatchObject({
      code: "F401",
      severity: "hint",
      message: "`os` imported but unused",
    });
    expect(problem!.fix).toEqual({
      title: "Remove unused import: `os`",
      changes: [{ from: 0, to: 10, insert: "" }],
    });
  });

  it("reports an unused variable but does not offer to remove it", () => {
    const [problem] = ruff.check("def f():\n    y = compute()\n");
    expect(problem).toMatchObject({ code: "F841", fix: null });
  });

  it("does not nag about style", () => {
    const text =
      "import os, sys\nprint(os, sys)\nl = lambda x: x\nif l(1): print(1); print(2)\nimport math\nprint(math.pi)\nmask = np.zeros(3) == None\n";
    expect(codes(text)).toEqual([]);
  });

  it("counts columns as JavaScript does, past characters outside ASCII", () => {
    const text = "é = '😀'; print(nope)\n";
    const [problem] = ruff.check(text);
    expect(text.slice(problem!.from, problem!.to)).toBe("nope");
  });
});

describe("the defined-elsewhere comment", () => {
  it("is started at the top of the file", () => {
    expect(addDefinedElsewhere("print(x)\n", "x")).toEqual({
      from: 0,
      to: 0,
      insert: "# defined elsewhere: x\n",
    });
  });

  it("is added to when there is one", () => {
    const text = "import math\n# defined elsewhere: a  \nprint(a, b)\n";
    const change = addDefinedElsewhere(text, "b");
    const result = text.slice(0, change.from) + change.insert + text.slice(change.to);
    expect(result).toBe("import math\n# defined elsewhere: a, b  \nprint(a, b)\n");
    expect(definedElsewhere(result)).toEqual(["a", "b"]);
  });
});

describe("formatting with Ruff", () => {
  it("formats a file as Black would", () => {
    const result = ruff.format("x = [1,2 ,3]\ndef  f( a,b ):\n  return a+b\n");
    expect(result).toEqual({
      ok: true,
      text: "x = [1, 2, 3]\n\n\ndef f(a, b):\n    return a + b\n",
    });
  });

  it("wraps at the line length asked for", () => {
    const text = "result = some_function(argument_one, argument_two, argument_three)\n";
    expect(ruff.format(text)).toEqual({ ok: true, text });
    expect(ruff.format(text, 40)).toEqual({
      ok: true,
      text: "result = some_function(\n    argument_one,\n    argument_two,\n    argument_three,\n)\n",
    });
  });

  it("leaves a file that does not parse alone and says where the error is", () => {
    const result = ruff.format("a = 1\nb = (2,\n");
    expect(result).toMatchObject({ ok: false, line: 3 });
    expect(result.ok ? "" : result.message).toMatch(/^Syntax error on line 3: /);
  });
});

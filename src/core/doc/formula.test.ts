import { describe, expect, it } from "vite-plus/test";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import {
  evaluateFormula,
  formulaName,
  formulaStatus,
  FormulaError,
  parseFormula,
  renameInFormula,
  type FormulaNode,
} from "./formula";
import { emptyDoc, type DocState } from "./types";
import { applyCommand } from "./commands";

const values = (...items: number[]) => new Float64Array(items);

/** The tree of a formula as fully parenthesized text, to read precedence off. */
function shape(node: FormulaNode): string {
  switch (node.kind) {
    case "number":
      return String(node.value);
    case "wave":
      return `[${node.name}]`;
    case "point":
      return "p";
    case "x":
      return "x";
    case "unary":
      return `(${node.op}${shape(node.operand)})`;
    case "binary":
      return `(${shape(node.left)} ${node.op} ${shape(node.right)})`;
    case "choice":
      return `(${shape(node.test)} ? ${shape(node.ifTrue)} : ${shape(node.ifFalse)})`;
    case "call":
      return `${node.name}(${node.args.map(shape).join(", ")})`;
  }
}

const read = (text: string) => shape(parseFormula(text).root);

/** Where a formula is refused, and why. */
function refusal(text: string): { at: number; detail: string } {
  try {
    parseFormula(text);
  } catch (error) {
    if (error instanceof FormulaError) return { at: error.at, detail: error.detail };
    throw error;
  }
  throw new Error(`${text} was accepted`);
}

function docWith(waves: Record<string, number[]>, scale: { x0?: number; dx?: number } = {}): Doc {
  const doc = new Doc();
  for (const [name, items] of Object.entries(waves)) {
    doc.dispatch({ op: "makeWave", name, data: values(...items), ...scale });
  }
  return doc;
}

const data = (doc: Doc, name: string) => [...doc.getState().waves[name]!.data];
const status = (doc: Doc, name: string) => {
  const state = doc.getState();
  return formulaStatus(state, name, state.waves[name]!.formula!);
};

describe("formula parser", () => {
  it("gives operators the precedence of mathematics", () => {
    expect(read("1 + 2 * 3")).toBe("(1 + (2 * 3))");
    expect(read("(1 + 2) * 3")).toBe("((1 + 2) * 3)");
    expect(read("a - b - c")).toBe("(([a] - [b]) - [c])");
    expect(read("a / b * c")).toBe("(([a] / [b]) * [c])");
    expect(read("2 ^ 3 ^ 2")).toBe("(2 ^ (3 ^ 2))");
    expect(read("-2 ^ 2")).toBe("(-(2 ^ 2))");
    expect(read("2 ^ -1")).toBe("(2 ^ (-1))");
    expect(read("a < b == c > d")).toBe("(([a] < [b]) == ([c] > [d]))");
    expect(read("a || b && !c")).toBe("([a] || ([b] && (![c])))");
    expect(read("a > 0 ? b : c ? d : f")).toBe("(([a] > 0) ? [b] : ([c] ? [d] : [f]))");
    expect(read("1 + a > 2 ? 3 : 4")).toBe("(((1 + [a]) > 2) ? 3 : 4)");
  });

  it("knows p, x, constants, functions and quoted names", () => {
    expect(read("p + x")).toBe("(p + x)");
    expect(read("pi * e")).toBe(`(${Math.PI} * ${Math.E})`);
    expect(read("nan + inf")).toBe("(NaN + Infinity)");
    expect(read("'x' + 'p'")).toBe("([x] + [p])");
    expect(read("atan2(y, sqrt(abs(z)))")).toBe("atan2([y], sqrt(abs([z])))");
    expect(read("max(a, b, 1)")).toBe("max([a], [b], 1)");
    expect(read("1.5e3 + .5")).toBe("(1500 + 0.5)");
  });

  it("reads data folder paths, with or without root", () => {
    expect(parseFormula("run1:V / root:run1:I").inputs).toEqual(["run1:V", "run1:I"]);
    expect(parseFormula("'root:run2:V' + V + V").inputs).toEqual(["run2:V", "V"]);
    expect(read("a ? b : c")).toBe("([a] ? [b] : [c])");
  });

  it("says where a formula goes wrong", () => {
    expect(refusal("1 +")).toEqual({ at: 3, detail: "The formula ends where a value is expected" });
    expect(refusal("(a + b")).toMatchObject({ at: 6 });
    expect(refusal("a b")).toEqual({ at: 2, detail: 'Expected an operator but found "b"' });
    expect(refusal("")).toMatchObject({ at: 0, detail: "The formula is empty" });
    expect(refusal("a = b")).toEqual({ at: 2, detail: 'Use "==" to compare' });
    expect(refusal("sqrt(1, 2)")).toEqual({ at: 0, detail: "sqrt takes one argument" });
    expect(refusal("min(1)")).toEqual({ at: 0, detail: "min takes at least 2 arguments" });
    expect(refusal("'a b'")).toMatchObject({ at: 0 });
    expect(refusal("'open")).toMatchObject({ at: 0, detail: "This quote is not closed" });
    expect(refusal("a?b:c").detail).toMatch(/b:c was read as a wave in a data folder/);
    const error = (() => {
      try {
        parseFormula("V / ");
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).toBe("The formula ends where a value is expected (at character 5)");
  });

  it("has no way to reach anything but waves and its own functions", () => {
    expect(refusal("a.b")).toEqual({ at: 1, detail: '"." has no meaning in a formula' });
    expect(refusal("f(x)")).toMatchObject({ at: 0 });
    expect(refusal("f(x)").detail).toMatch(/^There is no function "f"/);
    expect(refusal("__import__('os')")).toEqual({
      at: 0,
      detail: '"_" has no meaning in a formula',
    });
    expect(refusal("constructor(1)").detail).toMatch(/no function "constructor"/);
    expect(refusal("toString(1)").detail).toMatch(/no function/);
    expect(refusal("'sin'(1)").detail).toMatch(/no function/);
    expect(refusal("a[0]")).toMatchObject({ at: 1 });
    expect(refusal('"text"')).toMatchObject({ at: 0 });
    expect(refusal("a; b")).toMatchObject({ at: 1 });
    expect(refusal("2 ** 3")).toMatchObject({ at: 3 });
  });

  it("refuses nesting deep enough to exhaust the stack", () => {
    expect(refusal(`${"(".repeat(5000)}1${")".repeat(5000)}`).detail).toMatch(/nested too deeply/);
    expect(refusal(`${"-".repeat(5000)}1`).detail).toMatch(/nested too deeply/);
    expect(refusal(`2${"^2".repeat(5000)}`).detail).toMatch(/nested too deeply/);
  });
});

describe("formula names", () => {
  it("quotes the names that would mean something else", () => {
    expect(formulaName("V")).toBe("V");
    expect(formulaName("run1:V")).toBe("run1:V");
    expect(formulaName("x")).toBe("'x'");
    expect(formulaName("pi")).toBe("'pi'");
    expect(formulaName("sin")).toBe("sin");
  });

  it("renames waves and keeps the rest of the text as typed", () => {
    const rename = (name: string) => (name === "V" ? "volts" : name);
    expect(renameInFormula("V/I + 2*V", rename)).toBe("volts/I + 2*volts");
    expect(renameInFormula("'V' * x", rename)).toBe("'volts' * x");
    expect(renameInFormula("V > 0 ? V : nan", (name) => (name === "V" ? "x" : name))).toBe(
      "'x' > 0 ? 'x' : nan",
    );
    expect(renameInFormula("c ? 'V':V", (name) => (name === "V" ? "run1:V" : name))).toBe(
      "c ? 'run1:V':run1:V",
    );
    expect(renameInFormula("not a formula (", rename)).toBe("not a formula (");
  });
});

describe("formula values", () => {
  const state = (): DocState => {
    let next = emptyDoc();
    const make = (name: string, items: number[], extra: Record<string, unknown> = {}) => {
      next = applyCommand(next, { op: "makeWave", name, data: values(...items), ...extra }).state;
    };
    make("V", [1, 2, 3, 4]);
    make("I", [2, 0, 1, NaN]);
    make("short", [1, 2]);
    make("shifted", [1, 2, 3, 4], { x0: 1 });
    make("scaled", [5, 6, 7, 8], { x0: 10, dx: 0.5, xUnit: "s" });
    make("words", [], {});
    next = applyCommand(next, { op: "makeWave", name: "text", text: ["a", "b"] }).state;
    next = applyCommand(next, {
      op: "makeWave",
      name: "complex",
      data: values(1, 2, 3, 4),
      imag: values(0, 0, 0, 0),
    }).state;
    next = applyCommand(next, {
      op: "makeWave",
      name: "matrix",
      data: values(1, 2, 3, 4),
      shape: [2, 2],
    }).state;
    return next;
  };
  const evaluate = (expr: string, target = "R") => evaluateFormula(state(), target, expr);

  it("divides one wave by another, point by point", () => {
    const outcome = evaluate("V / I");
    expect([...outcome.values]).toEqual([0.5, NaN, 3, NaN]);
    // NaN in I passes through; the 0 is a division by zero, counted.
    expect(outcome.zeroDivisions).toBe(1);
  });

  it("uses numbers, p and x for every point", () => {
    expect([...evaluate("2 * pi", "V").values]).toEqual([
      2 * Math.PI,
      2 * Math.PI,
      2 * Math.PI,
      2 * Math.PI,
    ]);
    expect([...evaluate("V * 0 + p").values]).toEqual([0, 1, 2, 3]);
    expect([...evaluateFormula(state(), "R", "scaled + x").values]).toEqual([15, 16.5, 18, 19.5]);
    expect(evaluateFormula(state(), "R", "scaled").xUnit).toBe("s");
  });

  it("lets NaN through everything but isnan", () => {
    expect([...evaluate("I + 1").values]).toEqual([3, 1, 2, NaN]);
    expect([...evaluate("I > 0").values]).toEqual([1, 0, 1, NaN]);
    expect([...evaluate("I > 0 ? 1 : 2").values]).toEqual([1, 2, 1, NaN]);
    expect([...evaluate("!I").values]).toEqual([0, 1, 0, NaN]);
    expect([...evaluate("isnan(I) ? -1 : I").values]).toEqual([2, 0, 1, -1]);
    expect([...evaluate("I && 1").values]).toEqual([1, 0, 1, NaN]);
    expect([...evaluate("I || 0").values]).toEqual([1, 0, 1, NaN]);
  });

  it("counts only the divisions by zero of the branch taken", () => {
    const outcome = evaluate("I == 0 ? 0 : V / I");
    expect([...outcome.values]).toEqual([0.5, 0, 3, NaN]);
    expect(outcome.zeroDivisions).toBe(0);
    expect(evaluate("0 / 0 + V").zeroDivisions).toBe(4);
  });

  it("computes the functions", () => {
    expect([...evaluate("round(V * 1.25 - 2.5)").values]).toEqual([-1, 0, 1, 3]);
    expect([...evaluate("round(-2.5) + 0 * V").values]).toEqual([-3, -3, -3, -3]);
    expect([...evaluate("log(100) + ln(e) + log10(1000) + V * 0").values]).toEqual([6, 6, 6, 6]);
    expect([...evaluate("min(V, 2) + max(V, 3, 0)").values]).toEqual([4, 5, 5, 6]);
    expect([...evaluate("sign(V - 2) + hypot(3, 4) + pow(2, 3)").values]).toEqual([12, 13, 14, 14]);
  });

  it("refuses inputs of different lengths or X, and waves that are not plain numbers", () => {
    expect(() => evaluate("V + short")).toThrow(/short has 2 points but V has 4/);
    expect(() => evaluate("V + shifted")).toThrow(/other X values .*nothing is interpolated/);
    expect(() => evaluate("V + text")).toThrow(/text is a text wave/);
    expect(() => evaluate("V + complex")).toThrow(/complex is complex/);
    expect(() => evaluate("matrix * 2")).toThrow(/formulas work on 1-D waves/);
    expect(() => evaluate("V + nothere")).toThrow(/Missing input: there is no wave named nothere/);
    expect(() => evaluate("V", "text")).toThrow(/The target text is a text wave/);
    expect(() => evaluate("V", "shifted")).toThrow(/shifted has other X values/);
  });

  it("takes the target's points when it names no wave", () => {
    expect([...evaluate("p * 2", "V").values]).toEqual([0, 2, 4, 6]);
    expect(() => evaluate("p * 2", "R")).toThrow(/names no wave/);
  });

  it("allows for rounding in X scaling", () => {
    let next = state();
    next = applyCommand(next, {
      op: "makeWave",
      name: "near",
      data: values(1, 1, 1, 1),
      x0: 1e-12,
      dx: 1 + 1e-12,
    }).state;
    expect([...evaluateFormula(next, "R", "V + near").values]).toEqual([2, 3, 4, 5]);
  });
});

describe("setting formulas", () => {
  it("makes the target with the inputs' scaling and records the formula", () => {
    const doc = docWith({ V: [2, 4, 6], I: [1, 2, 0] }, { x0: 5, dx: 0.5 });
    expect(doc.dispatch({ op: "setFormula", name: "R", expr: " V / I " })).toBe("R");
    const R = doc.getState().waves.R!;
    expect([...R.data]).toEqual([2, 2, NaN]);
    expect([R.x0, R.dx, R.type]).toEqual([5, 0.5, "float64"]);
    expect(R.formula).toMatchObject({ expr: "V / I", auto: true, error: null, zeroDivisions: 1 });
    expect(status(doc, "R").status).toBe("ok");
  });

  it("writes into an existing wave as float64, keeping its units", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "makeWave", name: "R", data: new Int16Array([7, 7, 7]), unit: "Ohm" });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 1.5" });
    const R = doc.getState().waves.R!;
    expect([...R.data]).toEqual([1.5, 3]);
    expect(R.type).toBe("float64");
    expect(R.unit).toBe("Ohm");
  });

  it("is not computed again when only an input's note or unit changes, or its own", () => {
    const doc = docWith({ a: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "b", expr: "a * 2" });
    doc.dispatch({ op: "setFormula", name: "c", expr: "b + 1" });
    const before = doc.getState().waves;
    doc.dispatch({ op: "setWaveMeta", name: "a", note: "raw", unit: "V" });
    doc.dispatch({ op: "setWaveMeta", name: "b", note: "doubled" });
    const after = doc.getState().waves;
    expect(after.a!.rev).not.toBe(before.a!.rev);
    expect(after.b!.data).toBe(before.b!.data);
    expect(after.c!.data).toBe(before.c!.data);
    expect(after.b!.note).toBe("doubled");
    expect([status(doc, "b").status, status(doc, "c").status]).toEqual(["ok", "ok"]);

    // What the values come from still counts: its numbers, and its scaling (b's no longer matches).
    doc.dispatch({ op: "setWaveData", name: "a", data: values(5, 6) });
    expect([...doc.getState().waves.c!.data]).toEqual([11, 13]);
    doc.dispatch({ op: "setWaveScale", name: "a", x0: 3 });
    expect(status(doc, "b").status).toBe("error");
  });

  it("keeps a manual formula out of date when only the note changed since", () => {
    const doc = docWith({ a: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "b", expr: "a * 2", auto: false });
    doc.dispatch({ op: "setWaveData", name: "a", data: values(3, 4) });
    doc.dispatch({ op: "setWaveMeta", name: "a", note: "later" });
    expect(status(doc, "b").status).toBe("stale");
  });

  it("refuses a cycle and changes nothing", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "A", expr: "V + 1" });
    doc.dispatch({ op: "setFormula", name: "B", expr: "A * 2" });
    const before = doc.getState();
    expect(() => doc.dispatch({ op: "setFormula", name: "V", expr: "B - 1" })).toThrow(
      /B is computed from V/,
    );
    expect(() => doc.dispatch({ op: "setFormula", name: "A", expr: "A + 1" })).toThrow(
      /A cannot be computed from itself/,
    );
    expect(doc.getState()).toBe(before);
  });

  it("refuses a formula that does not compute", () => {
    const doc = docWith({ V: [1, 2], W: [1] });
    expect(() => doc.dispatch({ op: "setFormula", name: "R", expr: "V + W" })).toThrow(
      /W has 1 points but V has 2/,
    );
    expect(() => doc.dispatch({ op: "setFormula", name: "R", expr: "V +" })).toThrow(FormulaError);
    expect(doc.getState().waves.R).toBeUndefined();
  });

  it("removes a formula and keeps the values", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 10" });
    const rev = doc.getState().waves.R!.rev;
    doc.dispatch({ op: "setFormula", name: "R", expr: null });
    const R = doc.getState().waves.R!;
    expect(R.formula).toBeUndefined();
    expect(R.rev).toBe(rev);
    doc.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [5] });
    expect(data(doc, "R")).toEqual([10, 20]);
  });

  it("is echoed as Python", () => {
    expect(echoPython({ op: "setFormula", name: "R", expr: "V / I" })).toBe(
      'op.set_formula("R", "V / I")',
    );
    expect(echoPython({ op: "setFormula", name: "R", expr: "V / I", auto: false })).toBe(
      'op.set_formula("R", "V / I", auto=False)',
    );
    expect(echoPython({ op: "setFormula", name: "R", expr: null })).toBe(
      'op.wave("R").formula = None',
    );
    expect(echoPython({ op: "recalculate" })).toBe("op.recalculate()");
    expect(echoPython({ op: "recalculate", names: ["R", "S"] })).toBe('op.recalculate(["R", "S"])');
  });
});

describe("automatic recalculation", () => {
  it("follows a change of an input in the same undo step", () => {
    const doc = docWith({ V: [2, 4], I: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V / I" });
    doc.dispatch({ op: "setWavePoints", name: "V", start: 1, values: [8] });
    expect(data(doc, "R")).toEqual([2, 4]);
    doc.undo();
    expect(data(doc, "V")).toEqual([2, 4]);
    expect(data(doc, "R")).toEqual([2, 2]);
    doc.redo();
    expect(data(doc, "R")).toEqual([2, 4]);
  });

  it("goes through a chain ten deep in order", () => {
    const doc = docWith({ w0: [1, 2, 3] });
    // Set from the far end first, so creation order is not dependency order.
    for (let index = 1; index <= 10; index += 1) {
      doc.dispatch({ op: "setFormula", name: `w${index}`, expr: `w${index - 1} + 1` });
    }
    doc.dispatch({ op: "renameWave", name: "w5", newName: "middle" });
    expect(doc.getState().waves.w6!.formula!.expr).toBe("middle + 1");
    doc.dispatch({ op: "setWavePoints", name: "w0", start: 0, values: [100] });
    expect(data(doc, "w10")).toEqual([110, 12, 13]);
    expect(data(doc, "middle")).toEqual([105, 7, 8]);
    doc.undo();
    expect(data(doc, "w10")).toEqual([11, 12, 13]);
  });

  it("recomputes in dependency order whatever the order of the waves", () => {
    const doc = docWith({ a: [1], b: [0], c: [0] });
    doc.dispatch({ op: "setFormula", name: "c", expr: "a * 3" });
    doc.dispatch({ op: "setFormula", name: "b", expr: "c + a" });
    doc.dispatch({ op: "setWavePoints", name: "a", start: 0, values: [2] });
    expect(data(doc, "c")).toEqual([6]);
    expect(data(doc, "b")).toEqual([8]);
  });

  it("keeps the values and shows an error when a recomputation fails", () => {
    const doc = docWith({ V: [2, 4], I: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V / I" });
    doc.dispatch({ op: "insertPoints", name: "V", at: 2, count: 1 });
    expect(data(doc, "R")).toEqual([2, 2]);
    expect(status(doc, "R")).toEqual({
      status: "error",
      message: "I has 2 points but V has 3.",
    });
    // Once I has grown too, R follows the inputs' length.
    doc.dispatch({ op: "insertPoints", name: "I", at: 2, count: 1 });
    expect(data(doc, "R")).toEqual([2, 2, NaN]);
    expect(status(doc, "R").status).toBe("ok");
  });

  it("shows a deleted input as missing, and computes again when it is back", () => {
    const doc = docWith({ V: [2, 4], I: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V / I" });
    doc.dispatch({ op: "killWaves", names: ["I"] });
    expect(data(doc, "R")).toEqual([2, 2]);
    expect(status(doc, "R")).toEqual({
      status: "missing",
      message: "Missing input: I does not exist.",
    });
    doc.dispatch({ op: "makeWave", name: "I", data: values(4, 4) });
    expect(data(doc, "R")).toEqual([0.5, 1]);
    expect(status(doc, "R").status).toBe("ok");
  });

  it("replaces values typed into the wave itself, and refuses other X there", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2" });
    doc.dispatch({ op: "setWavePoints", name: "R", start: 0, values: [99] });
    expect(data(doc, "R")).toEqual([2, 4]);
    doc.dispatch({ op: "setWaveScale", name: "R", x0: 3 });
    expect(status(doc, "R").status).toBe("error");
    expect(status(doc, "R").message).toMatch(/R has other X values than V/);
  });

  it("follows a rename of an input or of the wave without computing again", () => {
    const doc = docWith({ V: [2, 4], I: [1, 2] });
    doc.dispatch({ op: "newFolder", path: "run" });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V/I", auto: false });
    const rev = doc.getState().waves.R!.rev;
    doc.dispatch({ op: "renameWave", name: "V", newName: "volts" });
    doc.dispatch({ op: "renameWave", name: "I", newName: "run:I" });
    doc.dispatch({ op: "renameWave", name: "R", newName: "run:R" });
    doc.dispatch({ op: "renameFolder", path: "run", newPath: "moved" });
    const R = doc.getState().waves["moved:R"]!;
    expect(R.formula!.expr).toBe("volts/moved:I");
    expect(Object.keys(R.formula!.inputs)).toEqual(["volts", "moved:I"]);
    expect(R.rev).not.toBe(rev);
    expect(status(doc, "moved:R").status).toBe("ok");
  });

  it("drops the formula from a duplicate", () => {
    const doc = docWith({ V: [1] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V + 1" });
    doc.dispatch({ op: "duplicateWave", name: "R", newName: "copy" });
    expect(doc.getState().waves.copy!.formula).toBeUndefined();
  });

  it("goes in with a transaction and leaves nothing when it is dropped", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2" });
    doc.transact((writer) => {
      writer.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [10] });
      // The transaction reads its own recomputed values.
      expect([...writer.getState().waves.R!.data]).toEqual([20, 4]);
    });
    expect(data(doc, "R")).toEqual([20, 4]);
    const before = doc.getState();
    expect(() =>
      doc.transact((writer) => {
        writer.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [30] });
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(doc.getState()).toBe(before);
    doc.undo();
    expect(data(doc, "R")).toEqual([2, 4]);
  });

  it("is computed in a stage, and again when its commands are replayed", () => {
    const doc = docWith({ V: [1, 2], other: [0] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2" });
    const stage = doc.stage();
    stage.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [5] });
    expect([...stage.getState().waves.R!.data]).toEqual([10, 4]);
    expect(data(doc, "R")).toEqual([2, 4]);
    // The document changes meanwhile, so the commit replays the stage's commands.
    doc.dispatch({ op: "setWavePoints", name: "other", start: 0, values: [1] });
    stage.commit();
    expect(data(doc, "R")).toEqual([10, 4]);
    doc.undo();
    expect(data(doc, "R")).toEqual([2, 4]);
  });

  it("refuses a stage that read a wave its formula changed meanwhile", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2" });
    const stage = doc.stage();
    stage.read("R");
    stage.dispatch({ op: "makeWave", name: "S", data: values(1) });
    doc.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [5] });
    expect(() => stage.commit()).toThrow(/R changed while this was running/);
  });

  it("costs nothing when there are no formulas or no wave changed", () => {
    const doc = docWith({ V: [1, 2] });
    const before = doc.getState().waves;
    doc.dispatch({ op: "setTimeZone", zone: "local" });
    expect(doc.getState().waves).toBe(before);
  });
});

describe("manual formulas", () => {
  it("are marked out of date and computed only when asked", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2", auto: false });
    doc.dispatch({ op: "setFormula", name: "S", expr: "R + 1" });
    doc.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [5] });
    expect(data(doc, "R")).toEqual([2, 4]);
    expect(status(doc, "R").status).toBe("stale");
    doc.dispatch({ op: "recalculate", names: ["R"] });
    expect(data(doc, "R")).toEqual([10, 4]);
    // The automatic formula of S follows R in the same step.
    expect(data(doc, "S")).toEqual([11, 5]);
    expect(status(doc, "R").status).toBe("ok");
    doc.undo();
    expect(data(doc, "S")).toEqual([3, 5]);
    expect(status(doc, "R").status).toBe("stale");
  });

  it("recalculate leaves what is up to date alone and refuses a wave without a formula", () => {
    const doc = docWith({ V: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V * 2", auto: false });
    const before = doc.getState();
    doc.dispatch({ op: "recalculate" });
    expect(doc.getState()).toBe(before);
    expect(() => doc.dispatch({ op: "recalculate", names: ["V"] })).toThrow(/V has no formula/);
  });
});

describe("saving formulas", () => {
  it("keeps formulas, their values and whether they were out of date", () => {
    const doc = docWith({ V: [2, 4], I: [1, 0] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V / I" });
    doc.dispatch({ op: "setFormula", name: "M", expr: "V + 1", auto: false });
    doc.dispatch({ op: "setFormula", name: "Q", expr: "V - 1", auto: false });
    doc.dispatch({ op: "setWavePoints", name: "I", start: 1, values: [0] });
    doc.dispatch({ op: "setWavePoints", name: "V", start: 0, values: [6] });
    doc.dispatch({ op: "recalculate", names: ["Q"] });
    const restored = new Doc();
    restored.load(unzipExperiment(zipExperiment(doc.getState(), [])).state);
    const state = restored.getState();
    expect([...state.waves.R!.data]).toEqual([6, NaN]);
    expect(state.waves.R!.formula).toMatchObject({ expr: "V / I", auto: true, zeroDivisions: 1 });
    expect(formulaStatus(state, "R", state.waves.R!.formula!).status).toBe("ok");
    expect(formulaStatus(state, "M", state.waves.M!.formula!).status).toBe("stale");
    expect(formulaStatus(state, "Q", state.waves.Q!.formula!).status).toBe("ok");
    // And they keep working.
    restored.dispatch({ op: "setWavePoints", name: "I", start: 1, values: [2] });
    expect([...restored.getState().waves.R!.data]).toEqual([6, 2]);
    restored.dispatch({ op: "recalculate" });
    expect([...restored.getState().waves.M!.data]).toEqual([7, 5]);
  });

  it("keeps an error and a missing input", () => {
    const doc = docWith({ V: [2, 4], I: [1, 2] });
    doc.dispatch({ op: "setFormula", name: "R", expr: "V / I" });
    doc.dispatch({ op: "killWaves", names: ["I"] });
    const state = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(formulaStatus(state, "R", state.waves.R!.formula!).status).toBe("missing");
    expect(state.waves.R!.formula!.error).toMatch(/Missing input/);
  });

  it("opens files that have no formulas, and leaves out one it cannot read", () => {
    const doc = docWith({ V: [1] });
    const file = zipExperiment(doc.getState(), []);
    expect(unzipExperiment(file).state.waves.V!.formula).toBeUndefined();
  });
});

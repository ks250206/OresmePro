import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { codeToRun, dedent, editMenuState } from "./commands";
import { diffText } from "./diff";

const FILE = "def area(r):\n    s = r * r\n    return 3 * s\n\nprint(area(2))\n";

/** A state of FILE with the selection given as [anchor, head] pairs. */
function stateWith(...ranges: [number, number][]) {
  return EditorState.create({
    doc: FILE,
    selection: EditorSelection.create(
      ranges.map(([anchor, head]) => EditorSelection.range(anchor, head)),
    ),
    extensions: [EditorState.allowMultipleSelections.of(true), history()],
  });
}

const at = (text: string) => FILE.indexOf(text);

describe("Run Selection", () => {
  it("runs the line the cursor is on, without its indentation", () => {
    expect(codeToRun(stateWith([at("s = r"), at("s = r")]))).toBe("s = r * r");
    expect(codeToRun(stateWith([at("print"), at("print")]))).toBe("print(area(2))");
  });

  it("runs just the selection within a line", () => {
    const from = at("area(2)");
    expect(codeToRun(stateWith([from, from + "area(2)".length]))).toBe("area(2)");
  });

  it("runs the lines a selection covers, whole and dedented", () => {
    // From the middle of one line to the middle of the next, selected backwards.
    expect(codeToRun(stateWith([at("* s"), at("r * r")]))).toBe("s = r * r\nreturn 3 * s");
  });

  it("leaves out the line a selection ends at the start of", () => {
    expect(codeToRun(stateWith([at("    s ="), at("\nprint")]))).toBe("s = r * r\nreturn 3 * s");
    expect(codeToRun(stateWith([0, at("print")]))).toBe(
      "def area(r):\n    s = r * r\n    return 3 * s",
    );
  });

  it("runs several selections one after the other", () => {
    expect(codeToRun(stateWith([at("s = r"), at("s = r")], [at("print"), at("print")]))).toBe(
      "s = r * r\nprint(area(2))",
    );
  });

  it("has nothing to run on a blank line", () => {
    expect(codeToRun(stateWith([at("\n\n") + 1, at("\n\n") + 1]))).toBe("");
  });

  it("dedents as Python's textwrap does", () => {
    expect(dedent("    a\n\n      b\n    c")).toBe("a\n\n  b\nc");
    expect(dedent("a\n  b")).toBe("a\n  b");
  });
});

describe("the editing items of the context menu", () => {
  it("follow the selection and the editor's own history", () => {
    let state = stateWith([0, 0]);
    expect(editMenuState(state)).toEqual({
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      hasText: true,
      canRunSelection: true,
    });
    state = state.update({ changes: { from: 0, insert: "# area\n" } }).state;
    state = state.update({ selection: { anchor: 0, head: 6 } }).state;
    expect(editMenuState(state)).toMatchObject({
      canUndo: true,
      canRedo: false,
      hasSelection: true,
    });
    undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    });
    expect(editMenuState(state)).toMatchObject({ canUndo: false, canRedo: true });
    expect(state.doc.toString()).toBe(FILE);
  });

  it("have nothing to act on in an empty editor", () => {
    const state = EditorState.create({ doc: "" });
    expect(editMenuState(state)).toMatchObject({
      hasText: false,
      hasSelection: false,
      canRunSelection: false,
    });
  });
});

/** Applies changes given in the coordinates of the original text, as CodeMirror does. */
function apply(text: string, changes: readonly { from: number; to: number; insert: string }[]) {
  let result = text;
  for (const change of [...changes].reverse()) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

describe("diffText", () => {
  it("changes only what differs", () => {
    const before = "import os\nx=[1,2]\n\ndef f( a ):\n  return a\n";
    const after = "import os\n\nx = [1, 2]\n\n\ndef f(a):\n    return a\n";
    const changes = diffText(before, after);
    expect(apply(before, changes)).toBe(after);
    // The first line is not touched.
    expect(changes[0]!.from).toBeGreaterThanOrEqual("import os\n".length);
  });

  it("handles text added or removed at either end", () => {
    for (const [a, b] of [
      ["", "a\nb"],
      ["a\nb", ""],
      ["a", "a\nb\n"],
      ["a\nb\n", "b\n"],
      ["x\ny", "x\ny\n"],
      ["same", "same"],
    ] as const) {
      expect(apply(a, diffText(a, b))).toBe(b);
    }
  });

  it("gives up on a fine diff past its limit, and is still right", () => {
    const a = Array.from({ length: 50 }, (_, index) => `a${index}`).join("\n");
    const b = Array.from({ length: 50 }, (_, index) => `b${index}`).join("\n");
    const changes = diffText(a, b, 10);
    expect(changes).toHaveLength(1);
    expect(apply(a, changes)).toBe(b);
  });

  it("agrees with a brute-force check on random edits", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const lines = Array.from({ length: Math.floor(random() * 12) }, () =>
        "abc"[Math.floor(random() * 3)]!.repeat(1 + Math.floor(random() * 2)),
      );
      const edited = lines.flatMap((line) =>
        random() < 0.2
          ? []
          : random() < 0.2
            ? [line, "new"]
            : random() < 0.1
              ? ["x" + line]
              : [line],
      );
      const a = lines.join("\n");
      const b = edited.join("\n");
      expect(apply(a, diffText(a, b))).toBe(b);
    }
  });
});

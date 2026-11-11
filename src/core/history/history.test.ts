import { describe, expect, it } from "vite-plus/test";
import { renderTerminalText, stripAnsi } from "./ansi";
import { History, recallList, searchHistory, stepRecall, suggestCompletion } from "./history";
import { isCompleteInput } from "./inputState";

describe("History", () => {
  it("merges consecutive stream output and records status", () => {
    const history = new History();
    const id = history.add("user", "print(1)", "running", 1000);
    history.appendOutput(id, { kind: "stream", name: "stdout", text: "a" });
    history.appendOutput(id, { kind: "stream", name: "stdout", text: "b" });
    history.appendOutput(id, { kind: "stream", name: "stderr", text: "c" });
    history.update(id, { status: "ok", durationMs: 12 });
    expect(history.getEntries()[0]).toMatchObject({
      status: "ok",
      durationMs: 12,
      outputs: [
        { kind: "stream", name: "stdout", text: "ab" },
        { kind: "stream", name: "stderr", text: "c" },
      ],
    });
  });

  it("marks interrupted entries as failed when reloaded", () => {
    const history = new History();
    history.add("user", "while True: pass", "running");
    const restored = new History();
    restored.load(history.getEntries());
    expect(restored.getEntries()[0]!.status).toBe("error");
    expect(restored.add("user", "1")).toBe(2);
  });
});

describe("recall", () => {
  const history = new History();
  for (const code of ["a = 1", "b = 2", "a = 1", "print(a)", "  ", "b = 3"])
    history.add("user", code);
  history.add("system", "Kernel restarted");
  history.add("gui", 'op.display("a")');
  const commands = recallList(history.getEntries());

  it("lists commands oldest first without repeats", () => {
    expect(commands).toEqual(["b = 2", "a = 1", "print(a)", "b = 3", 'op.display("a")']);
  });

  it("steps through commands sharing a prefix", () => {
    const first = stepRecall(commands, "b", commands.length, -1);
    expect(first).toBe(3);
    expect(stepRecall(commands, "b", first!, -1)).toBe(0);
    expect(stepRecall(commands, "b", 0, -1)).toBeNull();
    expect(stepRecall(commands, "b", 0, 1)).toBe(3);
  });

  it("searches by words, most recent first", () => {
    expect(searchHistory(commands, "b =")).toEqual(["b = 3", "b = 2"]);
    expect(searchHistory(commands, "DISPLAY")).toEqual(['op.display("a")']);
    expect(searchHistory(commands, "zzz")).toEqual([]);
  });

  it("suggests the rest of the most recent matching command", () => {
    expect(suggestCompletion(commands, "b")).toBe(" = 3");
    expect(suggestCompletion(commands, "op.")).toBe('display("a")');
    expect(suggestCompletion(commands, "b = 3")).toBe("");
    expect(suggestCompletion(commands, "")).toBe("");
  });
});

describe("isCompleteInput", () => {
  it.each([
    ["x = 1", true],
    ["print('a:b')", true],
    ["x = [1,", false],
    ["x = [1,\n 2]", true],
    ["def f():", false],
    ["def f():\n    return 1", false],
    ["def f():\n    return 1\n", true],
    ["for i in range(3): print(i)", true],
    ['"""doc', false],
    ['s = """a\nb"""', true],
    ["x = 1 \\", false],
    ["x = 1  # trailing: comment", true],
    ["@decorator", false],
    ["a = 1\nb = 2", true],
    ["", false],
    ["x = '('", true],
  ])("%j -> %s", (code, expected) => {
    expect(isCompleteInput(code)).toBe(expected);
  });
});

describe("terminal text", () => {
  it("applies colors", () => {
    expect(renderTerminalText("\x1b[31mred\x1b[0m plain\x1b[1;38;5;21m!")).toEqual([
      [
        { text: "red", fg: "#c4282b" },
        { text: " plain" },
        { text: "!", bold: true, fg: "rgb(0,0,255)" },
      ],
    ]);
  });

  it("lets a carriage return overwrite the line, as progress bars do", () => {
    expect(stripAnsi("10%\r20%\r100%\ndone")).toBe("100%\ndone");
    expect(stripAnsi("abcdef\rxy")).toBe("xycdef");
    expect(stripAnsi("abcdef\rxy\x1b[K")).toBe("xy");
  });

  it("drops other escape sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07a\x1b[2Ab\x1b[?25l")).toBe("ab");
  });
});

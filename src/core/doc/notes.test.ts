import { describe, expect, it } from "vite-plus/test";
import { importedNoteName } from "../../app/notes";
import { windowListItems } from "../../app/windowMenu";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { markdownToHtml } from "../markdown";
import { isTransient } from "./commands";
import { Doc } from "./doc";
import { echoPython } from "./echo";

describe("notes", () => {
  it("are windows of Markdown text, named Note0, Note1, ...", () => {
    const doc = new Doc();
    expect(doc.dispatch({ op: "newNote" })).toBe("Note0");
    expect(doc.dispatch({ op: "newNote", text: "# Run 2" })).toBe("Note1");
    expect(doc.getState().notes.Note1).toEqual({ name: "Note1", text: "# Run 2" });
    expect(doc.getState().windows.map((window) => [window.name, window.kind])).toEqual([
      ["Note0", "note"],
      ["Note1", "note"],
    ]);
    expect(() => doc.dispatch({ op: "newNote", name: "Note0" })).toThrow(/already exists/);
    expect(() => doc.dispatch({ op: "newNote", name: "a note" })).toThrow(/not a valid note name/);
    expect(() => doc.dispatch({ op: "setNote", name: "Nope", text: "" })).toThrow(/No note/);

    // Typing is the editor's to undo, as in a procedure: making the note is the document's.
    doc.dispatch({ op: "setNote", name: "Note0", text: "Hello" });
    expect(doc.getState().notes.Note0!.text).toBe("Hello");
    expect(isTransient({ op: "setNote", name: "Note0", text: "" })).toBe(true);
    doc.undo();
    expect(doc.getState().notes.Note1).toBeUndefined();
    expect(doc.getState().notes.Note0!.text).toBe("Hello");
  });

  it("are renamed, closed, reopened and killed like other windows", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newNote", name: "log", text: "x" });
    doc.dispatch({ op: "renameWindow", name: "log", newName: "diary" });
    expect(doc.getState().notes.diary).toEqual({ name: "diary", text: "x" });
    doc.dispatch({ op: "closeWindow", name: "diary" });
    const menu = windowListItems(doc.getState().windows, null);
    expect(menu.map((item) => ("label" in item ? item.label : ""))).toEqual(["Notes (1)"]);
    doc.dispatch({ op: "reopenWindow", name: "diary" });
    doc.dispatch({ op: "killWindow", name: "diary" });
    expect(doc.getState().notes).toEqual({});
    expect(doc.getState().windows).toEqual([]);
  });

  it("are saved with the experiment", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newNote", name: "log", text: "# Title\n\n- one\n" });
    doc.dispatch({ op: "closeWindow", name: "log" });
    const restored = unzipExperiment(zipExperiment(doc.getState(), [], [])).state;
    expect(restored.notes.log).toEqual({ name: "log", text: "# Title\n\n- one\n" });
    expect(restored.windows).toMatchObject([{ name: "log", kind: "note", hidden: true }]);
  });

  it("are made from Python, as the history shows", () => {
    expect(echoPython({ op: "newNote" })).toBe("op.new_note()");
    expect(echoPython({ op: "newNote", name: "log", text: "Hi" })).toBe(
      'op.new_note(name="log", text="Hi")',
    );
    expect(echoPython({ op: "setNote", name: "log", text: "Hi" })).toBeNull();
  });

  it("take their names from the Markdown files imported", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newNote", name: "notes" });
    expect(importedNoteName(doc.getState(), "run 12.md")).toBe("run_12");
    expect(importedNoteName(doc.getState(), "notes.md")).toBe("notes_0");
    expect(importedNoteName(doc.getState(), "2026-11-16.markdown")).toBe("Note_2026_11_16");
  });
});

describe("a note's Markdown", () => {
  it("is formatted", () => {
    const html = markdownToHtml(
      "# Run\n\n**bold** and `code`\n\n| a | b |\n|--:|---|\n| 1 | 2 |\n\n- [link](https://example.com)\n",
    );
    expect(html).toContain("<h1>Run</h1>");
    expect(html).toContain("<strong>bold</strong> and <code>code</code>");
    expect(html).toContain('<th style="text-align:right">a</th>');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>',
    );
  });

  it("never lets HTML or scripts through", () => {
    const html = markdownToHtml(
      [
        '<script>alert(1)</script><img src=x onerror="alert(2)">',
        "",
        "[js](javascript:alert(3)) [data](data:text/html,<b>x</b>) [file](file:///etc/passwd)",
        "",
        "<a href='https://x' onclick='alert(4)'>raw</a>",
      ].join("\n"),
    );
    // The only tags are paragraphs and a link to the https address, with no handlers.
    const tags = [...html.matchAll(/<([a-z]+)([^>]*)>/g)].map(([, tag, rest]) => [tag, rest]);
    expect(tags).toEqual([
      ["p", ""],
      ["p", ""],
      ["p", ""],
      ["a", ' href="https://x" target="_blank" rel="noopener noreferrer"'],
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("[js](javascript:alert(3))");
  });

  it("shows pictures only when they are in the text", () => {
    const inline = "data:image/png;base64,iVBORw0KGgo=";
    expect(markdownToHtml(`![dot](${inline})`)).toContain(`<img src="${inline}" alt="dot">`);
    const remote = markdownToHtml("![tracker](https://example.com/pixel.png)");
    expect(remote).not.toContain("<img");
    expect(remote).toContain(
      '<a href="https://example.com/pixel.png" target="_blank" rel="noopener noreferrer">Picture: tracker</a>',
    );
    expect(markdownToHtml("![x](relative.png)")).not.toContain("<img");
  });
});

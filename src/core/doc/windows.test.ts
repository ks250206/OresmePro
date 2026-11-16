import { describe, expect, it } from "vite-plus/test";
import { savedFileName } from "../../app/actions";
import { importedProcedureName } from "../../app/procedures";
import { windowListItems } from "../../app/windowMenu";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { frontWindow, openWindows, type WindowState } from "./types";

function setup(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: new Float64Array([1, 2, 3]) });
  doc.dispatch({ op: "display", y: ["y"], name: "G" });
  doc.dispatch({ op: "edit", waves: ["y"], name: "T" });
  doc.dispatch({ op: "newProcedure", name: "P", code: "x = 1\n" });
  return doc;
}

const names = (doc: Doc) => doc.getState().windows.map((window) => window.name);
const windowOf = (doc: Doc, name: string) =>
  doc.getState().windows.find((window) => window.name === name);

describe("closing a window and keeping what it shows", () => {
  it("hides the window at the back and keeps the graph, then reopens it in front", () => {
    const doc = setup();
    doc.dispatch({ op: "closeWindow", name: "G" });
    expect(windowOf(doc, "G")?.hidden).toBe(true);
    expect(names(doc)).toEqual(["G", "T", "P"]);
    expect(doc.getState().graphs.G).toBeDefined();
    expect(frontWindow(doc.getState().windows)?.name).toBe("P");
    expect(openWindows(doc.getState().windows).map((window) => window.name)).toEqual(["T", "P"]);
    // The name stays taken while it is closed.
    expect(() => doc.dispatch({ op: "display", y: ["y"], name: "G" })).toThrow(/already exists/);
    expect(() => doc.dispatch({ op: "activateWindow", name: "G" })).toThrow(/is closed/);

    // A closed graph keeps its waves, as it shows them when it is reopened.
    doc.dispatch({ op: "killWindow", name: "T" });
    expect(() => doc.dispatch({ op: "killWaves", names: ["y"] })).toThrow(
      'Wave "y" is in use by G (closed). Remove it from there first, or kill the closed window.',
    );
    doc.undo();

    doc.dispatch({ op: "reopenWindow", name: "G" });
    expect(windowOf(doc, "G")).not.toHaveProperty("hidden");
    expect(frontWindow(doc.getState().windows)?.name).toBe("G");
  });

  it("is undone, and a closed window can still be killed", () => {
    const doc = setup();
    const before = windowOf(doc, "T")!;
    doc.dispatch({ op: "closeWindow", name: "T" });
    doc.undo();
    expect(windowOf(doc, "T")).toEqual(before);
    doc.dispatch({ op: "closeWindow", name: "T" });
    doc.dispatch({ op: "killWindow", name: "T" });
    expect(windowOf(doc, "T")).toBeUndefined();
    expect(doc.getState().tables.T).toBeUndefined();
  });

  it("leaves no window in front when every one is closed", () => {
    const doc = setup();
    for (const name of ["G", "T", "P"]) doc.dispatch({ op: "closeWindow", name });
    expect(frontWindow(doc.getState().windows)).toBeNull();
  });

  it("is saved with the experiment and comes back closed", () => {
    const doc = setup();
    doc.dispatch({ op: "closeWindow", name: "P" });
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.windows.find((window) => window.name === "P")?.hidden).toBe(true);
    expect(back.procedures.P!.code).toBe("x = 1\n");
  });

  it("is written as Python", () => {
    expect(echoPython({ op: "closeWindow", name: "G" })).toBe('op.close_window("G")');
    expect(echoPython({ op: "reopenWindow", name: "G" })).toBe('op.reopen_window("G")');
  });
});

describe("renaming a window", () => {
  it("renames the graph, its window and the page layouts that show it", () => {
    const doc = setup();
    doc.dispatch({ op: "newLayout", name: "Fig" });
    doc.dispatch({ op: "addLayoutItem", layout: "Fig", kind: "graph", graph: "G" });
    const window = windowOf(doc, "G")!;
    expect(doc.dispatch({ op: "renameWindow", name: "G", newName: "Spectrum" })).toBe("Spectrum");
    const state = doc.getState();
    expect(state.graphs.G).toBeUndefined();
    expect(state.graphs.Spectrum!.name).toBe("Spectrum");
    expect(windowOf(doc, "Spectrum")).toEqual({ ...window, name: "Spectrum" });
    expect(state.pages.Fig!.items[0]!.graph).toBe("Spectrum");
    doc.undo();
    expect(doc.getState().graphs.G).toBeDefined();
    expect(doc.getState().pages.Fig!.items[0]!.graph).toBe("G");
  });

  it("renames tables, procedures, layouts and closed windows", () => {
    const doc = setup();
    doc.dispatch({ op: "renameWindow", name: "T", newName: "Results" });
    expect(doc.getState().tables.Results!.columns).toEqual(["y"]);
    doc.dispatch({ op: "renameWindow", name: "P", newName: "fits" });
    expect(doc.getState().procedures.fits).toEqual({
      name: "fits",
      code: "x = 1\n",
      autoRun: true,
    });
    doc.dispatch({ op: "closeWindow", name: "fits" });
    doc.dispatch({ op: "renameWindow", name: "fits", newName: "fits2" });
    expect(windowOf(doc, "fits2")?.hidden).toBe(true);
  });

  it("refuses names that are taken or not names, and module names that are not ASCII", () => {
    const doc = setup();
    expect(() => doc.dispatch({ op: "renameWindow", name: "G", newName: "T" })).toThrow(
      /already exists/,
    );
    expect(() => doc.dispatch({ op: "renameWindow", name: "G", newName: "2nd" })).toThrow();
    expect(() => doc.dispatch({ op: "renameWindow", name: "nope", newName: "X" })).toThrow(
      /No window named "nope"/,
    );
    expect(() => doc.dispatch({ op: "renameWindow", name: "P", newName: "解析" })).toThrow(
      /only ASCII letters/,
    );
    // Graphs may have names in any letters.
    doc.dispatch({ op: "renameWindow", name: "G", newName: "スペクトル" });
    expect(doc.getState().graphs["スペクトル"]).toBeDefined();
    // The same name changes nothing.
    expect(doc.dispatch({ op: "renameWindow", name: "T", newName: "T" })).toBe("T");
  });

  it("is written as Python", () => {
    expect(echoPython({ op: "renameWindow", name: "G", newName: "Spectrum" })).toBe(
      'op.rename_window("G", "Spectrum")',
    );
  });
});

describe("procedures from files", () => {
  it("are made without running when the experiment opens", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newProcedure", name: "fits", code: "a = 1\n", autoRun: false });
    expect(doc.getState().procedures.fits!.autoRun).toBe(false);
    expect(echoPython({ op: "newProcedure", name: "fits", code: "a = 1\n", autoRun: false })).toBe(
      'op.new_procedure(name="fits", code="a = 1\\n", auto_run=False)',
    );
  });

  it("are named after the file, as module names that are free", () => {
    const doc = setup();
    const state = doc.getState();
    expect(importedProcedureName(state, "peak fits.py")).toBe("peak_fits");
    expect(importedProcedureName(state, "2024-run.PY")).toBe("p_2024_run");
    expect(importedProcedureName(state, "解析.py")).toBe("Procedure");
    // P is a procedure already, and G a graph.
    expect(importedProcedureName(state, "P.py")).toBe("P_0");
    expect(importedProcedureName(state, "G.py")).toBe("G_0");
  });
});

describe("Save Experiment As", () => {
  it("saves under the name typed, as a .oresme file", () => {
    expect(savedFileName("run 2")).toBe("run 2.oresme");
    expect(savedFileName(" run2.oresme ")).toBe("run2.oresme");
    expect(savedFileName("a/b:c")).toBe("a_b_c.oresme");
    expect(savedFileName("  ")).toBeNull();
    expect(savedFileName(".oresme")).toBeNull();
  });
});

describe("the windows in the Windows menu", () => {
  const window = (name: string, kind: WindowState["kind"], hidden = false): WindowState => ({
    name,
    kind,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    ...(hidden ? { hidden } : {}),
  });

  it("are grouped by kind, open ones by name and then closed ones", () => {
    const windows = [
      window("Graph1", "graph", true),
      window("Table0", "table"),
      window("Graph2", "graph"),
      window("Graph0", "graph"),
      window("Procedure", "procedure"),
    ];
    const items = windowListItems(windows, windows[2]!);
    expect(items.map((item) => item.label)).toEqual(["Graphs (3)", "Tables (1)", "Procedures (1)"]);
    const graphs = items[0]!.submenu!;
    expect(graphs.map((item) => (item.separator ? "—" : item.label))).toEqual([
      "Graph0",
      "Graph2",
      "—",
      "Graph1 (closed)",
    ]);
    expect(graphs[1]!.checked).toBe(true);
    expect(windowListItems([], null)).toEqual([]);
  });
});

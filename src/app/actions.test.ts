import { describe, expect, it } from "vite-plus/test";
import {
  arrangeItems,
  graphsToArrange,
  importFile,
  loadFiles,
  selectedItems,
  selectItems,
} from "./actions";
import { igorFixture } from "../core/io/testdata/igor";
import { doc, files, history, ui } from "./session";

const csv = (name: string, value: number) => ({
  name,
  bytes: new TextEncoder().encode(`x,y\n1,${value}\n2,${value}\n`),
});

describe("loading files of data", () => {
  it("gives files loaded one after another distinct wave names instead of overwriting", async () => {
    await importFile(csv("a.csv", 10), {}, false);
    await importFile(csv("b.csv", 20), {}, false);
    const state = doc.getState();
    expect(state.waveOrder).toEqual(["x", "y", "x_1", "y_1"]);
    expect(Array.from(state.waves.y!.data)).toEqual([10, 10]);
    expect(Array.from(state.waves.y_1!.data)).toEqual([20, 20]);
  });

  it("does the same when two loads are started at once", async () => {
    await Promise.all([
      importFile(csv("c.csv", 30), {}, false),
      importFile(csv("d.csv", 40), {}, false),
    ]);
    const { waves, waveOrder } = doc.getState();
    expect(waveOrder).toHaveLength(8);
    expect(new Set(waveOrder).size).toBe(8);
    const loaded = waveOrder
      .filter((name) => name.startsWith("y"))
      .map((name) => waves[name]!.data[0]);
    expect(loaded.toSorted((a, b) => a! - b!)).toEqual([10, 20, 30, 40]);
  });

  it("keeps the file with the experiment and writes the Python that loads it again", async () => {
    const before = history.getEntries().length;
    expect(await importFile(csv("kept.csv", 50), { table: false, header: "yes" }, true)).toBe(true);
    expect(new TextDecoder().decode(files.get("kept.csv")!.bytes)).toBe("x,y\n1,50\n2,50\n");
    const entries = history.getEntries().slice(before);
    expect(entries.map((entry) => [entry.source, entry.code])).toEqual([
      ["gui", 'op.load_text("kept.csv", header="yes", table=False)'],
      ["system", "Loaded x_4, y_4 (2 points each) from kept.csv."],
    ]);
    expect(doc.getState().waves.y_4!.note).toMatch(
      /^Loaded from kept\.csv \(SHA-256 [0-9a-f]{64}\)$/,
    );
    // One step to undo.
    doc.undo();
    expect(doc.getState().waves.y_4).toBeUndefined();
  });

  it("opens the Load Data dialog for files that are dropped, one after another", async () => {
    await loadFiles([new File(["a\n1\n"], "one.csv"), new File(["b\n2\n"], "two.txt")]);
    const dialog = ui.get().dialog;
    expect(dialog).toMatchObject({ kind: "importData", file: { name: "one.csv" } });
    expect(dialog?.kind === "importData" && dialog.rest.map((file) => file.name)).toEqual([
      "two.txt",
    ]);
    ui.set({ dialog: null });
  });
});

describe("loading Igor files", () => {
  const igorFile = (fixture: string, name: string) =>
    new File([igorFixture(fixture) as Uint8Array<ArrayBuffer>], name);

  it("loads a dropped binary wave at once, as one undo step noted in the history", async () => {
    const before = history.getEntries().length;
    await loadFiles([igorFile("v5-be-3d.ibw", "cube.ibw"), new File(["a\n1\n"], "later.csv")]);
    expect(doc.getState().waves.cube).toMatchObject({ shape: [4, 3, 2], xUnit: "nanometre" });
    expect(doc.getState().waves.cube!.note).toMatch(
      /^Loaded from cube\.ibw \(SHA-256 [0-9a-f]{64}\): Igor wave cube, binary wave version 5/,
    );
    expect(
      history
        .getEntries()
        .slice(before)
        .map((entry) => [entry.source, entry.code]),
    ).toEqual([
      [
        "system",
        "Loaded cube (float64, 4×3×2) from cube.ibw.\nIgor's dimension labels are not loaded.\n" +
          'Igor\'s scaling of the layers: start 5, step 0.5, unit "K" (a wave here has scaling for its rows and columns only).',
      ],
    ]);
    // The text file still goes to the Load Data dialog.
    expect(ui.get().dialog).toMatchObject({ kind: "importData", file: { name: "later.csv" } });
    ui.set({ dialog: null });
    doc.undo();
    expect(doc.getState().waves.cube).toBeUndefined();
  });

  it("loads a packed experiment's waves and folders as one undo step", async () => {
    const before = doc.getState();
    await loadFiles([igorFile("experiment-le.pxp", "exp.pxp")]);
    const state = doc.getState();
    expect(state.waveOrder.length - before.waveOrder.length).toBe(21);
    expect(state.waves["raw_data:run_1:matrix"]).toMatchObject({ shape: [2, 3] });
    expect(state.folders).toContain("a_folder_whose_name_is_longer_than_31_bytes");
    expect(history.getEntries().at(-1)!.code).toMatch(/^Loaded 21 waves from exp\.pxp: /);
    doc.undo();
    expect(doc.getState().waveOrder).toEqual(before.waveOrder);
    expect(doc.getState().folders).toEqual(before.folders);
  });

  it("loads nothing from a damaged file and says why", async () => {
    const before = doc.getState().waveOrder;
    const bytes = igorFixture("experiment-be.pxp");
    await loadFiles([new File([bytes.slice(0, 4000)], "cut.pxp")]);
    expect(ui.get().alert).toEqual({
      title: "Could not load cut.pxp",
      message: expect.stringMatching(/^The file is cut short or damaged/) as string,
    });
    expect(doc.getState().waveOrder).toEqual(before);
    ui.set({ alert: null });
  });
});

describe("arranging a page layout from its window", () => {
  it("is one undo step, written into the history as the one call that does it", () => {
    doc.dispatch({ op: "makeWave", name: "arranged", data: Float64Array.of(1, 2) });
    const graphs = ["ArrangeA", "ArrangeB", "ArrangeC"];
    for (const name of graphs) doc.dispatch({ op: "display", y: ["arranged"], name });
    doc.dispatch({ op: "newLayout", name: "ArrangePage" });
    graphs.forEach((graph, index) =>
      doc.dispatch({
        op: "addLayoutItem",
        layout: "ArrangePage",
        kind: "graph",
        graph,
        x: 40 + 30 * index,
        y: 40 + 200 * index,
        w: 200,
        h: 150,
      }),
    );
    const before = doc.getState().pages.ArrangePage!.items;
    selectItems("ArrangePage", ["graph2", "graph0", "gone"]);
    // Names no longer on the page drop out; the order of selecting stays.
    expect(selectedItems("ArrangePage")).toEqual(["graph2", "graph0"]);

    expect(
      arrangeItems("ArrangePage", {
        action: "align",
        items: selectedItems("ArrangePage"),
        edge: "right",
      }),
    ).toBe(true);
    expect(doc.getState().pages.ArrangePage!.items.map((item) => item.x)).toEqual([100, 70, 100]);
    expect(history.getEntries().at(-1)?.code).toBe(
      'op.layout("ArrangePage").align(["graph2", "graph0"], "right")',
    );
    doc.undo();
    expect(doc.getState().pages.ArrangePage!.items).toEqual(before);

    const page = doc.getState().pages.ArrangePage!;
    // The grid takes the selected graphs in the order they read on the page.
    expect(graphsToArrange(page, ["graph2", "graph0"])).toEqual(["graph0", "graph2"]);
    expect(
      arrangeItems("ArrangePage", {
        action: "arrange",
        items: null,
        rows: 2,
        columns: 2,
        margin: 36,
        gap: [12, 12],
      }),
    ).toBe(true);
    expect(history.getEntries().at(-1)?.code).toBe(
      'op.layout("ArrangePage").arrange(2, 2, margin=36, gap=12)',
    );
    doc.undo();
    expect(doc.getState().pages.ArrangePage!.items).toEqual(before);

    // Refused: the user is told, and nothing is written or changed.
    const entries = history.getEntries().length;
    expect(
      arrangeItems("ArrangePage", {
        action: "distribute",
        items: ["graph0", "graph1"],
        direction: "vertical",
      }),
    ).toBe(false);
    expect(ui.get().alert?.message).toMatch(/three or more/);
    expect(history.getEntries()).toHaveLength(entries);
  });
});

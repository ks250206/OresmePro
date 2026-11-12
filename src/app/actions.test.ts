import { describe, expect, it } from "vite-plus/test";
import {
  arrangeItems,
  graphsToArrange,
  loadFile,
  loadFiles,
  selectedItems,
  selectItems,
} from "./actions";
import { doc, history, ui } from "./session";

const csv = (name: string, value: number) => new File([`x,y\n1,${value}\n2,${value}\n`], name);

describe("loading delimited text files", () => {
  it("gives files loaded together distinct wave names instead of overwriting", async () => {
    await loadFiles([csv("a.csv", 10), csv("b.csv", 20)]);
    const state = doc.getState();
    expect(state.waveOrder).toEqual(["x", "y", "x_1", "y_1"]);
    expect(Array.from(state.waves.y!.data)).toEqual([10, 10]);
    expect(Array.from(state.waves.y_1!.data)).toEqual([20, 20]);
  });

  it("does the same when two loads are started at once", async () => {
    await Promise.all([loadFile(csv("c.csv", 30)), loadFile(csv("d.csv", 40))]);
    const { waves, waveOrder } = doc.getState();
    expect(waveOrder).toHaveLength(8);
    expect(new Set(waveOrder).size).toBe(8);
    const loaded = waveOrder
      .filter((name) => name.startsWith("y"))
      .map((name) => waves[name]!.data[0]);
    expect(loaded.toSorted((a, b) => a! - b!)).toEqual([10, 20, 30, 40]);
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

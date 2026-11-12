import { describe, expect, it } from "vite-plus/test";
import {
  alignBoxes,
  arrangeLayout,
  distributeBoxes,
  gridCells,
  matchSizes,
  readingOrder,
} from "./arrange";
import { Doc } from "./doc";
import { echoArrangement } from "./echo";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const page = { width: 600, height: 800 };
/** Text 6 points wide per character, as a stand-in for a font. */
const measure = (text: string) => text.length * 6;

describe("lining up boxes", () => {
  const boxes = [box(10, 20, 100, 50), box(200, 5, 60, 80), box(50, 100, 30, 10)];

  it("aligns edges with the outermost box", () => {
    expect(alignBoxes(boxes, "left", page).map((b) => b.x)).toEqual([10, 10, 10]);
    expect(alignBoxes(boxes, "right", page).map((b) => b.x + b.w)).toEqual([260, 260, 260]);
    expect(alignBoxes(boxes, "top", page).map((b) => b.y)).toEqual([5, 5, 5]);
    expect(alignBoxes(boxes, "bottom", page).map((b) => b.y + b.h)).toEqual([110, 110, 110]);
    // Only the one coordinate changes.
    expect(alignBoxes(boxes, "left", page)[1]).toEqual(box(10, 5, 60, 80));
  });

  it("aligns middles with the middle of the boxes together", () => {
    // Across: 10 to 260, so the middle is at 135.
    expect(alignBoxes(boxes, "center", page).map((b) => b.x + b.w / 2)).toEqual([135, 135, 135]);
    // Down: 5 to 110, so the middle is at 57.5.
    expect(alignBoxes(boxes, "middle", page).map((b) => b.y + b.h / 2)).toEqual([57.5, 57.5, 57.5]);
  });

  it("aligns a single box with the page", () => {
    const one = [box(10, 20, 100, 50)];
    expect(alignBoxes(one, "left", page)[0]!.x).toBe(0);
    expect(alignBoxes(one, "right", page)[0]!.x).toBe(500);
    expect(alignBoxes(one, "center", page)[0]!.x).toBe(250);
    expect(alignBoxes(one, "bottom", page)[0]!.y).toBe(750);
    expect(alignBoxes(one, "middle", page)[0]!.y).toBe(375);
  });
});

describe("spacing boxes evenly", () => {
  it("leaves equal gaps between boxes of different sizes, keeping the outer ones", () => {
    // Given out of order: the order on the page is what counts.
    const boxes = [
      box(300, 0, 100, 10),
      box(0, 0, 50, 10),
      box(60, 0, 20, 10),
      box(100, 0, 30, 10),
    ];
    const spaced = distributeBoxes(boxes, "horizontal");
    // 0 to 400 holds 200 points of boxes: 200 points of room, 3 gaps of 66.67.
    const gap = 200 / 3;
    expect(spaced[1]!.x).toBe(0);
    expect(spaced[2]!.x).toBeCloseTo(50 + gap);
    expect(spaced[3]!.x).toBeCloseTo(70 + 2 * gap);
    expect(spaced[0]!.x + spaced[0]!.w).toBeCloseTo(400);
    expect(spaced.map((b) => b.y)).toEqual([0, 0, 0, 0]);
  });

  it("works down the page as well", () => {
    const spaced = distributeBoxes(
      [box(0, 0, 10, 100), box(5, 400, 10, 100), box(9, 110, 10, 40)],
      "vertical",
    );
    // 0 to 500 with 240 of boxes: gaps of 130.
    expect(spaced.map((b) => b.y)).toEqual([0, 400, 230]);
    expect(spaced.map((b) => b.x)).toEqual([0, 5, 9]);
  });

  it("leaves two boxes as they are", () => {
    const two = [box(0, 0, 10, 10), box(50, 0, 10, 10)];
    expect(distributeBoxes(two, "horizontal")).toEqual(two);
  });
});

describe("matching sizes", () => {
  it("makes boxes the size of the first, keeping their top left corners", () => {
    const boxes = [box(0, 0, 200, 100), box(300, 50, 80, 60)];
    expect(matchSizes(boxes, "width")[1]).toEqual(box(300, 50, 200, 60));
    expect(matchSizes(boxes, "height")[1]).toEqual(box(300, 50, 80, 100));
    expect(matchSizes(boxes, "both")[1]).toEqual(box(300, 50, 200, 100));
    expect(matchSizes(boxes, "both")[0]).toEqual(boxes[0]);
  });
});

describe("grids", () => {
  it("fill the area inside the margins, with gaps between cells, in reading order", () => {
    const cells = gridCells(2, 3, box(36, 36, 528, 300), [12, 20]);
    // (528 - 2 * 12) / 3 = 168 wide, (300 - 20) / 2 = 140 high.
    expect(cells).toEqual([
      box(36, 36, 168, 140),
      box(216, 36, 168, 140),
      box(396, 36, 168, 140),
      box(36, 196, 168, 140),
      box(216, 196, 168, 140),
      box(396, 196, 168, 140),
    ]);
  });

  it("read rows from the top, left to right within a row, even when roughly lined up", () => {
    const boxes = [
      box(300, 210, 100, 100), // second row, right
      box(0, 10, 100, 100), // first row, left
      box(310, 0, 100, 100), // first row, right (a little higher)
      box(5, 200, 100, 100), // second row, left
    ];
    expect(readingOrder(boxes)).toEqual([1, 2, 3, 0]);
  });
});

describe("arranging a page layout", () => {
  const setup = () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3) });
    for (let index = 0; index < 5; index += 1) doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({ op: "newLayout", name: "Fig", width: 600, height: 800 });
    const place = (graph: string, x: number, y: number, w: number, h: number) =>
      doc.dispatch({ op: "addLayoutItem", layout: "Fig", kind: "graph", graph, x, y, w, h });
    place("Graph0", 40, 40, 200, 100);
    place("Graph1", 300, 60, 150, 120);
    place("Graph2", 100, 300, 250, 90);
    doc.dispatch({
      op: "addLayoutItem",
      layout: "Fig",
      kind: "text",
      text: "Caption",
      x: 400,
      y: 500,
    });
    return doc;
  };
  const items = (doc: Doc) => doc.getState().pages.Fig!.items;
  const apply = (doc: Doc, request: Parameters<typeof arrangeLayout>[2]) => {
    const outcome = arrangeLayout(doc.getState(), "Fig", request, measure);
    for (const command of outcome.commands) doc.dispatch(command, { group: "one" });
    return outcome;
  };

  it("aligns graphs and text, with text as wide as its words", () => {
    const doc = setup();
    apply(doc, { action: "align", items: ["graph1", "text0", "graph0"], edge: "right" });
    // The outermost right edge was graph1's, at 450; "Caption" is 42 points wide.
    expect(items(doc).map((item) => item.x)).toEqual([250, 300, 100, 408]);
    expect(items(doc)[3]).toMatchObject({ w: 0, h: 0 });
  });

  it("changes only what moves, and is one step to undo", () => {
    const doc = setup();
    const before = items(doc);
    const { commands } = apply(doc, { action: "align", items: ["graph0", "graph2"], edge: "top" });
    expect(commands).toEqual([
      { op: "modifyLayoutItem", layout: "Fig", item: "graph2", props: { y: 40 } },
    ]);
    // Lined up already: nothing to do.
    expect(
      arrangeLayout(
        doc.getState(),
        "Fig",
        { action: "align", items: ["graph2", "graph0"], edge: "top" },
        measure,
      ).commands,
    ).toEqual([]);
    apply(doc, {
      action: "distribute",
      items: ["graph0", "graph1", "graph2"],
      direction: "horizontal",
    });
    expect(items(doc).map((item) => item.x)).not.toEqual(before.map((item) => item.x));
    doc.undo();
    expect(items(doc)).toEqual(before);
  });

  it("matches the size of the first graph and leaves text alone", () => {
    const doc = setup();
    apply(doc, { action: "matchSize", items: ["graph2", "text0", "graph0"], dimension: "both" });
    expect(items(doc)[0]).toMatchObject({ x: 40, y: 40, w: 250, h: 90 });
    expect(items(doc)[3]).toMatchObject({ x: 400, y: 500, w: 0, h: 0 });
    expect(() =>
      arrangeLayout(
        doc.getState(),
        "Fig",
        { action: "matchSize", items: ["graph0", "text0"], dimension: "width" },
        measure,
      ),
    ).toThrow(/two or more graphs/);
  });

  it("puts all graphs in a grid in reading order, and leaves text where it is", () => {
    const doc = setup();
    const { leftOut } = apply(doc, {
      action: "arrange",
      items: null,
      rows: 2,
      columns: 2,
      margin: 50,
      gap: [20, 10],
    });
    expect(leftOut).toEqual([]);
    // Cells (600 - 100 - 20) / 2 = 240 wide and (800 - 100 - 10) / 2 = 345 high.
    // graph0 and graph1 read as the first row; graph2 starts the second.
    expect(items(doc).map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [50, 50, 240, 345],
      [310, 50, 240, 345],
      [50, 405, 240, 345],
      [400, 500, 0, 0],
    ]);
  });

  it("puts the graphs named in the order given, and leaves out those beyond the cells", () => {
    const doc = setup();
    const { leftOut } = apply(doc, {
      action: "arrange",
      items: ["graph2", "text0", "graph0", "graph1"],
      rows: 1,
      columns: 2,
      margin: 0,
      gap: 0,
    });
    expect(leftOut).toEqual(["graph1"]);
    expect(items(doc).map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [300, 0, 300, 800],
      [300, 60, 150, 120],
      [0, 0, 300, 800],
      [400, 500, 0, 0],
    ]);
  });

  it("refuses what cannot be done, and names that are not items", () => {
    const doc = setup();
    const state = doc.getState();
    const attempt =
      (request: Record<string, unknown>, layout = "Fig") =>
      () =>
        arrangeLayout(state, layout, request, measure);
    expect(attempt({ action: "align", items: ["graph0"], edge: "top" }, "constructor")).toThrow(
      /No page layout/,
    );
    expect(attempt({ action: "align", items: ["constructor"], edge: "top" })).toThrow(
      /no item named "constructor"/,
    );
    expect(attempt({ action: "align", items: [], edge: "top" })).toThrow(/Name the items/);
    expect(attempt({ action: "align", items: ["graph0"], edge: "up" })).toThrow(/edge must be/);
    expect(
      attempt({ action: "distribute", items: ["graph0", "graph1"], direction: "horizontal" }),
    ).toThrow(/three or more/);
    expect(attempt({ action: "arrange", rows: 0, columns: 2 })).toThrow(/rows must be/);
    expect(attempt({ action: "arrange", rows: 2, columns: 2, gap: [1, 2, 3] })).toThrow(/gap/);
    expect(attempt({ action: "arrange", rows: 20, columns: 20 })).toThrow(/too little room/);
    expect(attempt({ action: "arrange", rows: 2, columns: 2, items: ["text0"] })).toThrow(
      /no graphs/,
    );
    expect(attempt({ action: "spin", items: [] })).toThrow(/action must be/);
  });
});

describe("arranging, written into the history", () => {
  it("is one Python call for the whole arrangement", () => {
    expect(
      echoArrangement("Fig", { action: "align", items: ["graph0", "text0"], edge: "left" }),
    ).toBe('op.layout("Fig").align(["graph0", "text0"], "left")');
    expect(
      echoArrangement("Fig", {
        action: "distribute",
        items: ["graph0", "graph1", "graph2"],
        direction: "vertical",
      }),
    ).toBe('op.layout("Fig").distribute(["graph0", "graph1", "graph2"], "vertical")');
    expect(
      echoArrangement("Fig", {
        action: "matchSize",
        items: ["graph1", "graph0"],
        dimension: "both",
      }),
    ).toBe('op.layout("Fig").match_size(["graph1", "graph0"], "both")');
    expect(
      echoArrangement("Fig", {
        action: "arrange",
        items: null,
        rows: 2,
        columns: 3,
        margin: 36,
        gap: [12, 12],
      }),
    ).toBe('op.layout("Fig").arrange(2, 3, margin=36, gap=12)');
    expect(
      echoArrangement("Fig", {
        action: "arrange",
        items: ["graph1", "graph0"],
        rows: 1,
        columns: 2,
        margin: 20,
        gap: [10, 24],
      }),
    ).toBe('op.layout("Fig").arrange(1, 2, items=["graph1", "graph0"], margin=20, gap=(10, 24))');
  });
});

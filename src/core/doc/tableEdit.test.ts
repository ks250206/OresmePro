import { describe, expect, it } from "vite-plus/test";
import { Doc } from "./doc";
import {
  clearCommands,
  pointCommands,
  selectionRange,
  tableEditCommands,
  type CellEdit,
  type TableColumn,
} from "./tableEdit";

const plane = { layer: 0, chunk: 0 };

function apply(doc: Doc, edits: CellEdit[], at = plane): void {
  const commands = tableEditCommands(doc.getState().waves, edits, at);
  expect(commands).not.toBeNull();
  for (const command of commands!) doc.dispatch(command);
}

/** The cells of a block pasted at (row, column j) of one matrix. */
const block = (wave: string, row: number, j: number, rows: string[][]): CellEdit[] =>
  rows.flatMap((cells, r) => cells.map((text, c) => ({ wave, j: j + c, row: row + r, text })));

describe("tableEditCommands", () => {
  it("keeps every cell of a block pasted into a matrix", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "m", data: new Float64Array(4), shape: [2, 2] });
    apply(
      doc,
      block("m", 0, 0, [
        ["1", "2"],
        ["3", "4"],
      ]),
    );
    // C order: [[1, 2], [3, 4]].
    expect(Array.from(doc.getState().waves.m!.data)).toEqual([1, 2, 3, 4]);
    expect(
      tableEditCommands(doc.getState().waves, block("m", 0, 0, [["5", "6"]]), plane),
    ).toHaveLength(1);
  });

  it("leaves the cells around a pasted block alone", () => {
    const doc = new Doc();
    const data = Float64Array.from({ length: 12 }, (_, index) => index);
    doc.dispatch({ op: "makeWave", name: "m", data, shape: [3, 4] });
    apply(
      doc,
      block("m", 1, 1, [
        ["-1", "-2"],
        ["-3", "-4"],
      ]),
    );
    expect(Array.from(doc.getState().waves.m!.data)).toEqual([
      0, 1, 2, 3, 4, -1, -2, 7, 8, -3, -4, 11,
    ]);
  });

  it("writes to the plane being shown and ignores rows past the end of a matrix", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "c", data: new Float64Array(8), shape: [2, 2, 2] });
    apply(
      doc,
      block("c", 1, 0, [
        ["7", "8"],
        ["9", "9"],
      ]),
      { layer: 1, chunk: 0 },
    );
    expect(Array.from(doc.getState().waves.c!.data)).toEqual([0, 0, 0, 0, 0, 7, 0, 8]);
  });

  it("extends 1-D waves and pastes several columns at once", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: new Float64Array([1, 2]) });
    doc.dispatch({ op: "makeWave", name: "t", text: ["x"] });
    apply(doc, [
      { wave: "a", j: null, row: 1, text: "20" },
      { wave: "t", j: null, row: 1, text: "y" },
      { wave: "a", j: null, row: 2, text: "" },
      { wave: "t", j: null, row: 2, text: "z" },
    ]);
    expect(Array.from(doc.getState().waves.a!.data)).toEqual([1, 20, Number.NaN]);
    expect(doc.getState().waves.t!.text).toEqual(["x", "y", "z"]);
  });

  it("reads dates in date waves and rejects text in numeric ones", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "when", data: new Float64Array([0]), unit: "dat" });
    apply(doc, [{ wave: "when", j: null, row: 0, text: "1970-01-02" }]);
    expect(doc.getState().waves.when!.data[0]).toBe(86400);
    expect(
      tableEditCommands(
        doc.getState().waves,
        [{ wave: "when", j: null, row: 0, text: "soon" }],
        plane,
      ),
    ).toBeNull();
  });
});

describe("ranges of cells", () => {
  const setup = () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3, 4, 5) });
    doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(10, 20, 30) });
    doc.dispatch({
      op: "makeWave",
      name: "m",
      data: Float64Array.of(1, 2, 3, 4, 5, 6),
      shape: [3, 2],
    });
    doc.dispatch({ op: "makeWave", name: "s", data: new Float64Array(0), text: ["x", "y", "z"] });
    const columns: TableColumn[] = [
      { wave: "a", j: null },
      { wave: "b", j: null },
      { wave: "m", j: 0 },
      { wave: "m", j: 1 },
      { wave: "s", j: null },
    ];
    return { doc, columns };
  };
  const run = (doc: Doc, commands: ReturnType<typeof clearCommands>) => {
    for (const command of commands) doc.dispatch(command);
  };

  it("orders the corners of a selection", () => {
    expect(selectionRange({ row: 4, column: 1 }, { row: 2, column: 3 })).toEqual({
      top: 2,
      bottom: 4,
      left: 1,
      right: 3,
    });
  });

  it("clears a range without growing the waves", () => {
    const { doc, columns } = setup();
    const range = { top: 1, bottom: 7, left: 0, right: 4 };
    run(doc, clearCommands(doc.getState().waves, columns, range, plane));
    const { a, b, m, s } = doc.getState().waves;
    expect(Array.from(a!.data)).toEqual([1, NaN, NaN, NaN, NaN]);
    expect(Array.from(b!.data)).toEqual([10, NaN, NaN]);
    expect(Array.from(m!.data)).toEqual([1, 2, NaN, NaN, NaN, NaN]);
    expect(s!.text).toEqual(["x", "", ""]);
  });

  it("clears one column of a matrix and leaves the other", () => {
    const { doc, columns } = setup();
    const range = { top: 0, bottom: 2, left: 3, right: 3 };
    run(doc, clearCommands(doc.getState().waves, columns, range, plane));
    expect(Array.from(doc.getState().waves.m!.data)).toEqual([1, NaN, 3, NaN, 5, NaN]);
  });

  it("clears nothing below the end of the waves", () => {
    const { doc, columns } = setup();
    const range = { top: 5, bottom: 9, left: 0, right: 1 };
    expect(clearCommands(doc.getState().waves, columns, range, plane)).toEqual([]);
  });

  it("deletes the selected rows from each 1-D wave that has them", () => {
    const { doc, columns } = setup();
    const range = { top: 2, bottom: 3, left: 0, right: 4 };
    run(doc, pointCommands(doc.getState().waves, columns, range, "delete"));
    const { a, b, m, s } = doc.getState().waves;
    expect(Array.from(a!.data)).toEqual([1, 2, 5]);
    expect(Array.from(b!.data)).toEqual([10, 20]);
    expect(m!.shape).toEqual([3, 2]);
    expect(s!.text).toEqual(["x", "y"]);
  });

  it("inserts as many rows as are selected", () => {
    const { doc, columns } = setup();
    const range = { top: 1, bottom: 2, left: 0, right: 0 };
    run(doc, pointCommands(doc.getState().waves, columns, range, "insert"));
    expect(Array.from(doc.getState().waves.a!.data)).toEqual([1, NaN, NaN, 2, 3, 4, 5]);
    expect(doc.getState().waves.b!.shape).toEqual([3]);
  });

  it("offers nothing for a matrix or for rows past the end", () => {
    const { doc, columns } = setup();
    const waves = doc.getState().waves;
    expect(
      pointCommands(waves, columns, { top: 0, bottom: 0, left: 2, right: 3 }, "delete"),
    ).toEqual([]);
    expect(
      pointCommands(waves, columns, { top: 8, bottom: 8, left: 0, right: 1 }, "insert"),
    ).toEqual([]);
  });
});

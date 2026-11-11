import { describe, expect, it } from "vite-plus/test";
import { Doc } from "./doc";
import { tableEditCommands, type CellEdit } from "./tableEdit";

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

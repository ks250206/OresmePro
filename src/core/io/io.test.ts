import { zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { timeZone } from "../plot/ticks";
import { columnsFromRows, parseDelimited } from "./delimited";
import { Doc } from "../doc/doc";
import { History } from "../history/history";
import { unzipExperiment, zipExperiment } from "./experiment";
import { decodeNpy, encodeNpy } from "./npy";
import excelWorkbook from "./testdata/excel.xlsx?inline";
import openpyxlWorkbook from "./testdata/openpyxl.xlsx?inline";
import { readXlsx } from "./xlsx";

describe("npy", () => {
  it("round-trips float64 data with an aligned header", () => {
    const data = new Float64Array([1.5, -2, Number.NaN, 1e300]);
    const bytes = encodeNpy(data);
    expect((bytes.length - data.byteLength) % 64).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(1, 6))).toBe("NUMPY");
    expect([...decodeNpy(bytes).data]).toEqual([...data]);
  });

  it("round-trips an empty array and rejects other files", () => {
    expect(decodeNpy(encodeNpy(new Float64Array(0))).data).toHaveLength(0);
    const matrix = decodeNpy(encodeNpy(new Float64Array(6), [2, 3]));
    expect(matrix.shape).toEqual([2, 3]);
    expect(() => decodeNpy(new Uint8Array([1, 2, 3]))).toThrow(/Not a .npy/);
  });

  it("keeps every wave type, and complex values as pairs", () => {
    const cases = [
      ["float32", Float32Array.of(0.5, -1.25)],
      ["int8", Int8Array.of(-128, 127)],
      ["uint8", Uint8Array.of(0, 255)],
      ["int16", Int16Array.of(-32768, 32767)],
      ["uint16", Uint16Array.of(0, 65535)],
      ["int32", Int32Array.of(-2147483648, 2147483647)],
      ["uint32", Uint32Array.of(0, 4294967295)],
    ] as const;
    for (const [type, data] of cases) {
      const file = encodeNpy(data, [2], type);
      const back = decodeNpy(file);
      expect([back.type, back.data.constructor, Array.from(back.data)]).toEqual([
        type,
        data.constructor,
        Array.from(data),
      ]);
      // Sized to the type: the header, then one element's bytes per value.
      expect((file.length - 2 * data.BYTES_PER_ELEMENT) % 64).toBe(0);
    }
    const file = encodeNpy(
      Float64Array.of(1, 2, 3),
      [3],
      "complex128",
      Float64Array.of(-1, -2, -3),
    );
    expect(new TextDecoder().decode(file.subarray(10, 60))).toContain("'descr': '<c16'");
    // Interleaved real and imaginary parts, as NumPy stores them.
    expect(Array.from(new Float64Array(file.slice(-48).buffer))).toEqual([1, -1, 2, -2, 3, -3]);
    const back = decodeNpy(file);
    expect([back.type, Array.from(back.data), Array.from(back.imag!)]).toEqual([
      "complex128",
      [1, 2, 3],
      [-1, -2, -3],
    ]);
    const single = decodeNpy(
      encodeNpy(Float32Array.of(1.5), [1], "complex64", Float32Array.of(2.5)),
    );
    expect([single.type, single.data[0], single.imag![0]]).toEqual(["complex64", 1.5, 2.5]);
  });
});

describe("parseDelimited", () => {
  const free = () => false;

  it("reads CSV with a header", () => {
    const result = parseDelimited("time (s),signal\n0,1.5\n1,2.5\n", free);
    expect(result.names).toEqual(["time_s", "signal"]);
    expect([...result.columns[1]!]).toEqual([1.5, 2.5]);
    expect(result.rows).toBe(2);
  });

  it("reads whitespace-separated numbers without a header", () => {
    const result = parseDelimited("# comment\n1  2\n3  4\n", free);
    expect(result.names).toEqual(["column0", "column1"]);
    expect([...result.columns[0]!]).toEqual([1, 3]);
  });

  it("reads tab-separated data, keeping text columns as text", () => {
    const result = parseDelimited("x\tlabel\ty\n1\ta\t\n2\tb\t5\n", free);
    expect(result.names).toEqual(["x", "label", "y"]);
    expect(result.columns[1]).toEqual(["a", "b"]);
    expect([...result.columns[2]!]).toEqual([Number.NaN, 5]);
  });

  it("reads a column of dates as seconds, marked as dates", () => {
    const result = parseDelimited("when,value\n2026-11-11 09:00,1\n2026-11-11 09:30,2\n", free);
    expect(result.dates).toEqual([true, false]);
    const [first, second] = result.columns[0] as Float64Array;
    expect(second! - first!).toBe(1800);
    expect(new Date(first! * 1000).toISOString()).toBe("2026-11-11T09:00:00.000Z");
  });

  it("keeps delimiters, quotes and line breaks that are inside quoted fields", () => {
    const result = parseDelimited('name,value\n"a,b",10\n"say ""hi""",20\n"two\nlines",30\n', free);
    expect(result.names).toEqual(["name", "value"]);
    expect(result.columns[0]).toEqual(["a,b", 'say "hi"', "two\nlines"]);
    expect(Array.from(result.columns[1] as Float64Array)).toEqual([10, 20, 30]);
  });

  it("loads files with more rows than a function call can take arguments", () => {
    const rows = 200_000;
    const text = `value\n${Array.from({ length: rows }, (_, index) => index).join("\n")}\n`;
    const result = parseDelimited(text, free);
    expect(result.rows).toBe(rows);
    expect((result.columns[0] as Float64Array)[rows - 1]).toBe(rows - 1);
  });

  it("keeps a column that mixes text and numbers as text, every cell as written", () => {
    const result = parseDelimited("name,value\nA,1\nB,2\n3,3\n4,4\n5,5\n", free);
    expect(result.names).toEqual(["name", "value"]);
    expect(result.columns[0]).toEqual(["A", "B", "3", "4", "5"]);
    expect(Array.from(result.columns[1] as Float64Array)).toEqual([1, 2, 3, 4, 5]);
    // A column of dates with a stray number is text too.
    const dates = parseDelimited("when\n2026-11-11\n7\n", free);
    expect([dates.dates[0], dates.columns[0]]).toEqual([false, ["2026-11-11", "7"]]);
  });

  it("reads markers of missing values as NaN, and infinities", () => {
    const markers =
      "NaN,nan,NA,na,N/A,#N/A,null,NULL,None,-,--,#DIV/0!,#VALUE!,#REF!,#NAME?,#NUM!,#NULL!";
    const text = [
      "value",
      "1",
      ...markers.split(","),
      "inf",
      "+Inf",
      "-inf",
      "Infinity",
      "-Infinity",
      "",
    ];
    const result = parseDelimited(text.map((cell, index) => `${index},${cell}`).join("\n"), free);
    expect(result.dates).toEqual([false, false]);
    expect(Array.from(result.columns[1] as Float64Array)).toEqual([
      1,
      ...markers.split(",").map(() => Number.NaN),
      Infinity,
      Infinity,
      -Infinity,
      Infinity,
      -Infinity,
      Number.NaN,
    ]);
    const dates = parseDelimited("when\n2026-11-11\nN/A\n\n", free);
    expect(dates.dates).toEqual([true]);
    expect((dates.columns[0] as Float64Array)[1]).toBeNaN();
    // A marker in a column of text is text like the rest.
    expect(parseDelimited("label\nA\nN/A\n-\n", free).columns[0]).toEqual(["A", "N/A", "-"]);
    // An Excel error at the start of a line is a value, not a comment.
    const first = parseDelimited("a,b\n#N/A,1\n#DIV/0!,2\n# note\n3,3\n", free);
    expect(Array.from(first.columns[0] as Float64Array)).toEqual([NaN, NaN, 3]);
    // "Na" is sodium, not "not available".
    expect(parseDelimited("element\nNa\n", free).columns[0]).toEqual(["Na"]);
  });

  it("avoids names that are taken", () => {
    const result = parseDelimited("x,x\n1,2\n", (name) => name === "x");
    expect(result.names).toEqual(["x_1", "x_2"]);
  });
});

describe("experiment files", () => {
  it("round-trips waves, folders, graphs, tables and history through one file", () => {
    const doc = new Doc();
    doc.dispatch({
      op: "makeWave",
      name: "run1:signal",
      data: new Float64Array([1, 2, 3]),
      dx: 0.5,
      unit: "V",
    });
    doc.dispatch({ op: "makeWave", name: "m", data: new Float64Array(6), shape: [2, 3], dy: 4 });
    doc.dispatch({ op: "makeWave", name: "labels", text: ["a", "b"] });
    doc.dispatch({ op: "makeWave", name: "counts", data: Uint16Array.of(7, 65535) });
    doc.dispatch({
      op: "makeWave",
      name: "spectrum",
      data: Float32Array.of(1, 2),
      imag: Float32Array.of(0.5, -0.5),
    });
    doc.dispatch({ op: "newFolder", path: "empty" });
    doc.dispatch({ op: "display", y: ["run1:signal"] });
    doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "B", trace: "signal", point: 1 });
    doc.dispatch({ op: "edit", waves: ["labels", "run1:signal"] });
    doc.dispatch({ op: "modifyTable", table: "Table0", props: { digits: 5 } });
    doc.dispatch({ op: "resizeColumn", table: "Table0", wave: "labels", width: 140 });
    doc.dispatch({ op: "setTimeZone", zone: "Europe/Paris" });
    doc.dispatch({ op: "newLayout", width: 842, height: 595 });
    doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "Graph0" });
    doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "text", text: "Caption" });
    doc.dispatch({ op: "newProcedure", code: "def f():\n    return 1\n" });
    doc.dispatch({ op: "setProcedure", name: "Procedure", autoRun: false });
    const history = new History();
    history.add("user", "print(1)");
    const stored = [
      { path: "out/fit.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") },
      { path: "raw.bin", bytes: Uint8Array.of(0, 255, 1) },
    ];

    const file = zipExperiment(doc.getState(), history.getEntries(), stored);
    expect(new TextDecoder().decode(file.subarray(0, 2))).toBe("PK");
    const restored = unzipExperiment(file);
    const before = doc.getState();
    expect(restored.state.waveOrder).toEqual(before.waveOrder);
    expect(restored.state.folders).toEqual(["run1", "empty"]);
    expect([...restored.state.waves["run1:signal"]!.data]).toEqual([1, 2, 3]);
    expect(restored.state.waves["run1:signal"]).toMatchObject({ dx: 0.5, unit: "V" });
    expect(restored.state.waves.m).toMatchObject({ shape: [2, 3], dy: 4 });
    expect(restored.state.waves.labels!.text).toEqual(["a", "b"]);
    const { counts, spectrum } = restored.state.waves;
    expect([counts!.type, counts!.data.constructor, Array.from(counts!.data)]).toEqual([
      "uint16",
      Uint16Array,
      [7, 65535],
    ]);
    expect([spectrum!.type, Array.from(spectrum!.data), Array.from(spectrum!.imag!)]).toEqual([
      "complex64",
      [1, 2],
      [0.5, -0.5],
    ]);
    expect(restored.state.graphs).toEqual(before.graphs);
    expect(restored.state.tables).toEqual(before.tables);
    expect(restored.state.procedures).toEqual(before.procedures);
    expect(restored.state.timeZone).toBe("Europe/Paris");
    expect(restored.state.pages).toEqual(before.pages);
    expect(before.pages.Layout0!.items).toHaveLength(2);
    expect(restored.state.windows).toEqual(before.windows);
    expect(restored.history[0]!.code).toBe("print(1)");
    expect(restored.files.map(([path, bytes]) => [path, Array.from(bytes)])).toEqual(
      stored.map((item) => [item.path, Array.from(item.bytes)]),
    );
  });

  it("rejects other files", () => {
    expect(() => unzipExperiment(new Uint8Array([1, 2, 3]))).toThrow(/not an OresmePro experiment/);
  });
});

describe("Excel workbooks", () => {
  // Two real files: one laid out as Excel writes them (shared strings, a
  // formula with its cached result, a title above the table that starts at
  // B4), one as openpyxl does (inline strings, a gap in the columns).
  // (They are imported as data URLs, which is how Vite hands a test a binary file.)
  const load = (dataUrl: string) =>
    readXlsx(
      Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) => char.charCodeAt(0)),
    );

  it("reads the sheets that have cells, as rows of text", () => {
    const sheets = load(excelWorkbook);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Run 1", "Second"]);
    expect(sheets[0]!.rows).toEqual([
      ["time", "temp (°C)", "sample", "count", "ok", "double", "day"],
      ["2026-01-15 09:00:00", "20.5", "alpha", "3", "1", "41.0", "2026-01-15"],
      ["2026-01-15 09:30:00", "21.25", "β & <tag>", "14", "0", "42.5", "2026-01-16"],
      ["2026-01-15 10:00:00", "0.3", "試料 3", "159", "1", "0.6000000000000001", "2026-02-01"],
    ]);
    expect(sheets[1]!.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("turns a sheet into waves: numbers, dates and text", () => {
    const [sheet] = load(excelWorkbook);
    const result = columnsFromRows(sheet!.rows, () => false);
    expect(result.names).toEqual(["time", "temp_C", "sample", "count", "ok", "double", "day"]);
    expect(result.dates).toEqual([true, false, false, false, false, false, true]);
    expect(Array.from(result.columns[0] as Float64Array)).toEqual(
      [9, 9.5, 10].map((hour) => Date.UTC(2026, 0, 15) / 1000 + hour * 3600),
    );
    // The number as stored, not as its format shows it.
    expect(Array.from(result.columns[1] as Float64Array)).toEqual([20.5, 21.25, 0.3]);
    expect(result.columns[2]).toEqual(["alpha", "β & <tag>", "試料 3"]);
    expect(Array.from(result.columns[5] as Float64Array)).toEqual([41, 42.5, 0.6000000000000001]);
    // Dates without an offset are on the clock of the zone asked for.
    const tokyo = columnsFromRows(sheet!.rows, () => false, timeZone("Asia/Tokyo"));
    expect((tokyo.columns[0] as Float64Array)[0]).toBe(Date.UTC(2026, 0, 15, 0) / 1000);
  });

  it("reads inline strings, empty cells and skips empty columns", () => {
    const [sheet] = load(openpyxlWorkbook);
    expect(sheet!.rows).toEqual([
      ["x", "y", "note", "when"],
      ["1", "1.5", "one", "2026-03-01 12:00:00"],
      ["2", "", "two", "2026-03-02 12:00:00"],
      ["3", "4.5", "", "2026-03-03 12:00:00"],
    ]);
    const result = columnsFromRows(sheet!.rows, (name) => name === "x");
    expect(result.names).toEqual(["x_1", "y", "note", "when"]);
    expect(Array.from(result.columns[1] as Float64Array)).toEqual([1.5, NaN, 4.5]);
    expect(result.columns[2]).toEqual(["one", "two", ""]);
  });

  it("says what is wrong with a file that is not a workbook", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3, 4]))).toThrow(/not an Excel workbook/);
    expect(() => readXlsx(zipSync({ "hello.txt": new Uint8Array(1) }))).toThrow(/\.xlsx/);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { parseDelimited } from "./delimited";
import { Doc } from "../doc/doc";
import { History } from "../history/history";
import { unzipExperiment, zipExperiment } from "./experiment";
import { decodeNpy, encodeNpy } from "./npy";

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
    doc.dispatch({ op: "newFolder", path: "empty" });
    doc.dispatch({ op: "display", y: ["run1:signal"] });
    doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "B", trace: "signal", point: 1 });
    doc.dispatch({ op: "edit", waves: ["labels", "run1:signal"] });
    const history = new History();
    history.add("user", "print(1)");

    const file = zipExperiment(doc.getState(), history.getEntries());
    expect(new TextDecoder().decode(file.subarray(0, 2))).toBe("PK");
    const restored = unzipExperiment(file);
    const before = doc.getState();
    expect(restored.state.waveOrder).toEqual(before.waveOrder);
    expect(restored.state.folders).toEqual(["run1", "empty"]);
    expect([...restored.state.waves["run1:signal"]!.data]).toEqual([1, 2, 3]);
    expect(restored.state.waves["run1:signal"]).toMatchObject({ dx: 0.5, unit: "V" });
    expect(restored.state.waves.m).toMatchObject({ shape: [2, 3], dy: 4 });
    expect(restored.state.waves.labels!.text).toEqual(["a", "b"]);
    expect(restored.state.graphs).toEqual(before.graphs);
    expect(restored.state.tables).toEqual(before.tables);
    expect(restored.history[0]!.code).toBe("print(1)");
  });

  it("rejects other files", () => {
    expect(() => unzipExperiment(new Uint8Array([1, 2, 3]))).toThrow(/not an OresmePro experiment/);
  });
});

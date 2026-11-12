import { describe, expect, it } from "vite-plus/test";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { DocError } from "./types";

const wave = (...values: number[]) => new Float64Array(values);

function sample(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "signal", data: wave(1, 2, 3), dx: 0.5, xUnit: "s" });
  doc.dispatch({ op: "makeWave", name: "time", data: wave(0, 1, 2) });
  return doc;
}

describe("waves", () => {
  it("creates, overwrites and keeps scaling on overwrite", () => {
    const doc = sample();
    const before = doc.getState().waves.signal!.rev;
    doc.dispatch({ op: "makeWave", name: "signal", data: wave(9) });
    const signal = doc.getState().waves.signal!;
    expect([...signal.data]).toEqual([9]);
    expect(signal.dx).toBe(0.5);
    expect(signal.rev).toBeGreaterThan(before);
    expect(doc.getState().waveOrder).toEqual(["signal", "time"]);
  });

  it("rejects illegal names", () => {
    const doc = new Doc();
    expect(() => doc.dispatch({ op: "makeWave", name: "1abc", data: wave() })).toThrow(DocError);
    expect(() => doc.dispatch({ op: "makeWave", name: "a b", data: wave() })).toThrow(DocError);
  });

  it("edits points, extending the wave by appending", () => {
    const doc = sample();
    doc.dispatch({ op: "setWavePoints", name: "signal", start: 2, values: [7, 8] });
    expect([...doc.getState().waves.signal!.data]).toEqual([1, 2, 7, 8]);
    expect(() =>
      doc.dispatch({ op: "setWavePoints", name: "signal", start: 9, values: [1] }),
    ).toThrow(/out of range/);
  });

  it("inserts and deletes points", () => {
    const doc = sample();
    doc.dispatch({ op: "insertPoints", name: "signal", at: 1, count: 2 });
    expect([...doc.getState().waves.signal!.data]).toEqual([1, NaN, NaN, 2, 3]);
    doc.dispatch({ op: "deletePoints", name: "signal", at: 0, count: 3 });
    expect([...doc.getState().waves.signal!.data]).toEqual([2, 3]);
  });

  it("refuses to kill a wave that is in use", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    expect(() => doc.dispatch({ op: "killWaves", names: ["signal"] })).toThrow(/in use by Graph0/);
    doc.dispatch({ op: "killWaves", names: ["time"] });
    expect(doc.getState().waveOrder).toEqual(["signal"]);
  });

  it("renames a wave everywhere it is used", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"], x: "time" });
    doc.dispatch({ op: "edit", waves: ["signal", "time"] });
    doc.dispatch({ op: "renameWave", name: "signal", newName: "volts" });
    const state = doc.getState();
    expect(state.graphs.Graph0!.traces[0]).toMatchObject({ name: "volts", y: "volts", x: "time" });
    expect(state.tables.Table0!.columns).toEqual(["volts", "time"]);
    expect(state.waveOrder).toEqual(["volts", "time"]);
  });
});

describe("graphs", () => {
  it("names windows and repeated traces like Igor", () => {
    const doc = sample();
    expect(doc.dispatch({ op: "display", y: ["signal", "signal"] })).toBe("Graph0");
    expect(doc.dispatch({ op: "display", y: [] })).toBe("Graph1");
    const traces = doc.getState().graphs.Graph0!.traces;
    expect(traces.map((trace) => trace.name)).toEqual(["signal", "signal#1"]);
    expect(traces.map((trace) => trace.color)).toEqual(["#ff0000", "#0000ff"]);
  });

  it("requires X and Y waves of equal length", () => {
    const doc = sample();
    doc.dispatch({ op: "makeWave", name: "short", data: wave(1) });
    expect(() => doc.dispatch({ op: "display", y: ["signal"], x: "short" })).toThrow(/points/);
  });

  it("validates trace and axis properties", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    doc.dispatch({
      op: "modifyTrace",
      graph: "Graph0",
      trace: "signal",
      props: { color: "blue", lineSize: 2 },
    });
    expect(doc.getState().graphs.Graph0!.traces[0]).toMatchObject({
      color: "#0000ff",
      lineSize: 2,
    });
    expect(() =>
      doc.dispatch({
        op: "modifyTrace",
        graph: "Graph0",
        trace: "signal",
        props: { colour: "red" },
      }),
    ).toThrow(/Unknown trace property "colour"/);
    expect(() =>
      doc.dispatch({
        op: "modifyAxis",
        graph: "Graph0",
        axis: "left",
        props: { log: true, min: 0 },
      }),
    ).toThrow(/log axis/);
  });

  it("adds and removes annotations", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    expect(doc.dispatch({ op: "addAnnotation", graph: "Graph0", kind: "legend" })).toBe("legend0");
    doc.dispatch({ op: "removeAnnotation", graph: "Graph0", annotation: "legend0" });
    expect(doc.getState().graphs.Graph0!.annotations).toEqual([]);
  });
});

describe("undo", () => {
  it("undoes and redoes commands", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    expect(doc.undo()).toBe(true);
    expect(doc.getState().graphs).toEqual({});
    expect(doc.redo()).toBe(true);
    expect(Object.keys(doc.getState().graphs)).toEqual(["Graph0"]);
  });

  it("undoes a group of commands in one step", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: wave(1) }, { group: "run1" });
    doc.dispatch({ op: "makeWave", name: "b", data: wave(1) }, { group: "run1" });
    doc.undo();
    expect(doc.getState().waveOrder).toEqual([]);
  });

  it("does not record window moves, and keeps them across undo", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    doc.dispatch({ op: "modifyGraph", graph: "Graph0", props: { fontSize: 20 } });
    doc.dispatch({ op: "moveWindow", name: "Graph0", x: 300, y: 200 });
    doc.undo();
    const state = doc.getState();
    expect(state.graphs.Graph0!.fontSize).toBe(12);
    expect(state.windows[0]).toMatchObject({ x: 300, y: 200 });
  });
});

describe("echoPython", () => {
  it("writes GUI commands as Python", () => {
    expect(echoPython({ op: "display", y: ["a", "b"], x: "t" })).toBe(
      'op.display("a", "b", x="t")',
    );
    expect(echoPython({ op: "setWavePoints", name: "a", start: 3, values: [1.5] })).toBe(
      'op.wave("a")[3] = 1.5',
    );
    expect(echoPython({ op: "setWavePoints", name: "a", start: 3, values: [1, NaN] })).toBe(
      'op.wave("a")[3:5] = [1, float("nan")]',
    );
    expect(
      echoPython({
        op: "modifyTrace",
        graph: "Graph0",
        trace: "a",
        props: { lineSize: 2, markerFill: false },
      }),
    ).toBe('op.graph("Graph0").trace("a").set(line_size=2, marker_fill=False)');
    expect(
      echoPython({ op: "modifyAxis", graph: "Graph0", axis: "left", props: { min: 0, max: 5 } }),
    ).toBe('op.graph("Graph0").axis("left").set(range=(0, 5))');
    expect(
      echoPython({
        op: "modifyAxis",
        graph: "Graph0",
        axis: "left",
        props: { min: null, max: null },
      }),
    ).toBe('op.graph("Graph0").axis("left").autoscale()');
    expect(echoPython({ op: "appendTraces", graph: "Graph0", y: ["a"], vAxis: "right" })).toBe(
      'op.graph("Graph0").append("a", axis="right")',
    );
    expect(echoPython({ op: "addAnnotation", graph: "Graph0", kind: "legend" })).toBe(
      'op.graph("Graph0").legend()',
    );
    expect(echoPython({ op: "moveWindow", name: "Graph0", x: 1 })).toBeNull();
  });
});

describe("data folders", () => {
  it("creates folders on demand and lists parents first", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "root:run1:raw:signal", data: wave(1) });
    expect(doc.getState().folders).toEqual(["run1", "run1:raw"]);
    expect(doc.getState().waveOrder).toEqual(["run1:raw:signal"]);
  });

  it("moves a folder with its waves and keeps graphs pointing at them", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "run1:signal", data: wave(1, 2) });
    doc.dispatch({ op: "display", y: ["run1:signal"] });
    doc.dispatch({ op: "renameFolder", path: "run1", newPath: "archive:run1" });
    const state = doc.getState();
    expect(state.folders).toEqual(["archive:run1", "archive"]);
    expect(state.graphs.Graph0!.traces[0]).toMatchObject({
      name: "signal",
      y: "archive:run1:signal",
    });
  });

  it("kills a folder unless a wave in it is in use", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a:x", data: wave(1) });
    doc.dispatch({ op: "makeWave", name: "a:b:y", data: wave(1) });
    doc.dispatch({ op: "edit", waves: ["a:b:y"] });
    expect(() => doc.dispatch({ op: "killFolder", path: "a" })).toThrow(/in use by Table0/);
    doc.dispatch({ op: "killWindow", name: "Table0" });
    doc.dispatch({ op: "killFolder", path: "a" });
    expect(doc.getState().folders).toEqual([]);
    expect(doc.getState().waveOrder).toEqual([]);
  });
});

describe("multi-dimensional and text waves", () => {
  it("checks that the shape matches the data", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "m", data: new Float64Array(6), shape: [2, 3] });
    expect(doc.getState().waves.m!.shape).toEqual([2, 3]);
    expect(() =>
      doc.dispatch({ op: "makeWave", name: "bad", data: new Float64Array(6), shape: [4, 2] }),
    ).toThrow(/does not match/);
    doc.dispatch({ op: "setWaveData", name: "m", data: new Float64Array(6).fill(1) });
    expect(doc.getState().waves.m!.shape).toEqual([2, 3]);
    doc.dispatch({ op: "setWavePoints", name: "m", start: 4, values: [9, 9] });
    expect(() =>
      doc.dispatch({ op: "setWavePoints", name: "m", start: 5, values: [9, 9] }),
    ).toThrow(/out of range/);
  });

  it("refuses a matrix as a trace and a vector as an image", () => {
    const doc = sample();
    doc.dispatch({ op: "makeWave", name: "m", data: new Float64Array(6), shape: [2, 3] });
    expect(() => doc.dispatch({ op: "display", y: ["m"] })).toThrow(/image or contour/);
    doc.dispatch({ op: "display", y: [] });
    expect(() => doc.dispatch({ op: "appendImage", graph: "Graph0", wave: "signal" })).toThrow(
      /has one dimension/,
    );
    expect(doc.dispatch({ op: "appendImage", graph: "Graph0", wave: "m" })).toBe("m");
  });

  it("inserts a very large number of text points", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "labels", text: ["a", "b"] });
    doc.dispatch({ op: "insertPoints", name: "labels", at: 1, count: 300_000 });
    const text = doc.getState().waves.labels!.text!;
    expect(text).toHaveLength(300_002);
    expect([text[0], text[1], text.at(-1)]).toEqual(["a", "", "b"]);
  });

  it("stores and edits text", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "labels", text: ["a", "b"] });
    doc.dispatch({ op: "setWaveText", name: "labels", start: 2, values: ["c"] });
    doc.dispatch({ op: "deletePoints", name: "labels", at: 0, count: 1 });
    expect(doc.getState().waves.labels).toMatchObject({ text: ["b", "c"], shape: [2] });
    expect(() => doc.dispatch({ op: "display", y: ["labels"] })).toThrow(/text wave/);
  });
});

describe("axes, cursors and error bars", () => {
  it("adds named axes and checks their orientation", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    doc.dispatch({ op: "addAxis", graph: "Graph0", name: "L2", side: "left" });
    expect(() =>
      doc.dispatch({ op: "appendTraces", graph: "Graph0", y: ["time"], hAxis: "L2" }),
    ).toThrow(/vertical; a horizontal axis is needed/);
    doc.dispatch({ op: "appendTraces", graph: "Graph0", y: ["time"], vAxis: "L2" });
    expect(() => doc.dispatch({ op: "removeAxis", graph: "Graph0", axis: "L2" })).toThrow(/in use/);
    expect(() => doc.dispatch({ op: "removeAxis", graph: "Graph0", axis: "left" })).toThrow(
      /cannot be removed/,
    );
    expect(() =>
      doc.dispatch({ op: "modifyAxis", graph: "Graph0", axis: "L2", props: { span: [0.6, 0.5] } }),
    ).toThrow(/span/);
  });

  it("keeps cursors with their trace", () => {
    const doc = sample();
    doc.dispatch({ op: "display", y: ["signal"] });
    doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "A", trace: "signal", point: 2 });
    expect(() =>
      doc.dispatch({ op: "setCursor", graph: "Graph0", cursor: "B", trace: "signal", point: 3 }),
    ).toThrow(/out of range/);
    doc.dispatch({ op: "renameWave", name: "signal", newName: "volts" });
    expect(doc.getState().graphs.Graph0!.cursors.A).toEqual({ trace: "volts", point: 2 });
    doc.dispatch({ op: "removeTraces", graph: "Graph0", traces: ["volts"] });
    expect(doc.getState().graphs.Graph0!.cursors).toEqual({});
  });

  it("accepts a constant or a matching wave as error bars", () => {
    const doc = sample();
    doc.dispatch({ op: "makeWave", name: "short", data: wave(1) });
    doc.dispatch({ op: "display", y: ["signal"] });
    const modify = (props: Record<string, unknown>) =>
      doc.dispatch({ op: "modifyTrace", graph: "Graph0", trace: "signal", props });
    modify({ yError: 0.1, xError: "time" });
    expect(doc.getState().graphs.Graph0!.traces[0]).toMatchObject({ yError: 0.1, xError: "time" });
    expect(() => modify({ yError: "short" })).toThrow(/1 points but signal has 3/);
    expect(() => doc.dispatch({ op: "killWaves", names: ["time"] })).toThrow(/in use/);
  });
});

describe("echoPython for new commands", () => {
  it("writes them as Python", () => {
    expect(echoPython({ op: "addAxis", graph: "G", name: "L2", side: "left" })).toBe(
      'op.graph("G").add_axis("L2", "left")',
    );
    expect(
      echoPython({ op: "modifyAxis", graph: "G", axis: "L2", props: { span: [0.5, 1] } }),
    ).toBe('op.graph("G").axis("L2").set(span=[0.5, 1])');
    expect(
      echoPython({ op: "appendImage", graph: "G", wave: "m", props: { colorTable: "viridis" } }),
    ).toBe('op.graph("G").append_image("m", color_table="viridis")');
    expect(echoPython({ op: "setCursor", graph: "G", cursor: "A", trace: "a", point: 7 })).toBe(
      'op.graph("G").cursor("A", "a", 7)',
    );
    expect(echoPython({ op: "newFolder", path: "run1" })).toBe('op.new_folder("run1")');
    expect(echoPython({ op: "setWaveText", name: "t", start: 0, values: ["x"] })).toBe(
      'op.wave("t")[0] = "x"',
    );
  });
});

describe("tables", () => {
  const setup = () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2) });
    doc.dispatch({ op: "makeWave", name: "b", data: Float64Array.of(3, 4) });
    doc.dispatch({ op: "edit", waves: ["a", "b"] });
    return doc;
  };

  it("sets how many digits a table shows", () => {
    const doc = setup();
    expect(doc.getState().tables.Table0!.digits).toBe(8);
    doc.dispatch({ op: "modifyTable", table: "Table0", props: { digits: 12 } });
    expect(doc.getState().tables.Table0!.digits).toBe(12);
    expect(() =>
      doc.dispatch({ op: "modifyTable", table: "Table0", props: { digits: 0 } }),
    ).toThrow();
    expect(() =>
      doc.dispatch({ op: "modifyTable", table: "Table0", props: { digits: 2.5 } }),
    ).toThrow();
    doc.undo();
    expect(doc.getState().tables.Table0!.digits).toBe(8);
    expect(echoPython({ op: "modifyTable", table: "Table0", props: { digits: 12 } })).toBe(
      'op.table("Table0").set(digits=12)',
    );
  });

  it("keeps column widths with the waves they belong to", () => {
    const doc = setup();
    doc.dispatch({ op: "resizeColumn", table: "Table0", wave: "a", width: 150.4 });
    doc.dispatch({ op: "resizeColumn", table: "Table0", wave: "b", width: 5 });
    expect(doc.getState().tables.Table0!.widths).toEqual({ a: 150, b: 32 });
    doc.dispatch({ op: "removeFromTable", table: "Table0", waves: ["b"] });
    doc.dispatch({ op: "renameWave", name: "a", newName: "run:a" });
    expect(doc.getState().tables.Table0!.widths).toEqual({ "run:a": 150 });
    doc.dispatch({ op: "removeFromTable", table: "Table0", waves: ["run:a"] });
    expect(doc.getState().tables.Table0!.widths).toEqual({});
    // A width for a wave the table does not show is dropped.
    doc.dispatch({ op: "resizeColumn", table: "Table0", wave: "zz", width: 90 });
    expect(doc.getState().tables.Table0!.widths).toEqual({});
  });

  it("writes matrix cells by their indices in the history", () => {
    const shape = () => [3, 4];
    expect(echoPython({ op: "setWavePoints", name: "m", start: 6, values: [9] }, shape)).toBe(
      'op.wave("m")[1, 2] = 9',
    );
    expect(echoPython({ op: "setWavePoints", name: "m", start: 2, values: [1, 2, 3] }, shape)).toBe(
      'op.wave("m").flat[2:5] = [1, 2, 3]',
    );
    expect(echoPython({ op: "setWavePoints", name: "a", start: 1, values: [NaN, NaN, NaN] })).toBe(
      'op.wave("a")[1:4] = float("nan")',
    );
  });
});

describe("procedures", () => {
  it("are windows with a Python file's text", () => {
    const doc = new Doc();
    expect(doc.dispatch({ op: "newProcedure" })).toBe("Procedure");
    expect(doc.dispatch({ op: "newProcedure", code: "x = 1\n" })).toBe("Procedure1");
    expect(doc.getState().windows.map((window) => [window.name, window.kind])).toEqual([
      ["Procedure", "procedure"],
      ["Procedure1", "procedure"],
    ]);
    expect(doc.getState().procedures.Procedure1).toEqual({
      name: "Procedure1",
      code: "x = 1\n",
      autoRun: true,
    });
    // The name is a module name, and windows share one set of names.
    expect(() => doc.dispatch({ op: "newProcedure", name: "données" })).toThrow();
    expect(() => doc.dispatch({ op: "newProcedure", name: "Procedure" })).toThrow();
    expect(() => doc.dispatch({ op: "display", y: [], name: "Procedure" })).toThrow();
    expect(echoPython({ op: "newProcedure", name: "Fits" })).toBe('op.new_procedure(name="Fits")');
    expect(echoPython({ op: "setProcedure", name: "Fits", code: "x" })).toBeNull();
  });

  it("keep their text through undo, which their editor handles itself", () => {
    const doc = new Doc();
    doc.dispatch({ op: "newProcedure" });
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1) });
    doc.dispatch({ op: "setProcedure", name: "Procedure", code: "typed later" });
    doc.dispatch({ op: "setProcedure", name: "Procedure", autoRun: false });
    doc.undo();
    expect(doc.getState().waves.a).toBeUndefined();
    expect(doc.getState().procedures.Procedure).toMatchObject({
      code: "typed later",
      autoRun: false,
    });
    doc.redo();
    expect(doc.getState().procedures.Procedure!.code).toBe("typed later");

    // Closing the window is undone with the text it had.
    doc.dispatch({ op: "killWindow", name: "Procedure" });
    expect(doc.getState().procedures.Procedure).toBeUndefined();
    doc.undo();
    expect(doc.getState().procedures.Procedure!.code).toBe("typed later");
  });

  it("keep column widths through undo as well", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1) });
    doc.dispatch({ op: "edit", waves: ["a"] });
    doc.dispatch({ op: "modifyTable", table: "Table0", props: { digits: 4 } });
    doc.dispatch({ op: "resizeColumn", table: "Table0", wave: "a", width: 200 });
    doc.undo();
    expect(doc.getState().tables.Table0).toMatchObject({ digits: 8, widths: { a: 200 } });
  });
});

describe("time zone", () => {
  it("is a setting of the experiment", () => {
    const doc = new Doc();
    expect(doc.getState().timeZone).toBe("UTC");
    doc.dispatch({ op: "setTimeZone", zone: "Asia/Tokyo" });
    expect(doc.getState().timeZone).toBe("Asia/Tokyo");
    expect(() => doc.dispatch({ op: "setTimeZone", zone: "Nowhere/Land" })).toThrow(/time zone/);
    doc.undo();
    expect(doc.getState().timeZone).toBe("UTC");
    expect(echoPython({ op: "setTimeZone", zone: "local" })).toBe('op.set_time_zone("local")');
  });
});

describe("wave types", () => {
  it("takes the type of the data and converts to a type asked for", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "f", data: Float32Array.of(0.1, 2) });
    doc.dispatch({
      op: "makeWave",
      name: "i",
      data: Float64Array.of(1.6, -2.5, 70000, NaN),
      type: "int16",
    });
    doc.dispatch({
      op: "makeWave",
      name: "c",
      data: Float64Array.of(1, 2),
      imag: Float64Array.of(3, 4),
    });
    const { f, i, c } = doc.getState().waves;
    expect([f!.type, f!.data.constructor.name]).toEqual(["float32", "Float32Array"]);
    // Rounded to the nearest whole number and held at the ends of the range.
    expect([i!.type, Array.from(i!.data)]).toEqual(["int16", [2, -2, 32767, 0]]);
    expect(i!.data).toBeInstanceOf(Int16Array);
    expect([c!.type, Array.from(c!.data), Array.from(c!.imag!)]).toEqual([
      "complex128",
      [1, 2],
      [3, 4],
    ]);
    expect(() =>
      doc.dispatch({ op: "makeWave", name: "bad", data: Float64Array.of(1), type: "int64" }),
    ).toThrow(/type/);
    expect(() =>
      doc.dispatch({
        op: "makeWave",
        name: "bad",
        data: Float64Array.of(1),
        imag: Float64Array.of(1, 2),
      }),
    ).toThrow(/different lengths/);
  });

  it("writes points in the wave's own type, growing both parts of a complex wave", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "b", data: Uint8Array.of(1, 2) });
    doc.dispatch({ op: "setWavePoints", name: "b", start: 1, values: [300, 2.5, -4] });
    expect(Array.from(doc.getState().waves.b!.data)).toEqual([1, 255, 3, 0]);
    expect(doc.getState().waves.b!.data).toBeInstanceOf(Uint8Array);
    doc.dispatch({ op: "insertPoints", name: "b", at: 1, count: 2 });
    // An integer wave has no NaN: new points are 0.
    expect(Array.from(doc.getState().waves.b!.data)).toEqual([1, 0, 0, 255, 3, 0]);

    doc.dispatch({
      op: "makeWave",
      name: "c",
      data: Float64Array.of(1),
      imag: Float64Array.of(-1),
    });
    doc.dispatch({ op: "setWavePoints", name: "c", start: 1, values: [2, 3], imag: [5, 6] });
    doc.dispatch({ op: "setWavePoints", name: "c", start: 0, values: [9] });
    let c = doc.getState().waves.c!;
    expect([Array.from(c.data), Array.from(c.imag!), c.shape]).toEqual([
      [9, 2, 3],
      [-1, 5, 6],
      [3],
    ]);
    doc.dispatch({ op: "deletePoints", name: "c", at: 0, count: 1 });
    c = doc.getState().waves.c!;
    expect([Array.from(c.data), Array.from(c.imag!)]).toEqual([
      [2, 3],
      [5, 6],
    ]);
    expect(() =>
      doc.dispatch({ op: "setWavePoints", name: "b", start: 0, values: [1], imag: [1] }),
    ).toThrow(/not a complex wave/);
    expect(
      echoPython({ op: "setWavePoints", name: "c", start: 0, values: [1, NaN], imag: [2, 0] }),
    ).toBe('op.wave("c")[0:2] = [complex(1, 2), complex(float("nan"), 0)]');
  });

  it("changes a wave's type, keeping what the new type can hold", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "w", data: Float64Array.of(1.25, -3.75) });
    doc.dispatch({ op: "redimension", name: "w", type: "complex64" });
    let w = doc.getState().waves.w!;
    expect([w.type, Array.from(w.data), Array.from(w.imag!)]).toEqual([
      "complex64",
      [1.25, -3.75],
      [0, 0],
    ]);
    expect(w.imag).toBeInstanceOf(Float32Array);
    doc.dispatch({ op: "redimension", name: "w", type: "int8" });
    w = doc.getState().waves.w!;
    expect([w.type, Array.from(w.data), w.imag]).toEqual(["int8", [1, -4], null]);
    doc.undo();
    expect(doc.getState().waves.w!.type).toBe("complex64");
    doc.dispatch({ op: "duplicateWave", name: "w", newName: "copy" });
    expect(doc.getState().waves.copy).toMatchObject({ type: "complex64" });
    expect(doc.getState().waves.copy!.imag).not.toBe(doc.getState().waves.w!.imag);
    expect(echoPython({ op: "redimension", name: "w", type: "float32" })).toBe(
      'op.wave("w").redimension("float32")',
    );
    doc.dispatch({ op: "makeWave", name: "t", text: ["a"] });
    expect(() => doc.dispatch({ op: "redimension", name: "t", type: "float32" })).toThrow(/text/);
  });
});

describe("page layouts", () => {
  const setup = () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "a", data: Float64Array.of(1, 2, 3) });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({ op: "display", y: ["a"] });
    doc.dispatch({ op: "newLayout" });
    return doc;
  };
  const page = (doc: Doc) => doc.getState().pages.Layout0!;

  it("are windows holding graphs and text at places on a sheet of paper", () => {
    const doc = setup();
    expect(page(doc)).toEqual({ name: "Layout0", width: 595, height: 842, items: [] });
    expect(doc.getState().windows.at(-1)).toMatchObject({ name: "Layout0", kind: "page" });
    expect(
      doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "Graph0" }),
    ).toBe("graph0");
    expect(
      doc.dispatch({
        op: "addLayoutItem",
        layout: "Layout0",
        kind: "graph",
        graph: "Graph1",
        w: 200,
        h: 150,
      }),
    ).toBe("graph1");
    doc.dispatch({
      op: "addLayoutItem",
      layout: "Layout0",
      kind: "text",
      text: "Figure 1",
      x: 40,
      y: 800,
      size: 9,
    });
    const [first, second, caption] = page(doc).items;
    // The first at the top margin, as wide as the page allows; the next below it.
    expect(first).toMatchObject({ x: 36, y: 36, w: 440, graph: "Graph0" });
    expect(second).toMatchObject({ x: 36, y: first!.y + first!.h + 12, w: 200, h: 150 });
    expect(caption).toMatchObject({
      name: "text0",
      kind: "text",
      text: "Figure 1",
      x: 40,
      y: 800,
      size: 9,
    });

    doc.dispatch({
      op: "modifyLayoutItem",
      layout: "Layout0",
      item: "graph1",
      props: { x: 300, w: 10 },
    });
    // Never too small to grab.
    expect(page(doc).items[1]).toMatchObject({ x: 300, w: 40 });
    doc.dispatch({ op: "modifyLayout", layout: "Layout0", props: { width: 842, height: 595 } });
    expect([page(doc).width, page(doc).height]).toEqual([842, 595]);
    expect(() =>
      doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "Nope" }),
    ).toThrow();
    expect(() => doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "text" })).toThrow(
      /text/,
    );
    expect(() =>
      doc.dispatch({ op: "modifyLayout", layout: "Layout0", props: { width: 1 } }),
    ).toThrow();
  });

  it("lose a graph that is closed, and get it back with undo", () => {
    const doc = setup();
    doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "Graph0" });
    doc.dispatch({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "Graph1" });
    doc.dispatch({ op: "killWindow", name: "Graph0" });
    expect(page(doc).items.map((item) => item.graph)).toEqual(["Graph1"]);
    doc.undo();
    expect(page(doc).items.map((item) => item.graph)).toEqual(["Graph0", "Graph1"]);
    doc.dispatch({ op: "removeLayoutItem", layout: "Layout0", item: "graph0" });
    expect(page(doc).items.map((item) => item.name)).toEqual(["graph1"]);
    doc.dispatch({ op: "killWindow", name: "Layout0" });
    expect(doc.getState().pages).toEqual({});
  });

  it("are written into the history as Python", () => {
    expect(echoPython({ op: "newLayout" })).toBe("op.new_layout()");
    expect(
      echoPython({
        op: "addLayoutItem",
        layout: "L",
        kind: "graph",
        graph: "Graph0",
        x: 10,
        w: 200,
      }),
    ).toBe('op.layout("L").add_graph("Graph0", x=10, w=200)');
    expect(
      echoPython({ op: "addLayoutItem", layout: "L", kind: "text", text: "Hi", size: 9 }),
    ).toBe('op.layout("L").add_text("Hi", size=9)');
    expect(
      echoPython({ op: "modifyLayoutItem", layout: "L", item: "graph0", props: { x: 1, y: 2 } }),
    ).toBe('op.layout("L").item("graph0").set(x=1, y=2)');
    expect(echoPython({ op: "removeLayoutItem", layout: "L", item: "text0" })).toBe(
      'op.layout("L").item("text0").remove()',
    );
    expect(
      echoPython({ op: "modifyLayout", layout: "L", props: { width: 842, height: 595 } }),
    ).toBe('op.layout("L").set(width=842, height=595)');
  });
});

describe("memory held by undo", () => {
  it("forgets the oldest steps when they hold too much wave data", () => {
    // Room for about three old copies of an 8000-byte wave.
    const doc = new Doc({ undoBytes: 30_000 });
    doc.dispatch({ op: "makeWave", name: "big", data: new Float64Array(1000) });
    for (let step = 1; step <= 10; step += 1) {
      doc.dispatch({ op: "setWavePoints", name: "big", start: 0, values: [step] });
    }
    let undone = 0;
    while (doc.undo()) undone += 1;
    // The last few edits can be undone; the earlier copies were let go.
    expect(undone).toBeGreaterThanOrEqual(3);
    expect(undone).toBeLessThanOrEqual(4);
    expect(doc.getState().waves.big!.data[0]).toBe(10 - undone);
  });

  it("does not count data that the steps share", () => {
    const doc = new Doc({ undoBytes: 30_000 });
    doc.dispatch({ op: "makeWave", name: "big", data: new Float64Array(1000) });
    // Twenty steps that leave the wave alone: its array is in every snapshot, once.
    for (let step = 0; step < 20; step += 1) {
      doc.dispatch({ op: "setWaveMeta", name: "big", note: `note ${step}` });
    }
    let undone = 0;
    while (doc.undo()) undone += 1;
    expect(undone).toBe(21);
  });

  it("always allows one undo, however large the wave", () => {
    const doc = new Doc({ undoBytes: 10 });
    doc.dispatch({ op: "makeWave", name: "big", data: new Float64Array(1000) });
    doc.dispatch({ op: "setWavePoints", name: "big", start: 0, values: [1] });
    doc.dispatch({ op: "setWavePoints", name: "big", start: 0, values: [2] });
    expect(doc.undo()).toBe(true);
    expect(doc.getState().waves.big!.data[0]).toBe(1);
    expect(doc.undo()).toBe(false);
  });
});

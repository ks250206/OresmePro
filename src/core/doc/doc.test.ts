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

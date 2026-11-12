import { describe, expect, it } from "vite-plus/test";
import { parseDelimited } from "../io/delimited";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { layoutGraph } from "../plot/layout";
import { layoutPage } from "../plot/page";
import { tableEditCommands } from "./tableEdit";
import { Doc } from "./doc";
import { DocError, type DocState } from "./types";
import { strToU8, zipSync } from "fflate";

// Names that are also properties every plain JavaScript object inherits.
const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];
/** Looks a name up as the code does; `waves.toString` would be typed as the method. */
const at = <T>(record: Readonly<Record<string, T>>, name: string): T | undefined => record[name];
const measure = (text: string, size: number) => text.length * size * 0.55;

/** Every record of a document that is kept by name, which must have no prototype. */
function records(state: DocState): [string, object][] {
  return [
    ["waves", state.waves],
    ["graphs", state.graphs],
    ["tables", state.tables],
    ["procedures", state.procedures],
    ["pages", state.pages],
    ["styles", state.styles],
    ...Object.values(state.graphs).flatMap((graph): [string, object][] => [
      [`${graph.name}.axes`, graph.axes],
      [`${graph.name}.cursors`, graph.cursors],
    ]),
    ...Object.values(state.tables).map((table): [string, object] => [
      `${table.name}.widths`,
      table.widths,
    ]),
  ];
}

const withPrototype = (state: DocState) =>
  records(state)
    .filter(([, record]) => Object.getPrototypeOf(record) !== null)
    .map(([what]) => what);

/** A document with a wave, an X wave and a graph of them for each name. */
function build(names: readonly string[]): Doc {
  const doc = new Doc();
  for (const name of names) {
    doc.dispatch({ op: "makeWave", name, data: new Float64Array([1, 2, 3]), unit: "V" });
    doc.dispatch({ op: "makeWave", name: `${name}_x`, data: new Float64Array([0, 1, 2]) });
    doc.dispatch({ op: "display", y: [name], x: `${name}_x`, name: `${name}Graph` });
  }
  return doc;
}

describe("names that objects inherit", () => {
  it("are waves like any other: made, listed, renamed, duplicated, killed and undone", () => {
    const doc = new Doc();
    for (const name of INHERITED) {
      doc.dispatch({ op: "makeWave", name, data: new Float64Array([1, 2]), dx: 3 });
    }
    expect(doc.getState().waveOrder).toEqual(INHERITED);
    expect(at(doc.getState().waves, "constructor")).toMatchObject({ name: "constructor", dx: 3 });
    // Overwriting keeps the scaling of the wave that was there, not of anything inherited.
    doc.dispatch({ op: "makeWave", name: "toString", data: new Float64Array([5]) });
    expect(at(doc.getState().waves, "toString")).toMatchObject({ name: "toString", dx: 3 });
    expect(() =>
      doc.dispatch({
        op: "makeWave",
        name: "valueOf",
        data: new Float64Array(1),
        overwrite: false,
      }),
    ).toThrow(/already exists/);

    doc.dispatch({ op: "makeWave", name: "plain", data: new Float64Array([7]) });
    doc.dispatch({ op: "renameWave", name: "plain", newName: "propertyIsEnumerable" });
    expect(at(doc.getState().waves, "propertyIsEnumerable")!.data[0]).toBe(7);
    doc.dispatch({ op: "duplicateWave", name: "constructor", newName: "toLocaleString" });
    expect(doc.getState().waveOrder.slice(-2)).toEqual(["propertyIsEnumerable", "toLocaleString"]);
    doc.dispatch({ op: "killWaves", names: ["hasOwnProperty"] });
    expect(doc.getState().waveOrder).not.toContain("hasOwnProperty");
    expect(() => doc.dispatch({ op: "setWaveMeta", name: "hasOwnProperty", unit: "s" })).toThrow(
      /No wave named "hasOwnProperty"/,
    );
    doc.undo();
    expect(at(doc.getState().waves, "hasOwnProperty")).toMatchObject({ name: "hasOwnProperty" });

    doc.dispatch({ op: "newFolder", path: "constructor_folder" });
    doc.dispatch({ op: "renameFolder", path: "constructor_folder", newPath: "toString_folder" });
    doc.dispatch({ op: "makeWave", name: "toString_folder:valueOf", data: new Float64Array(1) });
    expect(doc.getState().waves["toString_folder:valueOf"]).toBeDefined();
  });

  it("are graphs, axes, tables, page layouts and procedures, and are plotted", () => {
    const doc = build(["constructor"]);
    doc.dispatch({ op: "display", y: ["constructor"], name: "toString" });
    doc.dispatch({ op: "addAxis", graph: "toString", name: "valueOf", side: "right" });
    doc.dispatch({ op: "appendTraces", graph: "toString", y: ["constructor_x"], vAxis: "valueOf" });
    doc.dispatch({ op: "modifyAxis", graph: "toString", axis: "valueOf", props: { log: true } });
    doc.dispatch({ op: "edit", waves: ["constructor"], name: "hasOwnProperty" });
    doc.dispatch({ op: "resizeColumn", table: "hasOwnProperty", wave: "constructor", width: 99 });
    doc.dispatch({ op: "newLayout", name: "valueOf" });
    doc.dispatch({ op: "addLayoutItem", layout: "valueOf", kind: "graph", graph: "toString" });
    doc.dispatch({ op: "newProcedure", name: "isPrototypeOf", code: "x = 1\n" });
    expect(() => doc.dispatch({ op: "applyStyle", style: "constructor", graphs: [] })).toThrow(
      'No style named "constructor".',
    );
    doc.dispatch({ op: "setStyle", name: "constructor", style: { graph: { fontSize: 7 } } });
    doc.dispatch({ op: "renameStyle", name: "constructor", newName: "toString" });
    doc.dispatch({ op: "setDefaultStyle", name: "toString" });
    doc.dispatch({ op: "applyStyle", style: "toString", graphs: ["toString"] });
    expect(at(doc.getState().graphs, "toString")).toMatchObject({ fontSize: 7, style: "toString" });
    expect(at(doc.getState().styles, "constructor")).toBeUndefined();
    const state = doc.getState();
    expect(at(at(state.graphs, "toString")!.axes, "valueOf")).toMatchObject({
      side: "right",
      log: true,
    });
    expect(at(at(state.tables, "hasOwnProperty")!.widths, "constructor")).toBe(99);
    expect(at(state.pages, "valueOf")!.items[0]!.graph).toBe("toString");
    expect(at(state.procedures, "isPrototypeOf")!.code).toBe("x = 1\n");
    expect(state.windows.map((window) => window.name)).toEqual([
      "constructorGraph",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
    ]);

    const graph = layoutGraph(at(state.graphs, "toString")!, state.waves, 400, 300, measure);
    expect(graph.traces).toHaveLength(2);
    expect(at(graph.axes, "valueOf")?.side).toBe("right");
    expect(at(graph.axes, "constructor")).toBeUndefined();
    expect(layoutPage(at(state.pages, "valueOf")!, state, measure).prims.length).toBeGreaterThan(0);

    // A table edit past the end of a wave named like this grows it.
    const edits = tableEditCommands(
      state.waves,
      [{ wave: "constructor", row: 3, j: null, text: "4" }],
      { layer: 0, chunk: 0 },
    );
    expect(edits).toEqual([{ op: "setWavePoints", name: "constructor", start: 3, values: [4] }]);
    expect(
      tableEditCommands(state.waves, [{ wave: "toString", row: 0, j: null, text: "1" }], {
        layer: 0,
        chunk: 0,
      }),
    ).toEqual([]);

    doc.dispatch({ op: "killWindow", name: "toString" });
    expect(at(doc.getState().graphs, "toString")).toBeUndefined();
    expect(at(doc.getState().pages, "valueOf")!.items).toEqual([]);
    doc.undo();
    expect(at(doc.getState().pages, "valueOf")!.items).toHaveLength(1);
  });

  it("are looked up in records that have no prototype, however the document was changed", () => {
    const doc = build(["signal", "other"]);
    const seen: DocState[] = [];
    const step = (command: Parameters<Doc["dispatch"]>[0]) => {
      doc.dispatch(command);
      seen.push(doc.getState());
    };
    step({ op: "addAxis", graph: "signalGraph", name: "right2", side: "right" });
    step({ op: "modifyAxis", graph: "signalGraph", axis: "right2", props: { log: true } });
    step({ op: "setCursor", graph: "signalGraph", cursor: "A", trace: "signal", point: 1 });
    step({ op: "removeCursor", graph: "signalGraph", cursor: "A" });
    step({ op: "setCursor", graph: "signalGraph", cursor: "B", trace: "signal", point: 1 });
    step({ op: "edit", waves: ["signal", "other"] });
    step({ op: "resizeColumn", table: "Table0", wave: "signal", width: 90 });
    step({ op: "resizeColumn", table: "Table0", wave: "other", width: 90 });
    step({ op: "removeFromTable", table: "Table0", waves: ["other"] });
    step({ op: "renameWave", name: "signal", newName: "renamed" });
    step({ op: "newFolder", path: "f" });
    step({ op: "renameFolder", path: "f", newPath: "g" });
    step({ op: "removeTraces", graph: "signalGraph", traces: ["renamed"] });
    step({ op: "removeAxis", graph: "signalGraph", axis: "right2" });
    step({ op: "newLayout" });
    step({ op: "addLayoutItem", layout: "Layout0", kind: "graph", graph: "otherGraph" });
    step({ op: "newProcedure", code: "" });
    step({ op: "setProcedure", name: "Procedure", code: "z = 3\n" });
    step({ op: "killWindow", name: "otherGraph" });
    step({ op: "killWaves", names: ["other_x"] });
    step({ op: "saveStyle", name: "paper", graph: "signalGraph" });
    step({ op: "setStyle", name: "talk", style: { graph: { fontSize: 20 } } });
    step({ op: "renameStyle", name: "talk", newName: "poster" });
    step({ op: "setDefaultStyle", name: "poster" });
    step({ op: "display", y: [] });
    step({ op: "applyStyle", style: "paper", graphs: ["signalGraph", "Graph0"] });
    step({ op: "removeStyle", name: "poster" });
    while (doc.undo()) seen.push(doc.getState());
    while (doc.redo()) seen.push(doc.getState());
    seen.push(unzipExperiment(zipExperiment(doc.getState(), [])).state);
    for (const state of seen) expect(withPrototype(state)).toEqual([]);
  });

  it("work in a document built elsewhere from ordinary objects and loaded", () => {
    const state = build(["signal"]).getState();
    const graph = state.graphs.signalGraph!;
    const doc = new Doc();
    doc.load({
      ...state,
      waves: { ...state.waves },
      graphs: { signalGraph: { ...graph, axes: { ...graph.axes }, cursors: {} } },
      tables: {},
      procedures: {},
    });
    expect(withPrototype(doc.getState())).toEqual([]);
    doc.dispatch({ op: "makeWave", name: "constructor", data: new Float64Array(1) });
    doc.dispatch({ op: "edit", waves: ["constructor"], name: "toString" });
    expect(doc.getState().waveOrder).toContain("constructor");
  });

  it("are not taken for existing windows, axes or properties", () => {
    const doc = build(["signal"]);
    for (const name of INHERITED) {
      expect(() => doc.dispatch({ op: "appendTraces", graph: name, y: ["signal"] })).toThrow(
        `No graph named "${name}".`,
      );
      expect(() => doc.dispatch({ op: "appendToTable", table: name, waves: ["signal"] })).toThrow(
        `No table named "${name}".`,
      );
      expect(() => doc.dispatch({ op: "modifyLayout", layout: name, props: {} })).toThrow(
        `No page layout named "${name}".`,
      );
      expect(() => doc.dispatch({ op: "setProcedure", name, code: "" })).toThrow(
        `No procedure named "${name}".`,
      );
      expect(() => doc.dispatch({ op: "killWindow", name })).toThrow(`No window named "${name}".`);
      expect(() =>
        doc.dispatch({ op: "modifyAxis", graph: "signalGraph", axis: name, props: {} }),
      ).toThrow(/has no axis named/);
      expect(() =>
        doc.dispatch({
          op: "modifyTrace",
          graph: "signalGraph",
          trace: "signal",
          props: { [name]: 1 },
        }),
      ).toThrow(/Unknown trace property/);
    }
  });

  it("__proto__ is not a name, and is never found", () => {
    const doc = build(["signal"]);
    const before = doc.getState();
    expect(() =>
      doc.dispatch({ op: "makeWave", name: "__proto__", data: new Float64Array(1) }),
    ).toThrow(DocError);
    expect(() => doc.dispatch({ op: "renameWave", name: "signal", newName: "__proto__" })).toThrow(
      /not a valid wave name/,
    );
    expect(() => doc.dispatch({ op: "display", y: ["signal"], name: "__proto__" })).toThrow(
      /not a valid graph name/,
    );
    expect(() => doc.dispatch({ op: "setWaveMeta", name: "__proto__", unit: "s" })).toThrow(
      'No wave named "__proto__".',
    );
    expect(() => doc.dispatch({ op: "killWindow", name: "__proto__" })).toThrow(/No window/);
    expect(() =>
      doc.dispatch({ op: "modifyAxis", graph: "signalGraph", axis: "__proto__", props: {} }),
    ).toThrow(/has no axis named/);
    expect(() =>
      doc.dispatch({
        op: "modifyTrace",
        graph: "signalGraph",
        trace: "signal",
        props: JSON.parse('{"__proto__": {"mode": "bars"}}') as Record<string, unknown>,
      }),
    ).toThrow(/Unknown trace property/);
    expect(doc.getState()).toBe(before);
  });

  it("survive saving and loading an experiment", () => {
    const doc = build(INHERITED);
    doc.dispatch({ op: "addAxis", graph: "constructorGraph", name: "toString", side: "left" });
    doc.dispatch({ op: "edit", waves: ["valueOf"], name: "constructor" });
    doc.dispatch({ op: "resizeColumn", table: "constructor", wave: "valueOf", width: 120 });
    doc.dispatch({ op: "newLayout", name: "toString" });
    doc.dispatch({ op: "newProcedure", name: "valueOf", code: "y = 2\n" });
    doc.dispatch({ op: "saveStyle", name: "hasOwnProperty", graph: "constructorGraph" });
    doc.dispatch({ op: "setDefaultStyle", name: "hasOwnProperty" });
    const before = doc.getState();

    const restored = unzipExperiment(zipExperiment(before, [])).state;
    expect(restored.waveOrder).toEqual(before.waveOrder);
    for (const name of INHERITED) {
      expect([...restored.waves[name]!.data]).toEqual([1, 2, 3]);
      expect(restored.waves[name]!.unit).toBe("V");
    }
    expect(restored.graphs).toEqual(before.graphs);
    expect(at(restored.graphs.constructorGraph!.axes, "toString")!.side).toBe("left");
    expect(at(at(restored.tables, "constructor")!.widths, "valueOf")).toBe(120);
    expect(at(restored.pages, "toString")).toEqual(at(before.pages, "toString"));
    expect(at(restored.procedures, "valueOf")!.code).toBe("y = 2\n");
    expect(restored.windows).toEqual(before.windows);
    expect(at(restored.graphs, "hasOwnProperty")).toBeUndefined();
    expect(at(restored.styles, "hasOwnProperty")).toEqual(at(before.styles, "hasOwnProperty"));
    expect(restored.defaultStyle).toBe("hasOwnProperty");
    expect(at(restored.styles, "toString")).toBeUndefined();

    // What is loaded can be changed further, under the same names.
    const again = new Doc();
    again.load(restored);
    again.dispatch({ op: "makeWave", name: "isPrototypeOf", data: new Float64Array([9]) });
    again.dispatch({ op: "killWindow", name: "constructor" });
    expect(again.getState().waveOrder.filter((name) => name === "isPrototypeOf")).toHaveLength(1);
    expect(at(again.getState().tables, "constructor")).toBeUndefined();
  });

  it("an experiment file that names something __proto__ changes nothing it should not", () => {
    const experiment = `{
      "version": 2, "waves": [], "windows": [{"name": "__proto__", "kind": "graph", "x": 0, "y": 0, "w": 100, "h": 100}],
      "graphs": {"__proto__": {"name": "__proto__", "traces": [], "axes": {}}},
      "tables": {"__proto__": {"name": "__proto__", "columns": []}},
      "procedures": {"__proto__": {"code": ""}},
      "pages": {"__proto__": {"name": "__proto__", "width": 100, "height": 100, "items": []}}
    }`;
    const file = zipSync({ "experiment.json": strToU8(experiment) });
    expect(() => unzipExperiment(file)).toThrow(/not a valid graph name/);
    expect(({} as Record<string, unknown>).traces).toBeUndefined();
  });

  it("are kept by import instead of being renamed", () => {
    const doc = build(["valueOf"]);
    const { waves } = doc.getState();
    // As the file loaders call it.
    const result = parseDelimited(
      "constructor,toString,valueOf,__proto__\n1,2,3,4\n",
      (name) => name in waves,
    );
    expect(result.names).toEqual(["constructor", "toString", "valueOf_1", "proto"]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { checkView, getPath, readGraph, readViewJson, setPath, viewNodes } from "./view";

/** What a view's Python returns is checked part by part before anything is drawn. */
describe("plugin views", () => {
  const body = {
    type: "column",
    children: [
      { type: "wave", label: "Frequency", bind: "frequency" },
      {
        type: "split",
        children: [
          {
            type: "plot",
            series: [{ x: "f", y: "mod", mode: "markers" }],
            x_log: true,
            height: 200,
          },
          {
            type: "table",
            bind: "params",
            columns: [
              { key: "name", editable: false },
              { key: "value", type: "number" },
            ],
          },
        ],
        ratio: 0.6,
      },
      { type: "tabs", tabs: [{ title: "A", body: { type: "text", text: "a", tone: "muted" } }] },
      { type: "choice", label: "Imaginary", bind: "imaginary", choices: [["−Z″", "-Z''"], "Z''"] },
      {
        type: "button",
        label: "Fit",
        action: "eis_circuit",
        args: { guess: { $bind: "guess" }, n: 3 },
        replace: true,
      },
      { type: "button", label: "Guess", on: "guess" },
    ],
  };

  it("are read into a fixed shape, with defaults filled in", () => {
    const view = checkView({ version: 1, body });
    const nodes = [...viewNodes(view.body)].map((node) => node.type);
    expect(nodes).toEqual([
      "column",
      "wave",
      "split",
      "plot",
      "table",
      "tabs",
      "text",
      "choice",
      "button",
      "button",
    ]);
    const plot = [...viewNodes(view.body)].find((node) => node.type === "plot")!;
    expect(plot).toMatchObject({ xLog: true, yLog: false, equal: false, height: 200 });
    const table = [...viewNodes(view.body)].find((node) => node.type === "table")!;
    expect(table).toMatchObject({
      columns: [
        { key: "name", title: "name", type: "text", editable: false },
        { key: "value", type: "number", editable: true },
      ],
    });
    const fit = [...viewNodes(view.body)].find((node) => node.type === "button")!;
    expect(fit).toMatchObject({
      action: "eis_circuit",
      on: null,
      args: { guess: { $bind: "guess" }, n: 3 },
      replace: true,
    });
  });

  it("are refused whole when a part is not one the app draws, or is off", () => {
    const cases: [unknown, RegExp][] = [
      [{ version: 2, body }, /not one this app draws/],
      [{ version: 1, body: { type: "html", html: "<b>" } }, /not a part this app draws/],
      [{ version: 1, body: { type: "text", text: "a", onclick: "x" } }, /has no "onclick"/],
      [{ version: 1, body: { type: "number", bind: "a b" } }, /not a path of the state/],
      [{ version: 1, body: { type: "button", label: "x" } }, /either on .* or action/],
      [
        { version: 1, body: { type: "button", label: "x", on: "a", action: "b" } },
        /either on .* or action/,
      ],
      [
        { version: 1, body: { type: "plot", series: [{ y: "a", color: "url(x)" }] } },
        /not a color/,
      ],
      [{ version: 1, body: { type: "split", children: [body] } }, /two children/],
    ];
    for (const [raw, message] of cases) expect(() => checkView(raw)).toThrow(message);
    let deep: unknown = { type: "text", text: "x" };
    for (let i = 0; i < 40; i += 1) deep = { type: "group", body: deep };
    expect(() => checkView({ version: 1, body: deep })).toThrow(/nests more than/);
    const many = {
      type: "column",
      children: Array.from({ length: 2100 }, () => ({ type: "text", text: "x" })),
    };
    expect(() => checkView({ version: 1, body: many })).toThrow(/more than 2000 parts/);
  });

  it("take handles a plot can be dragged by, and a handler for clicks", () => {
    const view = checkView({
      version: 1,
      body: {
        type: "plot",
        series: [{ y: "a" }],
        handles: [
          { x: 3, y: 10, bind_x: "peaks.0.center", bind_y: "peaks.0.height", label: "A" },
          { x: 1, bind_x: "range.0" },
          { y: 0.5, color: "gray" },
        ],
        on_click: "add_peak",
      },
    });
    expect(view.body).toMatchObject({
      onClick: "add_peak",
      handles: [
        { x: 3, y: 10, bindX: "peaks.0.center", bindY: "peaks.0.height", label: "A" },
        { x: 1, y: null, bindX: "range.0", bindY: null, label: "", color: null },
        { x: null, y: 0.5, bindX: null, bindY: null, color: "gray" },
      ],
    });
    const plot = (handles: unknown, extra = {}) => ({
      version: 1,
      body: { type: "plot", series: [], handles, ...extra },
    });
    expect(() => checkView(plot([{ label: "nowhere" }]))).toThrow(/an x, a y or both/);
    expect(() => checkView(plot([{ x: 1, bind_y: "a" }]))).toThrow(/only along the axes/);
    expect(() => checkView(plot([{ x: 1, bind_x: "a b" }]))).toThrow(/not a path/);
    expect(() => checkView(plot([{ x: 1, script: "x" }]))).toThrow(/has no "script"/);
    expect(() => checkView(plot(Array.from({ length: 201 }, () => ({ x: 1 }))))).toThrow(
      /at most 200 handles/,
    );
    expect(() => checkView(plot([], { on_click: "a-b" }))).toThrow(/not a handler's name/);
  });

  it("take a nodes part with its palette, and read the graph it edits leniently", () => {
    const view = checkView({
      version: 1,
      body: {
        type: "nodes",
        bind: "diagram",
        palette: [
          { kind: "R", title: "Resistor", ports: ["a", "b"] },
          { kind: "start", ports: [["p", "right"]], add: false, color: "gray" },
        ],
      },
    });
    expect(view.body).toEqual({
      type: "nodes",
      label: "",
      bind: "diagram",
      height: 260,
      palette: [
        {
          kind: "R",
          title: "Resistor",
          ports: [
            { name: "a", side: "left" },
            { name: "b", side: "right" },
          ],
          color: null,
          add: true,
        },
        {
          kind: "start",
          title: "start",
          ports: [{ name: "p", side: "right" }],
          color: "gray",
          add: false,
        },
      ],
    });
    const nodes = (palette: unknown) => ({
      version: 1,
      body: { type: "nodes", bind: "d", palette },
    });
    expect(() => checkView(nodes([]))).toThrow(/1 to 40 kinds/);
    expect(() => checkView(nodes([{ kind: "R", ports: ["a", "a"] }]))).toThrow(
      /not a port of its own/,
    );
    expect(() => checkView(nodes([{ kind: "R", ports: [["a", "middle"]] }]))).toThrow(/side is/);
    expect(() =>
      checkView(
        nodes([
          { kind: "R", ports: [] },
          { kind: "R", ports: [] },
        ]),
      ),
    ).toThrow(/twice/);
    expect(() => checkView(nodes([{ kind: "<b>", ports: [] }]))).toThrow(/not a kind/);

    const graph = readGraph({
      nodes: [
        { id: "R0", kind: "R", x: 10, y: 20 },
        { id: "R0", kind: "R", x: 0, y: 0 },
        { id: "start", kind: "start", label: "Start", x: 0, y: 0, fixed: true },
        { id: "bad id", kind: "R", x: 0, y: 0 },
        { id: "C1", kind: "C", x: "far" },
      ],
      edges: [
        { from: ["start", "p"], to: ["R0", "a"] },
        { from: ["R0", "b"], to: ["C1", "a"] },
        "wire",
      ],
    });
    expect(graph).toEqual({
      nodes: [
        { id: "R0", kind: "R", label: "R0", x: 10, y: 20, fixed: false },
        { id: "start", kind: "start", label: "Start", x: 0, y: 0, fixed: true },
      ],
      edges: [{ from: ["start", "p"], to: ["R0", "a"] }],
    });
    expect(readGraph("nothing")).toEqual({ nodes: [], edges: [] });
  });

  it("read and set values at paths of the state", () => {
    const state = { params: [{ value: 1 }, { value: 2 }], name: "a" };
    expect(getPath(state, "params.1.value")).toBe(2);
    expect(getPath(state, "params.5.value")).toBeUndefined();
    const next = setPath(state, "params.1.value", 9) as typeof state;
    expect(next.params[1]!.value).toBe(9);
    expect(state.params[1]!.value).toBe(2);
    expect(setPath(null, "a.b", 1)).toEqual({ a: { b: 1 } });
    expect(() => readViewJson("x".repeat(2 * 1024 * 1024), "state")).toThrow(/larger than/);
  });
});

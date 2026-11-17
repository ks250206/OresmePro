import { describe, expect, it } from "vite-plus/test";
import { checkView, getPath, readViewJson, setPath, viewNodes } from "./view";

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

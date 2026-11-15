import { describe, expect, it } from "vite-plus/test";
import type { ActionSpec } from "../actions";
import { buildState, describeExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import {
  checkPanel,
  codeActions,
  controlForParam,
  matchesFilter,
  panelFile,
  panelTrust,
  pickerWaves,
  readPanelFile,
  resolveButton,
} from "./panels";
import type { PanelControl, PanelSpec } from "./types";

const wave = (...values: number[]) => new Float64Array(values);

/** A panel that fits a peak: a wave picker, a choice of model, a number and a Fit button. */
function quickFit(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "sig", data: wave(1, 3, 1) });
  doc.dispatch({ op: "newPanel", name: "quick_fit", title: "Quick Fit" });
  const add = (kind: string, name: string, props: Record<string, unknown> = {}) =>
    doc.dispatch({ op: "addControl", panel: "quick_fit", kind, name, props });
  add("wave", "target", { label: "Spectrum", value: "sig", dims: 1 });
  add("choice", "model", { label: "Model", options: ["gauss", "lor"] });
  add("number", "width", { label: "Width", value: 5, min: 1, max: 99, inline: true });
  add("button", "run", {
    label: "Fit",
    action: "core.fit",
    args: { function: { $control: "model" }, y: { $control: "target" } },
  });
  return doc;
}

const panelOf = (doc: Doc, name = "quick_fit"): PanelSpec => doc.getState().panels[name]!;
const controlOf = (doc: Doc, name: string): PanelControl =>
  panelOf(doc).controls.find((item) => item.name === name)!;

const FIT: ActionSpec = {
  id: "core.fit",
  version: 1,
  title: "Curve Fit",
  description: null,
  params: {
    function: { type: "choice", optional: false, choices: ["gauss", "line"] },
    y: { type: "wave", optional: false },
    quiet: { type: "boolean", optional: true, default: false },
  },
};

describe("panels", () => {
  it("are documents objects with a window, and one undo step each", () => {
    const doc = quickFit();
    const state = doc.getState();
    expect(state.windows.at(-1)).toMatchObject({ name: "quick_fit", kind: "panel" });
    expect(panelOf(doc).controls.map((item) => [item.kind, item.name])).toEqual([
      ["wave", "target"],
      ["choice", "model"],
      ["number", "width"],
      ["button", "run"],
    ]);
    // A choice starts at its first option.
    expect(controlOf(doc, "model")).toMatchObject({ value: "gauss" });
    expect(() => doc.dispatch({ op: "newPanel", name: "quick_fit" })).toThrow(/already exists/);
    doc.undo();
    expect(panelOf(doc).controls).toHaveLength(3);
    doc.dispatch({ op: "killWindow", name: "quick_fit" });
    expect(doc.getState().panels.quick_fit).toBeUndefined();
    expect(doc.getState().windows).toEqual([]);
  });

  it("checks values against their control", () => {
    const doc = quickFit();
    const set = (control: string, value: unknown) =>
      doc.dispatch({ op: "setControlValue", panel: "quick_fit", control, value });
    set("width", 7);
    set("model", "lor");
    expect(controlOf(doc, "width")).toMatchObject({ value: 7 });
    expect(() => set("width", 0)).toThrow("Width must be at least 1.");
    expect(() => set("width", "7")).toThrow(/finite number/);
    expect(() => set("model", "voigt")).toThrow('Model must be one of "gauss", "lor".');
    expect(() => set("run", 1)).toThrow(/has no value/);
    expect(() => set("nothing", 1)).toThrow(/no control named "nothing"/);
    // Limits that leave the value outside move it in; options that leave it out pick the first.
    doc.dispatch({
      op: "modifyControl",
      panel: "quick_fit",
      control: "width",
      props: { max: 3 },
    });
    expect(controlOf(doc, "width")).toMatchObject({ value: 3, max: 3 });
    doc.dispatch({
      op: "modifyControl",
      panel: "quick_fit",
      control: "model",
      props: { options: ["exp", "line"] },
    });
    expect(controlOf(doc, "model")).toMatchObject({ value: "exp" });
    expect(() =>
      doc.dispatch({
        op: "modifyControl",
        panel: "quick_fit",
        control: "width",
        props: { options: [] },
      }),
    ).toThrow(/has no property "options"/);
  });

  it("rename a control and the buttons that pass it follow", () => {
    const doc = quickFit();
    doc.dispatch({
      op: "modifyControl",
      panel: "quick_fit",
      control: "model",
      props: { name: "shape", label: "Shape" },
    });
    expect(controlOf(doc, "shape")).toMatchObject({ label: "Shape", value: "gauss" });
    expect(controlOf(doc, "run")).toMatchObject({
      args: { function: { $control: "shape" }, y: { $control: "target" } },
    });
    expect(() =>
      doc.dispatch({
        op: "modifyControl",
        panel: "quick_fit",
        control: "shape",
        props: { name: "target" },
      }),
    ).toThrow(/already has a control named "target"/);
  });

  it("move and remove controls", () => {
    const doc = quickFit();
    doc.dispatch({ op: "moveControl", panel: "quick_fit", control: "run", to: 0 });
    doc.dispatch({ op: "moveControl", panel: "quick_fit", control: "target", to: 99 });
    expect(panelOf(doc).controls.map((item) => item.name)).toEqual([
      "run",
      "model",
      "width",
      "target",
    ]);
    doc.dispatch({ op: "removeControl", panel: "quick_fit", control: "model" });
    expect(panelOf(doc).controls.map((item) => item.name)).toEqual(["run", "width", "target"]);
  });

  it("refuse buttons that hold anything but an action and plain arguments", () => {
    const doc = quickFit();
    const modify = (props: Record<string, unknown>) =>
      doc.dispatch({ op: "modifyControl", panel: "quick_fit", control: "run", props });
    expect(() => modify({ action: "print('hi')" })).toThrow(/id of an action/);
    expect(() => modify({ args: { y: { $control: "target", code: "x" } } })).toThrow(/\$control/);
    expect(() => modify({ args: { y: null } })).toThrow(/leave it out/);
    expect(() => modify({ args: JSON.parse('{"__proto__": 1}') })).toThrow(/not an argument name/);
    expect(() => modify({ args: { _private: 1 } })).toThrow(/not an argument name/);
    expect(() => modify({ code: "x" })).toThrow(/no property "code"/);
  });

  it("wave pickers follow renames and keep the name of a killed wave", () => {
    const doc = quickFit();
    doc.dispatch({ op: "renameWave", name: "sig", newName: "run1:spectrum" });
    expect(controlOf(doc, "target")).toMatchObject({ value: "run1:spectrum" });
    doc.dispatch({ op: "renameFolder", path: "run1", newPath: "run2" });
    expect(controlOf(doc, "target")).toMatchObject({ value: "run2:spectrum" });
    // Being picked does not keep a wave from being killed.
    doc.dispatch({ op: "killWaves", names: ["run2:spectrum"] });
    expect(controlOf(doc, "target")).toMatchObject({ value: "run2:spectrum" });
  });

  it("resolve a button from the values the panel has when it is pressed", () => {
    const doc = quickFit();
    const waveExists = (name: string) => name in doc.getState().waves;
    const resolved = resolveButton(panelOf(doc), "run", { waveExists, catalog: [FIT] });
    expect(resolved).toEqual({
      call: { action: "core.fit", version: null, args: { function: "gauss", y: "sig" } },
      problems: [],
    });
    // A literal argument passes as it is.
    doc.dispatch({
      op: "modifyControl",
      panel: "quick_fit",
      control: "run",
      props: { args: { function: "line", y: { $control: "target" }, quiet: true } },
    });
    expect(resolveButton(panelOf(doc), "run", { waveExists }).call?.args).toEqual({
      function: "line",
      y: "sig",
      quiet: true,
    });
  });

  it("say what is wrong with a press in the panel's words", () => {
    const doc = quickFit();
    const waveExists = (name: string) => name in doc.getState().waves;
    const problems = () =>
      resolveButton(panelOf(doc), "run", { waveExists, catalog: [FIT] }).problems;
    doc.dispatch({ op: "killWaves", names: ["sig"] });
    expect(problems()).toEqual(["Spectrum is missing: there is no wave sig."]);
    doc.dispatch({ op: "setControlValue", panel: "quick_fit", control: "target", value: null });
    expect(problems()).toEqual(["Choose a wave for Spectrum."]);
    doc.dispatch({ op: "makeWave", name: "sig", data: wave(1, 2) });
    doc.dispatch({ op: "setControlValue", panel: "quick_fit", control: "target", value: "sig" });
    // The catalog's choices are narrower than the panel's options.
    doc.dispatch({ op: "setControlValue", panel: "quick_fit", control: "model", value: "lor" });
    expect(problems()).toEqual(['Model must be one of "gauss", "line".']);
    doc.dispatch({ op: "removeControl", panel: "quick_fit", control: "model" });
    expect(problems()).toEqual(['function: there is no control named "model".']);
    expect(
      resolveButton(panelOf(doc), "run", { waveExists, catalog: [{ ...FIT, id: "core.other" }] })
        .problems,
    ).toEqual([
      'function: there is no control named "model".',
      "There is no action core.fit. If a procedure registers it, run the procedure.",
    ]);
    expect(resolveButton(panelOf(doc), "width", { waveExists }).problems).toEqual([
      'quick_fit has no button named "width".',
    ]);
  });

  it("resolve controls deep inside an argument, as a template's inputs take them", () => {
    const doc = quickFit();
    const waveExists = (name: string) => name in doc.getState().waves;
    doc.dispatch({
      op: "addControl",
      panel: "quick_fit",
      kind: "button",
      name: "batch",
      props: {
        action: "core.run_template",
        args: {
          template: "peak",
          inputs: [{ y: { $control: "target" }, x: null }],
          options: { width: { $control: "width" } },
        },
      },
    });
    expect(resolveButton(panelOf(doc), "batch", { waveExists }).call?.args).toEqual({
      template: "peak",
      inputs: [{ y: "sig", x: null }],
      options: { width: 5 },
    });
    doc.dispatch({
      op: "modifyControl",
      panel: "quick_fit",
      control: "target",
      props: { name: "spectrum" },
    });
    expect(controlOf(doc, "batch")).toMatchObject({
      args: { inputs: [{ y: { $control: "spectrum" } }] },
    });
    doc.dispatch({ op: "killWaves", names: ["sig"] });
    expect(resolveButton(panelOf(doc), "batch", { waveExists }).problems).toEqual([
      "Spectrum is missing: there is no wave sig.",
    ]);
    const modify = (args: unknown) =>
      doc.dispatch({ op: "modifyControl", panel: "quick_fit", control: "batch", props: { args } });
    expect(() => modify({ inputs: [{ y: { $control: "target", also: 1 } }] })).toThrow(
      /\{"\$control": name\} and nothing else/,
    );
    expect(() => modify({ inputs: [[[[[[[[[1]]]]]]]]] })).toThrow(/nested too deeply/);
  });

  it("are data unless a button calls the user's own actions", () => {
    const doc = quickFit();
    expect(panelTrust(panelOf(doc))).toBe("data");
    doc.dispatch({
      op: "addControl",
      panel: "quick_fit",
      kind: "button",
      name: "sandboxed",
      props: { action: "plugin.echem.cv" },
    });
    expect(panelTrust(panelOf(doc))).toBe("data");
    doc.dispatch({
      op: "addControl",
      panel: "quick_fit",
      kind: "button",
      name: "mine",
      props: { action: "lab.normalize" },
    });
    expect(panelTrust(panelOf(doc))).toBe("code");
    expect(codeActions(panelOf(doc))).toEqual(["lab.normalize"]);
    // A button with no action yet calls nothing.
    expect(panelTrust({ name: "p", title: "", controls: [] })).toBe("data");
  });

  it("are saved with their values and opened again", () => {
    const doc = quickFit();
    doc.dispatch({ op: "setControlValue", panel: "quick_fit", control: "width", value: 11 });
    const saved = JSON.parse(JSON.stringify(describeExperiment(doc.getState(), () => "w.npy")));
    const files = new Map([["w.npy", new Uint8Array()]]);
    // Text waves need no file; the numeric one is left out of this check.
    saved.waves = [];
    const state = buildState(saved, files);
    expect(state.panels.quick_fit).toEqual(panelOf(doc));
    expect(state.windows.map((item) => item.kind)).toEqual(["panel"]);
    // A panel that cannot be read is left behind, with its window.
    saved.panels.quick_fit.controls[0].kind = "slider";
    expect(buildState(saved, files).panels.quick_fit).toBeUndefined();
    expect(buildState(saved, files).windows).toEqual([]);
  });

  it("export to a file and come back from it as they were", () => {
    const doc = quickFit();
    const file = JSON.stringify(panelFile(panelOf(doc)));
    const read = readPanelFile(file);
    expect(read).toEqual({ ...panelOf(doc) });
    expect(() => readPanelFile("{}")).toThrow(/not an exported panel/);
    expect(() => readPanelFile("nope")).toThrow(/not JSON/);
    expect(() => checkPanel({ ...JSON.parse(file), version: 2 })).toThrow(/later version/);
    const other = new Doc();
    other.dispatch({ op: "setPanel", name: "copy", panel: JSON.parse(file) });
    expect(other.getState().panels.copy).toEqual({ ...panelOf(doc), name: "copy" });
    expect(other.getState().windows[0]).toMatchObject({ name: "copy", kind: "panel" });
  });

  it("echo as the Python that builds them", () => {
    const echo = (command: Parameters<typeof echoPython>[0]) => echoPython(command);
    expect(echo({ op: "newPanel" })).toBe("op.new_panel()");
    expect(echo({ op: "modifyPanel", panel: "p", props: { title: "Fit" } })).toBe(
      'op.panel("p").set(title="Fit")',
    );
    expect(
      echo({
        op: "addControl",
        panel: "p",
        kind: "wave",
        name: "target",
        props: { label: "Spectrum", dims: 1 },
      }),
    ).toBe('op.panel("p").wave("target", label="Spectrum", dims=1)');
    expect(
      echo({
        op: "addControl",
        panel: "p",
        kind: "choice",
        name: "model",
        props: { label: "Model", options: ["gauss", "lor"], value: "lor" },
      }),
    ).toBe('op.panel("p").choice("model", ["gauss", "lor"], label="Model", value="lor")');
    expect(
      echo({
        op: "addControl",
        panel: "p",
        kind: "button",
        name: "run",
        props: { label: "Fit", action: "core.fit", args: { y: { $control: "target" } } },
      }),
    ).toBe(
      'op.panel("p").button("run", "Fit", action="core.fit", args={"y": op.control("target")})',
    );
    expect(echo({ op: "setControlValue", panel: "p", control: "model", value: "lor" })).toBe(
      'op.panel("p")["model"] = "lor"',
    );
    expect(echo({ op: "moveControl", panel: "p", control: "run", to: 0 })).toBe(
      'op.panel("p").control("run").move(0)',
    );
    expect(echo({ op: "modifyControl", panel: "p", control: "run", props: { name: "go" } })).toBe(
      'op.panel("p").control("run").set(name="go")',
    );
    expect(echo({ op: "removeControl", panel: "p", control: "run" })).toBe(
      'op.panel("p").control("run").remove()',
    );
    expect(
      echo({
        op: "setPanel",
        name: "p",
        panel: {
          title: "",
          controls: [{ kind: "button", name: "b", args: { y: { $control: "w" } } }],
        },
      }),
    ).toBe(
      'op.set_panel("p", {"title": "", "controls": [{"kind": "button", "name": "b", "args": {"y": op.control("w")}}]})',
    );
  });
});

describe("wave pickers", () => {
  it("offer the numeric waves of their dimensions whose names pass the filter", () => {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "s1_I", data: wave(1, 2) });
    doc.dispatch({ op: "makeWave", name: "run1:s2_I", data: wave(1, 2) });
    doc.dispatch({ op: "makeWave", name: "s1_V", data: wave(1, 2) });
    doc.dispatch({ op: "makeWave", name: "map", data: wave(1, 2, 3, 4), shape: [2, 2] });
    doc.dispatch({ op: "makeWave", name: "labels", text: ["a", "b"] });
    const picker = (dims: number | null, filter: string) =>
      pickerWaves(doc.getState(), {
        kind: "wave",
        name: "w",
        label: "",
        inline: false,
        value: null,
        dims,
        filter,
      });
    expect(picker(null, "")).toEqual(["s1_I", "run1:s2_I", "s1_V", "map"]);
    expect(picker(1, "")).toEqual(["s1_I", "run1:s2_I", "s1_V"]);
    expect(picker(2, "")).toEqual(["map"]);
    expect(picker(null, "*_i")).toEqual(["s1_I", "run1:s2_I"]);
    expect(picker(null, "s1")).toEqual(["s1_I", "s1_V"]);
    expect(matchesFilter("a.b", "a.*")).toBe(true);
    expect(matchesFilter("axb", "a.b")).toBe(false);
  });
});

describe("controls made for an argument", () => {
  it("take the argument's kind, limits, choices and default", () => {
    expect(controlForParam("y", { type: "wave", title: "Y wave", optional: false })).toEqual({
      kind: "wave",
      props: { label: "Y wave" },
    });
    expect(controlForParam("n", { type: "integer", optional: true, min: 1, default: 5 })).toEqual({
      kind: "number",
      props: { label: "n", min: 1, step: 1, value: 5 },
    });
    expect(
      controlForParam("kind", {
        type: "choice",
        optional: true,
        choices: ["linear", "cubic"],
        default: "cubic",
      }),
    ).toEqual({
      kind: "choice",
      props: { label: "kind", options: ["linear", "cubic"], value: "cubic" },
    });
    expect(controlForParam("quiet", { type: "boolean", optional: true, default: false })).toEqual({
      kind: "checkbox",
      props: { label: "quiet", value: false },
    });
    expect(controlForParam("guess", { type: "numbers", optional: true })).toBeNull();
    // What it makes is a control the panel takes.
    const doc = new Doc();
    doc.dispatch({ op: "newPanel", name: "p" });
    const made = controlForParam("n", { type: "integer", optional: true, min: 1, default: 5 })!;
    doc.dispatch({ op: "addControl", panel: "p", kind: made.kind, name: "n", props: made.props });
    expect(doc.getState().panels.p!.controls[0]).toMatchObject({ value: 5, min: 1, step: 1 });
  });
});

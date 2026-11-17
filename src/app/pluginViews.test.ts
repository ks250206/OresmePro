import { describe, expect, it, vi } from "vite-plus/test";
import {
  beginHandleDrag,
  clickPlot,
  dragHandle,
  endHandleDrag,
  followWaves,
  forgetViews,
  openView,
  setValue,
  undoView,
  viewStore,
} from "./pluginViews";

/** A view's Python, held until a test lets each answer go; what it was sent is kept. */
interface Call {
  state: unknown;
  event: {
    type: string;
    paths?: string[];
    id?: string;
    x?: number;
    y?: number;
    saved?: unknown;
  };
  waves: Record<string, string>;
  answer: (values: { state?: unknown; ui?: unknown }) => void;
}
const calls: Call[] = [];
const kept: Record<string, { plugin: string; editor: string; version: string; state: unknown }> =
  {};
/** The experiment's waves, as far as views see them: their revisions. */
const waves: Record<string, { rev: number }> = {};
const listeners = new Set<() => void>();
/** Changes a wave (or takes it away, with null) and tells whoever follows the experiment. */
function changeWave(name: string, rev: number | null) {
  if (rev === null) delete waves[name];
  else waves[name] = { rev };
  for (const listener of listeners) listener();
}
vi.mock("./session", () => ({
  doc: {
    getState: () => ({ results: {}, editors: kept, waves }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: (command: { plugin: string; editor: string; version: string; state: unknown }) => {
      kept[`${command.plugin}/${command.editor}`] = { ...command };
      return null;
    },
  },
  pluginStore: {
    list: () => ["lab", "plot"].map((name) => ({ manifest: { name, version: "1.2.0" } })),
  },
  invokeAction: () => Promise.reject(new Error("no actions here")),
  plugins: {
    runView: (_plugin: string, _view: string, request: Omit<Call, "answer">) =>
      new Promise((resolve) => {
        calls.push({
          ...request,
          answer: (values) =>
            resolve({
              waves: [],
              values: {
                state: values.state === undefined ? null : JSON.stringify(values.state),
                ui: values.ui === undefined ? null : JSON.stringify(values.ui),
                message: null,
              },
              graph: null,
              log: "",
            }),
        });
      }),
  },
}));

const ui = {
  version: 1,
  body: {
    type: "column",
    children: [
      { type: "wave", label: "Y", bind: "y" },
      { type: "number", label: "X", bind: "x" },
    ],
  },
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the window of a plugin's view", () => {
  it("sends on the waves a view opened again chose for itself", async () => {
    openView("lab/one");
    await settle();
    expect(calls.at(-1)!.waves).toEqual({});
    // Restored from its last result: the view chose the wave "signal" itself.
    calls.at(-1)!.answer({ state: { y: "signal", x: 1 }, ui });
    await settle();
    expect(calls.at(-1)!.event).toEqual({ type: "change", paths: ["y"] });
    expect(calls.at(-1)!.waves).toEqual({ y: "signal" });
    calls.at(-1)!.answer({});
    await settle();
  });

  it("tells the view when a wave it was given changes or goes, while its window is open", async () => {
    changeWave("signal", 1);
    openView("lab/follow");
    await settle();
    calls.at(-1)!.answer({ state: { y: "signal", x: 1 }, ui });
    await settle();
    calls.at(-1)!.answer({});
    await settle();
    const stop = followWaves("lab/follow");
    const before = calls.length;

    changeWave("other", 5);
    await settle();
    expect(calls.length).toBe(before);

    changeWave("signal", 2);
    await settle();
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.event).toEqual({ type: "change", paths: ["y"] });
    calls.at(-1)!.answer({});
    await settle();

    changeWave("signal", null);
    await settle();
    expect(calls.length).toBe(before + 2);
    expect(calls.at(-1)!.event).toEqual({ type: "change", paths: ["y"] });
    calls.at(-1)!.answer({});
    await settle();

    // Closed, it is told nothing more.
    stop();
    changeWave("signal", 3);
    await settle();
    expect(calls.length).toBe(before + 2);
  });

  it("keeps an undo made while an answer was on its way", async () => {
    const key = "lab/two";
    openView(key);
    await settle();
    calls.at(-1)!.answer({ state: { x: 1 }, ui });
    await settle();
    setValue(key, "x", 2);
    await settle();
    // Undone before the view answers the edit: its answer must not bring the 2 back.
    undoView(key);
    calls.at(-1)!.answer({ state: { x: 2 } });
    await settle();
    expect(viewStore(key).get().state).toEqual({ x: 1 });
    expect(calls.at(-1)!.event).toEqual({ type: "change", paths: ["*"] });
    expect(calls.at(-1)!.state).toEqual({ x: 1 });
    calls.at(-1)!.answer({ state: { x: 1 } });
    await settle();
    expect(viewStore(key).get().state).toEqual({ x: 1 });
  });

  it("takes a handle's drag as one edit, told to the view as it goes", async () => {
    const key = "lab/three";
    openView(key);
    await settle();
    calls.at(-1)!.answer({ state: { x: 1, peak: { center: 5 } }, ui });
    await settle();
    beginHandleDrag(key);
    dragHandle(key, { "peak.center": 6 });
    // Moved again while the view answers the first step: the steps after it go as one change.
    dragHandle(key, { "peak.center": 7 });
    dragHandle(key, { "peak.center": 8 });
    expect(calls.at(-1)!.event).toEqual({ type: "change", paths: ["peak.center"] });
    calls.at(-1)!.answer({ state: { x: 1, peak: { center: 6 }, area: 60 } });
    await settle();
    // The view's answer is to the first step; where the handle is now stays.
    expect(viewStore(key).get().state).toEqual({ x: 1, peak: { center: 8 }, area: 60 });
    expect(calls.at(-1)!.state).toEqual({ x: 1, peak: { center: 8 }, area: 60 });
    calls.at(-1)!.answer({});
    await settle();
    endHandleDrag(key);
    expect(viewStore(key).get().past).toHaveLength(1);
    undoView(key);
    expect(viewStore(key).get().state).toEqual({ x: 1, peak: { center: 5 } });
    calls.at(-1)!.answer({});
    await settle();
  });

  it("tells the view where its plot was clicked", async () => {
    const key = "lab/four";
    openView(key);
    await settle();
    calls.at(-1)!.answer({ state: {}, ui });
    await settle();
    clickPlot(key, "add", 2.5, 10);
    expect(calls.at(-1)!.event).toEqual({ type: "command", id: "add", x: 2.5, y: 10 });
    calls.at(-1)!.answer({ state: { added: [2.5] } });
    await settle();
    // What the click added is undone in the window, as an edit is.
    expect(viewStore(key).get().past).toEqual([{}]);
    undoView(key);
    expect(viewStore(key).get().state).toEqual({});
    calls.at(-1)!.answer({});
    await settle();
    // A command that changes nothing leaves nothing to undo.
    clickPlot(key, "add", 1, 1);
    calls.at(-1)!.answer({ state: {} });
    await settle();
    expect(viewStore(key).get().past).toEqual([]);
  });

  it("keeps its state in the experiment, and starts from it when opened again", async () => {
    const key = "plot/five";
    openView(key);
    await settle();
    expect(calls.at(-1)!.event).toMatchObject({ type: "open", saved: null });
    calls.at(-1)!.answer({ state: { x: 1 }, ui });
    await settle();
    setValue(key, "x", 4);
    calls.at(-1)!.answer({});
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(kept[key]).toEqual({
      op: "keepEditorState",
      plugin: "plot",
      editor: "five",
      version: "1.2.0",
      state: { x: 4 },
    });
    // Another experiment, or a reload: the window starts again from what was kept.
    forgetViews();
    openView(key);
    await settle();
    expect(calls.at(-1)!.event).toMatchObject({
      type: "open",
      saved: { state: { x: 4 }, version: "1.2.0" },
    });
    calls.at(-1)!.answer({ state: { x: 4 }, ui });
    await settle();
  });
});

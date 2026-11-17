import { describe, expect, it, vi } from "vite-plus/test";
import { openView, setValue, undoView, viewStore } from "./pluginViews";

/** A view's Python, held until a test lets each answer go; what it was sent is kept. */
interface Call {
  state: unknown;
  event: { type: string; paths?: string[] };
  waves: Record<string, string>;
  answer: (values: { state?: unknown; ui?: unknown }) => void;
}
const calls: Call[] = [];
vi.mock("./session", () => ({
  doc: { getState: () => ({ results: {} }) },
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
});

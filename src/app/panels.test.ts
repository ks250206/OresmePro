import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buttonKey, panelRuntime, pressButton } from "./panels";
import { emptyDoc } from "../core/doc/types";
import { doc, kernel } from "./session";

/** A promise to settle from the test, as the call of an action that is running. */
function pending() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setUp() {
  doc.dispatch({ op: "makeWave", name: "w", data: new Float64Array([1, 2, 3]) });
  doc.dispatch({ op: "newPanel", name: "p" });
  doc.dispatch({ op: "addControl", panel: "p", kind: "number", name: "n", props: { value: 3 } });
  doc.dispatch({ op: "addControl", panel: "p", kind: "wave", name: "pick", props: { value: "w" } });
  doc.dispatch({
    op: "addControl",
    panel: "p",
    kind: "button",
    name: "go",
    props: { action: "core.smooth", args: { wave: { $control: "pick" }, n: { $control: "n" } } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  doc.load(emptyDoc());
  panelRuntime.set({ busy: {}, errors: {} });
});

describe("pressing a panel's button", () => {
  it("calls once while a call runs, with the values it was pressed with", async () => {
    setUp();
    const call = pending();
    const invoke = vi.spyOn(kernel, "invoke").mockReturnValue(call.promise);
    const first = pressButton("p", "go");
    const second = pressButton("p", "go");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("core.smooth", { wave: "w", n: 3 }, undefined);
    expect(panelRuntime.get().busy).toEqual({ p: "go" });
    // A change made while the call runs is the panel's, not the call's.
    doc.dispatch({ op: "setControlValue", panel: "p", control: "n", value: 9 });
    call.resolve({ wave: "w_smth" });
    await Promise.all([first, second]);
    expect(panelRuntime.get().busy).toEqual({});
    await pressButton("p", "go");
    expect(invoke).toHaveBeenLastCalledWith("core.smooth", { wave: "w", n: 9 }, undefined);
  });

  it("keeps what went wrong by the button and leaves the values as they are", async () => {
    setUp();
    vi.spyOn(kernel, "invoke").mockRejectedValue(
      new Error("OresmeError: core.smooth: n must be at least 1, not 0."),
    );
    await pressButton("p", "go");
    expect(panelRuntime.get().errors[buttonKey("p", "go")]).toBe(
      "core.smooth: n must be at least 1, not 0.",
    );
    expect(panelRuntime.get().busy).toEqual({});
    expect(doc.getState().panels.p!.controls[0]).toMatchObject({ value: 3 });
  });

  it("calls nothing when a value is missing, and says which", async () => {
    setUp();
    const invoke = vi.spyOn(kernel, "invoke");
    doc.dispatch({ op: "setControlValue", panel: "p", control: "pick", value: null });
    await pressButton("p", "go");
    expect(invoke).not.toHaveBeenCalled();
    expect(panelRuntime.get().errors[buttonKey("p", "go")]).toBe("Choose a wave for pick.");
  });
});

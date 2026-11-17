import { describe, expect, it } from "vite-plus/test";
import { failureJson } from "../../kernel/rpc";
import { PluginError } from "../plugins/manifest";
import { SandboxError } from "../sandbox/validate";
import { Doc } from "./doc";
import { DocError, ERROR_CODES, errorInfo } from "./types";

/** What a command is refused with, as code and details. */
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    const { code, details } = errorInfo(error);
    return { code, details };
  }
  throw new Error("It was not refused.");
}

function setup(): Doc {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: Float64Array.of(1, 2, 3) });
  doc.dispatch({ op: "display", y: ["y"], name: "G" });
  return doc;
}

describe("errors the app refuses requests with", () => {
  it("say what kind of refusal they are, and what it is about", () => {
    const doc = setup();
    expect(refusal(() => doc.dispatch({ op: "killWaves", names: ["nope"] }))).toEqual({
      code: "NOT_FOUND",
      details: { kind: "wave", name: "nope" },
    });
    expect(refusal(() => doc.dispatch({ op: "display", y: ["y"], name: "G" }))).toMatchObject({
      code: "ALREADY_EXISTS",
      details: { name: "G" },
    });
    expect(refusal(() => doc.dispatch({ op: "killWaves", names: ["y"] }))).toEqual({
      code: "IN_USE",
      details: { kind: "wave", name: "y", users: ["G"] },
    });
    expect(
      refusal(() =>
        doc.dispatch({ op: "modifyTrace", graph: "G", trace: "y", props: { lineSize: -1 } }),
      ),
    ).toEqual({ code: "INVALID_ARGUMENT", details: { field: "lineSize" } });
    expect(
      refusal(() =>
        doc.dispatch({ op: "modifyTrace", graph: "G", trace: "nope", props: { lineSize: 2 } }),
      ),
    ).toEqual({ code: "NOT_FOUND", details: { kind: "trace", name: "nope" } });
    expect(
      refusal(() => doc.dispatch({ op: "modifyAxis", graph: "G", axis: "R9", props: {} })),
    ).toMatchObject({ code: "NOT_FOUND", details: { kind: "axis", name: "R9" } });
  });

  it("are INVALID_ARGUMENT unless said otherwise, and anything that is not one is INTERNAL", () => {
    expect(errorInfo(new DocError("bad"))).toEqual({
      code: "INVALID_ARGUMENT",
      message: "bad",
      details: {},
    });
    expect(errorInfo(new TypeError("x is undefined"))).toEqual({
      code: "INTERNAL",
      message: "x is undefined",
      details: {},
    });
    expect(errorInfo("text")).toMatchObject({ code: "INTERNAL", message: "text" });
  });

  it("from plugins say so, and at which phase", () => {
    expect(errorInfo(new SandboxError("Took too long.", "timeout"))).toEqual({
      code: "PLUGIN_FAILED",
      message: "Took too long.",
      details: { phase: "timeout" },
    });
    expect(errorInfo(new SandboxError("No isolation here.", "start", "UNSUPPORTED")).code).toBe(
      "UNSUPPORTED",
    );
    expect(errorInfo(new PluginError("Bad manifest.")).code).toBe("PLUGIN_FAILED");
  });

  it("cross to Python with their message where it always was, and their code and details", () => {
    const doc = setup();
    let thrown: unknown;
    try {
      doc.dispatch({ op: "killWaves", names: ["y"] });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.parse(failureJson(thrown))).toEqual({
      ok: false,
      error: 'Wave "y" is in use by G. Remove it from there first.',
      code: "IN_USE",
      details: { kind: "wave", name: "y", users: ["G"] },
    });
    // Details that cannot be written as JSON are left out, not the refusal.
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(JSON.parse(failureJson(new DocError("odd", "INTERNAL", loop)))).toMatchObject({
      code: "INTERNAL",
      details: {},
    });
  });

  it("are a fixed list, which is part of the API", () => {
    expect([...ERROR_CODES]).toEqual([
      "INVALID_ARGUMENT",
      "NOT_FOUND",
      "ALREADY_EXISTS",
      "IN_USE",
      "CONFLICT",
      "UNSUPPORTED",
      "PLUGIN_FAILED",
      "INTERNAL",
    ]);
  });
});

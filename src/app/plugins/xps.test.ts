import { loadPyodide, type PyodideInterface } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../../core/doc/doc";
import { layoutGraph } from "../../core/plot/layout";
import { makePluginGraph, planOutcome } from "../../core/plugins/outcome";
import { checkResult } from "../../core/sandbox/validate";
import sdk from "../../sandbox/python/oresme_plugin.py?raw";
import { sandboxWave } from "./host";
import { readLocalPackage } from "./sources";

/**
 * The example plugin in examples/plugins/xps: it must stay a valid package,
 * its own numerical checks must pass in Pyodide (the Python it runs in), and
 * what its peak fit returns must be taken in as the app takes a run's
 * outcome: checked, made into waves, kept as a result, and drawn as the graph
 * it asks for (a reversed binding energy axis, the residual above the data).
 */

const FILES = import.meta.glob<string>(
  ["../../../examples/plugins/xps/**/*.{py,json,md}", "!**/__pycache__/**"],
  { query: "?raw", import: "default", eager: true },
);
const PREFIX = "../../../examples/plugins/";
const encode = (text: string) => new TextEncoder().encode(text);
const measure = (text: string, size: number) => text.length * size * 0.55;

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide({
    packageCacheDir: "public/pyodide",
    lockFileURL: "public/pyodide/pyodide-lock.json",
  });
  await pyodide.loadPackage(["numpy", "scipy"], { messageCallback: () => {} });
  // The repository's layout, as the checks find the plugin SDK from where they are.
  const copies: [string, string][] = [
    ...Object.entries(FILES).map(([path, text]): [string, string] => [
      `/repo/examples/plugins/${path.slice(PREFIX.length)}`,
      text,
    ]),
    ["/repo/src/sandbox/python/oresme_plugin.py", sdk],
  ];
  for (const [path, text] of copies) {
    pyodide.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    pyodide.FS.writeFile(path, encode(text));
  }
  pyodide.runPython(
    "import sys; sys.dont_write_bytecode = True; sys.path.insert(0, '/repo/src/sandbox/python')",
  );
}, 300_000);

/** Loads the plugin as the sandbox does (afresh) and runs xps_fit as sandboxWorker.js does. */
function runFit(doc: Doc, params: Record<string, unknown>): Record<string, unknown> {
  pyodide.runPython(
    "import sys\nfor name in [m for m in sys.modules if m == 'xps' or m.startswith('xps.')]:\n    del sys.modules[name]",
  );
  const runtime = pyodide.pyimport("oresme_plugin");
  runtime._load(
    "/repo/examples/plugins/xps",
    "xps",
    JSON.stringify(["quantify", "view:quant", "xps_fit", "xps_preview"]),
  );
  const inputs = { spectrum: sandboxWave(doc.getState().waves.c1s!) };
  const outcome = runtime._run("xps_fit", inputs, JSON.stringify(params));
  const result = outcome.toJs({ dict_converter: Object.fromEntries }) as {
    waves: Record<string, { dtype: string; data?: Uint8Array | ArrayBuffer }>;
    values: string;
    graph: string;
  };
  outcome.destroy();
  for (const wave of Object.values(result.waves)) {
    wave.data = (wave.data as Uint8Array).slice().buffer;
  }
  return {
    waves: result.waves,
    values: JSON.parse(result.values),
    graph: JSON.parse(result.graph),
    log: "",
  };
}

/** A C 1s spectrum: two GL(30) peaks on a step, binding energies 280–294 eV by 0.05 eV. */
function c1s(): Doc {
  const doc = new Doc();
  const count = 281;
  const data = new Float64Array(count);
  const gl = (u: number) => Math.exp(-4 * Math.LN2 * 0.7 * u * u) / (1 + 4 * 0.3 * u * u);
  for (let i = 0; i < count; i += 1) {
    const be = 280 + 0.05 * i;
    const peaks = 3000 * gl((be - 284.8) / 1.1) + 900 * gl((be - 286.3) / 1.1);
    const step = 1000 + 600 / (1 + Math.exp(-(be - 285.5) / 0.4));
    data[i] = step + peaks;
  }
  doc.dispatch({ op: "makeWave", name: "c1s", data, x0: 280, dx: 0.05, xUnit: "eV", unit: "cps" });
  return doc;
}

describe("the example plugin xps", () => {
  it("is a package the app installs: its manifest is valid and it has every file it lists", async () => {
    const picked = Object.entries(FILES).map(([path, text]) => ({
      path: path.slice(PREFIX.length),
      bytes: () => Promise.resolve(encode(text)),
    }));
    expect(picked.map((file) => file.path)).toContain("xps/README.md");
    const pkg = await readLocalPackage(picked);
    expect(pkg.manifest.name).toBe("xps");
    expect(pkg.manifest.actions.map((action) => action.name)).toEqual([
      "xps_fit",
      "xps_preview",
      "quantify",
    ]);
    // Its model editor is checked against those actions when it is installed.
    expect(pkg.manifest.editors.map((editor) => [editor.kind, editor.title])).toEqual([
      // A view, whose window its Python builds out of the app's parts.
      ["view", "XPS Quantification"],
      ["spectrum-fit", "XPS Peak Fitting"],
    ]);
    expect(pkg.manifest.python).toEqual({ entry: "xps", packages: ["numpy", "scipy"] });
    expect([...pkg.files.keys()].sort()).toEqual(pkg.manifest.files.map((f) => f.path).sort());
    expect(pkg.files.has("README.md")).toBe(false);
  });

  it("passes its numerical checks on synthetic spectra in Pyodide", { timeout: 300_000 }, () => {
    let printed = "";
    pyodide.setStdout({ batched: (text) => (printed += `${text}\n`) });
    const failures = pyodide
      .runPython(
        [
          "import sys",
          "sys.path.insert(0, '/repo/examples/plugins/xps/tests')",
          "import test_xps",
          "test_xps.run_all()",
        ].join("\n"),
      )
      .toJs() as string[];
    expect(failures, printed).toEqual([]);
    expect(printed).toContain("ok    test_fit_recovers_c1s_exactly");
  });

  it("fits a region and draws it as CasaXPS does, with the residual above", () => {
    const doc = c1s();
    const params = {
      components: "C-C: GL(30) pos=284.6; C-O: GL(30) pos=A+1.5 fwhm=A",
      region: [281, 293],
    };
    const outcome = checkResult(runFit(doc, params));
    const pkgAction = {
      name: "xps_fit",
      title: "XPS Peak Fit",
      description: "",
      params: {
        spectrum: { type: "wave" },
        components: { type: "string" },
        region: { type: "numbers", optional: true, length: 2 },
      },
    };
    const plan = planOutcome(
      doc.getState(),
      pkgAction as never,
      { spectrum: "c1s", ...params } as never,
      outcome,
      {
        action: "plugin.xps.xps_fit",
        plugin: "xps",
        version: "0.1.0",
        origin: "folder",
        commit: null,
        digest: "0".repeat(64),
      },
      0,
    );
    expect(plan.keepsResult).toBe(true);
    for (const command of plan.commands) doc.dispatch(command);
    const name = makePluginGraph(doc, plan.graph!, plan.waves, "xps");
    const state = doc.getState();
    const graph = state.graphs[name]!;
    expect(name).toBe("XPSFit0");
    expect(graph.traces.map((trace) => [trace.y, trace.vAxis])).toEqual([
      ["c1s_region", "left"],
      ["c1s_background", "left"],
      ["c1s_comp_A", "left"],
      ["c1s_comp_B", "left"],
      ["c1s_envelope", "left"],
      ["c1s_residual", "right"],
    ]);
    // The region's waves keep binding energies as their scaling: 281 eV on, by 0.05 eV.
    const region = state.waves.c1s_region!;
    expect(region.x0).toBeCloseTo(281, 9);
    expect(region.dx).toBeCloseTo(0.05, 12);
    expect(region.xUnit).toBe("eV");
    expect(graph.axes.bottom).toMatchObject({ label: "Binding Energy (eV)", reverse: true });
    expect(graph.axes.left!.span).toEqual([0, 0.78]);
    expect(graph.axes.right!.span).toEqual([0.82, 1]);
    expect(graph.annotations[0]).toMatchObject({ anchor: "LT", y: 0.2 });
    expect(graph.annotations[0]!.text).toContain("A: C-C");

    const values = plan.values as { components: { name: string; position: number }[] };
    expect(values.components.map((row) => row.name)).toEqual(["C-C", "C-O"]);
    expect(values.components[1]!.position - values.components[0]!.position).toBeCloseTo(1.5, 9);

    const layout = layoutGraph(graph, state.waves, 600, 450, measure);
    expect(layout.missing).toEqual([]);
    // Higher binding energy is on the left.
    const bottom = layout.axes.bottom!.scale;
    expect(bottom.toPixel(290)).toBeLessThan(bottom.toPixel(282));
  });
});

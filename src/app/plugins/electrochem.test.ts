import { loadPyodide } from "pyodide";
import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../../core/doc/doc";
import { layoutGraph } from "../../core/plot/layout";
import sdk from "../../sandbox/python/oresme_plugin.py?raw";
import { contributionCommands } from "./contributions";
import { readLocalPackage } from "./sources";

/**
 * The example plugin in examples/plugins/electrochem: it must stay a valid
 * package (so it can be installed as the docs say), its graph template must
 * be one the app takes, and its own numerical checks must pass in Pyodide,
 * the Python it runs in.
 */

/** Every file of the example (all text), by its path from this folder. */
const FILES = import.meta.glob<string>(
  ["../../../examples/plugins/electrochem/**/*.{py,json,md}", "!**/__pycache__/**"],
  { query: "?raw", import: "default", eager: true },
);
const PREFIX = "../../../examples/plugins/";

const encode = (text: string) => new TextEncoder().encode(text);

describe("the example plugin electrochem", () => {
  it("is a package the app installs: its manifest is valid and it has every file it lists", async () => {
    // As a folder is picked in the browser: its paths start with the folder's name.
    const picked = Object.entries(FILES).map(([path, text]) => ({
      path: path.slice(PREFIX.length),
      bytes: () => Promise.resolve(encode(text)),
    }));
    expect(picked.map((file) => file.path)).toContain("electrochem/README.md");
    const pkg = await readLocalPackage(picked);
    expect(pkg.manifest.name).toBe("electrochem");
    expect(pkg.manifest.actions.map((action) => action.name)).toEqual([
      "cv_peaks",
      "tafel",
      "eis_fit",
      "eis_circuit",
    ]);
    // A view, whose window its Python builds out of the app's parts.
    expect(pkg.manifest.editors.map((editor) => [editor.kind, editor.name])).toEqual([
      ["view", "eis"],
    ]);
    expect(pkg.manifest.python).toEqual({ entry: "electrochem", packages: ["numpy", "scipy"] });
    // Every file it lists, and not the README or the tests beside them.
    expect([...pkg.files.keys()].sort()).toEqual(pkg.manifest.files.map((f) => f.path).sort());
    expect(pkg.files.has("README.md")).toBe(false);

    // Its Nyquist template goes into an experiment and makes a graph of a spectrum and its fit.
    const doc = new Doc();
    const [path] = pkg.manifest.contributes.graphTemplates;
    for (const command of contributionCommands("graphTemplates", path!, pkg.files.get(path!)!)) {
      doc.dispatch(command);
    }
    // Z′ spans 3× the range of −Z″, as a spectrum's arc does.
    const values: Record<string, number[]> = {
      zre: [10, 20, 40],
      zim: [0, 5, 10],
      zre_fit: [10, 20, 40],
      zim_fit: [0, 5, 10],
    };
    for (const [name, data] of Object.entries(values)) {
      doc.dispatch({ op: "makeWave", name, data: Float64Array.from(data), unit: "Ω" });
    }
    doc.dispatch({
      op: "makeGraphs",
      template: "Nyquist",
      samples: [{ zre: "zre", zim: "zim", zre_fit: "zre_fit", zim_fit: "zim_fit" }],
      names: ["Spectrum"],
    });
    const graph = doc.getState().graphs.Spectrum!;
    expect(graph.traces.map((trace) => [trace.y, trace.x])).toEqual([
      ["zim", "zre"],
      ["zim_fit", "zre_fit"],
    ]);
    expect(graph.axes.left!.label).toBe("−Z″ (Ω)");
    expect(graph.axes.bottom!.label).toBe("Z′ (Ω)");
    // An ohm is as long along Z′ as along −Z″ (Plan 1), and the plot is 7 cm tall.
    expect(graph.width).toEqual({ mode: "plan", factor: 1, hAxis: "bottom", vAxis: "left" });
    const layout = layoutGraph(
      graph,
      doc.getState().waves,
      440,
      440,
      (text, size) => text.length * size * 0.55,
    );
    const perOhm = (name: string) => {
      const scale = layout.axes[name]!.scale;
      return Math.abs(scale.p1 - scale.p0) / (scale.max - scale.min);
    };
    expect(perOhm("bottom") / perOhm("left")).toBeCloseTo(1, 2);
    expect(layout.plot.h).toBe(Math.round((7 / 2.54) * 72 * (4 / 3)));
  });

  it("passes its numerical checks on synthetic data in Pyodide", { timeout: 300_000 }, async () => {
    const pyodide = await loadPyodide({
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
    let printed = "";
    pyodide.setStdout({ batched: (text) => (printed += `${text}\n`) });
    const failures = pyodide
      .runPython(
        [
          "import sys",
          "sys.dont_write_bytecode = True",
          "sys.path.insert(0, '/repo/examples/plugins/electrochem/tests')",
          "import test_electrochem",
          "test_electrochem.run_all()",
        ].join("\n"),
      )
      .toJs() as string[];
    expect(failures, printed).toEqual([]);
    expect(printed).toContain("ok    test_eis_recovers_every_model_exactly");
  });
});

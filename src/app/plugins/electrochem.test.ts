import { loadPyodide } from "pyodide";
import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../../core/doc/doc";
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
    for (const name of ["zre", "zim", "zre_fit", "zim_fit"]) {
      doc.dispatch({ op: "makeWave", name, data: Float64Array.from([1, 2, 3]), unit: "Ω" });
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

import { describe, expect, it } from "vite-plus/test";
import { catalogFromLock } from "../../app/packageCatalog";
import { installedRows, packageState, packageTree } from "../../ui/PackagesDialog";
import { unzipExperiment, zipExperiment } from "../io/experiment";
import { Doc } from "./doc";
import { echoPython } from "./echo";
import { fromOutside, normalizePackageName, requirementsText } from "./pythonEnv";

const pkg = (name: string, depends: string[] = [], requested = false, source = "pypi") => ({
  name,
  version: "1.0",
  source,
  url: `https://files.pythonhosted.org/${name}-1.0-py3-none-any.whl`,
  sha256: "ab",
  depends,
  requested,
});

function setup(): Doc {
  const doc = new Doc();
  doc.dispatch({
    op: "recordPackages",
    pyodide: "314.0.7",
    packages: [
      pkg("Py_Baselines", ["numpy"], true),
      pkg("emcee", ["numpy", "tqdm"], true),
      pkg("tqdm"),
      pkg("statsmodels", ["patsy"], true, "pyodide"),
      pkg("patsy", [], false, "pyodide"),
    ],
  });
  return doc;
}

describe("the Python packages of an experiment", () => {
  it("are recorded by normalized name, in order, and saved with it", () => {
    const doc = setup();
    const env = doc.getState().python;
    expect(env.pyodide).toBe("314.0.7");
    expect(env.packages.map((item) => item.name)).toEqual([
      "emcee",
      "patsy",
      "py-baselines",
      "statsmodels",
      "tqdm",
    ]);
    expect(fromOutside(env).map((item) => item.name)).toEqual(["emcee", "py-baselines", "tqdm"]);
    expect(requirementsText(env)).toBe("emcee==1.0\npy-baselines==1.0\nstatsmodels==1.0\n");
    const back = unzipExperiment(zipExperiment(doc.getState(), [])).state;
    expect(back.python).toEqual(env);
    expect(normalizePackageName("Scikit_Image")).toBe("scikit-image");
  });

  it("keep a package asked for asked for when it comes again as another's need", () => {
    const doc = setup();
    doc.dispatch({
      op: "recordPackages",
      pyodide: "314.0.7",
      packages: [{ ...pkg("emcee"), version: "2.0" }],
    });
    const emcee = doc.getState().python.packages.find((item) => item.name === "emcee")!;
    expect([emcee.version, emcee.requested]).toEqual(["2.0", true]);
  });

  it("go with what only they needed, and undo", () => {
    const doc = setup();
    doc.dispatch({ op: "forgetPackages", names: ["emcee"] });
    expect(doc.getState().python.packages.map((item) => item.name)).toEqual([
      "patsy",
      "py-baselines",
      "statsmodels",
    ]);
    doc.dispatch({ op: "forgetPackages", names: ["statsmodels", "Py-Baselines"] });
    expect(doc.getState().python).toEqual({ pyodide: null, packages: [] });
    doc.undo();
    expect(doc.getState().python.packages).toHaveLength(3);
    expect(() => doc.dispatch({ op: "forgetPackages", names: ["nothing"] })).toThrow(
      /does not use a package named "nothing"/,
    );
    expect(() =>
      doc.dispatch({
        op: "recordPackages",
        pyodide: "1",
        packages: [{ ...pkg("x"), source: "ftp" }],
      }),
    ).toThrow(/source must be one of/);
  });

  it("are recorded by the Python that installs them, not written again", () => {
    expect(echoPython({ op: "recordPackages", pyodide: "1", packages: [] })).toBeNull();
    expect(echoPython({ op: "forgetPackages", names: ["a"] })).toBeNull();
  });
});

describe("the Packages dialog", () => {
  it("shows each package asked for with what it brought, and how it stands in Python", () => {
    const env = setup().getState().python;
    expect(packageTree(env).map(({ depth, item }) => `${depth}:${item.name}`)).toEqual([
      "0:emcee",
      "1:tqdm",
      "0:py-baselines",
      "0:statsmodels",
      "1:patsy",
    ]);
    const emcee = env.packages[0]!;
    expect(packageState(emcee, null)).toBe("Python has not said");
    const status = {
      installed: { emcee: "1.0", tqdm: "0.9" },
      imported: ["emcee"],
      base: [],
      python: "3.14.2",
      pyodide: "314.0.7",
    };
    expect(packageState(emcee, status)).toBe("imported");
    expect(packageState(env.packages[4]!, status)).toBe("installed 0.9, 1.0 recorded");
    expect(packageState(env.packages[1]!, status)).toBe("not installed");
  });

  it("lists everything in Python, pre-installed too, and the bundled ones before they load", () => {
    const env = setup().getState().python;
    const status = {
      installed: { numpy: "2.2.5", ipython: "9.0", emcee: "1.0", sympy: "1.14", scipy: "1.18.0" },
      imported: ["numpy", "emcee", "scipy"],
      base: ["numpy", "ipython"],
      python: "3.14.2",
      pyodide: "314.0.7",
    };
    const catalog = catalogFromLock({
      packages: {
        numpy: { file_name: "numpy-2.2.5.whl", version: "2.2.5" },
        scipy: { file_name: "scipy-1.18.0.whl", version: "1.18.0" },
        "scikit-learn": { file_name: "scikit_learn-1.8.0.whl", version: "1.8.0" },
        lmfit: { file_name: "lmfit-1.3.4.whl", version: "1.3.4" },
        sympy: { file_name: "https://cdn.jsdelivr.net/pyodide/sympy-1.14.whl", version: "1.14" },
        "sympy-tests": { file_name: "sympy-tests.zip", version: "1.14", package_type: "package" },
        libfoo: { file_name: "libfoo.zip", version: "1", package_type: "shared_library" },
      },
    });
    expect(catalog.bundled).toEqual({
      numpy: "2.2.5",
      scipy: "1.18.0",
      "scikit-learn": "1.8.0",
      lmfit: "1.3.4",
    });
    expect(Object.keys(catalog.distribution).sort()).toEqual([
      "lmfit",
      "numpy",
      "scikit-learn",
      "scipy",
      "sympy",
    ]);
    expect(
      installedRows(status, env, true, catalog).map((row) => `${row.name}:${row.kind}`),
    ).toEqual(["emcee:experiment", "numpy:pre-installed", "scipy:bundled"]);
    const all = installedRows(status, env, false, catalog);
    expect(all.map((row) => `${row.name}:${row.kind}:${row.loaded}`)).toEqual([
      "emcee:experiment:true",
      "numpy:pre-installed:true",
      "scipy:bundled:true",
      "ipython:pre-installed:true",
      "sympy:pyodide:true",
      "lmfit:bundled:false",
      "scikit-learn:bundled:false",
    ]);
    expect(all.find((row) => row.name === "lmfit")!.version).toBe("1.3.4");
  });
});

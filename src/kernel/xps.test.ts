import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { background, curve, evaluateModel, parseShape, type Shape } from "../core/xps";
import { FileStore } from "../core/files/files";
import { bootPython, type PythonKernel } from "./boot";
import { answerRpc } from "./rpc";

/**
 * op.xps_fit, the app's own XPS peak fit (src/kernel/python/_oresme_xps.py),
 * run in Pyodide against a real document, on synthetic spectra whose answers
 * are known.
 */
const doc = new Doc();
const files = new FileStore();
let kernel: PythonKernel;
let stdout = "";
let errors: string[] = [];
let runCount = 0;

async function run(code: string): Promise<boolean> {
  stdout = "";
  errors = [];
  runCount += 1;
  return kernel.execute(code);
}

/** Runs code and returns what it printed, failing the test if it raised. */
async function output(code: string): Promise<string> {
  const ok = await run(code);
  expect(errors).toEqual([]);
  expect(ok).toBe(true);
  return stdout;
}

beforeAll(async () => {
  const pyodide = await loadPyodide({
    packageCacheDir: "public/pyodide",
    lockFileURL: "public/pyodide/pyodide-lock.json",
  });
  kernel = await bootPython(pyodide, {
    rpc: (method, paramsJson, data) =>
      answerRpc(
        {
          doc,
          files,
          renderSvg: () => "",
          exportGraph: () => {},
          renderPageSvg: () => "",
          exportPage: () => {},
          measureText: (text, size) => text.length * size * 0.55,
          importPresets: () => [],
        },
        method,
        paramsJson,
        data ? data.slice() : null,
        `run${runCount}`,
      ),
    stream: (name, text) => {
      if (name === "stdout") stdout += text;
    },
    display: () => {},
    error: (name, message) => errors.push(`${name}: ${message}`),
  });
  // A C 1s spectrum: three GL(30) components on a flat background of 200 counts,
  // with B tied to A as C-O is to C-C (A+1.5 eV, the same width).
  await output(
    [
      "import _oresme_xps as X",
      "be = np.arange(294.0, 279.99, -0.05)",
      "gl = X.parse_shape('GL(30)')",
      "truth = [(284.8, 1.1, 3000.0), (286.3, 1.1, 800.0), (288.9, 1.3, 400.0)]",
      "clean = 200 + sum(gl.curve(be, p, f, a) for p, f, a in truth)",
      "op.make('c1s', clean, x0=be[0], dx=be[1] - be[0], x_unit='eV')",
      "C1S = [",
      "    {'name': 'C-C', 'shape': 'GL(30)', 'position': 284.6, 'fwhm': 1.0},",
      "    {'name': 'C-O', 'position': 286.0, 'constraints': {'position': 'A+1.5', 'fwhm': 'A'}},",
      "    {'name': 'O-C=O', 'position': 289.1, 'fwhm': 1.5, 'constraints': {'position': '288, 290'}},",
      "]",
    ].join("\n"),
  );
}, 300_000);

describe("op.xps_fit", () => {
  it("finds the components of a clean spectrum", async () => {
    const text = await output(
      [
        "r = op.xps_fit('c1s', C1S, region=[281, 293], quiet=True)",
        "for row, (p, f, a) in zip(r.components, truth):",
        "    assert abs(row['position'] - p) < 1e-5, (row, p)",
        "    assert abs(row['fwhm'] - f) < 1e-5, (row, f)",
        "    assert abs(row['area'] - a) < 1e-4 * a, (row, a)",
        "assert r.components[1]['constraints'] == {'position': 'A+1.5', 'fwhm': 'A', 'area': '0, ∞'}",
        "assert abs(sum(row['percent'] for row in r.components) - 100) < 1e-9",
        "assert r.chisq < 1e-6 and r.converged, r",
        "print(r.name, sorted(r.waves))",
      ].join("\n"),
    );
    expect(text.trim()).toBe("XPS0 ['A', 'B', 'C', 'background', 'fit', 'residual']");
    const state = doc.getState();
    expect(state.results.XPS0!.kind).toBe("xps");
    const graph = state.graphs.XPS_c1s!;
    expect(graph.axes.bottom!.reverse).toBe(true);
    expect(graph.traces.map((trace) => trace.y)).toEqual([
      "c1s",
      "fit_c1s_bg",
      "fit_c1s_A",
      "fit_c1s_B",
      "fit_c1s_C",
      "fit_c1s",
      "fit_c1s_res",
    ]);
    // NaN outside the region, the spectrum's length and scaling.
    const background = state.waves.fit_c1s_bg!;
    expect(background.data.length).toBe(state.waves.c1s!.data.length);
    expect(Number.isNaN(background.data[0])).toBe(true);
  });

  it("puts the truth within its uncertainties when there is noise", async () => {
    await output(
      [
        "rng = np.random.default_rng(7)",
        "op.make('noisy', rng.poisson(clean).astype(float), x0=be[0], dx=be[1] - be[0])",
        "r = op.xps_fit('noisy', C1S, region=[281, 293], quiet=True, graph=False, record=False)",
        "for row, (p, f, a) in zip(r.components, truth):",
        "    for key, value in (('position', p), ('fwhm', f), ('area', a)):",
        "        assert abs(row[key] - value) < 4 * row[key + '_sigma'] + 1e-12, (key, row, value)",
        "assert 0.7 < r.chisq_reduced < 1.4, r.chisq_reduced",
      ].join("\n"),
    );
  });

  it("works from kinetic energies with a charge correction", async () => {
    await output(
      [
        "ke = 1486.6 - (be + 0.4)",
        "op.make('ke_counts', clean)",
        "op.make('ke_axis', ke)",
        "r = op.xps_fit('ke_counts', C1S, x='ke_axis', energy='kinetic', shift=-0.4,",
        "               region=[281, 293], quiet=True, graph=False, record=False)",
        "for row, (p, f, a) in zip(r.components, truth):",
        "    assert abs(row['position'] - p) < 1e-5 and abs(row['area'] - a) < 1e-4 * a, row",
        "assert op.exists('fit_ke_counts_BE')",
      ].join("\n"),
    );
  });

  it("keeps the area of every line shape, with or without a Gaussian", async () => {
    await output(
      [
        "far = np.geomspace(60, 1e7, 40_000)[1:]",
        "grid = np.concatenate([-far[::-1], np.linspace(-60, 60, 600_001), far])",
        "for text in ['GL(0)', 'GL(30)', 'GL(70)', 'SGL(40)', 'GL(30)T(1.5)', 'SGL(20)T(0.8)', 'LA(1.53,243)', 'LA(1.2,3)']:",
        "    shape = X.parse_shape(text)",
        "    area = np.trapezoid(shape.curve(grid, 0.3, 0.9, 5.0), grid)",
        "    assert abs(area - 5.0) < 2e-4 * 5.0, (text, area)",
        "    # A Gaussian moves area about but keeps it, over a span that holds both.",
        "    near = np.linspace(-60, 60, 600_001)",
        "    plain = np.trapezoid(shape.curve(near, 0.3, 0.9, 5.0), near)",
        "    smoothed = np.trapezoid(shape.curve(near, 0.3, 0.9, 5.0, 0.6), near)",
        "    assert abs(smoothed - plain) < 2e-4 * 5.0, (text, plain, smoothed)",
        "numeric = X._half_area(lambda u: np.exp(-4 * np.log(2) * u * u))",
        "assert abs(numeric - 0.25 * np.sqrt(np.pi / np.log(2))) < 1e-10, numeric",
        "lorentz = X._half_area(lambda u: 1 / (1 + 4 * u * u))",
        "assert abs(lorentz - np.pi / 4) < 1e-9, lorentz",
      ].join("\n"),
    );
  });

  it("makes the waves again and drops components no longer there", async () => {
    await output(
      [
        "r = op.xps_fit('c1s', C1S[:2], region=[281, 293], quiet=True)",
        "assert not op.exists('fit_c1s_C')",
        "assert 'fit_c1s_C' not in [t.name for t in op.graph('XPS_c1s').traces]",
      ].join("\n"),
    );
  });

  it("runs again from the result it kept", async () => {
    await output(
      [
        "again = op.result('XPS0').rerun()",
        "assert len(again.components) == 3 and abs(again.components[0]['position'] - 284.8) < 1e-5",
        "both = op.result('XPS0').apply(['noisy', 'c1s'], table=False)",
        "assert [r.spectrum for r in both] == ['noisy', 'c1s'], both",
        "assert abs(both[1].components[0]['position'] - 284.8) < 1e-5",
        "assert op.exists('fit_noisy_C')",
      ].join("\n"),
    );
  });

  it("only draws the components when told not to fit", async () => {
    await output(
      [
        "r = op.xps_fit('c1s', [{'position': 284.8, 'fwhm': 1.1, 'area': 3000}], region=[281, 293],",
        "               fit=False, quiet=True, graph=False, record=False)",
        "assert r.components[0]['position'] == 284.8 and r.components[0]['area'] == 3000",
        "assert r.reason == 'not fitted'",
      ].join("\n"),
    );
  });

  it("is an action that returns the components and is recorded as op.xps_fit", async () => {
    const result = (await kernel.invoke(
      "core.xps_fit",
      null,
      JSON.stringify({
        y: "c1s",
        components: [{ name: "C-C", position: 284.7, fwhm: 1.2 }],
        region: [282, 287.5],
        background: "linear",
        graph: false,
        quiet: true,
      }),
      (code) => {
        expect(code).toBe(
          'op.xps_fit(op.wave("c1s"), [{"name": "C-C", "position": 284.7, "fwhm": 1.2}], ' +
            'region=[282.0, 287.5], background="linear", graph=False, quiet=True)',
        );
      },
    )) as string;
    const parsed = JSON.parse(result) as {
      result: { components: { letter: string; position: number }[]; background: string };
    };
    expect(parsed.result.background).toBe("linear");
    expect(parsed.result.components[0]!.letter).toBe("A");
    expect(parsed.result.components[0]!.position).toBeGreaterThan(284.5);
  });

  it("draws in the window what Python computes", async () => {
    // The window's own arithmetic (src/core/xps.ts) must agree with Python's.
    const shapes = [
      "GL(30)",
      "GL(0)",
      "GL(100)",
      "SGL(40)",
      "GL(30)T(1.5)",
      "SGL(20)T(0.8)",
      "LA(1.53,243)",
      "LA(1.2,3)",
    ];
    const grid = Array.from({ length: 241 }, (_, i) => 280 + i * 0.05);
    const python = JSON.parse(
      await output(
        [
          "import json",
          `grid = np.array(${JSON.stringify(grid)})`,
          "out = {}",
          `for text in ${JSON.stringify(shapes)}:`,
          "    s = X.parse_shape(text)",
          "    out[text] = [s.curve(grid, 285.3, 0.9, 7.0).tolist(), s.curve(grid, 285.3, 0.9, 7.0, 0.7).tolist()]",
          "y = clean[(be > 281) & (be < 293)]",
          "x = be[(be > 281) & (be < 293)]",
          "for method in ['shirley', 'linear', 'tougaard']:",
          "    out[method] = X.make_background(x, y + 40 * (x > 286), method, 5).tolist()",
          "out['x'] = x.tolist(); out['y'] = (y + 40 * (x > 286)).tolist()",
          "print(json.dumps(out))",
        ].join("\n"),
      ),
    ) as Record<string, number[] | number[][]>;
    const close = (a: ArrayLike<number>, b: readonly number[], what: string) => {
      const scale = Math.max(...b.map(Math.abs));
      for (let i = 0; i < b.length; i += 1)
        expect(Math.abs(a[i]! - b[i]!), `${what} at ${i}`).toBeLessThan(1e-9 * scale);
    };
    for (const text of shapes) {
      const shape = parseShape(text) as Shape;
      const [plain, smoothed] = python[text] as number[][];
      close(curve(shape, grid, 285.3, 0.9, 7.0), plain!, text);
      close(curve(shape, grid, 285.3, 0.9, 7.0, 0.7), smoothed!, `${text} with a Gaussian`);
    }
    const x = python.x as number[];
    const y = python.y as number[];
    for (const method of ["shirley", "linear", "tougaard"] as const) {
      close(background(x, y, method, 5) as Float64Array, python[method] as number[], method);
    }
    // And the model it starts the fit from is the one Python fits.
    const model = evaluateModel({
      be: Float64Array.from(x),
      y,
      region: null,
      background: "shirley",
      average: 5,
      components: [
        {
          name: "A",
          shape: "GL(30)",
          position: 284.8,
          fwhm: 1.1,
          area: 3000,
          rsf: 1,
          gauss: 0,
          constraints: { position: "", fwhm: "", area: "" },
        },
        {
          name: "B",
          shape: "GL(30)",
          position: 0,
          fwhm: 0,
          area: 800,
          rsf: 1,
          gauss: 0,
          constraints: { position: "A+1.5", fwhm: "A", area: "" },
        },
      ],
    });
    expect(typeof model).not.toBe("string");
    if (typeof model !== "string") {
      expect(model.resolved.values[1]).toEqual({ position: 286.3, fwhm: 1.1, area: 800 });
      expect(model.resolved.errors).toEqual({});
    }
  });

  it("refuses what cannot be fitted, saying why", async () => {
    const cases: [string, string][] = [
      [
        "[{'position': 285, 'constraints': {'position': 'B'}}, {'position': 286, 'constraints': {'position': 'A'}}]",
        "circle",
      ],
      ["[{'position': 285, 'constraints': {'area': 'C*0.5'}}]", "no component C"],
      ["[{'position': 285, 'shape': 'Voigt'}]", "not a line shape"],
      ["[{'position': 285, 'constraints': {'fwhm': 'wide'}}]", "not a constraint"],
      ["[{'name': 'x'}]", "has no position"],
    ];
    for (const [components, message] of cases) {
      expect(await run(`op.xps_fit('c1s', ${components}, region=[281, 293], quiet=True)`)).toBe(
        false,
      );
      expect(errors.join("\n")).toContain(message);
    }
  });
});

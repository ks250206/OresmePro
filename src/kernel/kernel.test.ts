import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { echoPython } from "../core/doc/echo";
import { tableEditCommands, type CellEdit } from "../core/doc/tableEdit";
import { FileStore } from "../core/files/files";
import { layoutGraph } from "../core/plot/layout";
import { layoutPage } from "../core/plot/page";
import { toSvg } from "../core/plot/svg";
import excelWorkbook from "../core/io/testdata/excel.xlsx?inline";
import { igorFixture } from "../core/io/testdata/igor";
import { bootPython, type PythonKernel } from "./boot";
import { answerRpc } from "./rpc";

/**
 * Runs the real Python package inside Pyodide against a real document. Only
 * the thread boundary is missing: here Python calls the document directly.
 */
const doc = new Doc();
const files = new FileStore();
let kernel: PythonKernel;
let stdout = "";
let stderr = "";
let errors: string[] = [];
let displays: Record<string, string>[] = [];
let runCount = 0;
const exported: string[] = [];

async function run(code: string): Promise<boolean> {
  stdout = "";
  stderr = "";
  errors = [];
  displays = [];
  runCount += 1;
  return kernel.execute(code);
}

beforeAll(async () => {
  // The lock file the app serves: it also knows the packages added from PyPI (lmfit).
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
          renderSvg: (name, width, height) => {
            const state = doc.getState();
            const layout = layoutGraph(
              state.graphs[name]!,
              state.waves,
              width ?? 400,
              height ?? 300,
              (text, size) => text.length * size * 0.55,
              { timeZone: state.timeZone },
            );
            return toSvg(layout.prims, layout.width, layout.height);
          },
          exportGraph: (name, filename, cursors) =>
            exported.push(`${name}:${filename}${cursors ? ":cursors" : ""}`),
          renderPageSvg: (name) => {
            const state = doc.getState();
            const layout = layoutPage(
              state.pages[name]!,
              state,
              (text, size) => text.length * size * 0.55,
            );
            return toSvg(layout.prims, layout.width, layout.height);
          },
          exportPage: (name, filename) => exported.push(`${name}:${filename}`),
          measureText: (text, size) => text.length * size * 0.55,
          importPresets: () => [{ name: "bench", settings: { decimal: ",", skip: 1 } }],
        },
        method,
        paramsJson,
        // Copy out of the WebAssembly heap, as the worker does by transferring.
        data ? data.slice() : null,
        `run${runCount}`,
      ),
    stream: (name, text) => {
      if (name === "stdout") stdout += text;
      else stderr += text;
    },
    display: (json) => displays.push(JSON.parse(json) as Record<string, string>),
    error: (name, message) => errors.push(`${name}: ${message}`),
  });
}, 180_000);

describe("oresme Python API", () => {
  it("has numpy and oresme imported", async () => {
    expect(await run("print(np.__name__, op.__name__)")).toBe(true);
    expect(stdout).toBe("numpy oresme\n");
  });

  it("makes waves and reads them back", async () => {
    expect(
      await run(
        'w = op.make("signal", np.arange(5) * 2.0, dx=0.5, x_unit="s", unit="V")\nprint(repr(w), len(w), w[1], w.data.sum(), w.x.tolist())',
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "Wave('signal', n=5, x0=0, dx=0.5 s, unit='V') 5 2.0 20.0 [0.0, 0.5, 1.0, 1.5, 2.0]\n",
    );
    expect([...doc.getState().waves.signal!.data]).toEqual([0, 2, 4, 6, 8]);
  });

  it("works with numpy functions and arithmetic", async () => {
    expect(await run("print(np.sqrt(w)[2], (w + 1)[0], (w * w).max(), float(np.mean(w)))")).toBe(
      true,
    );
    expect(stdout).toBe("2.0 1.0 64.0 4.0\n");
  });

  it("writes points, slices and whole arrays back", async () => {
    expect(await run("w[0] = 10; w[1:3] = [11, 12]; w[-1] = 14; w[::2] = 0")).toBe(true);
    expect([...doc.getState().waves.signal!.data]).toEqual([0, 11, 0, 6, 0]);
    expect(await run("w.data = w.data * 2; print(w.data[1])")).toBe(true);
    expect(stdout).toBe("22.0\n");
  });

  it("refuses silent no-op writes to the data copy", async () => {
    expect(await run("w.data[0] = 1")).toBe(false);
    expect(errors[0]).toMatch(/ValueError: assignment destination is read-only/);
  });

  it("builds and modifies a graph", async () => {
    expect(
      await run(
        [
          "g = op.display(w)",
          'g.trace("signal").color = "blue"',
          'g.trace().set(mode="lines+markers", line_size=2)',
          'g.axis("left").label = "Amplitude"',
          "g.bottom.range = (0, 1)",
          "g.legend()",
          "print(g, g.trace().color, g.left.label, g.bottom.range, g.font_size)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("Graph('Graph0') #0000ff Amplitude (0, 1) 12\n");
    const graph = doc.getState().graphs.Graph0!;
    expect(graph.traces[0]).toMatchObject({ mode: "lines+markers", lineSize: 2 });
    expect(graph.annotations).toHaveLength(1);
  });

  it("plots arrays directly by making waves for them", async () => {
    expect(await run("g2 = op.display(np.ones(3)); print(g2.traces[0].y.name)")).toBe(true);
    expect(stdout).toBe("wave0\n");
  });

  it("shows a graph as an image when it is the result", async () => {
    expect(await run("g")).toBe(true);
    expect(displays[0]!["text/plain"]).toBe("Graph('Graph0')");
    expect(displays[0]!["image/svg+xml"]).toMatch(/^<svg /);
  });

  it("returns ordinary results as text", async () => {
    expect(await run("1 + 1")).toBe(true);
    expect(displays).toEqual([{ "text/plain": "2" }]);
  });

  it("reports application errors as Python exceptions", async () => {
    expect(await run('op.wave("nope")')).toBe(false);
    expect(errors[0]).toBe('OresmeError: No wave named "nope".');
    expect(await run('g.trace().colour = "red"')).toBe(false);
    expect(errors[0]).toMatch(/AttributeError: Trace has no property 'colour'/);
    expect(await run("op.kill(w)")).toBe(false);
    expect(errors[0]).toMatch(/in use by Graph0/);
  });

  it("reports syntax errors", async () => {
    expect(await run("x = = 1")).toBe(false);
    expect(errors[0]).toMatch(/^SyntaxError/);
  });

  it("supports top-level await and magics", async () => {
    expect(await run("import asyncio\nawait asyncio.sleep(0)\nprint('awaited')")).toBe(true);
    expect(stdout).toBe("awaited\n");
    expect(await run("%pwd")).toBe(true);
    expect(displays[0]!["text/plain"]).toContain("/");
  });

  it("makes tables and lists windows", async () => {
    expect(await run("t = op.edit(w); print(t, op.graphs(), op.tables(), op.graph().name)")).toBe(
      true,
    );
    expect(stdout).toBe(
      "Table('Table0') [Graph('Graph0'), Graph('Graph1')] [Table('Table0')] Graph1\n",
    );
  });

  it("sets table digits and writes cells the way the table echoes them", async () => {
    expect(
      await run("t.digits = 5; print(t.digits, op.table('Table0').set(digits=6).digits)"),
    ).toBe(true);
    expect(stdout).toBe("5 6\n");
    expect(
      await run(
        [
          "gw = op.make('grow', [1.0, 2.0])",
          "gw[2] = 3; gw[3:5] = [4, 5]; gw[0:2] = float('nan')",
          "mm = op.make('mm', np.zeros((3, 4)))",
          "mm[1, 2] = 9; mm.flat[2:5] = [1, 2, 3]",
          "print(gw.data.tolist(), mm.data.tolist())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "[nan, nan, 3.0, 4.0, 5.0] [[0.0, 0.0, 1.0, 2.0], [3.0, 0.0, 9.0, 0.0], [0.0, 0.0, 0.0, 0.0]]\n",
    );
  });

  it("undoes a whole execution as one step", async () => {
    const before = Object.keys(doc.getState().waves).length;
    await run('op.make("a1", [1]); op.make("a2", [2])');
    doc.undo();
    expect(Object.keys(doc.getState().waves)).toHaveLength(before);
  });

  it("completes names", async () => {
    const items = kernel.complete("op.dis", 6);
    expect(items).toContainEqual({ text: "display", start: 3, end: 6, type: "attribute" });
  });

  it("keeps waves in data folders", async () => {
    expect(
      await run(
        [
          'f = op.new_folder("run1")',
          'a = f.make("a", [1, 2, 3])',
          'b = op.make("run1:raw:b", [4.0])',
          "print(a.name, f.waves(), [x.path for x in f.folders()], [x.path for x in op.folders()])",
          'a.rename("archive:a")',
          'print(a.name, op.exists("archive:a"), op.exists("root:archive:a"), op.exists("run1:a"))',
          'op.folder("run1").kill()',
          "print([x.path for x in op.folders()])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "run1:a [Wave('run1:a', n=3, x0=0, dx=1)] ['run1:raw'] ['run1', 'run1:raw']\n" +
        "archive:a True True False\n['archive']\n",
    );
  });

  it("handles 2-D and text waves", async () => {
    expect(
      await run(
        [
          'm = op.make("m", np.arange(6.0).reshape(2, 3), dx=2, y0=10, dy=5)',
          "print(repr(m), m.shape, m.ndim, m[1, 2], m.data.sum(axis=1).tolist(), m.y.tolist())",
          "m[0, :] = -1",
          "print(m.data.tolist())",
          't = op.make("labels", ["a", "b"])',
          't[1] = "z"; t[2] = "new"',
          "print(repr(t), t.is_text, t.data.tolist(), len(t))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "Wave('m', shape=(2, 3), x0=0, dx=2) (2, 3) 2 5.0 [3.0, 12.0] [10.0, 15.0, 20.0]\n" +
        "[[-1.0, -1.0, -1.0], [3.0, 4.0, 5.0]]\n" +
        "Wave('labels', n=3, text) True ['a', 'z', 'new'] 3\n",
    );
    expect(doc.getState().waves.m!.shape).toEqual([2, 3]);
  });

  it("makes image and contour plots with free axes", async () => {
    expect(
      await run(
        [
          "gi = op.image(m, color_table='viridis')",
          "gi.image().z_max = 4",
          "c = gi.append_contour(m, levels=[1, 2], color='red')",
          "gi.colorscale()",
          "ax = gi.add_axis('R2', 'right')",
          "ax.set(span=(0.5, 1), label='other')",
          "gi.append(w, axis='R2')",
          "print(gi.image().color_table, gi.image().z_max, c.levels, [a.name for a in gi.axes], gi.axis('R2').side)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("viridis 4 [1, 2] ['left', 'bottom', 'right', 'top', 'R2'] right\n");
    expect(await run("op.image(w)")).toBe(false);
    expect(errors[0]).toMatch(/has one dimension/);
    expect(Object.keys(doc.getState().graphs)).not.toContain("Graph4");
  });

  it("places cursors and reads them back", async () => {
    expect(
      await run(
        [
          'c = op.make("curve", np.arange(10.0) ** 2, x0=100, dx=0.5)',
          "gc = op.display(c)",
          'a = gc.cursor("A", "curve", 3)',
          'b = gc.cursor("B", c, 5)',
          "print(a.point, a.x, a.y, b.y - a.y, a)",
          "a.point = 4; print(a.y); b.remove(); print(gc.cursor('B').is_set)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("3 101.5 9.0 16.0 Cursor('A' on curve[3], x=101.5, y=9)\n16.0\nFalse\n");
  });

  it("fits built-in and custom functions", async () => {
    expect(
      await run(
        [
          "rng = np.random.default_rng(3)",
          "xs = np.linspace(-5, 5, 201)",
          'peak = op.make("peak", 0.5 + 3 * np.exp(-((xs - 1.2) / 0.8) ** 2) + rng.normal(scale=0.01, size=xs.size), x0=xs[0], dx=xs[1] - xs[0])',
          "gp = op.display(peak)",
          'r = op.fit("gauss", peak, quiet=True)',
          "print(r.names, np.round(r.coef, 2).tolist(), r.converged, bool(np.all(r.sigma < 0.01)))",
          "print([t.name for t in gp.traces], op.wave('W_coef').data.shape, round(r['x0'], 2))",
          'line = op.make("line", 2 * xs + 1)',
          'r2 = op.fit("poly2", line, x=op.make("xs", xs), quiet=True)',
          "print(np.round(r2.coef, 6).tolist())",
          "r3 = op.fit(lambda x, a, k: a * np.exp(k * x), op.make('grow', 2 * np.exp(0.3 * xs)), x='xs', guess=[1, 0.1], quiet=True)",
          "print(np.round(r3.coef, 4).tolist())",
          'decay = op.make("decay", 1 + 4 * np.exp(-np.arange(100) * 0.1 / 2.5), dx=0.1)',
          'print(np.round(op.fit("exp", decay, quiet=True).coef, 3).tolist())',
          'wave_ = op.make("osc", 0.2 + 1.5 * np.sin(3.0 * np.arange(400) * 0.02 + 0.4), dx=0.02)',
          'print(np.round(op.fit("sin", wave_, quiet=True).coef, 3).tolist())',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "('y0', 'A', 'x0', 'width') [0.5, 3.0, 1.2, 0.8] True True\n" +
        "['peak', 'fit_peak'] (4,) 1.2\n" +
        "[1.0, 2.0]\n[2.0, 0.3]\n[1.0, 4.0, 2.5]\n[0.2, 1.5, 3.0, 0.4]\n",
    );
  });

  it("fits between cursors and reports what it did", async () => {
    expect(
      await run(
        'gp.cursor("A", "peak", 100); gp.cursor("B", "peak", 160)\nr = op.fit("gauss", peak, cursors=True)',
      ),
    ).toBe(true);
    expect(stdout).toMatch(/^Fit: gauss\(peak\), 61 points, chi-square = /);
    expect(stdout).toMatch(/x0 {4}= 1\.2\d* \u00b1 /);
    expect(await run('op.fit("nope", peak)')).toBe(false);
    expect(errors[0]).toMatch(/Unknown fit function 'nope'/);
  });

  it("runs the analysis operations", async () => {
    expect(
      await run(
        [
          't2 = op.make("ramp", np.arange(11.0) * 2, dx=0.5, x_unit="s", unit="V")',
          "s = op.stats(t2, quiet=True)",
          "print(s['mean'], s['max'], s['max_x'])",
          "print(op.differentiate(t2).data[:3].tolist(), op.integrate(t2).data[-1], op.integrate(t2).name)",
          "print(op.smooth(t2, 3).data[1], op.fft(t2).x_unit, op.histogram(t2, bins=5).data.tolist())",
          "print(float(np.mean(t2)), np.concatenate([t2, t2]).shape)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "10.0 20.0 5.0\n[4.0, 4.0, 4.0] 50.0 ramp_INT\n2.0 Hz [2.0, 2.0, 2.0, 2.0, 3.0]\n10.0 (22,)\n",
    );
  });

  it("differentiates and integrates against an X wave", async () => {
    expect(
      await run(
        [
          // Uneven steps: the three-point formula is exact for a parabola inside, first order at the ends.
          'dxv = op.make("dxv", [0.0, 0.5, 2.0, 2.25, 4.0], unit="V")',
          'dq = op.differentiate(op.make("dqv", np.array([0.0, 0.5, 2.0, 2.25, 4.0]) ** 2, unit="mAh"), x=dxv)',
          "print(dq.name, dq.data.tolist(), dq.unit, dq.x0, dq.dx, repr(dq.x_unit))",
          // Evenly spaced X gives what the X scaling gives.
          'even = op.make("dxeven", np.sin(np.arange(20) * 0.3), x0=1, dx=0.3)',
          'same = op.differentiate(even, name="dxeven_a").data; byx = op.differentiate(even, x=1 + 0.3 * np.arange(20), name="dxeven_b").data',
          "print(bool(np.allclose(same, byx, rtol=0, atol=1e-12)), op.exists('wave1'))",
          // A repeated X value, and X coming back to where it was, have no slope.
          'print(op.differentiate(op.make("dxrep", [0.0, 1, 2, 3, 4]), x=[0.0, 1, 1, 2, 3]).data.tolist())',
          'print(op.differentiate(op.make("dxturn", [0.0, 1, 4, 1, 0]), x=[0.0, 1, 2, 1, 0]).data.tolist())',
          // Constant current over uneven time steps, and a loop that comes back.
          'itime = op.make("itime", [0.0, 1.0, 3.0, 3.5, 10.0], unit="s")',
          'q = op.integrate(op.make("icur", np.full(5, 2.0), unit="A"), x=itime)',
          "print(q.name, q.data.tolist(), q.unit)",
          'print(op.integrate(op.make("iloop", np.ones(5)), x=[0.0, 1, 2, 1, 0]).data.tolist())',
          // With the X scaling the units follow the same rule.
          'sv = op.make("dxscaled", np.arange(4.0), dx=0.5, x_unit="s", unit="V")',
          "print(op.differentiate(sv).unit, op.integrate(sv).unit, repr(op.integrate(op.make('dxnounit', [1.0, 2.0])).unit))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "dqv_DIF [0.5, 1.0, 4.0, 4.5, 6.25] mAh/V 0.0 1.0 ''",
      "True False",
      "[1.0, nan, nan, 1.0, 1.0]",
      "[1.0, 2.0, nan, 2.0, 1.0]",
      "icur_INT [0.0, 2.0, 6.0, 7.0, 20.0] A·s",
      "[0.0, 1.0, 2.0, 1.0, 0.0]",
      "V/s V·s ''",
    ]);
    expect(await run('op.integrate("icur", x=[0.0, 1, np.nan, 3, 4])')).toBe(false);
    expect(errors[0]).toContain("The X wave is NaN or infinite at point 2, where Y has a value.");
    expect(await run('op.differentiate("icur", x=[0.0, 1, 2])')).toBe(false);
    expect(errors[0]).toContain("must be 1-D with 5 points");
  });

  it("saves a graph through the application", async () => {
    expect(await run('g.save("figure.pdf")')).toBe(true);
    expect(exported).toEqual(["Graph0:figure.pdf"]);
    expect(await run('g.save("figure.bmp")')).toBe(false);
    expect(errors[0]).toMatch(/\.pdf, \.svg or \.png/);
  });

  it("holds, bounds and weights fit parameters", async () => {
    expect(
      await run(
        [
          "xs = np.linspace(-5, 5, 201)",
          'pk = op.make("pk", 0.5 + 3 * np.exp(-((xs - 1.2) / 0.8) ** 2), x0=xs[0], dx=xs[1] - xs[0])',
          'r = op.fit("gauss", pk, hold={"y0": 0.4}, quiet=True)',
          "print(r.held, r['y0'], r.sigma[0], round(r['A'], 1) != 3.0)",
          'r = op.fit("gauss", pk, hold=["width"], guess=[0.5, 3, 1.2, 0.8], quiet=True)',
          "print(np.round(r.coef, 3).tolist(), r.sigma[3])",
          'r = op.fit("gauss", pk, bounds={"A": (None, 2.5), "x0": (0, 5)}, quiet=True)',
          "print(round(r['A'], 6), 0 <= r['x0'] <= 5)",
          "print(str(op.fit('gauss', pk, hold={'y0': 0.5}, quiet=True)).splitlines()[1])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      "('y0',) 0.4 0.0 True\n[0.5, 3.0, 1.2, 0.8] 0.0\n2.5 True\n  y0    = 0.5 (held)\n",
    );
    expect(await run('op.fit("gauss", pk, hold={"nope": 1})')).toBe(false);
    expect(errors[0]).toMatch(/hold: no parameter named 'nope'/);
  });

  it("uses per-point uncertainties as weights and for the reported errors", async () => {
    expect(
      await run(
        [
          "rng = np.random.default_rng(5)",
          "xl = np.arange(50.0)",
          "err = np.where(xl < 25, 0.1, 5.0)",
          'ln = op.make("ln", 2 + 0.5 * xl + rng.normal(scale=err))',
          'op.make("ln_err", err)',
          'weighted = op.fit("line", ln, sigma="ln_err", quiet=True)',
          'plain = op.fit("line", ln, quiet=True)',
          "print(abs(weighted['b'] - 0.5) < 0.02, weighted.sigma[1] < plain.sigma[1], 20 < weighted.chisq < 90)",
          'same = op.fit("line", ln, sigma=2.0, quiet=True)',
          "print(np.allclose(same.coef, plain.coef))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("True True True\nTrue\n");
  });

  it("stores dates as seconds marked with the date unit", async () => {
    expect(
      await run(
        [
          'when = op.make("when", np.array(["2026-11-11T09:00", "2026-11-11T09:30"], dtype="datetime64[m]"))',
          "print(when.unit, when.data[1] - when.data[0], when.data[0])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("dat 1800.0 1794387600.0\n");
  });

  it("makes category plots, shows planes of 3-D waves and labels contours", async () => {
    expect(
      await run(
        [
          'names = op.make("days", ["Mon", "Tue", "Wed"])',
          'counts = op.make("counts", [3, 5, 2])',
          "gb = op.display(counts, x=names)",
          'gb.trace().mode = "bars"',
          "print(gb.trace().mode, gb.trace().x.is_text)",
          'cube = op.make("cube", np.arange(24.0).reshape(3, 4, 2))',
          "gq = op.image(cube, layer=1)",
          "cq = gq.append_contour(cube, layer=1, labels=False)",
          "print(gq.image().layer, cq.labels, cq.layer)",
          "cq.labels = True; print(cq.labels)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("bars True\n1 False 1\nTrue\n");
    expect(await run("gq.image().layer = 2")).toBe(false);
    expect(errors[0]).toMatch(/has 2 layers/);
    expect(await run("op.display(names)")).toBe(false);
    expect(errors[0]).toMatch(/text wave/);
  });

  it("can include cursors when saving a graph", async () => {
    expect(
      await run('g.save("with.svg", cursors=True); print("clip" in g.svg(cursors=True))'),
    ).toBe(true);
    expect(exported.at(-1)).toBe("Graph0:with.svg:cursors");
  });

  it("keeps procedures as Python files that run and import", async () => {
    expect(
      await run(
        [
          'p = op.new_procedure("Proc", "def twice(x):\\n    return 2 * x\\nloaded = True\\n")',
          "p.run()",
          "print(p, twice(4), loaded, p.auto_run, op.procedures(), op.procedure().name)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("Procedure('Proc') 8 True True [Procedure('Proc')] Proc\n");
    expect(doc.getState().procedures.Proc!.code).toContain("def twice");
    expect(doc.getState().windows.at(-1)).toMatchObject({ name: "Proc", kind: "procedure" });

    // Edited in its window, the file on Python's side follows before the next input.
    doc.dispatch({
      op: "setProcedure",
      name: "Proc",
      code: "def twice(x):\n    return x + x + 1\n",
    });
    expect(await run("p.run()\nimport Proc\nprint(twice(4), Proc.twice(1))")).toBe(true);
    expect(stdout).toBe("9 3\n");
    doc.dispatch({ op: "setProcedure", name: "Proc", code: "def twice(x):\n    return 2 * x\n" });
    expect(await run("import Proc\nprint(Proc.twice(5))")).toBe(true);
    expect(stdout).toBe("10\n");
    // The text of a procedure lives in the document, not among the experiment's files.
    expect(files.get("Proc.py")).toBeUndefined();

    expect(await run("p.code = 'raise ValueError(\"from the procedure\")'\np.run()")).toBe(false);
    expect(errors[0]).toBe("ValueError: from the procedure");
    expect(await run("p.kill(); print(op.procedures())")).toBe(true);
    expect(stdout).toBe("[]\n");
    expect(await run("import os; print(os.path.exists('Proc.py'))")).toBe(true);
    expect(stdout).toBe("False\n");
  });

  it("keeps the files Python writes, and gives it the files of the experiment", async () => {
    // Every byte value, and bit patterns that are NaNs when read as numbers.
    const odd = [1, 0, 0, 0, 0, 0, 0xf0, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 7];
    expect(
      await run(
        [
          "import os",
          "print(os.getcwd())",
          'open("out.txt", "w").write("héllo")',
          'os.makedirs("sub/dir", exist_ok=True)',
          `open("sub/dir/b.bin", "wb").write(bytes(range(256)) + bytes(${JSON.stringify(odd)}))`,
          'open("empty", "w").close()',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("/experiment\n");
    expect(stderr).toBe("");
    expect(files.list().map((file) => file.path)).toEqual(["empty", "out.txt", "sub/dir/b.bin"]);
    expect(new TextDecoder().decode(files.get("out.txt")!.bytes)).toBe("héllo");
    expect(Array.from(files.get("sub/dir/b.bin")!.bytes)).toEqual([
      ...Array.from({ length: 256 }, (_, index) => index),
      ...odd,
    ]);
    expect(files.get("empty")!.bytes).toHaveLength(0);

    // Nothing is sent again while nothing changes.
    const version = files.get("out.txt")!.version;
    expect(await run("1 + 1")).toBe(true);
    expect(files.get("out.txt")!.version).toBe(version);

    // Added, replaced and removed in the application.
    files.put("in/data.bin", Uint8Array.from([...odd, 250, 251]));
    files.put("out.txt", new TextEncoder().encode("from the app"));
    files.remove("empty");
    expect(
      await run(
        'print(list(open("in/data.bin", "rb").read()), open("out.txt").read(), os.path.exists("empty"))',
      ),
    ).toBe(true);
    expect(stdout).toBe(`[${[...odd, 250, 251].join(", ")}] from the app False\n`);

    expect(await run('os.remove("out.txt"); open("in/data.bin", "ab").write(b"!")')).toBe(true);
    expect(files.get("out.txt")).toBeUndefined();
    expect(files.get("in/data.bin")!.bytes).toHaveLength(odd.length + 3);

    // A different experiment: Python's directory becomes what that one has.
    files.load([["only.txt", new TextEncoder().encode("x")]]);
    expect(await run("print(sorted(os.listdir()), sorted(os.listdir('in')))")).toBe(true);
    expect(stdout).toBe("['in', 'only.txt', 'sub'] []\n");
  });

  it("writes the script that draws a graph again", async () => {
    expect(
      await run(
        [
          'sx = op.make("sx", [1.0, 2.0, 4.0]); sy = op.make("sy", [3.0, 1.0, 2.0]); se = op.make("se", [0.1, 0.2, 0.1])',
          'sg = op.display(sy, x=sx, name="Styled")',
          'sg.trace("sy").set(mode="lines+markers", color="#0000ff", y_error=se)',
          'sg.add_axis("R2", "right"); sg.append(se, axis="R2")',
          'sg.left.set(range=(0, 5), label="Signal", grid="major"); sg.bottom.set(log=True)',
          'sg.legend(anchor="LT"); sg.textbox("note", frame=False); sg.set(font_size=14)',
          'sg.cursor("A", "sy", 1)',
          "script = sg.script()",
          "print(script)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      [
        'g = op.display("sy", x="sx")',
        'g.add_axis("R2", "right")',
        'g.append("se", axis="R2")',
        'g.trace("sy").set(mode="lines+markers", color="#0000ff", y_error="se")',
        'g.axis("left").set(range=(0, 5), label="Signal", grid="major")',
        'g.axis("bottom").set(log=True)',
        'g.legend(anchor="LT", frame=True)',
        'g.textbox("note", anchor="RT", frame=False)',
        'g.cursor("A", "sy", 1)',
        "g.set(font_size=14)",
        "",
      ].join("\n"),
    );
    // Run as it is, it makes a second graph that looks the same.
    expect(await run("exec(script); print(g.name)")).toBe(true);
    const made = stdout.trim();
    expect(made).not.toBe("Styled");
    const { graphs } = doc.getState();
    expect({ ...graphs[made], name: "" }).toEqual({ ...graphs.Styled, name: "" });
  });

  it("styles traces and axes, tags points and moves annotations", async () => {
    expect(
      await run(
        [
          'ta = op.make("ta", [1.0, 4.0, 9.0, 16.0]); tz = op.make("tz", [0.0, 1.0, 2.0, 3.0])',
          'tg = op.display(ta, name="Polish")',
          'tr = tg.trace("ta")',
          'tr.set(fill="zero", fill_color="green", fill_opacity=0.4, y_offset=2, color_wave=tz, color_table="viridis")',
          'tg.bottom.set(reverse=True, tick_step=1, tick_format=".1f")',
          "tag = tg.tag(tr, 2, 'peak {y}')",
          "leg = tg.legend(x=-0.3, y=0.1)",
          "tag.set(x=0.2, y=-0.2); leg.x = -0.25",
          "print(tr.fill, tr.fill_color, tr.fill_opacity, tr.y_offset, tr.color_wave, tg.bottom.reverse, tg.bottom.tick_format)",
          "print(tag.name, tag.point, tag.x, leg.x, 'peak 9' in tg.svg())",
          "print(tg.script())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      [
        "zero #009900 0.4 2 tz True .1f",
        "tag0 2 0.2 -0.25 True",
        'g = op.display("ta")',
        'g.trace("ta").set(fill="zero", fill_color="#009900", fill_opacity=0.4, y_offset=2, color_wave="tz", color_table="viridis")',
        'g.axis("bottom").set(reverse=True, tick_step=1, tick_format=".1f")',
        'g.tag("ta", 2, "peak {y}", frame=True, x=0.2, y=-0.2)',
        'g.legend(anchor="RT", frame=True, x=-0.25, y=0.1)',
        "",
      ].join("\n"),
    );
    // The script makes the same graph.
    expect(await run("exec(tg.script()); print(g.name)")).toBe(true);
    const made = stdout.trim();
    const { graphs } = doc.getState();
    expect({ ...graphs[made], name: "" }).toEqual({ ...graphs.Polish, name: "" });
  });

  it("shows dates in the experiment's time zone", async () => {
    expect(
      await run(
        [
          'when = op.make("when", np.array(["2026-01-15T00:00", "2026-01-15T12:00"], dtype="datetime64[s]"))',
          'zg = op.display(op.make("zv", [1.0, 2.0]), x=when, name="Zoned")',
          'zg.tag("zv", 1, "{x}")',
          "print(op.time_zone(), '2026-01-15 12:00:00' in zg.svg())",
          'op.set_time_zone("Asia/Tokyo")',
          "print(op.time_zone(), '2026-01-15 21:00:00' in zg.svg(), 'Asia/Tokyo' in zg.svg())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("UTC True\nAsia/Tokyo True True\n");
    expect(await run('op.set_time_zone("Mars/Olympus")')).toBe(false);
    expect(errors[0]).toContain("is not a time zone");
    doc.dispatch({ op: "setTimeZone", zone: "UTC" });
  });

  it("fits with residuals and a confidence band", async () => {
    expect(
      await run(
        [
          "rng = np.random.default_rng(3)",
          "lx = np.linspace(0, 10, 60)",
          'ly = op.make("ly", 2 + 0.5 * lx + rng.normal(scale=0.2, size=60), dx=lx[1] - lx[0])',
          'lg = op.display(ly, name="Resid")',
          'r = op.fit("line", ly, residuals=True, band=0.95, quiet=True)',
          "lo, hi = r.band",
          "inside = np.mean((2 + 0.5 * lo.x > lo.data) & (2 + 0.5 * hi.x < hi.data))",
          "print(r.residuals.name, lo.name, hi.name, len(r.residuals), round(float(abs(r.residuals.data.mean())), 6))",
          "print(bool(inside > 0.9), bool(np.all(hi.data > lo.data)), round(float((hi.data - lo.data).mean()), 2))",
          "print([t.name for t in lg.traces], sorted(lg._info()['axes']), lg.axis('res_left').span, lg.left.span)",
          "print(lg.trace('fit_ly_hi').fill, lg.trace('res_ly')._get()['vAxis'])",
        ].join("\n"),
      ),
    ).toBe(true);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("res_ly fit_ly_lo fit_ly_hi 60 0.0");
    // The true line lies within the band, which is a fraction of the noise wide.
    expect(lines[1]).toMatch(/^True True 0\.[12]\d?$/);
    expect(lines[2]).toBe(
      "['ly', 'fit_ly_hi', 'fit_ly_lo', 'fit_ly', 'res_ly'] ['bottom', 'left', 'res_left', 'right', 'top'] [0.78, 1] [0, 0.72]",
    );
    expect(lines[3]).toBe("next res_left");
    // Fitting again reuses what is there.
    expect(
      await run('op.fit("line", ly, residuals=True, band=True, quiet=True); print(len(lg.traces))'),
    ).toBe(true);
    expect(stdout).toBe("5\n");
  });

  it("finds and fits several peaks", async () => {
    expect(
      await run(
        [
          "px = np.linspace(0, 20, 800)",
          "clean = 0.5 + 0.02 * px + 3 * np.exp(-((px - 6) / 0.8) ** 2) + 1.5 * np.exp(-((px - 11) / 1.2) ** 2) + 2 * np.exp(-((px - 12.8) / 0.5) ** 2)",
          'pk = op.make("mpk", clean + np.random.default_rng(5).normal(scale=0.02, size=800), x0=0, dx=px[1] - px[0])',
          'pg = op.display(pk, name="Peaks")',
          "found = op.find_peaks(pk, smooth=5)",
          "print(len(found), [round(p['x'], 1) for p in sorted(found, key=lambda p: p['x'])])",
          'res = op.fit_peaks(pk, baseline="linear", smooth=5, quiet=True)',
          "print(len(res), [round(p['x'], 2) for p in res], [round(p['height'], 1) for p in res], [round(float(p['width']), 2) for p in res])",
          "print(round(res.baseline['offset'], 1), round(res.baseline['slope'], 2), res.converged, op.wave('W_peaks').data.shape)",
          "print([t.name for t in pg.traces])",
          "print(str(res).splitlines()[0][:38])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "3 [6.0, 11.0, 12.8]",
      // FWHM is 2*sqrt(ln 2) = 1.665 times the width parameter.
      "3 [6.0, 11.0, 12.8] [3.0, 1.5, 2.0] [1.34, 2.0, 0.83]",
      "0.5 0.02 True (3, 4)",
      "['mpk', 'fit_mpk_p1', 'fit_mpk_p2', 'fit_mpk_p3', 'fit_mpk']",
      "Multi-peak fit: 3 gauss peaks, 800 poi",
    ]);
    // Positions given by hand, Lorentzian shape.
    expect(
      await run(
        [
          'lz = op.make("lz", 4 / (1 + ((px - 9) / 0.7) ** 2), x0=0, dx=px[1] - px[0])',
          'one = op.fit_peaks(lz, peaks=[8.5], shape="lor", baseline=None, components=False, quiet=True)',
          "print(round(one[0]['x'], 3), round(one[0]['height'], 3), round(float(one[0]['width']), 3), round(float(one[0]['area']), 2))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("9.0 4.0 1.4 8.8\n");
    expect(await run('op.fit_peaks(op.make("flat", np.zeros(50)))')).toBe(false);
    expect(errors[0]).toContain("No peaks were found");
  });

  it("computes the Faddeeva function and the Voigt profile", async () => {
    expect(
      await run(
        [
          "import _oresme_analysis as oa",
          "def c(v): return f'{v.real:.13f}{v.imag:+.13f}j'",
          "print(c(oa._faddeeva(0)), c(oa._faddeeva(1)), c(oa._faddeeva(1j)), c(oa._faddeeva(1 + 1j)), c(oa._faddeeva(-2.5 + 0.3j)))",
          "vu = np.linspace(-30, 30, 6001)",
          // The limits: a Gaussian when the Lorentzian width is 0, a Lorentzian when the Gaussian width is 0 or tiny.
          "print(float(np.max(np.abs(oa._voigt(vu, 1.3, 0) - np.exp(-(vu / 1.3) ** 2)))) < 1e-14,",
          "      bool(np.array_equal(oa._voigt(vu, 0, 0.7), 1 / (1 + (vu / 0.7) ** 2))),",
          "      float(np.max(np.abs(oa._voigt(vu, 1e-6, 0.7) - 1 / (1 + (vu / 0.7) ** 2)))) < 1e-11)",
          // The normalized profile Re w(z) / (gauss sqrt(pi)) has unit area; the tails past +-L hold 2 lorentz / (pi L).
          "big = np.linspace(-2000, 2000, 400001); g_, l_ = 0.8, 0.5",
          "total = np.trapezoid(oa._voigt(big, g_, l_), big) / oa._voigt_area(g_, l_) + 2 * l_ / (np.pi * 2000)",
          "print(abs(total - 1) < 1e-7, round(oa._voigt_area(1, 0), 12) == round(np.sqrt(np.pi), 12), round(oa._voigt_area(0, 1), 12) == round(np.pi, 12))",
          // The FWHM is exact for the pure shapes, and within 0.02% of Olivero and Longbothum's formula between them.
          "fg, fl = 2 * np.sqrt(np.log(2)), 2.0",
          "print(round(oa._voigt_fwhm(1, 0), 12) == round(fg, 12), oa._voigt_fwhm(0, 1), abs(oa._voigt_fwhm(1, 1) / (0.5346 * fl + np.sqrt(0.2166 * fl ** 2 + fg ** 2)) - 1) < 2e-4,",
          "      round(float(oa._voigt(oa._voigt_fwhm(0.6, 0.9) / 2, 0.6, 0.9)), 12))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      // w(0) = 1, w(1) = exp(-1) + 2i/sqrt(pi) D(1), w(i) = erfcx(1); mpmath at 40 digits for the others.
      "1.0000000000000+0.0000000000000j 0.3678794411714+0.6071577058414j 0.4275835761558+0.0000000000000j 0.3047442052569+0.2082189382028j 0.0382265062607-0.2430420085310j",
      "True True True",
      "True True True",
      "True 2.0 True 0.5",
    ]);
  });

  it("fits Voigt and pseudo-Voigt peaks", async () => {
    expect(
      await run(
        [
          "import _oresme_analysis as oa",
          "vx = np.linspace(-6, 8, 701); vrng = np.random.default_rng(11)",
          'vw = op.make("voigtpk", 0.2 + 3 * oa._voigt(vx - 1.0, 0.6, 0.4) + vrng.normal(scale=0.002, size=vx.size), x0=vx[0], dx=vx[1] - vx[0])',
          'r = op.fit("voigt", vw, quiet=True)',
          "print(r.names, np.round(r.coef, 2).tolist(), r.converged, bool(np.all(np.abs(r.coef - [0.2, 3, 1.0, 0.6, 0.4]) < 3 * r.sigma + 1e-9)))",
          'pw = op.make("pvpk", 0.1 + 2 * oa._pseudo_voigt(vx + 0.5, 0.7, 0.3) + vrng.normal(scale=0.002, size=vx.size), x0=vx[0], dx=vx[1] - vx[0])',
          'r = op.fit("pseudo_voigt", pw, quiet=True)',
          "print(r.names, np.round(r.coef, 2).tolist(), r.converged)",
          // Two Voigt peaks of different mixtures on a sloping baseline.
          "mx = np.linspace(0, 20, 1001)",
          "two = 0.5 + 0.01 * mx + 2 * oa._voigt(mx - 7, 0.5, 0.3) + 1.2 * oa._voigt(mx - 12, 0.3, 0.6)",
          'mw = op.make("voigt2", two + vrng.normal(scale=0.002, size=mx.size), x0=0, dx=mx[1] - mx[0])',
          'res = op.fit_peaks(mw, shape="voigt", baseline="linear", quiet=True)',
          "print(len(res), res.converged, [round(p['x'], 2) for p in res], [round(p['height'], 2) for p in res])",
          "print([round(p['gauss_fwhm'], 2) for p in res], [round(p['lorentz_fwhm'], 2) for p in res])",
          // The FWHM and area of each peak against the profile they were made from.
          "print([round(p['width'] / oa._voigt_fwhm(g, l), 3) for p, (g, l) in zip(res, [(0.5, 0.3), (0.3, 0.6)])],",
          "      [round(float(p['area'] / (h * oa._voigt_area(g, l))), 3) for p, (h, g, l) in zip(res, [(2, 0.5, 0.3), (1.2, 0.3, 0.6)])],",
          "      all(0 < p['area_sigma'] < 0.01 and 0 < p['lorentz_fwhm_sigma'] < 0.05 for p in res), op.wave('W_peaks').data.shape)",
          "print(str(res).splitlines()[1])",
          "pv2 = 0.3 + 2 * oa._pseudo_voigt(mx - 6, 0.6, 0.2) + 1.5 * oa._pseudo_voigt(mx - 13, 0.9, 0.8)",
          'pm = op.make("pvoigt2", pv2 + vrng.normal(scale=0.002, size=mx.size), x0=0, dx=mx[1] - mx[0])',
          'res = op.fit_peaks(pm, shape="pseudo_voigt", quiet=True)',
          "print(len(res), [round(p['x'], 2) for p in res], [round(p['width'], 2) for p in res], [round(p['eta'], 2) for p in res], op.wave('W_peaks').data.shape)",
          // A pure Lorentzian pushes eta to its bound, and the rest still fits.
          'one = op.fit_peaks("lz", peaks=[8.5], shape="pseudo_voigt", baseline=None, components=False, quiet=True)[0]',
          "print(round(one['eta'], 6), round(one['x'], 3), round(one['width'], 3), round(one['area'], 2))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "('y0', 'A', 'x0', 'gwidth', 'lwidth') [0.2, 3.0, 1.0, 0.6, 0.4] True True",
      "('y0', 'A', 'x0', 'width', 'eta') [0.1, 2.0, -0.5, 0.7, 0.3] True",
      "2 True [7.0, 12.0] [2.0, 1.2]",
      // Gaussian FWHM 1.665 times the Gaussian width, Lorentzian FWHM twice the half width.
      "[0.83, 0.5] [0.6, 1.2]",
      "[1.0, 1.0] [0.999, 1.001] True (2, 6)",
      "   #      position        height          FWHM          area    Gauss FWHM     Lor. FWHM",
      "2 [6.0, 13.0] [1.2, 1.8] [0.2, 0.8] (2, 5)",
      "1.0 9.0 1.4 8.8",
    ]);
  });

  it("makes Shirley, Tougaard and linear backgrounds", async () => {
    expect(
      await run(
        [
          // Peaks on a step that is their own Shirley background: it rises from 1 to 3 as their area is passed.
          "bx = np.linspace(280, 300, 401)",
          "bp = 5 * np.exp(-((bx - 290) / 0.8) ** 2) + 2 * np.exp(-((bx - 293) / 1.0) ** 2)",
          "barea = np.concatenate(([0], np.cumsum((bp[1:] + bp[:-1]) / 2 * np.diff(bx))))",
          "bstep = 1 + 2 * barea / barea[-1]",
          'sb = op.background(op.make("shirbe", bstep + bp, x0=280, dx=0.05, x_unit="eV", unit="cps"), "shirley")',
          "print(sb.name, float(np.max(np.abs(sb.data - bstep))) < 1e-6, bool(np.all(np.diff(sb.data) >= 0)), round(sb.data[0], 9), round(sb.data[-1], 9), sb.x0, sb.dx, sb.x_unit, sb.unit)",
          // The same spectrum with binding energy running down, and in kinetic energy as XY data.
          'down = op.background(op.make("shirdown", (bstep + bp)[::-1], x0=300, dx=-0.05), "shirley")',
          'op.make("shirke", 1486.6 - bx[::-1])',
          'ke = op.background(op.make("shirkey", (bstep + bp)[::-1]), "shirley", x="shirke")',
          "print(float(np.max(np.abs(down.data[::-1] - bstep))) < 1e-6, float(np.max(np.abs(ke.data[::-1] - bstep))) < 1e-6)",
          // Over a range of a longer spectrum: NaN outside it, and the subtracted spectrum is the peaks.
          "lx = np.linspace(270, 310, 801); lp = np.interp(lx, bx, bp); ls = np.interp(lx, bx, bstep)",
          'bg, sub = op.background(op.make("shirwide", ls + lp, x0=270, dx=0.05), "shirley", range=(300, 280), subtract=True)',
          "inside = ~np.isnan(bg.data)",
          "print(bg.name, sub.name, int(inside.sum()), float(lx[inside][0]), float(lx[inside][-1]), float(np.max(np.abs(sub.data[inside] - lp[inside]))) < 1e-6, bool(np.isnan(sub.data[0])))",
          "print(bg.note)",
          // Tougaard: a spectrum made from its primary peaks by the loss model, on a constant level of 50.
          "tx = np.arange(601) * 0.1; tf = 1000 * np.exp(-((tx - 20) / 1.0) ** 2) + 600 * np.exp(-((tx - 25) / 1.5) ** 2)",
          "tj = tf.copy()",
          "for i in range(1, tx.size):",
          "    lost = tx[i] - tx[: i + 1]; f = lost / (1643 + lost ** 2) ** 2 * tj[: i + 1]",
          "    tj[i] = tf[i] + 2866 * np.sum((f[1:] + f[:-1]) / 2 * np.diff(tx[: i + 1]))",
          'tw = op.make("tougbe", 50 + tj, x0=0, dx=0.1, x_unit="eV")',
          'tb, ts = op.background(tw, "tougaard", scale=False, subtract=True)',
          "print(float(np.max(np.abs(ts.data - tf))) < 1e-9, round(float(tb.data[-1] - 50), 3), round(float(tj[-1]), 3))",
          // Scaled to meet the data at the far end, B comes out as the universal value; and in kinetic energy.
          'tb = op.background(tw, "tougaard"); print(tb.note)',
          'tk = op.background(op.make("tougke", (50 + tj)[::-1], x0=1486.6 - 60, dx=0.1), "tougaard", subtract=True)[1]',
          "print(float(np.max(np.abs(tk.data[::-1] - tf))) < 1e-6, 'B = 2866 ' in tk.note)",
          // Told the wrong way, the background would have to fall.
          'print(op.background(tw, "tougaard", energy="binding").note == tb.note)',
          // Linear: the line through the averaged ends, exact for a sloping baseline.
          "lb = op.background(op.make('linbg', 2 + 0.1 * bx + bp, x0=280, dx=0.05), 'linear', average=10)",
          "print(float(np.max(np.abs(lb.data - (2 + 0.1 * bx)))) < 1e-9)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "shirbe_bg True True 1.0 3.0 280.0 0.05 eV cps",
      "True True",
      "shirwide_bg shirwide_sub 401 280.0 300.0 True True",
      "shirley background over x = 280 to 300, ends averaged over 5 points",
      "True 54.266 54.266",
      "tougaard background over x = 0 to 60, ends averaged over 5 points, B = 2866 eV^2, C = 1643 eV^2",
      "True True",
      "True",
      "True",
    ]);
    for (const [code, error] of [
      ['op.background("tougbe", "tougaard", energy="kinetic")', "check energy= or the range"],
      ['op.background("shirbe", "shirley", average=300)', "too few to average 300"],
      ['op.background("shirbe", "magic")', 'method must be "shirley", "tougaard" or "linear"'],
      ['op.background("shirbe", range=(500, 600))', "No points have X between 500 and 600"],
      [
        'op.background(op.make("shirnan", [1.0, 2, np.nan, 4, 5, 6, 7, 8, 9, 10, 11, 12]), average=2)',
        "NaN or infinite",
      ],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toContain(error);
    }
    // Between the cursors of the graph showing the spectrum.
    expect(
      await run(
        [
          'cg = op.display("shirwide", name="BgCursors"); cg.cursor("A", "shirwide", 600); cg.cursor("B", "shirwide", 200)',
          'cb = op.background("shirwide", cursors=True, name="shirwide_cur")',
          "print(cb.name, int(np.sum(~np.isnan(cb.data))), bool(np.allclose(cb.data, bg.data, equal_nan=True)))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("shirwide_cur 401 True\n");
  });

  it("finds an onset where the edge line crosses the baseline", async () => {
    expect(
      await run(
        [
          // The edge is 2(x - 4) and the baseline 0.1 + 0.02(x - 3): they cross at x = 8.04 / 1.98.
          "ox = np.arange(0, 8, 0.05); oclean = np.maximum(0.1 + 0.02 * (ox - 3), 2 * ox - 8)",
          'ow = op.make("onsetpk", oclean, dx=0.05, x_unit="eV", unit="cps")',
          "r = op.onset(ow, edge=(4.5, 6), baseline=(2, 3.5), quiet=True)",
          "print(abs(r.x - 8.04 / 1.98) < 1e-12, r.x_sigma < 1e-12, round(r.y, 9), round(r.edge['slope'], 9), round(r.edge['intercept'], 9), r.edge['points'], round(r.baseline['slope'], 9), r.baseline['range'])",
          // With noise the answer lies within the uncertainty, which is a fraction of the noise.
          'nw = op.make("onsetnz", oclean + np.random.default_rng(7).normal(scale=0.05, size=ox.size), dx=0.05, x_unit="eV")',
          "r = op.onset(nw, edge=(4.5, 6), baseline=(3.5, 2))",
          "print(abs(r.x - 8.04 / 1.98) < 3 * r.x_sigma, 0.002 < r.x_sigma < 0.05, float(r) == r.x)",
          // A falling edge (a secondary cutoff) down to a level of 0, the default.
          'fw = op.make("onsetfall", np.maximum(0, 5 - 2.5 * (ox - 1)), dx=0.05)',
          "r = op.onset(fw, edge=(1.5, 2.5), quiet=True)",
          "print(round(r.x, 12), r.baseline, round(op.onset(fw, edge=(1.5, 2.5), baseline=0.5, quiet=True).x, 12))",
        ].join("\n"),
      ),
    ).toBe(true);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("True True 0.121212121 2.0 -8.0 31 0.02 (2.0, 3.5)");
    expect(lines[1]).toMatch(/^Onset of onsetnz: x = 4\.0\d+ ± 0\.0\d+ eV \(y = 0\.1\d*\)$/);
    expect(lines[2]).toMatch(
      /^ {2}edge: {6}slope = 2\.\d+ ± 0\.0\d+, intercept = -8\.\d+ ± 0\.\d+ \(31 points, x = 4\.5 to 6\)$/,
    );
    expect(lines[3]).toMatch(/^ {2}baseline: {2}slope = .* \(31 points, x = 2 to 3\.5\)$/);
    expect(lines.slice(4)).toEqual(["True True True", "3.0 {'level': 0.0} 2.8"]);
  });

  it("draws the lines of an onset on the graph of XY data", async () => {
    expect(
      await run(
        [
          // Binding energy running down, unevenly spaced, as XY data.
          "import _oresme_analysis as oa",
          "orng = np.random.default_rng(3); be = np.sort(orng.uniform(0, 6, 200))[::-1]",
          'op.make("onsetbe", be, unit="eV"); op.make("onsetxy", np.where(be < 2, 0.2, 0.2 + 3 * (be - 2)) + orng.normal(scale=0.01, size=200))',
          'og = op.display("onsetxy", x="onsetbe", name="Onset")',
          'r = op.onset("onsetxy", x="onsetbe", edge=(2.5, 4), baseline=(0.5, 1.8), graph=True, quiet=True)',
          "print(abs(r.x - 2) < 3 * r.x_sigma, r.edge['points'] + r.baseline['points'], [w.name for w in r.waves], [t.name for t in og.traces])",
          "print(og.annotations[0].text == f'onset {oa._with_error(r.x, r.x_sigma)} eV', og.trace('onsetxy_onset').mode, len(op.wave('onsetxy_edge')))",
          "e = op.wave('onsetxy_edge'); print(round(e.x[0], 2), round(e.x[-1], 2), e.x_unit, op.wave('onsetxy_onset').x0 == r.x)",
          // Again: the same waves and tag, updated rather than added.
          'r = op.onset("onsetxy", x="onsetbe", edge=(2.5, 3.5), baseline=0.2, graph=og, quiet=True)',
          "print(len(og.traces), len(og.annotations), og.annotations[0].text == f'onset {oa._with_error(r.x, r.x_sigma)} eV')",
          // Uncertainties are written to the digits they leave meaningful.
          "print(oa._with_error(4.51234, 0.00213), oa._with_error(1234.5, 25), oa._with_error(2.0, 1.7e-16), oa._with_error(3.0, 0.0))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "True 98 ['onsetxy_edge', 'onsetxy_base', 'onsetxy_onset'] ['onsetxy', 'onsetxy_edge', 'onsetxy_base', 'onsetxy_onset']",
      "True markers 50",
      "1.9 4.1 eV True",
      "4 1 True",
      "4.5123 ± 0.0021 1234 ± 25 2 ± 1.7e-16 3",
    ]);
    expect(await run('op.onset("onsetfall", edge=(1.5, 2.5), graph=True)')).toBe(false);
    expect(errors[0]).toContain("graph=True needs a graph that shows the wave");
    expect(await run('op.onset("onsetfall", edge=(1.5, 1.55))')).toBe(false);
    expect(errors[0]).toContain("The edge range has 2 points; a line with an uncertainty needs 3.");
  });

  it("interpolates, filters images and takes line profiles", async () => {
    expect(
      await run(
        [
          'ix = op.make("ix", [0.0, 1.0, 2.0, 4.0]); iy = op.make("iy", [0.0, 1.0, 4.0, 16.0])',
          "lin = op.interpolate(iy, ix, n=5)",
          'cub = op.interpolate(iy, ix, at=[0.5, 3.0, 9.0], kind="cubic", name="cub")',
          "print(lin.name, lin.data.tolist(), lin.x0, lin.dx)",
          "print(cub.name, [round(float(v), 2) for v in cub.data[:2]], bool(np.isnan(cub.data[2])))",
          // A cubic spline reproduces a cubic's interior closely and passes through the knots.
          "kx = np.linspace(0, 3, 13); ks = op.interpolate(op.make('ky', kx ** 3, dx=0.25), at=kx, kind='cubic', name='kn')",
          "print(bool(np.allclose(ks.data, kx ** 3)))",
          'im = op.make("im", np.zeros((9, 9)), x0=10, dx=2, y0=-4, dy=1); im[4, 4] = 81.0',
          'ga = op.filter_image(im, "gauss", 1); me = op.filter_image(im, "mean", 3, name="im_mean"); md = op.filter_image(im, "median", 3, name="im_med")',
          "print(ga.name, round(float(ga.data.sum()), 6), float(ga.data[4, 4]) < 81, ga.x0, ga.dy)",
          "print(float(me.data[4, 4]), float(me.data[3, 3]), float(me.data[0, 0]), float(md.data.max()))",
          'ramp = op.make("ramp", np.add.outer(np.arange(5.0), 10 * np.arange(4.0)), dx=2)',
          "pr = op.line_profile(ramp, (0, 0), (8, 3))",
          "print(pr.name, len(pr), pr.data[0], pr.data[-1], round(pr.dx * (len(pr) - 1), 4))",
          "print(op.line_profile(ramp, (0, 1), (8, 1), n=3, name='row').data.tolist())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "iy_interp [0.0, 1.0, 4.0, 10.0, 16.0] 0.0 1.0",
      "cub [0.35, 9.35] True",
      "True",
      "im_filt 81.0 True 10.0 1.0",
      "9.0 9.0 0.0 0.0",
      "ramp_prof 6 0.0 34.0 8.544",
      "[10.0, 12.0, 14.0]",
    ]);
  });

  it("keeps the number type of waves, and complex values", async () => {
    expect(
      await run(
        [
          'f4 = op.make("f4", np.arange(4, dtype=np.float32) / 3)',
          'u1 = op.make("u1", np.array([1, 2, 250], dtype=np.uint8))',
          'ints = op.make("ints", [1, 2, 3]); op.make("ar", np.arange(3)); op.make("i4", np.arange(3), dtype="int32")',
          'i2 = op.make("i2", [1.6, -2.4, 1e6], dtype="int16")',
          'cx = op.make("cx", np.array([1 + 2j, 3 - 4j]))',
          "print(f4.dtype, u1.dtype, ints.dtype, op.wave('ar').dtype, op.wave('i4').dtype, i2.dtype, cx.dtype, cx.is_complex, f4.is_complex)",
          "print(f4.data.dtype, bool(f4.data[1] == np.float32(1 / 3)), u1.data.tolist(), i2.data.tolist(), cx.data.tolist())",
          // Arithmetic follows NumPy, and assigning keeps the wave's type.
          "u1.data = u1.data + 10; f4[0] = 0.1; i2[0:2] = [7.5, 8.4]",
          "print(u1.data.tolist(), u1.dtype, float(f4.data[0]) == float(np.float32(0.1)), i2.data.tolist())",
          "cx[0] = 5j; cx.data = cx.data * 2",
          "print(cx.data.tolist(), abs(cx).tolist())",
          'f4.redimension("complex64"); u1.redimension(np.float64)',
          "print(f4.dtype, f4.data[1], u1.dtype, u1.data.tolist())",
          "ints.data = np.array([1j, 2])",
          "print(ints.dtype, ints.data.tolist())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "float32 uint8 float64 float64 int32 int16 complex128 True False",
      "float32 True [1, 2, 250] [2, -2, 32767] [(1+2j), (3-4j)]",
      // 250 + 10 does not fit in a byte: NumPy wraps it round to 4 before it is stored.
      "[11, 12, 4] uint8 True [8, 8, 32767]",
      "[10j, (6-8j)] [10.0, 10.0]",
      "complex64 (0.33333334+0j) float64 [11.0, 12.0, 4.0]",
      "complex128 [1j, (2+0j)]",
    ]);
    const { f4, i2, cx } = doc.getState().waves;
    expect(f4!.data).toBeInstanceOf(Float32Array);
    expect(i2!.data).toBeInstanceOf(Int16Array);
    expect([Array.from(cx!.data), Array.from(cx!.imag!)]).toEqual([
      [0, 6],
      [10, -8],
    ]);
    expect(await run('op.make("bad", [1], dtype="int64")')).toBe(false);
    expect(errors[0]).toContain("A wave cannot be int64");
  });

  it("keeps a spectrum complex and inverts it", async () => {
    expect(
      await run(
        [
          "ft = np.arange(101) * 0.01",
          'sg = op.make("sg", np.sin(2 * np.pi * 5 * ft) + 0.5, x0=0, dx=0.01, x_unit="s", unit="V")',
          'sp = op.fft(sg, output="complex")',
          "print(sp.name, sp.dtype, len(sp), sp.x_unit, round(sp.dx, 4), int(np.argmax(np.abs(sp.data[1:])) + 1))",
          "back = op.ifft(sp)",
          "print(back.name, len(back), back.x_unit, round(back.dx, 6), bool(np.allclose(back.data, sg.data)))",
          'mag = op.fft(sg, name="sg_mag")',
          "print(mag.dtype, round(float(mag.data[0]), 2))",
          'gz = op.display(sp, name="Spectrum"); gz.trace("sg_FFT").part = "magnitude"',
          "print(gz.trace('sg_FFT').part, 'sg_FFT' in gz.script(), 'part=\"magnitude\"' in gz.script())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "sg_FFT complex128 51 Hz 0.9901 5",
      "sg_FFT_IFFT 101 s 0.01 True",
      // The DC part is the mean, 0.5, and is not doubled.
      "float64 0.5",
      "magnitude True True",
    ]);
  });

  it("arranges graphs on a page layout", async () => {
    expect(
      await run(
        [
          'pa = op.make("pa", [1.0, 2.0, 4.0]); g1 = op.display(pa, name="PanelA"); g2 = op.display(pa, name="PanelB")',
          'page = op.new_layout("Fig", "A5", landscape=True)',
          "top = page.add_graph(g1, x=30, y=30, w=250, h=160)",
          'bottom = page.add_graph("PanelB")',
          'cap = page.add_text("Figure 1. Two panels", x=30, y=380, size=9)',
          "bottom.set(x=300, y=30, w=250, h=160); cap.text = 'Fig. 1'",
          "print(page, page.width, page.height, [i.name for i in page.items], op.layouts(), op.layout().name)",
          "print(top.graph, bottom.x, bottom.w, cap.text, cap.size, page.item('graph0').h)",
          "svg = page.svg(); print(svg.count('<polyline'), 'Fig. 1' in svg, 'width=\"595\" height=\"420\"' in svg)",
          'page.save("fig.pdf"); cap.remove(); page.set(width=842, height=595); print(len(page.items), page.width)',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "Layout('Fig') 595 420 ['graph0', 'graph1', 'text0'] [Layout('Fig')] Fig",
      "Graph('PanelA') 300 250 Fig. 1 9 160",
      "2 True True",
      "2 842",
    ]);
    expect(exported.at(-1)).toBe("Fig:fig.pdf");
    expect(await run('page.save("fig.gif")')).toBe(false);
    expect(
      await run("g1.kill(); print([i.name for i in page.items]); page.kill(); print(op.layouts())"),
    ).toBe(true);
    expect(stdout).toBe("['graph1']\n[]\n");
  });

  it("loads text files and workbooks as waves, as told", async () => {
    expect(
      await run(
        [
          'open("lt_run.csv", "w").write("Instrument X\\nlt_t (s),lt_U (V),lt_dU (V),lt_label\\n0,1.5,0.1,a\\n1,2.5,0.2,b\\n")',
          'ws = op.load_text("lt_run.csv", graph=True, x=0, errors={1: 2})',
          "print([w.name for w in ws], ws[1].unit, ws[1].data.tolist(), ws[1].note[:32])",
          // The preset passes over one line and reads decimal commas; the call adds to it.
          'ps = op.load_text(b"junk\\nlt_a;lt_b\\n1,5;2\\n2,5;x\\n", name="p.txt", preset="bench", table=False, columns={1: {"type": "number", "name": "lt_c"}})',
          "print([w.name for w in ps], ps[0].data.tolist(), ps[1].data.tolist())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "['lt_t', 'lt_U', 'lt_dU', 'lt_label'] V [1.5, 2.5] Loaded from lt_run.csv (SHA-256 ",
      "['lt_a', 'lt_c'] [1.5, 2.5] [2.0, nan]",
    ]);
    expect(stderr).toMatch(/p\.txt: cells that could not be read are NaN in lt_c \(1\)/);
    const state = doc.getState();
    const graph = Object.values(state.graphs).find((item) => item.traces[0]?.y === "lt_U")!;
    expect(graph.traces).toMatchObject([{ y: "lt_U", x: "lt_t", yError: "lt_dU" }]);
    expect(Object.values(state.tables).some((table) => table.columns.includes("lt_label"))).toBe(
      true,
    );
    expect(Object.values(state.tables).some((table) => table.columns.includes("lt_a"))).toBe(false);
    // One input is one step to undo, whatever it loaded.
    doc.undo();
    expect(doc.getState().waves.lt_a).toBeUndefined();
    expect(doc.getState().waves.lt_U).toBeUndefined();
    doc.redo();
    expect(doc.getState().waves.lt_U).toBeDefined();

    const workbook = Uint8Array.from(
      atob(excelWorkbook.slice(excelWorkbook.indexOf(",") + 1)),
      (c) => c.charCodeAt(0),
    );
    files.put("lt_book.xlsx", workbook);
    expect(
      await run(
        [
          'book = op.load_excel("lt_book.xlsx", table=False)',
          "first = list(book)[0]",
          'one = op.load_excel("lt_book.xlsx", sheets=first, table=False, columns={0: {"type": "skip"}})',
          "print(len(book) > 1, list(one) == [first], len(one[first]) == len(book[first]) - 1)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("True True True\n");
    for (const [code, error] of [
      ['op.load_text("lt_missing.csv")', /Could not read lt_missing\.csv/],
      [
        'op.load_text("lt_run.csv", preset="nope")',
        /No import preset named "nope". Presets: bench/,
      ],
      ['op.load_text("lt_run.csv", delimiter="pipe")', /delimiter must be one of/],
      ['op.load_text(b"1,2")', /Give name=/],
      ['op.load_excel("lt_run.csv")', /not an Excel workbook/],
      ['op.load_excel("lt_book.xlsx", sheets="Nope")', /no sheet named "Nope"/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  });

  it("loads Igor binary waves and packed experiments through the same reader", async () => {
    files.put("li_frames.ibw", igorFixture("v5-le-4d-uint16.ibw"));
    files.put("li_exp.pxp", igorFixture("experiment-be.pxp"));
    const order = doc.getState().waveOrder;
    expect(
      await run(
        [
          'fr = op.load_igor("li_frames.ibw")',
          "print([w.name for w in fr], fr[0].dtype, fr[0].shape, int(fr[0].data[2, 1, 0, 1]))",
          'ex = op.load_igor("li_exp.pxp")',
          'm = op.wave("raw_data:run_1:matrix")',
          "print(len(ex), ex[-3].name, m.data.tolist(), m.y0, m.dy, m.y_unit)",
          'print(op.wave("raw_data:run_1:t3_uint16").data.tolist(), op.wave("raw_data:run_1:c64").data.tolist())',
          'again = op.load_igor(open("li_frames.ibw", "rb").read(), name="copy.ibw")',
          "print(again[0].name, again[0].note.splitlines()[0][:30])",
        ].join("\n"),
      ),
    ).toBe(true);
    // The 3×2×2×2 wave counts 0, 1, 2, ... in Igor's order (rows fastest), so the
    // value at row 2, column 1, layer 0, chunk 1 is 2 + 3 + 12.
    expect(stdout.trim().split("\n")).toEqual([
      "['frames'] uint16 (3, 2, 2, 2) 17",
      "21 raw_data:run_1:matrix [[0.0, 2.0, 4.0], [1.0, 3.0, 5.0]] 10.0 5.0 mm",
      "[0, 0, 65535] [(1+2j), (-0-3.5j)]",
      "frames_1 Loaded from copy.ibw (SHA-256",
    ]);
    expect(stderr).toMatch(/li_exp\.pxp: not loaded, without saved values: root:dep/);
    // One input is one step to undo, whatever it loaded; the document is left as it was.
    doc.undo();
    expect(doc.getState().waveOrder).toEqual(order);
    for (const [code, error] of [
      ['op.load_igor("li_missing.ibw")', /Could not read li_missing\.ibw/],
      ['op.load_igor(b"x,y\\n1,2\\n", name="table.ibw")', /not an Igor binary wave/],
      ['op.load_igor(b"x,y\\n1,2\\n", name="table.pxp")', /not an Igor packed experiment/],
      ['op.load_igor(b"1")', /Give name=/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  });

  it("fits the points that are chosen: ranges in X, spans left out, a mask", async () => {
    expect(
      await run(
        [
          "sx = np.arange(20.0)",
          "sy = 1 + 2 * sx",
          "sy[5:8] += 50; sy[15] = -30",
          'sw = op.make("sel_w", sy)',
          // Left to itself the line is pulled by the bad points.
          'print(abs(op.fit("line", sw, quiet=True)["b"] - 2) > 0.1)',
          'r = op.fit("line", sw, exclude=[(5, 7), (15, 15)], quiet=True)',
          "print(np.round(r.coef, 9).tolist(), r.points, r.freedom)",
          'r = op.fit("line", sw, xrange=(8, 14), quiet=True); print(np.round(r.coef, 9).tolist(), r.points)',
          'sm = op.make("sel_mask", (sy == 1 + 2 * sx).astype(float))',
          'r = op.fit("line", sw, mask=sm, range=(0, 12), quiet=True); print(np.round(r.coef, 9).tolist(), r.points)',
          // The wave itself is untouched, and the curve runs across what was left out.
          'print(sw.data[6], np.isfinite(op.wave("fit_sel_w").data).all())',
          'r = op.fit("line", sw, mask=np.ones(20), exclude=(5, 7), residuals=True, quiet=True)',
          "print(round(float(r.residuals.data[6]), 6), round(float(r.residuals.data[2]), 6))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "True",
      "[1.0, 2.0] 16 14",
      "[1.0, 2.0] 7",
      "[1.0, 2.0] 10",
      "63.0 True",
      // The residual of a point left out shows how far off it is.
      expect.stringMatching(/^5\d\.\d+ -?\d\.\d+$/),
    ]);
    for (const [code, error] of [
      ['op.fit("line", sw, mask=[1, 0])', /mask needs one value per point/],
      ['op.fit("line", sw, exclude=(0, 100))', /No points are left to fit/],
      ['op.fit("line", sw, exclude=5)', /exclude takes \(low, high\)/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  });

  it("keeps each fit with its settings, to be compared, run again and applied to other waves", async () => {
    expect(
      await run(
        [
          "kx = np.linspace(0, 4, 41)",
          'ka = op.make("keep_a", 1 + 3 * np.exp(-kx / 0.5), x0=0, dx=0.1)',
          'kb = op.make("keep_b", 2 + 5 * np.exp(-kx / 0.8), x0=0, dx=0.1)',
          'kc = op.make("keep_c", 0.5 + 1 * np.exp(-kx / 1.5), x0=0, dx=0.1)',
          'r = op.fit("exp", ka, hold={"y0": 1}, xrange=(0, 3), quiet=True)',
          "kept = op.result(r.name)",
          "print(kept.kind, kept.label, kept.names, kept.held, np.round(kept.coef, 6).tolist())",
          "print(kept.settings['hold'], kept.settings['xrange'], kept.settings['y'], kept.reason, kept.changed)",
          "print(kept.covariance.shape, round(float(kept.correlation[1, 2]), 2), np.isnan(kept.correlation[0, 1]), list(kept.outputs))",
          // The data changes: the result says so, and running it again gives a new one beside it.
          "ka.data = 1 + 4 * np.exp(-kx / 0.5)",
          "again = kept.rerun(quiet=True)",
          "print(kept.changed, again.name != kept.name, round(kept['A'], 6), round(again['A'], 6), op.result(again.name).changed)",
          "same = kept.rerun(replace=True, quiet=True); print(same.name == kept.name, round(kept['A'], 6))",
          // The same settings on other waves, and all of them side by side.
          "others = kept.apply([kb, 'keep_c'])",
          "print([o.function for o in others], [round(o['tau'], 6) for o in others], [round(o['y0'], 6) for o in others])",
          't = op.table("Results"); print([c.name for c in t.columns][:6])',
          'print(op.wave("Results_data").data[-2:], np.round(op.wave("Results_tau").data[-2:], 6).tolist())',
          "print(str(kept).splitlines()[0])",
          "kept.rename('sampleA'); print(op.result('sampleA')['tau'] == same['tau'], 'sampleA' in [x.name for x in op.results()])",
          "again.result.remove(); print(again.name in [x.name for x in op.results()])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "fit exp(keep_a) ('y0', 'A', 'tau') ('y0',) [1.0, 3.0, 0.5]",
      "{'y0': 1} [0, 3] keep_a converged []",
      // A and tau of a decay lean on each other; the held y0 has no correlation to give.
      "(3, 3) -0.63 True ['fit']",
      "['keep_a'] True 3.0 4.0 []",
      "True 4.0",
      // y0 stays held at 1 for the others too, so their fits are of other curves.
      expect.stringMatching(
        /^\['exp\(keep_b\)', 'exp\(keep_c\)'\] \[\d\.\d+, \d\.\d+\] \[1\.0, 1\.0\]$/,
      ),
      "['Results_result', 'Results_data', 'Results_y0', 'Results_y0_sd', 'Results_A', 'Results_A_sd']",
      expect.stringMatching(/^\['keep_b' 'keep_c'\] \[\d\.\d+, \d\.\d+\]$/),
      expect.stringMatching(/^Fit\d+: exp\(keep_a\), 31 points, chi-square = /),
      "True True",
      "False",
    ]);
    // In the document: with fingerprints of the inputs, and undone with the fit that made it.
    const kept = doc.getState().results.sampleA!;
    expect(kept.inputs.map((input) => input.wave)).toEqual(["keep_a"]);
    expect(kept.created).toBeGreaterThan(Date.now() - 600_000);
    expect(await run('q = op.fit("line", "keep_b", quiet=True, record=False); print(q.name)')).toBe(
      true,
    );
    expect(stdout).toBe("None\n");
  });

  it("finds a function of the user's again, and says what cannot be repeated", async () => {
    expect(
      await run(
        [
          "def keep_fn(x, a, b): return a * np.sqrt(x) + b",
          "fx = np.linspace(1, 9, 30)",
          'fw = op.make("keep_fn_w", 2 * np.sqrt(fx) + 1, x0=1, dx=fx[1] - fx[0])',
          "r = op.fit(keep_fn, fw, guess=[1, 0], quiet=True)",
          "print(np.round(r.rerun(quiet=True).coef, 6).tolist(), r.result.settings['function'])",
          "s = op.fit('line', fw, sigma=np.full(30, 0.1), quiet=True)",
          "print(np.round(s.rerun(sigma=0.2, quiet=True).sigma / s.sigma, 6).tolist())",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe("[2.0, 1.0] keep_fn\n[2.0, 2.0]\n");
    expect(await run("s.rerun()")).toBe(false);
    expect(errors[0]).toMatch(/was given sigma as data, which was not kept\. Give sigma= again/);
    expect(await run("del keep_fn; r.rerun()")).toBe(false);
    expect(errors[0]).toMatch(/used your function 'keep_fn', which is not defined now/);
  });

  it("says what makes a fit doubtful: parameters that stand in for each other, and why it stopped", async () => {
    expect(
      await run(
        [
          "dx_ = np.linspace(1000, 1001, 40)",
          'dw = op.make("doubt_w", 3 + 0.5 * dx_ + np.random.default_rng(3).normal(0, 0.01, 40), x0=1000, dx=dx_[1] - dx_[0])',
          'r = op.fit("line", dw, quiet=True); print(str(r).splitlines()[-1]); print(r.reason)',
          'z = op.fit(lambda x, a: np.exp(-a * x), op.make("doubt_z", np.zeros(20), x0=1, dx=1), guess=[1.0], quiet=True)',
          "print(z.converged, z.reason, str(z).splitlines()[1])",
          // eta of a pseudo-Voigt stays within 0..1 without being told to.
          "px = np.linspace(-8, 8, 161)",
          'pw = op.make("doubt_pv", 1 / (1 + (px / 0.7) ** 4), x0=-8, dx=0.1)',
          'p = op.fit("pseudo_voigt", pw, quiet=True); print(0 <= p["eta"] <= 1)',
          // A limit given on one side leaves the function's own limit on the other.
          'p = op.fit("pseudo_voigt", pw, bounds={"eta": (None, 0.25)}, quiet=True); print(round(p["eta"], 6))',
          'pl = op.make("doubt_lor", 1 / (1 + (px / 0.7) ** 2), x0=-8, dx=0.1)',
          'p = op.fit("pseudo_voigt", pl, bounds={"eta": (None, 0.25)}, quiet=True); print(round(p["eta"], 6))',
          'p = op.fit("pseudo_voigt", pl, bounds={"eta": (0.5, None)}, quiet=True); print(round(p["eta"], 6))',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "strongly correlated: a and b (-1.000)",
      "converged",
      expect.stringMatching(
        /^False (stopped[^(]*?) {3}\(did not converge: \1; showing the best parameters found\)$/,
      ),
      "True",
      "0.0",
      "0.25",
      "1.0",
    ]);
  });

  it("fits several waves at once with parameters in common, and many waves one by one", async () => {
    expect(
      await run(
        [
          "gx = np.linspace(0, 5, 51)",
          "gn = np.random.default_rng(7)",
          'gs = [op.make(f"glob_{i}", y0 + A * np.exp(-gx / 0.9) + gn.normal(0, 0.01, 51), x0=0, dx=0.1) for i, (y0, A) in enumerate([(0, 1), (0.5, 3), (-1, 0.2)])]',
          'g = op.fit_global("exp", gs, shared=["tau"], quiet=True)',
          "print(g.names, g.shared, g.coef.shape, round(g['tau'], 2), np.round(g['A'], 1).tolist(), (np.round(g['y0'], 1) + 0.0).tolist())",
          // One time constant fitted to all three is known better than from any one of them.
          'alone = [op.fit("exp", w, quiet=True) for w in gs]',
          "print(g.sigma[0, 2] < min(r.sigma[2] for r in alone), np.all(g.sigma[:, 2] == g.sigma[0, 2]), g.converged)",
          "kept = g.result; print(kept.kind, kept.names[:3], len(kept.names), kept.settings['shared'], list(kept.outputs))",
          'h = op.fit_global("exp", gs, shared=["tau"], hold={"y0": 0}, quiet=True); print(h.held, h.coef[:, 0].tolist(), h.chisq > g.chisq)',
          "print(str(g).splitlines()[1].strip().split(' ±')[0][:9], len(str(g).splitlines()))",
          "print(round(kept.rerun(quiet=True)['tau'], 2))",
          'b = op.fit_batch("exp", gs); print(len(b), [round(r["tau"], 1) for r in b])',
          'print(op.wave("Results_data").data[-3:])',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "('y0', 'A', 'tau') ('tau',) (3, 3) 0.9 [1.0, 3.0, 0.2] [0.0, 0.5, -1.0]",
      "True True True",
      "global ('tau', 'y0[0]', 'A[0]') 7 ['tau'] ['fit0', 'fit1', 'fit2']",
      "('y0',) [0.0, 0.0, 0.0] True",
      "tau = 0.9 6",
      "0.9",
      expect.stringMatching(/^Fit\d+: exp\(glob_0\), chi-square = /),
      expect.stringMatching(/^Fit\d+: exp\(glob_1\), chi-square = /),
      expect.stringMatching(/^Fit\d+: exp\(glob_2\), chi-square = /),
      "3 [0.9, 0.9, 0.9]",
      "['glob_0' 'glob_1' 'glob_2']",
    ]);
    for (const [code, error] of [
      ['op.fit_global("exp", gs[:1])', /needs two waves or more/],
      ['op.fit_global("exp", gs, shared=["rate"])', /no parameter named 'rate'/],
      ['op.fit_global("exp", gs, xs=[gs[0]])', /one X wave for each wave/],
      ["kept.apply(gs)", /cannot be applied wave by wave/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  });

  it("ties peaks to each other: a spacing, a ratio of areas, the same width", async () => {
    expect(
      await run(
        [
          "tx = np.linspace(0, 20, 801)",
          "tg = lambda x0, h, w: h * np.exp(-((tx - x0) / w) ** 2)",
          // A doublet that overlaps: 1.5 apart, areas 2:1, the same width.
          'tw = op.make("tie_w", 0.2 + tg(9, 4, 0.9) + tg(10.5, 2, 0.9) + np.random.default_rng(5).normal(0, 0.02, 801), x0=0, dx=0.025)',
          "free = op.fit_peaks(tw, peaks=[9, 10.5], quiet=True)",
          "tied = op.fit_peaks(tw, peaks=[9, 10.5], same_width=True, spacing={(1, 2): 1.5}, area_ratio={(1, 2): 0.5}, quiet=True)",
          "a, b = tied.peaks",
          "print(round(b['x'] - a['x'], 9), round(b['area'] / a['area'], 9), round(b['width'] - a['width'], 9))",
          "print(round(a['x'], 2), round(a['height'], 1), round(a['width'] / (2 * np.sqrt(np.log(2))), 2), tied.converged)",
          // With fewer free parameters the position is known better, and the tied one as well as its source.
          "print(a['x_sigma'] < free.peaks[0]['x_sigma'], round(b['x_sigma'] / a['x_sigma'], 6), b['area_sigma'] > 0)",
          "kept = tied.result; print(kept.kind, kept.names, kept.freedom - free.result.freedom)",
          "print(kept.settings['spacing'], kept.settings['area_ratio'], kept.settings['same_width'], kept.settings['peaks'])",
          "again = kept.rerun(quiet=True); print(round(again.peaks[1]['x'] - again.peaks[0]['x'], 9))",
          // A chain of spacings, given as a list.
          'tw3 = op.make("tie_w3", tg(5, 1, 0.5) + tg(7, 1, 0.5) + tg(9, 1, 0.5), x0=0, dx=0.025)',
          "c = op.fit_peaks(tw3, peaks=[5.1, 6.8, 9.2], baseline=None, spacing=[(1, 2, 2), (2, 3, 2)], quiet=True)",
          "print([round(p['x'], 6) for p in c.peaks])",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "1.5 0.5 0.0",
      "9.0 4.0 0.9 True",
      "True 1.0 True",
      "peaks ('x1', 'height1', 'fwhm1', 'area1', 'x2', 'height2', 'fwhm2', 'area2', 'offset') 3",
      "[[1, 2, 1.5]] [[1, 2, 0.5]] True [9, 10.5]",
      "1.5",
      "[5.0, 7.0, 9.0]",
    ]);
    for (const [code, error] of [
      [
        "op.fit_peaks(tw, peaks=[9, 10.5], spacing={(1, 3): 1})",
        /there is no peak 3; the peaks are 1 to 2/,
      ],
      [
        "op.fit_peaks(tw, peaks=[9, 10.5], spacing={(1, 2): 1, (2, 1): -1})",
        /go round in a circle/,
      ],
      ["op.fit_peaks(tw, peaks=[9, 10.5], spacing=[(1, 2, 1), (1, 2, 2)])", /tied twice over/],
      ["op.fit_peaks(tw, peaks=[9, 10.5], area_ratio=[1, 2])", /area_ratio takes/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  });

  it("differentiates a matrix along X, keeping its other scaling", async () => {
    expect(
      await run(
        [
          'dm = op.make("dif_m", np.outer(np.arange(4.0) ** 2, [1, 2, 3]), x0=0, dx=0.5, y0=10, dy=2, y_unit="K")',
          "dd = op.differentiate(dm)",
          "print(dd.shape, dd.data[:, 1].tolist(), dd.dx, dd.y0, dd.dy, dd.y_unit)",
        ].join("\n"),
      ),
    ).toBe(true);
    // d/dx of 2 i^2 with x = i / 2: one-sided at the ends, central inside.
    expect(stdout).toBe("(4, 3) [4.0, 8.0, 16.0, 20.0] 0.5 10.0 2.0 K\n");
  });

  it("fits a peak that fills the range it is given, as between two cursors at its feet", async () => {
    expect(
      await run(
        [
          // The demo: a decaying sine. Each half wave is a hump or a trough of its own.
          "hx = np.linspace(0, 10, 2000)",
          'hw = op.make("hump_w", np.sin(2 * np.pi * hx) * np.exp(-hx / 3), dx=hx[1] - hx[0])',
          "for a, b in [(0, 0.5), (0.5, 1.0), (2.0, 2.5), (0.05, 0.45)]:",
          '    r = op.fit("gauss", hw, xrange=(a, b), quiet=True)',
          "    print(round(r['x0'], 2), r['A'] > 0, bool(np.sqrt(r.chisq / r.points) < 0.02), r.converged)",
          // By point numbers, as the cursors give them, and with a Lorentzian.
          'r = op.fit("lor", hw, range=(0, 100), quiet=True); print(round(r["x0"], 2), bool(np.sqrt(r.chisq / r.points) < 0.02))',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "0.25 True True True",
      "0.75 False True True",
      "2.25 True True True",
      "0.24 True True True",
      "0.25 True",
    ]);
  });

  it("installs SciPy, pandas, scikit-learn and lmfit when they are first imported", async () => {
    expect(
      await run(
        [
          "import sys",
          "print(any(name in sys.modules for name in ('scipy', 'pandas', 'sklearn', 'lmfit')))",
          "from scipy.optimize import curve_fit",
          "from scipy import integrate as sp_integrate",
          "pkx = np.linspace(0, 4, 50)",
          'pkw = op.make("pkg_w", 2.5 * np.exp(-pkx / 0.7) + 0.3, x0=0, dx=pkx[1])',
          // A wave goes where an array goes.
          "popt, _ = curve_fit(lambda x, a, t, c: a * np.exp(-x / t) + c, pkw.x, pkw, p0=[1, 1, 0])",
          "print(np.round(popt, 6).tolist(), round(float(sp_integrate.trapezoid(pkw, pkw.x)), 3))",
          "from sklearn.linear_model import LinearRegression",
          "lr = LinearRegression().fit(pkw.x.reshape(-1, 1), 3 * pkw.x + 1)",
          "print(round(float(lr.coef_[0]), 6), round(float(lr.intercept_), 6))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual(["False", "[2.5, 0.7, 0.3] 2.946", "3.0 1.0"]);
    expect(stderr).toBe("");
  }, 120_000);

  it("moves waves to pandas and back, with dates and text", async () => {
    expect(
      await run(
        [
          "import pandas as pd",
          'op.make("pd_t", np.array(["2026-11-11T09:00", "2026-11-11T09:30", "NaT"], dtype="datetime64[s]"))',
          'op.make("pd_v", [1.5, 2.5, 3.5]); op.make("pd_s", ["a", "b", "c"]); op.make("pd_short", [7.0])',
          'df = op.to_dataframe("pd_t", "pd_v", "pd_s", "pd_short")',
          "print(list(df.columns), [str(t) for t in df.dtypes], df.shape)",
          "print(str(df.pd_t[1]), pd.isna(df.pd_t[2]), df.pd_s.tolist(), df.pd_short.isna().tolist())",
          // And back: an index that means something, dates with a zone, missing values, a column to rename.
          'frame = pd.DataFrame({"T (K)": [300.0, 310.0], "label": ["x", None], "n": pd.array([1, None], dtype="Int64"), "ok": [True, False], "pd_v": [9.0, 8.0]},',
          '    index=pd.DatetimeIndex(["2026-01-01T09:00+09:00", "2026-01-02T09:00+09:00"], name="when"))',
          'made = op.from_dataframe(frame, "pdx_", table=False)',
          "print([w.name for w in made], made[0].unit, made[0].data[0] == 1767225600.0)",
          "print(made[1].data.tolist(), made[2].data.tolist(), made[3].data.tolist(), made[4].dtype, made[4].data.tolist())",
          'print([w.name for w in op.from_dataframe(frame[["pd_v"]], index=False, table=False)])',
          't = op.edit("pd_v", "pd_s"); print(t.to_dataframe().to_dict("list"))',
          'print(op.from_dataframe(pd.Series([1.0, 2.0], name="solo"), "pdx_", table=False)[0].name)',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "['pd_t', 'pd_v', 'pd_s', 'pd_short'] ['datetime64[s]', 'float64', 'str', 'float64'] (3, 4)",
      "2026-11-11 09:30:00 True ['a', 'b', 'c'] [False, True, True]",
      "['pdx_when', 'pdx_T_K', 'pdx_label', 'pdx_n', 'pdx_ok', 'pdx_pd_v'] dat True",
      "[300.0, 310.0] ['x', ''] [1.0, nan] uint8 [1, 0]",
      "['pd_v_1']",
      "{'pd_v': [1.5, 2.5, 3.5], 'pd_s': ['a', 'b', 'c']}",
      "pdx_solo",
    ]);
  }, 120_000);

  it("fits an lmfit model through op.fit, kept and drawn like any other fit", async () => {
    expect(
      await run(
        [
          "from lmfit.models import GaussianModel, LinearModel",
          "lx = np.linspace(-5, 5, 201)",
          'lw = op.make("lm_w", 0.5 + 0.1 * lx + 3 * np.exp(-((lx - 1.2) ** 2) / (2 * 0.8**2)) + np.random.default_rng(4).normal(0, 0.02, 201), x0=-5, dx=0.05)',
          "lg = op.display(lw)",
          "model = GaussianModel() + LinearModel()",
          "p = model.make_params(amplitude=5, center=1, sigma=1, slope=0, intercept=0)",
          "r = op.fit(model, lw, params=p, residuals=True, band=0.95, quiet=True)",
          "print(r.names[:3], round(r['center'], 2), round(r['sigma'], 2), round(r['slope'], 2), r.converged, r.reason)",
          // fwhm and height follow the others by expressions: lmfit holds them, op.fit reports them so.
          "print('fwhm' in r.held, round(r['fwhm'] / r['sigma'], 4), r.lmfit.nfev > 0, r.covariance.shape, bool(r.sigma[r.names.index('center')] > 0))",
          "print([t.name for t in lg.traces], r.band[0].name, r.residuals.name)",
          "kept = r.result; print(kept.label, kept.settings['custom'], kept.held[:1], kept.reason)",
          // Held and bounded through op.fit's own options, on chosen points.
          "h = op.fit(model, lw, params=p, hold={'slope': 0.1}, bounds={'sigma': (None, 0.5)}, xrange=(-2, 4), quiet=True)",
          "print('slope' in h.held, h['slope'], round(h['sigma'], 6), h.points)",
          // A single model guesses for itself.
          'g = op.fit(GaussianModel(), op.make("lm_g", np.exp(-((lx - 0.5) ** 2) / 2), x0=-5, dx=0.05), quiet=True); print(round(g["center"], 3), round(g["sigma"], 3))',
          "print(round(kept.rerun(function=model, params=p, quiet=True)['center'], 2))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "('amplitude', 'center', 'sigma') 1.2 0.8 0.1 True Fit succeeded.",
      "True 2.3548 True (7, 7) True",
      "['lm_w', 'fit_lm_w_hi', 'fit_lm_w_lo', 'fit_lm_w', 'res_lm_w'] fit_lm_w_lo res_lm_w",
      "lmfit (Model(gaussian) + Model(linear))(lm_w) True ('fwhm',) Fit succeeded.",
      "True 0.1 0.5 121",
      "0.5 1.0",
      "1.2",
    ]);
    for (const [code, error] of [
      ["op.fit(model, lw, guess=[1, 2])", /give starting values as params=/],
      ["op.fit(model, lw, hold={'nope': 1})", /hold: no parameter named 'nope'/],
      ['op.fit("gauss", lw, params=p)', /params= goes with an lmfit model/],
      ["kept.rerun()", /which is not defined now/],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
  }, 120_000);

  it("lines up, spaces and sizes items, and puts graphs in a grid", async () => {
    expect(
      await run(
        [
          'lw = op.make("lineup_w", [1.0, 3.0, 2.0])',
          'lg = [op.display(lw, name=f"Lineup{i}") for i in range(5)]',
          'lp = op.new_layout("Lineup", size=(600, 800))',
          "li = [lp.add_graph(g, x=40 + 50 * i, y=40 + 150 * i, w=100 + 10 * i, h=60 + 20 * i) for i, g in enumerate(lg[:4])]",
          'lt = lp.add_text("Caption", x=300, y=700, size=10)',
          'lp.align([li[0], "graph2", lt], "right"); print([i.x for i in lp.items])',
          'lp.align(li[1], "center"); print(li[1].x)',
          'lp.distribute(li[:3], "vertical"); print([i.y for i in li])',
          'lp.match_size(["graph3", "graph0", lt]); print([(i.w, i.h) for i in li], lt.size)',
          "lp.arrange(2, 2, margin=50, gap=(20, 10)); print([(i.x, i.y, i.w, i.h) for i in li], lt.x)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      // "Caption" is 38.5 points wide, so its right edge, at 338.5, is the outermost.
      "[238.5, 90, 218.5, 190, 300]",
      // One item alone lines up with the page: (600 - 110) / 2.
      "245",
      // From 40 to 440 with 240 points of graphs: gaps of 80.
      "[40, 180, 340, 490]",
      // The size of graph3, the first named; text keeps its own.
      "[(130, 120), (110, 80), (120, 100), (130, 120)] 10",
      // Cells (500 - 20) / 2 wide and (700 - 10) / 2 high, filled in reading order.
      "[(50, 50, 240, 345), (310, 50, 240, 345), (50, 405, 240, 345), (310, 405, 240, 345)] 300",
    ]);
    // A graph beyond the cells stays where it is, and Python is told.
    expect(await run('lp.add_graph("Lineup4", x=10, y=10); lp.arrange(1, 2)')).toBe(true);
    // The new graph reads first, at the top left; the next row is graph2 and graph3.
    expect(stderr).toMatch(/graph1, graph2, graph3 did not fit in the 1 × 2 grid/);
    expect(
      await run('lp.arrange(1, 2, items=["graph3", lt, "graph1"], gap=0); print(li[3].x, li[1].x)'),
    ).toBe(true);
    expect(stdout).toBe("36 300\n");
    // All of one input is one step to undo.
    const before = doc.getState().pages.Lineup!.items;
    expect(
      await run('lp.align(["graph0", "graph2"], "top"); lp.distribute(li, "horizontal")'),
    ).toBe(true);
    doc.undo();
    expect(doc.getState().pages.Lineup!.items).toEqual(before);
    expect(await run('lp.align(["graph0", "nope"], "left")')).toBe(false);
    expect(errors[0]).toMatch(/OresmeError: Lineup has no item named "nope"/);
    expect(await run('lp.distribute(li[:2], "vertical")')).toBe(false);
    expect(errors[0]).toMatch(/three or more/);
  });

  it("takes names that JavaScript objects inherit, such as constructor and toString", async () => {
    expect(
      await run(
        [
          'cw = op.make("constructor", [1.0, 2.0, 3.0], unit="V"); op.make("toString", [0.0, 1.0, 2.0])',
          'cg = op.display(cw, x="toString", name="valueOf"); cg.add_axis("hasOwnProperty", "right")',
          'cg.append(op.wave("toString").duplicate("toLocaleString"), axis="hasOwnProperty")',
          'ct = op.edit("constructor", name="isPrototypeOf"); cp = op.new_layout("propertyIsEnumerable")',
          "cp.add_graph(cg); cw[3] = 4",
          'print(op.wave("constructor").data.tolist(), op.wave("constructor").unit, op.exists("toString"))',
          "print([w.name for w in op.waves()][-3:], [a.name for a in cg.axes][-1], cg.axis('hasOwnProperty').side)",
          'print(op.graph("valueOf"), op.table("isPrototypeOf").columns, op.layout("propertyIsEnumerable").items[0].graph)',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "[1.0, 2.0, 3.0, 4.0] V True",
      "['constructor', 'toString', 'toLocaleString'] hasOwnProperty right",
      "Graph('valueOf') [Wave('constructor', n=4, x0=0, dx=1, unit='V')] Graph('valueOf')",
    ]);
    expect(doc.getState().waveOrder).toContain("constructor");
    expect(doc.getState().graphs["valueOf" as string]!.traces.map((trace) => trace.y)).toEqual([
      "constructor",
      "toLocaleString",
    ]);
    for (const [code, error] of [
      ['op.wave("__proto__")', 'OresmeError: No wave named "__proto__".'],
      ['op.wave("valueOf")', 'OresmeError: No wave named "valueOf".'],
      ['op.make("__proto__", [1.0])', /OresmeError: "__proto__" is not a valid wave name/],
      ['cw.rename("__proto__")', /OresmeError: "__proto__" is not a valid wave name/],
      ['op.graph("constructor")', "OresmeError: No graph named 'constructor'."],
      ['cg.axis("constructor")', /OresmeError: valueOf has no axis named 'constructor'/],
      ['cg.axis("__proto__").label = "x"', /OresmeError: valueOf has no axis named '__proto__'/],
      ['op.kill_window("__proto__")', 'OresmeError: No window named "__proto__".'],
    ] as const) {
      expect(await run(code), code).toBe(false);
      expect(errors[0]).toMatch(error);
    }
    expect(await run('op.kill_window("valueOf"); op.kill(op.wave("toLocaleString"))')).toBe(true);
    expect(doc.getState().waveOrder).not.toContain("toLocaleString");
    doc.undo();
    expect(doc.getState().waveOrder).toContain("toLocaleString");
    expect(doc.getState().graphs["valueOf" as string]).toBeDefined();
  });

  it("replays table edits of complex waves from the history, appending points as well", async () => {
    expect(
      await run(
        [
          'op.make("ztab", np.array([1 + 2j, 3 - 4j]))',
          'op.make("ztab32", np.array([5 + 6j], dtype=np.complex64))',
          'op.make("ztab2", np.array([[1 + 1j, 2 + 2j], [3 + 3j, np.nan + 4j]]))',
        ].join("\n"),
      ),
    ).toBe(true);
    /**
     * Makes the edits as the table does, in a copy of the document, and runs
     * the Python the table writes to the history against the document as it
     * was. Both must end up the same.
     */
    async function replay(edits: CellEdit[]) {
      const before = doc.getState();
      const commands = tableEditCommands(before.waves, edits, { layer: 0, chunk: 0 })!;
      expect(commands.length).toBeGreaterThan(0);
      const gui = new Doc();
      gui.load(before);
      const lines = commands.map((command) => {
        gui.dispatch(command);
        return echoPython(command, (wave) => gui.getState().waves[wave]?.shape)!;
      });
      const code = lines.join("\n");
      expect(await run(code), `${code}\n${errors.join("\n")}`).toBe(true);
      for (const name of new Set(edits.map((edit) => edit.wave))) {
        const replayed = doc.getState().waves[name]!;
        const expected = gui.getState().waves[name]!;
        const content = (wave: typeof replayed) => ({
          type: wave.type,
          shape: wave.shape,
          data: Array.from(wave.data),
          imag: Array.from(wave.imag ?? []),
        });
        expect(content(replayed), code).toEqual(content(expected));
      }
      return code;
    }
    // Typing the real part, then the imaginary part, into the row after the last point.
    expect(await replay([{ wave: "ztab", j: null, row: 2, text: "7" }])).toBe(
      'op.wave("ztab")[2] = complex(7, 0)',
    );
    expect(await replay([{ wave: "ztab", j: null, row: 3, text: "8", imag: true }])).toBe(
      'op.wave("ztab")[3] = complex(float("nan"), 8)',
    );
    // A paste of two rows that extends several complex columns, one of them complex64.
    await replay([
      { wave: "ztab", j: null, row: 3, text: "9" },
      { wave: "ztab", j: null, row: 4, text: "10" },
      { wave: "ztab", j: null, row: 3, text: "-1", imag: true },
      { wave: "ztab", j: null, row: 4, text: "nan", imag: true },
      { wave: "ztab32", j: null, row: 1, text: "0.5" },
      { wave: "ztab32", j: null, row: 2, text: "1.5" },
      { wave: "ztab32", j: null, row: 1, text: "2.5", imag: true },
    ]);
    // A paste that starts inside a wave and runs past its end.
    await replay([
      { wave: "ztab32", j: null, row: 2, text: "3", imag: true },
      { wave: "ztab32", j: null, row: 3, text: "4", imag: true },
    ]);
    expect(doc.getState().waves.ztab32!.shape).toEqual([4]);
    // A matrix keeps its shape: cells inside it are written, cells below it are not.
    await replay([
      { wave: "ztab2", j: 1, row: 1, text: "6" },
      { wave: "ztab2", j: 0, row: 0, text: "nan", imag: true },
      { wave: "ztab2", j: 0, row: 2, text: "1" },
    ]);
    expect(doc.getState().waves.ztab2!.shape).toEqual([2, 2]);
  });

  it("fits the free parameters while a bounded one rests on its bound", async () => {
    expect(
      await run(
        [
          'bw = op.make("bounded", 3 + 2 * np.arange(10))',
          'r = op.fit("line", bw, bounds={"b": (None, 1)}, quiet=True)',
          // With b = 1 the best a is the mean of y - x: 7.5, leaving sum((x - 4.5)^2) = 82.5.
          "print(np.round(r.coef, 6).tolist(), round(r.chisq, 6), r.converged)",
          'r = op.fit("line", bw, bounds={"b": (None, 5)}, quiet=True)',
          "print(np.round(r.coef, 6).tolist(), round(r.chisq, 6), r.converged)",
          "bx = np.linspace(-5, 5, 201)",
          'bg = op.make("bgauss", 0.5 + 3 * np.exp(-((bx - 1.2) / 0.8) ** 2), x0=bx[0], dx=bx[1] - bx[0])',
          'r = op.fit("gauss", bg, bounds={"width": (None, 0.5)}, quiet=True)',
          "print(np.round(r.coef, 5).tolist(), round(r.chisq, 5), r.converged)",
          'r = op.fit("gauss", bg, hold={"y0": 0.5}, bounds={"width": (0.1, 0.5)}, quiet=True)',
          "print(np.round(r.coef, 5).tolist(), round(r.chisq, 5), r.converged, r.sigma[0])",
        ].join("\n"),
      ),
    ).toBe(true);
    // The Gaussian references come from fixing the width at 0.5 and searching
    // x0 by golden section, with y0 and A by linear least squares at each x0.
    expect(stdout.trim().split("\n")).toEqual([
      "[7.5, 1.0] 82.5 True",
      "[3.0, 2.0] 0.0 True",
      "[0.62112, 3.42646, 1.2, 0.5] 15.6695 True",
      "[0.5, 3.59775, 1.2, 0.5] 18.25051 True 0.0",
    ]);
  });

  it("lets a fitted peak rest on the edge of the data", async () => {
    expect(
      await run(
        [
          "ex = np.linspace(0, 20, 401)",
          // A peak centred just beyond the data, so its position stops at x = 20.
          'ep = op.make("edgepk", 0.3 + 2 * np.exp(-((ex - 21) / 1.5) ** 2), x0=0, dx=ex[1] - ex[0])',
          "res = op.fit_peaks(ep, peaks=[19.5], components=False, quiet=True)",
          "p = res[0]",
          "print(p['x'], round(p['height'], 5), round(p['width'], 4), round(res.baseline['offset'], 5), round(res.chisq, 5), res.converged)",
        ].join("\n"),
      ),
    ).toBe(true);
    // Reference: position fixed at 20, width by golden section, the rest linear.
    expect(stdout).toBe("20.0 1.103 1.4987 0.30221 0.13836 True\n");
  });

  it("converges from a guess a width away, and on a background of a million", async () => {
    expect(
      await run(
        [
          "rx = np.linspace(0, 10, 200)",
          "rnoise = np.random.default_rng(1).normal(0, 0.1, rx.size)",
          'rw = op.make("rpeak", 1 + 5 * np.exp(-((rx - 4) / 0.8) ** 2) + rnoise, x0=0, dx=rx[1])',
          // A full Gauss-Newton step from here flattens the peak and throws it out of the data.
          'r = op.fit("gauss", rw, guess=[0, 3, 5, 0.4], quiet=True)',
          "print(np.round(r.coef, 2).tolist(), r.chisq < 3, r.converged)",
          // Rounding at 1e6 hides the last gains; the fit is at its minimum and must say so.
          'rb = op.make("rpeak_bg", rw.data + 1e6, x0=0, dx=rx[1])',
          'r = op.fit("gauss", rb, guess=[1e6, 3, 4.5, 1], quiet=True)',
          "print(np.round(r.coef - [1e6, 0, 0, 0], 2).tolist(), r.chisq < 3, r.converged)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "[0.99, 5.0, 4.0, 0.8] True True",
      "[0.99, 5.0, 4.0, 0.8] True True",
    ]);
  });

  it("fits on a large offset and says when a fit cannot converge", async () => {
    expect(
      await run(
        [
          'ow = op.make("offset", 1e8 + 3 * np.arange(10))',
          'r = op.fit("line", ow, quiet=True)',
          "print(np.round(r.coef, 9).tolist(), r.chisq, r.converged)",
          // The same model as a custom function goes through the iterative solver.
          "r = op.fit(lambda x, a, b: a + b * x, ow, guess=[1e8, 0], quiet=True)",
          "print(round(r['a'] - 1e8, 6), round(r['b'], 6), r.chisq < 1e-10, r.converged)",
          'r = op.fit("poly3", op.make("offpoly", 1e8 + 2 * np.arange(10) + 0.5 * np.arange(10) ** 2), hold={"K0": 1e8}, quiet=True)',
          "print(np.round(r.coef, 9).tolist(), r.converged)",
          // y = exp(-a*x) approaches 0 only as a goes to infinity: there is no minimum.
          "r = op.fit(lambda x, a: np.exp(-a * x), op.make('nofit', np.zeros(10)), x=op.make('nofit_x', np.arange(1.0, 11)), guess=[0.5], quiet=True)",
          "print(r.converged, 'did not converge' in str(r))",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "[100000000.0, 3.0] 0.0 True",
      "0.0 3.0 True True",
      "[100000000.0, 2.0, 0.5] True",
      "False True",
    ]);
  });

  it("weights a linear fit by the uncertainties of the points", async () => {
    expect(
      await run(
        [
          'op.make("wline", [0.0, 1.0, 3.0]); op.make("wline_err", [1.0, 1.0, 0.5])',
          'r = op.fit("line", "wline", sigma="wline_err", quiet=True)',
          "print(np.round(r.coef * 21, 9).tolist(), round(r.chisq * 21, 9), np.round(r.sigma ** 2 * 21, 9).tolist(), r.converged)",
        ].join("\n"),
      ),
    ).toBe(true);
    // Weights 1, 1, 4: the weighted normal equations give a = -4/21, b = 33/21,
    // chi-square 4/21, and variances 17/21 and 6/21.
    expect(stdout).toBe("[-4.0, 33.0] 4.0 [17.0, 6.0] True\n");
  });

  it("gives the amplitude of DC and Nyquist components without doubling them", async () => {
    expect(
      await run(
        [
          'print(op.fft(op.make("ones8", np.ones(8))).data.tolist())',
          'print(np.round(op.fft(op.make("alt8", (-1.0) ** np.arange(8))).data, 12).tolist())',
          // 0.25 + 2 cos at bin 1 + 0.5 cos at the Nyquist frequency, and an odd length with no Nyquist bin.
          'print(np.round(op.fft(op.make("mix8", 0.25 + 2 * np.cos(2 * np.pi * np.arange(8) / 8) + 0.5 * (-1.0) ** np.arange(8))).data, 12).tolist())',
          'print(np.round(op.fft(op.make("odd7", 1 + 3 * np.cos(2 * np.pi * 3 * np.arange(7) / 7))).data, 12).tolist())',
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout.trim().split("\n")).toEqual([
      "[1.0, 0.0, 0.0, 0.0, 0.0]",
      "[0.0, 0.0, 0.0, 0.0, 1.0]",
      "[0.25, 2.0, 0.0, 0.0, 0.5]",
      "[1.0, 0.0, 0.0, 3.0]",
    ]);
  });

  it("widens the confidence band by Student's t for few degrees of freedom", async () => {
    expect(
      await run(
        [
          "import _oresme_analysis as oa",
          "print([round(oa._student_quantile(0.975, n), 4) for n in (1, 2, 3, 5, 10, 30)])",
          "print([round(oa._student_quantile(0.995, n), 4) for n in (1, 2)], round(oa._student_quantile(0.95, 1), 4))",
          // Three points leave one degree of freedom. The line is -1/6 + 1.5x with
          // chi-square 1/6, so the standard error of the curve at x = 1 is sqrt(1/18).
          'op.make("tband", [0.0, 1.0, 3.0]); op.make("tband_x", [0.0, 1.0, 2.0])',
          'r = op.fit("line", "tband", x="tband_x", band=0.95, quiet=True)',
          "lo, hi = r.band",
          "print(round((hi.data[1] - lo.data[1]) / 2 / np.sqrt(1 / 18), 4))",
        ].join("\n"),
      ),
    ).toBe(true);
    // Table values of the t distribution.
    expect(stdout.trim().split("\n")).toEqual([
      "[12.7062, 4.3027, 3.1824, 2.5706, 2.2281, 2.0423]",
      "[63.6567, 9.9248] 6.3138",
      "12.7062",
    ]);
  });

  it("leaves infinities out of the statistics and of the positions of the extremes", async () => {
    expect(
      await run(
        [
          's = op.stats(op.make("infs", [1, np.inf, 4, -np.inf, np.nan, 2], x0=10, dx=0.5), quiet=True)',
          "print(s['min'], s['min_x'], s['max'], s['max_x'], s['points'], s['nans'], s['mean'], s['sum'])",
        ].join("\n"),
      ),
    ).toBe(true);
    // The finite values are 1, 4 and 2, at x = 10, 11 and 12.5.
    expect(stdout).toBe("1.0 10.0 4.0 11.0 6 3 2.3333333333333335 7.0\n");
  });

  it("keeps graph styles, gives them to graphs, and gives new graphs the default one", async () => {
    expect(
      await run(
        [
          'sa = op.make("st_a", [1.0, 2.0, 3.0]); sb = op.make("st_b", [2.0, 1.0, 0.0])',
          'src = op.display(sa, sb, name="StyleSource")',
          'src.set(font_size=15); src.trace("st_a").set(line_size=3, color="red")',
          'src.left.set(ticks="inside", mirror="on")',
          'paper = src.save_style("stPaper")',
          "data = paper.data",
          'print(paper, data["graph"]["font_size"], data["traces"][0]["line_size"], data["axes"]["left"])',
          'other = op.display(sb, sa, sb, name="StyleTarget", style=None)',
          'other.apply_style("stPaper")',
          "print(other.font_size, other.style, [t.line_size for t in other.traces], other.left.mirror)",
          'op.set_style("stTalk", {"graph": {"font_size": 22}, "traces": [{"line_size": 4}]})',
          'op.apply_style("stTalk", graphs=[other, "StyleSource"])',
          'print(other.font_size, src.font_size, src.trace("st_a").color, src.trace("st_a").line_size)',
          'op.set_default_style("stTalk")',
          'made = op.display(sa, name="StyleNew")',
          "print(made.font_size, made.style, op.default_style())",
          'op.style("stTalk").rename("stPoster")',
          'print(op.default_style(), made.style, [s.name for s in op.styles() if s.name.startswith("st")])',
          "try:",
          '    op.set_style("stBad", {"traces": [{"y_error": 1}]})',
          "except op.OresmeError as error:",
          '    print(str(error).split(".")[0])',
          'op.style("stPoster").remove()',
          "print(op.default_style(), made.style, made.font_size)",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(stdout).toBe(
      [
        "Style('stPaper') 15 3 {'mirror': 'on', 'ticks': 'inside', 'minor': False, 'grid': 'off'}",
        "15 Style('stPaper') [3, 1, 3] on",
        "22 22 #ff0000 4",
        "22 Style('stTalk') Style('stTalk')",
        "Style('stPoster') Style('stPoster') ['stPaper', 'stPoster']",
        'Unknown trace style property "yError"',
        "None None 22",
        "",
      ].join("\n"),
    );
    expect(doc.getState().graphs.StyleTarget!.traces.map((trace) => trace.color)).toEqual([
      "#ff0000",
      "#0000ff",
      "#ff0000",
    ]);

    // What the GUI writes into the history does the same when it is run.
    const { styles } = doc.getState();
    const line = echoPython({ op: "setStyle", name: "stEcho", style: styles.stPaper });
    expect(await run(`${line}\nop.set_style("stCopy", op.style("stPaper"))`)).toBe(true);
    expect(doc.getState().styles.stEcho).toEqual(styles.stPaper);
    expect(doc.getState().styles.stCopy).toEqual(styles.stPaper);
    expect(
      await run(echoPython({ op: "saveStyle", name: "stSized", graph: "StyleNew", size: true })!),
    ).toBe(true);
    expect(doc.getState().styles.stSized!.size).toEqual({ width: 440, height: 276 });
  });
});

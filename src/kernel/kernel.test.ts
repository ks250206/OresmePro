import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { layoutGraph } from "../core/plot/layout";
import { toSvg } from "../core/plot/svg";
import { bootPython, type PythonKernel } from "./boot";
import { answerRpc } from "./rpc";

/**
 * Runs the real Python package inside Pyodide against a real document. Only
 * the thread boundary is missing: here Python calls the document directly.
 */
const doc = new Doc();
let kernel: PythonKernel;
let stdout = "";
let errors: string[] = [];
let displays: Record<string, string>[] = [];
let runCount = 0;
const exported: string[] = [];

async function run(code: string): Promise<boolean> {
  stdout = "";
  errors = [];
  displays = [];
  runCount += 1;
  return kernel.execute(code);
}

beforeAll(async () => {
  const pyodide = await loadPyodide({ packageCacheDir: "node_modules/.cache/pyodide" });
  kernel = await bootPython(pyodide, {
    rpc: (method, paramsJson, data) =>
      answerRpc(
        {
          doc,
          renderSvg: (name, width, height) => {
            const state = doc.getState();
            const layout = layoutGraph(
              state.graphs[name]!,
              state.waves,
              width ?? 400,
              height ?? 300,
              (text, size) => text.length * size * 0.55,
            );
            return toSvg(layout.prims, layout.width, layout.height);
          },
          exportGraph: (name, filename, cursors) =>
            exported.push(`${name}:${filename}${cursors ? ":cursors" : ""}`),
        },
        method,
        paramsJson,
        // Copy out of the WebAssembly heap, as the worker does by transferring.
        data ? data.slice() : null,
        `run${runCount}`,
      ),
    stream: (name, text) => {
      if (name === "stdout") stdout += text;
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
});

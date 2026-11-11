import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import { FileStore } from "../core/files/files";
import { layoutGraph } from "../core/plot/layout";
import { layoutPage } from "../core/plot/page";
import { toSvg } from "../core/plot/svg";
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
  const pyodide = await loadPyodide({ packageCacheDir: "public/pyodide" });
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
      "float64 1.0",
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
});

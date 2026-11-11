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
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sandbox } from "../src/sandbox/host";
import { expect, test } from "./fixtures";

declare global {
  var sandboxUnderTest: Sandbox | undefined;
}

/**
 * The sandbox for plugin code, tried against code that tries to get out.
 *
 * A server on the side counts every request that reaches it, and answers
 * anything with headers that would let a page read the answer: if the
 * sandbox let any request through, the count would show it.
 */
let canary: Server;
let canaryURL = "";
const hits: string[] = [];

test.beforeAll(async () => {
  canary = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Type": "text/plain",
    });
    response.end("reached");
  });
  canary.on("upgrade", (request, socket) => {
    hits.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
  canaryURL = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => canary.close(() => resolve()));
});

/** Loads Python plugin source into a new sandbox on the page. */
async function startSandbox(
  page: import("@playwright/test").Page,
  source: string,
  packages: string[] = [],
) {
  return page.evaluate(
    async ({ source, packages }) => {
      globalThis.sandboxUnderTest?.destroy();
      const sandbox = await (
        globalThis.oresme as unknown as {
          sandbox: { create(packages: string[]): Promise<Sandbox> };
        }
      ).sandbox.create(packages);
      globalThis.sandboxUnderTest = sandbox;
      const actions = await sandbox.load({
        key: "probe",
        files: { "probe.py": new TextEncoder().encode(source).buffer },
        entry: "probe",
      });
      return actions.map((action) => action.name);
    },
    { source, packages },
  );
}

const wave = (values: number[]) => ({
  name: "input",
  dtype: "float64" as const,
  shape: [values.length],
  values,
  x0: 0,
  dx: 0.5,
  xUnit: "s",
  y0: 0,
  dy: 1,
  yUnit: "",
  unit: "V",
  note: "",
});

/** Runs an action of the sandbox on the page; returns the outcome or the error message. */
async function runAction(
  page: import("@playwright/test").Page,
  action: string,
  inputs: Record<string, ReturnType<typeof wave>>,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000,
) {
  return page.evaluate(
    async ({ action, inputs, params, timeoutMs }) => {
      const sandbox = globalThis.sandboxUnderTest!;
      try {
        const outcome = await sandbox.run({
          action,
          inputs: Object.fromEntries(
            Object.entries(inputs).map(([key, { values, ...rest }]) => [
              key,
              { ...rest, data: Float64Array.from(values).buffer, imag: null },
            ]),
          ),
          params: params as Record<string, never>,
          timeoutMs,
        });
        return {
          ok: true as const,
          waves: outcome.waves.map(([role, item]) => ({
            role,
            type: item.type,
            shape: item.shape,
            values: Array.from(item.data),
            x0: item.x0,
            dx: item.dx,
            unit: item.unit,
          })),
          values: outcome.values,
          log: outcome.log,
        };
      } catch (error) {
        return { ok: false as const, error: String(error), destroyed: sandbox.isDestroyed };
      }
    },
    { action, inputs, params, timeoutMs },
  );
}

test.describe("the sandbox for plugin code", () => {
  test.describe.configure({ timeout: 180_000 });

  test("runs plugin Python with NumPy and SciPy and hands back waves and values", async ({
    app,
    page,
  }) => {
    await app.idle();
    const names = await startSandbox(
      page,
      [
        "import numpy as np",
        "from scipy.integrate import cumulative_trapezoid",
        "from oresme_plugin import action, wave",
        "",
        '@action("area", title="Running area", inputs={"y": "wave"}, params={"scale": {"type": "number"}})',
        "def area(y, scale=1.0):",
        '    print("integrating", y.name)',
        "    total = cumulative_trapezoid(y.data, dx=y.dx, initial=0) * scale",
        '    return {"waves": {"area": wave(total, like=y, unit="V*s")}, "values": {"total": total[-1]}}',
      ].join("\n"),
      ["numpy", "scipy"],
    );
    expect(names).toEqual(["area"]);
    const outcome = await runAction(page, "area", { y: wave([0, 2, 4, 6]) }, { scale: 2 });
    expect(outcome).toMatchObject({
      ok: true,
      waves: [
        {
          role: "area",
          type: "float64",
          shape: [4],
          values: [0, 1, 4, 9],
          x0: 0,
          dx: 0.5,
          unit: "V*s",
        },
      ],
      values: { total: 9 },
      log: "integrating input\n",
    });
  });

  test("lets no request out and reaches none of the app's storage", async ({ app, page }) => {
    await app.idle();
    await startSandbox(
      page,
      `
import js
import pyodide.http
from pyodide.ffi import to_js
from oresme_plugin import action

CANARY = ${JSON.stringify(canaryURL)}
attempts = {}

def attempt(name, step):
    try:
        outcome = step()
        attempts[name] = "no error"
        # A promise: note how it ends, for the report.
        if hasattr(outcome, "then"):
            attempts[name] = "pending"
            def done(value, name=name):
                attempts[name] = "resolved"
            def failed(error, name=name):
                attempts[name] = "rejected"
            outcome.then(done, failed)
    except Exception as error:
        attempts[name] = "threw " + type(error).__name__

def xhr(asynchronous):
    request = js.XMLHttpRequest.new()
    request.open("GET", CANARY + "/xhr-" + str(asynchronous), asynchronous)
    request.send()

def nested_worker():
    code = "fetch('" + CANARY + "/nested'); postMessage('started')"
    url = js.URL.createObjectURL(js.Blob.new(to_js([code]), to_js({"type": "text/javascript"}, dict_converter=js.Object.fromEntries)))
    return js.Worker.new(url)

def cache_names():
    # WebKit gives an opaque origin an empty cache storage of its own: harmless,
    # as long as none of the app's caches can be seen in it.
    def seen(names):
        attempts["caches seen"] = ",".join(str(name) for name in names)
    return js.caches.keys().then(seen)

def font():
    face = js.FontFace.new("probe", "url(" + CANARY + "/font)")
    return face.load()

@action("probe", title="Probe", inputs={}, params={})
def probe():
    attempt("fetch", lambda: js.fetch(CANARY + "/fetch"))
    attempt("fetch no-cors", lambda: js.fetch(CANARY + "/no-cors", to_js({"mode": "no-cors"}, dict_converter=js.Object.fromEntries)))
    attempt("xhr async", lambda: xhr(True))
    attempt("xhr sync", lambda: xhr(False))
    attempt("websocket", lambda: js.WebSocket.new(CANARY.replace("http", "ws") + "/ws"))
    attempt("eventsource", lambda: js.EventSource.new(CANARY + "/sse"))
    attempt("import", lambda: js.eval("import('" + CANARY + "/import.js')"))
    attempt("worker by url", lambda: js.Worker.new(CANARY + "/worker.js"))
    attempt("nested worker", nested_worker)
    attempt("font", font)
    attempt("pyfetch", lambda: pyodide.http.pyfetch(CANARY + "/pyfetch"))
    attempt("open_url", lambda: pyodide.http.open_url(CANARY + "/open-url"))
    attempt("opfs", lambda: js.navigator.storage.getDirectory())
    attempt("indexeddb", lambda: js.indexedDB.open("oresme"))
    attempt("caches", cache_names)
    attempt("broadcast", lambda: js.BroadcastChannel.new("oresme-probe").postMessage("out"))
    if hasattr(js.navigator, "sendBeacon"):
        attempt("beacon", lambda: js.navigator.sendBeacon(CANARY + "/beacon", "x"))
    return {"values": {"origin": str(js.self.origin)}}

@action("report", title="Report", inputs={}, params={})
def report():
    return {"values": attempts}
`,
    );
    // The app listens where a plugin might broadcast to it.
    await page.evaluate(() => {
      const heard: string[] = [];
      (globalThis as unknown as { heard: string[] }).heard = heard;
      new BroadcastChannel("oresme-probe").onmessage = (event) => heard.push(String(event.data));
    });
    const probe = await runAction(page, "probe", {});
    expect(probe).toMatchObject({ ok: true, values: { origin: "null" } });
    // Give anything that slipped out time to arrive.
    await page.waitForTimeout(2000);
    const report = await runAction(page, "report", {});
    expect(report.ok).toBe(true);
    const attempts = (report as { values: Record<string, string> }).values;
    for (const name of [
      "fetch",
      "fetch no-cors",
      "import",
      "font",
      "pyfetch",
      "opfs",
      "indexeddb",
    ]) {
      expect(attempts[name], name).not.toBe("resolved");
    }
    // The app's own caches (the service worker keeps the app and Python in them).
    expect(attempts["caches seen"] ?? "").not.toMatch(/oresme/);
    expect(attempts["xhr sync"]).toMatch(/^threw/);
    expect(hits).toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as { heard: string[] }).heard)).toEqual(
      [],
    );
  });

  test("stops a plugin that does not answer, and the app goes on", async ({ app, page }) => {
    await app.idle();
    await startSandbox(
      page,
      [
        "from oresme_plugin import action",
        '@action("spin", title="Spin", inputs={}, params={})',
        "def spin():",
        "    while True:",
        "        pass",
      ].join("\n"),
    );
    const outcome = await runAction(page, "spin", {}, {}, 3000);
    expect(outcome).toMatchObject({ ok: false, destroyed: true });
    expect((outcome as { error: string }).error).toMatch(/did not answer within 3 s/);
    // The frame is gone, and with it the worker.
    expect(await page.locator("iframe[sandbox]").count()).toBe(0);
    const entry = await app.run("print(1 + 1)");
    expect(entry.output).toBe("2\n");
  });

  test("refuses a result that does not match what it claims", async ({ app, page }) => {
    await app.idle();
    await startSandbox(
      page,
      [
        "import js",
        "from oresme_plugin import action",
        '@action("lie", title="Lie", inputs={}, params={})',
        "def lie():",
        "    # Rewrite what the sandbox sends: a wave of a million points with the data of eight.",
        '    js.eval("""',
        "      const send = MessagePort.prototype.postMessage;",
        "      MessagePort.prototype.postMessage = function (message, transfer) {",
        "        if (message && message.type === 'result') {",
        "          message.ok = true;",
        "          message.waves = { big: { dtype: 'float64', shape: [1000000], data: new ArrayBuffer(64), imag: null,",
        "            x0: 0, dx: 1, xUnit: '', y0: 0, dy: 1, yUnit: '', unit: '', note: '' } };",
        "          message.values = {};",
        "        }",
        "        return send.call(this, message, []);",
        "      };",
        '    """)',
        '    return {"values": {}}',
      ].join("\n"),
    );
    const outcome = await runAction(page, "lie", {});
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: string }).error).toMatch(/do not match its shape and type/);
  });
});

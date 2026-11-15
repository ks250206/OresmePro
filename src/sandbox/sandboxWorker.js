// Runs inside the sandbox: a worker started from a blob by a frame whose
// origin is opaque (sandbox="allow-scripts", no allow-same-origin) and whose
// policy forbids every kind of fetching. Plugin code runs here, in its own
// Pyodide, and may run any JavaScript it likes through Pyodide's `js` module:
// what keeps it in is not this file but the frame's origin and policy. So
// nothing here is a security check on the plugin; it only refuses to start
// when the browser did not apply those, and carries messages.
//
// This file is plain JavaScript with no imports: its text is handed to the
// frame, which cannot fetch anything, and run from a blob.

/** Where Pyodide believes its files are. Nothing is ever fetched from here. */
const BASE = "https://sandbox.invalid/pyodide/";

/** @type {MessagePort | null} */
let port = null;
/** Files the host handed over, by the URL Pyodide will ask for. */
const files = new Map();
let pyodide = null;
let runtime = null;
let log = "";
const LOG_LIMIT = 64 * 1024;

function send(message, transfer = []) {
  port?.postMessage(message, transfer);
}

function write(text) {
  if (log.length < LOG_LIMIT) log += text.slice(0, LOG_LIMIT - log.length);
}

/**
 * Checks that the browser applied what keeps plugin code in: an opaque origin
 * (no storage of the app's) and a policy that blocks fetching. Each probe is
 * one that succeeds, offline and at once, when the protection is missing.
 */
async function selfCheck() {
  const missing = [];
  if (self.origin !== "null") missing.push(`the origin is ${self.origin}, not opaque`);
  // connect-src 'none' covers data: URLs too; without the policy this fetch
  // succeeds. With it, every directive of the policy holds, script-src too,
  // which names no source on the network.
  try {
    await fetch("data:text/plain,probe");
    missing.push("fetching is not blocked");
  } catch {
    // Blocked, as it should be.
  }
  try {
    await navigator.storage.getDirectory();
    missing.push("the origin's file system is reachable");
  } catch {
    // An opaque origin has none.
  }
  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("oresme-sandbox-probe");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    missing.push("IndexedDB is reachable");
  } catch {
    // An opaque origin has none.
  }
  try {
    // Chromium has no cache storage here. WebKit gives each opaque origin an
    // empty one of its own, which is harmless; one holding caches is not.
    const names = await caches.keys();
    if (names.length > 0) missing.push("the cache storage holds caches of others");
  } catch {
    // None at all.
  }
  return missing;
}

/** Serves Pyodide's requests for its own files from what the host handed over, and nothing else. */
function offlineFetch(input) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const bytes = files.get(url);
  if (!bytes) return Promise.reject(new TypeError(`The sandbox has no file ${url}.`));
  const type = url.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return Promise.resolve(new Response(bytes, { headers: { "Content-Type": type } }));
}

// From a data: URL rather than a blob: WebKit refuses to import a blob made
// in an opaque origin, as a cross-origin load.
const moduleFrom = (text) =>
  import(`data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`);

async function boot(message) {
  const missing = await selfCheck();
  if (missing.length > 0) {
    send({ type: "unsupported", reason: missing.join("; ") });
    return;
  }
  for (const [name, bytes] of Object.entries(message.files)) {
    files.set(/^https?:/.test(name) ? name : BASE + name, bytes);
  }
  self.fetch = offlineFetch;
  // Pyodide takes a worker where importScripts works for a classic one, which
  // it refuses. This one never loads scripts that way: its modules are given.
  self.importScripts = undefined;
  const loader = await moduleFrom(message.pyodide);
  const asm = await moduleFrom(message.asm);
  pyodide = await loader.loadPyodide({
    indexURL: BASE,
    lockFileContents: message.lock,
    // Given a lock file's text, Pyodide asks where its relative package names are.
    packageBaseUrl: BASE,
    stdLibURL: `${BASE}python_stdlib.zip`,
    createPyodideModule: asm.default,
    stdout: (text) => write(`${text}\n`),
    stderr: (text) => write(`${text}\n`),
  });
  const problems = [];
  await pyodide.loadPackage(message.packages, {
    messageCallback: () => {},
    errorCallback: (text) => problems.push(text),
  });
  const notLoaded = message.packages.filter((name) => !(name in pyodide.loadedPackages));
  if (notLoaded.length > 0) {
    throw new Error(`Could not load ${notLoaded.join(", ")}: ${problems.join(" ")}`);
  }
  pyodide.FS.mkdirTree("/sandbox/sdk");
  pyodide.FS.writeFile("/sandbox/sdk/oresme_plugin.py", message.sdk);
  pyodide.runPython("import sys; sys.path.insert(0, '/sandbox/sdk')");
  runtime = pyodide.pyimport("oresme_plugin");
  send({ type: "booted" });
}

function load(message) {
  log = "";
  const root = `/sandbox/plugins/${message.key}`;
  for (const [path, bytes] of Object.entries(message.files)) {
    const full = `${root}/${path}`;
    pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    pyodide.FS.writeFile(full, new Uint8Array(bytes));
  }
  const actions = runtime._load(root, message.entry);
  send({ type: "loaded", actions: JSON.parse(actions), log });
}

function run(message) {
  log = "";
  const outcome = runtime._run(message.action, message.inputs, JSON.stringify(message.params));
  const result = outcome.toJs({ dict_converter: Object.fromEntries });
  outcome.destroy();
  const transfer = [];
  for (const wave of Object.values(result.waves)) {
    // Copied out of Python's memory, so it can be handed over.
    wave.data = wave.data.slice().buffer;
    transfer.push(wave.data);
    if (wave.imag) {
      wave.imag = wave.imag.slice().buffer;
      transfer.push(wave.imag);
    }
  }
  send(
    {
      type: "result",
      runId: message.runId,
      ok: true,
      waves: result.waves,
      values: result.values,
      log,
    },
    transfer,
  );
}

function failed(message, error) {
  const text = error instanceof Error ? error.message : String(error);
  if (message.type === "run")
    send({ type: "result", runId: message.runId, ok: false, error: text, log });
  else if (message.type === "load") send({ type: "load-failed", error: text, log });
  else send({ type: "boot-failed", error: text });
}

// Messages are handled one after another: a run waits for the load before it.
let queue = Promise.resolve();
self.onmessage = (event) => {
  if (port || event.data?.type !== "port" || event.ports.length !== 1) return;
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    queue = queue.then(async () => {
      try {
        if (data.type === "boot") await boot(data);
        else if (data.type === "load") load(data);
        else if (data.type === "run") run(data);
      } catch (error) {
        failed(data, error);
      }
    });
  };
  send({ type: "ready" });
};

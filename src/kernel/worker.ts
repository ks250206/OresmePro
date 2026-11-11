import type { PyodideAPI } from "pyodide";
import { bootPython, type PythonKernel } from "./boot";
import type { FromWorker, ToWorker } from "./protocol";
import { armSyncBuffer, createSyncBuffer, waitSyncReply } from "./syncChannel";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

let syncBuffer = createSyncBuffer();
let interrupt: Uint8Array | null = null;
let currentId = 0;

// Program output arrives in many tiny writes; batch them so the main thread
// is not flooded, but never hold text back for long.
let pending: { name: "stdout" | "stderr"; text: string } | null = null;
let lastFlush = 0;
function flushStream(): void {
  if (pending) post({ type: "stream", id: currentId, ...pending });
  pending = null;
  lastFlush = performance.now();
}
function writeStream(name: "stdout" | "stderr", text: string): void {
  if (pending && pending.name !== name) flushStream();
  if (pending) pending.text += text;
  else pending = { name, text };
  if (pending.text.length > 8192 || performance.now() - lastFlush > 40) flushStream();
}

function rpc(method: string, paramsJson: string, data: Float64Array | null) {
  // `data` may be a view into Python's memory, which cannot be transferred.
  const payload = data ? data.slice() : null;
  armSyncBuffer(syncBuffer);
  post(
    { type: "rpc", execId: currentId, method, paramsJson, data: payload, buffer: syncBuffer },
    payload ? [payload.buffer] : [],
  );
  let reply = waitSyncReply(syncBuffer);
  if ("needed" in reply) {
    syncBuffer = createSyncBuffer(reply.needed * 2);
    armSyncBuffer(syncBuffer);
    post({ type: "rpc-resend", buffer: syncBuffer });
    reply = waitSyncReply(syncBuffer);
    if ("needed" in reply) throw new Error("Reply does not fit in the shared buffer.");
  }
  return reply;
}

async function boot(indexURL: string, interruptBuffer: SharedArrayBuffer): Promise<PythonKernel> {
  post({ type: "progress", message: "Loading Python…" });
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideAPI>;
  };
  const pyodide = await module.loadPyodide({ indexURL });
  interrupt = new Uint8Array(interruptBuffer);
  pyodide.setInterruptBuffer(interrupt);
  return bootPython(
    pyodide,
    {
      rpc,
      stream: writeStream,
      display: (bundleJson) => {
        flushStream();
        post({
          type: "display",
          id: currentId,
          bundle: JSON.parse(bundleJson) as Record<string, string>,
        });
      },
      error: (name, message, traceback) => {
        flushStream();
        post({ type: "error", id: currentId, name, message, traceback });
      },
    },
    (message) => post({ type: "progress", message }),
  );
}

let kernel: Promise<PythonKernel> | null = null;
let executing = false;

// An exception escaping from a Python callback must not take the worker (and
// with it the session) down. Before Python is up, errors go to the main thread.
scope.addEventListener("error", (event) => {
  if (!kernel) return;
  console.error("Uncaught error in the Python worker:", event.message);
  event.preventDefault();
});
// Executions run strictly one after another, in arrival order.
let queue: Promise<unknown> = Promise.resolve();

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "init") {
    kernel = boot(message.indexURL, message.interrupt);
    kernel.then(
      () => post({ type: "ready" }),
      (error: unknown) => post({ type: "failed", message: String(error) }),
    );
    return;
  }
  const ready = kernel;
  if (!ready) return;
  if (message.type === "execute") {
    queue = queue.then(async () => {
      const python = await ready;
      currentId = message.id;
      if (interrupt) interrupt[0] = 0;
      post({ type: "started", id: message.id });
      let ok = false;
      executing = true;
      try {
        ok = await python.execute(message.code);
      } catch (error) {
        post({
          type: "error",
          id: message.id,
          name: "InternalError",
          message: String(error),
          traceback: String(error),
        });
      }
      executing = false;
      flushStream();
      post({ type: "done", id: message.id, ok });
    });
    // A failure to boot is reported once, by the init handler.
    queue = queue.catch(() => {});
  } else if (message.type === "interrupt") {
    // Getting this message at all means Python is not in the middle of
    // synchronous code: it is idle or waiting on `await`.
    post({ type: "interrupt-ack" });
    if (executing) void ready.then((python) => python.interrupt());
  } else if (message.type === "complete") {
    void ready.then(
      (python) => {
        let items: ReturnType<PythonKernel["complete"]> = [];
        try {
          items = python.complete(message.code, message.cursor);
        } catch {
          // Completion is best-effort.
        }
        post({ type: "completions", id: message.id, items });
      },
      () => post({ type: "completions", id: message.id, items: [] }),
    );
  }
};

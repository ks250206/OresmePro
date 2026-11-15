import type {
  HostToSandbox,
  Json,
  SandboxActionInfo,
  SandboxToHost,
  SandboxWave,
} from "../core/sandbox/protocol";
import {
  checkActions,
  checkLog,
  checkResult,
  SandboxError,
  type CheckedResult,
} from "../core/sandbox/validate";
import { packageClosure, type Lock } from "../core/sandbox/packages";
import sdkSource from "./python/oresme_plugin.py?raw";
import workerSource from "./sandboxWorker.js?raw";

/**
 * Runs code the app does not trust: plugin Python, in a Pyodide of its own.
 *
 * The code runs in a worker inside a frame with `sandbox="allow-scripts"`
 * and no `allow-same-origin`, so its origin is opaque: the app's saved
 * experiments (OPFS), IndexedDB and caches belong to another origin and are
 * out of reach. The frame's policy forbids fetching anything at all, so the
 * code has no network either; Pyodide, the packages and the plugin's files
 * are read here and handed over as bytes. The one way out is the message
 * port given to the worker, and every message on it is checked
 * (src/core/sandbox/validate.ts) before it is used.
 *
 * A browser that does not apply these (the worker checks on start) gets no
 * sandbox at all; the code is never run elsewhere instead.
 */

/** The policy of the frame, and of the worker it starts from a blob. */
export const SANDBOX_POLICY = [
  "default-src 'none'",
  // Pyodide compiles WebAssembly and its modules are imported from data: URLs.
  // Plugin code may run any script it likes anyway: what matters is that no
  // source of script is on the network, and that nothing can be fetched.
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data:",
  // The worker starts from a data: URL too: WebKit refuses a worker, or a
  // module, from a blob an opaque origin made on a cross-origin isolated page.
  "worker-src data:",
  "child-src data:",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The frame's page: it waits for the app's first message, starts the worker
 * from the text it brings and hands the worker the port. It runs no plugin
 * code and listens to nothing after that.
 */
const FRAME = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_POLICY}">
<script>
addEventListener("message", function start(event) {
  if (event.source !== parent || !event.data || event.data.type !== "oresme-sandbox" || event.ports.length !== 1) return;
  removeEventListener("message", start);
  var worker = new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(event.data.worker));
  worker.onerror = function (error) { console.error("OresmePro sandbox:", error.message); };
  worker.postMessage({ type: "port" }, [event.ports[0]]);
});
</script>`;

export interface SandboxOptions {
  /** Where Pyodide is served (the app's own copy). */
  pyodideURL: string;
  /** Packages to load before the plugin runs: "numpy", "scipy", ... */
  packages?: readonly string[];
  /** How long starting may take. */
  bootTimeoutMs?: number;
  /** Where the frame goes; the document's body by default. */
  container?: HTMLElement;
  /** Fetches the app's own files (Pyodide and packages); for tests. */
  fetchFile?: (url: string) => Promise<ArrayBuffer>;
}

export interface PluginFiles {
  key: string;
  files: Record<string, ArrayBuffer>;
  entry: string;
}

export interface RunRequest {
  action: string;
  inputs: Record<string, SandboxWave | SandboxWave[]>;
  params: Record<string, Json>;
  /** Stops a run that takes longer; the sandbox is then thrown away. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (message: SandboxToHost) => void;
  reject: (error: Error) => void;
  /** Which messages answer this request. */
  accepts: (message: SandboxToHost) => boolean;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new SandboxError(`Could not fetch ${url} (${response.status}).`);
  return response.arrayBuffer();
}

export class Sandbox {
  private readonly frame: HTMLIFrameElement;
  private readonly port: MessagePort;
  private readonly pending = new Set<Pending>();
  private nextRun = 1;
  private destroyed = false;
  /** Requests go one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(frame: HTMLIFrameElement, port: MessagePort) {
    this.frame = frame;
    this.port = port;
    port.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
  }

  /** Starts a sandbox with Pyodide and the given packages loaded. */
  static async create(options: SandboxOptions): Promise<Sandbox> {
    const fetchFile = options.fetchFile ?? fetchBytes;
    const base = options.pyodideURL;
    const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
    const [pyodide, asm, lockText, wasm, stdlib] = await Promise.all([
      fetchFile(`${base}pyodide.mjs`).then(decode),
      fetchFile(`${base}pyodide.asm.mjs`).then(decode),
      fetchFile(`${base}pyodide-lock.json`).then(decode),
      fetchFile(`${base}pyodide.asm.wasm`),
      fetchFile(`${base}python_stdlib.zip`),
    ]);
    const lock = JSON.parse(lockText) as Lock;
    // The plugin SDK itself uses NumPy.
    const wanted = ["numpy", ...(options.packages ?? [])];
    const packages = packageClosure(lock, wanted);
    const files: Record<string, ArrayBuffer> = {
      "pyodide.asm.wasm": wasm,
      "python_stdlib.zip": stdlib,
    };
    await Promise.all(
      packages.map(async (name) => {
        const fileName = lock.packages[name]!.file_name;
        files[fileName] = await fetchFile(new URL(fileName, base).href);
      }),
    );

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = FRAME;
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    (options.container ?? document.body).append(frame);
    await loaded;
    const channel = new MessageChannel();
    const sandbox = new Sandbox(frame, channel.port1);
    try {
      const ready = sandbox.expect((message) => message.type === "ready", options.bootTimeoutMs);
      // The frame's origin is opaque, so there is no origin to name here.
      frame.contentWindow!.postMessage({ type: "oresme-sandbox", worker: workerSource }, "*", [
        channel.port2,
      ]);
      await ready;
      const boot: HostToSandbox = {
        type: "boot",
        pyodide,
        asm,
        lock: lockText,
        files,
        packages: [...new Set(wanted)],
        sdk: sdkSource,
      };
      const booted = sandbox.expect(
        (message) =>
          message.type === "booted" ||
          message.type === "unsupported" ||
          message.type === "boot-failed",
        options.bootTimeoutMs ?? 120_000,
      );
      sandbox.port.postMessage(boot, Object.values(files));
      const answer = await booted;
      if (answer.type === "unsupported") {
        throw new SandboxError(
          `This browser cannot keep plugin code apart from the app (${checkLog(answer.reason)}), so plugins with code cannot run here.`,
        );
      }
      if (answer.type === "boot-failed") {
        throw new SandboxError(`Python did not start in the sandbox: ${checkLog(answer.error)}`);
      }
      return sandbox;
    } catch (error) {
      sandbox.destroy();
      throw error;
    }
  }

  /** Puts a plugin's files in the sandbox and imports it; returns the actions it registered. */
  load(plugin: PluginFiles, timeoutMs = 60_000): Promise<SandboxActionInfo[]> {
    if (!KEY.test(plugin.key)) throw new SandboxError(`${plugin.key} is not a usable plugin key.`);
    return this.serial(async () => {
      const answer = this.expect(
        (message) => message.type === "loaded" || message.type === "load-failed",
        timeoutMs,
      );
      const files = Object.fromEntries(
        Object.entries(plugin.files).map(([path, bytes]) => [path, bytes.slice(0)]),
      );
      const message: HostToSandbox = { type: "load", key: plugin.key, files, entry: plugin.entry };
      this.port.postMessage(message, Object.values(files));
      const reply = await answer;
      if (reply.type === "load-failed") {
        throw new SandboxError(`The plugin did not load: ${checkLog(reply.error)}`);
      }
      return checkActions((reply as { actions: unknown }).actions);
    });
  }

  /** Runs an action and returns its checked outcome. */
  run(request: RunRequest): Promise<CheckedResult> {
    return this.serial(async () => {
      const runId = this.nextRun;
      this.nextRun += 1;
      const answer = this.expect(
        (message) => message.type === "result" && message.runId === runId,
        request.timeoutMs ?? 120_000,
        request.signal,
      );
      const transfer: ArrayBuffer[] = [];
      // Copies: the sandbox gets buffers of its own, never the document's.
      const copy = (item: SandboxWave): SandboxWave => {
        const data = item.data.slice(0);
        const imag = item.imag ? item.imag.slice(0) : null;
        transfer.push(data);
        if (imag) transfer.push(imag);
        return { ...item, data, imag };
      };
      const inputs = Object.fromEntries(
        Object.entries(request.inputs).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map(copy) : copy(value),
        ]),
      );
      const message: HostToSandbox = {
        type: "run",
        runId,
        action: request.action,
        inputs,
        params: request.params,
      };
      this.port.postMessage(message, transfer);
      const reply = (await answer) as unknown as Record<string, unknown>;
      if (reply.ok !== true) {
        throw new SandboxError(checkLog(reply.error) || "The action failed.");
      }
      return checkResult(reply);
    });
  }

  /** Stops the sandbox: its worker ends with the frame. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.port.onmessage = null;
    this.port.close();
    this.frame.remove();
    for (const pending of this.pending)
      pending.reject(new SandboxError("The sandbox was stopped."));
    this.pending.clear();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Waits for the message that answers a request. A request that takes too
   * long, or is cancelled, stops the whole sandbox: code that does not answer
   * cannot be asked to stop, only thrown away.
   */
  private expect(
    accepts: (message: SandboxToHost) => boolean,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<SandboxToHost> {
    if (this.destroyed) return Promise.reject(new SandboxError("The sandbox was stopped."));
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        accepts,
        resolve: (message) => {
          finish();
          resolve(message);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      const stop = (reason: string) => {
        finish();
        reject(new SandboxError(reason));
        this.destroy();
      };
      const timer = setTimeout(
        () =>
          stop(
            `The plugin did not answer within ${Math.round(timeoutMs / 1000)} s and was stopped.`,
          ),
        timeoutMs,
      );
      const abort = () => stop("Cancelled.");
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(pending);
      };
      this.pending.add(pending);
      if (signal?.aborted) abort();
    });
  }

  private receive(data: unknown): void {
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    const message = data as SandboxToHost;
    // Anything that answers no request (a late result, a repeat) is dropped.
    for (const pending of this.pending) {
      if (pending.accepts(message)) {
        pending.resolve(message);
        return;
      }
    }
  }
}

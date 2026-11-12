import type { Doc } from "../core/doc/doc";
import type { FileStore } from "../core/files/files";
import type { History } from "../core/history/history";
import type { CompletionItem } from "./boot";
import type { FromWorker, ToWorker } from "./protocol";
import { answerRpc, type RpcContext } from "./rpc";
import { writeSyncReply } from "./syncChannel";

export interface KernelState {
  /** starting: loading Python. unavailable: this page cannot run it at all. */
  status: "starting" | "ready" | "busy" | "failed" | "unavailable";
  message: string;
  /** Set while Python is waiting in input(): the prompt to show. */
  input: string | null;
  /** True once an interrupt was requested and the code has not stopped yet. */
  interrupting: boolean;
}

export interface KernelOptions {
  doc: Doc;
  history: History;
  files: FileStore;
  /** Called each time Python is (re)started, once it can be given code to run. */
  onStart?: () => void;
  renderSvg: RpcContext["renderSvg"];
  exportGraph: RpcContext["exportGraph"];
  renderPageSvg: RpcContext["renderPageSvg"];
  exportPage: RpcContext["exportPage"];
  measureText: RpcContext["measureText"];
  importPresets: RpcContext["importPresets"];
  indexURL: string;
}

interface Running {
  historyId: number;
  startedAt: number;
}

/**
 * Owns the Python worker: starts it, feeds it code, routes its output into
 * the history, and answers its requests against the document. The document
 * and history live here on the main thread, so restarting Python loses
 * nothing but Python's own variables.
 */
export class KernelClient {
  private worker: Worker | null = null;
  private interrupt: Uint8Array | null = null;
  private state: KernelState = {
    status: "starting",
    message: "Loading Python…",
    input: null,
    interrupting: false,
  };
  /** The shared buffer Python is blocked on while it waits for input(). */
  private inputBuffer: SharedArrayBuffer | null = null;
  private inputHistoryId: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly running = new Map<number, Running>();
  private readonly completions = new Map<number, (items: CompletionItem[]) => void>();
  private pendingReply: { json: string; data: Float64Array | null } | null = null;
  private nextId = 1;
  private ready = false;
  private interruptAcked = false;
  private readonly options: KernelOptions;

  constructor(options: KernelOptions) {
    this.options = options;
  }

  readonly getState = (): KernelState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (typeof SharedArrayBuffer === "undefined" || !globalThis.crossOriginIsolated) {
      this.setState({
        status: "unavailable",
        message:
          "Python needs a cross-origin isolated page (COOP/COEP headers). Graphs and tables still work.",
      });
      return;
    }
    this.ready = false;
    this.setState({
      status: "starting",
      message: "Loading Python…",
      input: null,
      interrupting: false,
    });
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const interruptBuffer = new SharedArrayBuffer(4);
    this.worker = worker;
    this.interrupt = new Uint8Array(interruptBuffer);
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      // After start-up the worker handles its own errors; this is a failure to load.
      if (this.ready) return;
      this.failAll(`Python stopped: ${event.message}`);
      this.setState({
        status: "failed",
        message: event.message || "The Python worker failed to start.",
      });
    };
    this.send({ type: "init", indexURL: this.options.indexURL, interrupt: interruptBuffer });
    this.options.onStart?.();
  }

  /**
   * Queues code to run and returns its history entry id. Code the user did
   * not type (a procedure run when the experiment opens) is marked "gui".
   */
  execute(code: string, source: "user" | "gui" = "user"): number {
    const { history } = this.options;
    const historyId = history.add(source, code, "queued");
    if (!this.worker || this.state.status === "unavailable" || this.state.status === "failed") {
      history.appendOutput(historyId, {
        kind: "error",
        name: "PythonUnavailable",
        message: this.state.message,
        traceback: `Python is not running: ${this.state.message}`,
      });
      history.update(historyId, { status: "error", durationMs: 0 });
      return historyId;
    }
    const id = this.nextId;
    this.nextId += 1;
    this.running.set(id, { historyId, startedAt: Date.now() });
    this.send({ type: "execute", id, code });
    this.refreshStatus();
    return historyId;
  }

  /** Completions at a cursor position; empty if Python is busy or not up. */
  complete(code: string, cursor: number): Promise<CompletionItem[]> {
    if (!this.worker || !this.ready || this.running.size > 0) return Promise.resolve([]);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      this.completions.set(id, resolve);
      this.send({ type: "complete", id, code, cursor });
      setTimeout(() => {
        if (this.completions.delete(id)) resolve([]);
      }, 2000);
    });
  }

  /**
   * Stops the running code, like Ctrl+C in a shell.
   *
   * Code waiting on `await` is cancelled by a message to the worker. A worker
   * busy with synchronous Python cannot read messages, so if it does not
   * acknowledge promptly, a signal is raised through the shared interrupt
   * buffer instead. Trying the message first matters: a signal delivered
   * while Python sits in its event loop would be raised there, not in the
   * user's code.
   *
   * Python only notices the signal between bytecodes, so a long call into
   * compiled code (a large matrix product, say) runs to its end first. Asking
   * again while still waiting gives up on that and restarts Python; nothing
   * but Python's own variables is lost.
   */
  interruptExecution(): void {
    if (!this.worker || this.running.size === 0) return;
    if (this.inputBuffer) {
      this.answerInput(null);
      return;
    }
    if (this.state.interrupting) {
      this.restart("Python did not stop, so it was restarted.");
      return;
    }
    this.interruptAcked = false;
    // Executions run in order, so the first one still pending is the one running.
    const [current] = this.running.keys();
    this.send({ type: "interrupt", id: current! });
    setTimeout(() => {
      if (!this.interruptAcked && this.interrupt && this.running.size > 0) this.interrupt[0] = 2;
    }, 150);
    // Only offer the forced restart once the polite request has had a moment.
    setTimeout(() => {
      if (this.running.size > 0 && !this.inputBuffer) {
        this.setState({
          interrupting: true,
          message: "Still running… interrupt again to restart Python",
        });
      }
    }, 1500);
  }

  /** Answers a pending input() with a line of text, or null to interrupt it. */
  answerInput(text: string | null): void {
    const buffer = this.inputBuffer;
    if (!buffer) return;
    const { history } = this.options;
    if (this.inputHistoryId !== null && text !== null) {
      history.appendOutput(this.inputHistoryId, {
        kind: "stream",
        name: "stdout",
        text: `${text}\n`,
      });
    }
    this.inputBuffer = null;
    this.inputHistoryId = null;
    this.setState({ input: null });
    writeSyncReply(buffer, JSON.stringify({ ok: true, result: text }), null);
  }

  restart(reason = "Python was restarted."): void {
    this.worker?.terminate();
    this.worker = null;
    this.inputBuffer = null;
    this.inputHistoryId = null;
    this.failAll(reason);
    this.options.history.add("system", "Python restarted. Waves, graphs and tables are kept.");
    this.start();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private receive(message: FromWorker): void {
    const { history } = this.options;
    switch (message.type) {
      case "progress":
        if (!this.ready) this.setState({ status: "starting", message: message.message });
        break;
      case "ready":
        this.ready = true;
        this.refreshStatus();
        break;
      case "failed":
        this.failAll(`Python failed to start: ${message.message}`);
        this.setState({ status: "failed", message: message.message });
        break;
      case "started": {
        const run = this.running.get(message.id);
        if (!run) break;
        run.startedAt = Date.now();
        history.update(run.historyId, { status: "running", startedAt: run.startedAt });
        break;
      }
      case "stream": {
        const run = this.running.get(message.id);
        if (run) {
          history.appendOutput(run.historyId, {
            kind: "stream",
            name: message.name,
            text: message.text,
          });
        }
        break;
      }
      case "display": {
        const run = this.running.get(message.id);
        if (!run) break;
        const { bundle } = message;
        history.appendOutput(run.historyId, {
          kind: "result",
          text: bundle["text/plain"] ?? "",
          ...(bundle["image/svg+xml"] ? { svg: bundle["image/svg+xml"] } : {}),
          ...(bundle["image/png"] ? { png: bundle["image/png"] } : {}),
        });
        break;
      }
      case "error": {
        const run = this.running.get(message.id);
        if (run) {
          history.appendOutput(run.historyId, {
            kind: "error",
            name: message.name,
            message: message.message,
            traceback: message.traceback,
          });
        }
        break;
      }
      case "done": {
        const run = this.running.get(message.id);
        if (!run) break;
        this.running.delete(message.id);
        history.update(run.historyId, {
          status: message.ok ? "ok" : "error",
          durationMs: Date.now() - run.startedAt,
        });
        this.refreshStatus();
        break;
      }
      case "interrupt-ack":
        this.interruptAcked = true;
        break;
      case "completions":
        this.completions.get(message.id)?.(message.items);
        this.completions.delete(message.id);
        break;
      case "rpc": {
        if (message.method === "input") {
          // Answered later, when the user has typed a line; Python waits meanwhile.
          const run = this.running.get(message.execId);
          const asked = (JSON.parse(message.paramsJson) as { prompt?: unknown }).prompt;
          const prompt = typeof asked === "string" ? asked : "";
          this.inputBuffer = message.buffer;
          this.inputHistoryId = run?.historyId ?? null;
          if (run && prompt) {
            history.appendOutput(run.historyId, { kind: "stream", name: "stdout", text: prompt });
          }
          this.setState({ input: prompt });
          break;
        }
        const reply = answerRpc(
          this.options,
          message.method,
          message.paramsJson,
          message.data,
          `exec${message.execId}`,
        );
        this.pendingReply = writeSyncReply(message.buffer, reply.json, reply.data) ? null : reply;
        break;
      }
      case "rpc-resend":
        if (this.pendingReply) {
          writeSyncReply(message.buffer, this.pendingReply.json, this.pendingReply.data);
          this.pendingReply = null;
        }
        break;
    }
  }

  private failAll(reason: string): void {
    const { history } = this.options;
    for (const run of this.running.values()) {
      history.appendOutput(run.historyId, {
        kind: "error",
        name: "Stopped",
        message: reason,
        traceback: reason,
      });
      history.update(run.historyId, { status: "error", durationMs: Date.now() - run.startedAt });
    }
    this.running.clear();
    for (const resolve of this.completions.values()) resolve([]);
    this.completions.clear();
  }

  private refreshStatus(): void {
    if (!this.ready) return;
    if (this.running.size > 0) {
      if (this.state.status !== "busy") this.setState({ status: "busy", message: "Running…" });
    } else {
      this.setState({ status: "ready", message: "Python ready", interrupting: false });
    }
  }

  private setState(change: Partial<KernelState>): void {
    const state = { ...this.state, ...change };
    if (
      state.status === this.state.status &&
      state.message === this.state.message &&
      state.input === this.state.input &&
      state.interrupting === this.state.interrupting
    ) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

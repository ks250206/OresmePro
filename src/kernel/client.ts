import { invokeCode, type ActionArgs, type ActionSpec } from "../core/actions";
import type { Doc } from "../core/doc/doc";
import type { FileStore } from "../core/files/files";
import type { History } from "../core/history/history";
import type { CompletionItem } from "./boot";
import type { FromWorker, ToWorker } from "./protocol";
import type { DocWriter } from "../core/doc/doc";
import { answerRpc, dropStage, openStage, type RpcContext } from "./rpc";
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
  /** Called before an input is entered in the history: what must be written first goes in here. */
  onExecute?: () => void;
  renderSvg: RpcContext["renderSvg"];
  exportGraph: RpcContext["exportGraph"];
  renderPageSvg: RpcContext["renderPageSvg"];
  exportPage: RpcContext["exportPage"];
  measureText: RpcContext["measureText"];
  importPresets: RpcContext["importPresets"];
  pluginCatalog?: RpcContext["pluginCatalog"];
  packagesStatus?: RpcContext["packagesStatus"];
  variablesStatus?: RpcContext["variablesStatus"];
  /**
   * Runs a plugin's action for Python (`op.invoke("plugin....")`). It is
   * answered later, when the plugin's sandbox is done; Python waits. Its
   * waves go into `writer`, Python's open atomic block, when there is one.
   */
  invokePlugin?: (
    action: string,
    args: Record<string, unknown>,
    writer: DocWriter | null,
  ) => Promise<unknown>;
  indexURL: string;
}

interface Running {
  historyId: number;
  startedAt: number;
  /** For an action call: settles its promise when it is done. */
  settle?: (outcome: { ok: true; value: unknown } | { ok: false; error: string }) => void;
  /** The last error it reported, which an action call is rejected with. */
  error?: string;
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
  private catalog: readonly ActionSpec[] = [];
  private readonly actionListeners = new Set<() => void>();
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

  /** The actions Python has registered (empty until it is up). */
  readonly getActions = (): readonly ActionSpec[] => this.catalog;

  /** Calls `listener` whenever the list of actions changes. */
  readonly subscribeActions = (listener: () => void): (() => void) => {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
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
    this.setActions([]);
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
    this.options.onExecute?.();
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

  /**
   * Calls a registered action (see `op.action`) with plain values, queued
   * behind any code that is running, as a GUI does. The call is entered in
   * the history as the Python that does the same, with what it prints.
   * Resolves to the JSON form of what the action returned; rejects with the
   * error's message if the call is refused or fails, which changes nothing.
   * `version` picks a version of the action, the highest by default.
   */
  invoke(action: string, args: ActionArgs = {}, version?: number): Promise<unknown> {
    const { history } = this.options;
    let argsJson: string;
    let code: string;
    try {
      argsJson = JSON.stringify(args);
      code = invokeCode(action, args, version);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.options.onExecute?.();
    // Until Python has checked the call, it is shown as the op.invoke it is.
    const historyId = history.add("gui", code, "queued");
    if (!this.worker || this.state.status === "unavailable" || this.state.status === "failed") {
      history.appendOutput(historyId, {
        kind: "error",
        name: "PythonUnavailable",
        message: this.state.message,
        traceback: `Python is not running: ${this.state.message}`,
      });
      history.update(historyId, { status: "error", durationMs: 0 });
      return Promise.reject(new Error(`Python is not running: ${this.state.message}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.running.set(id, {
        historyId,
        startedAt: Date.now(),
        settle: (outcome) =>
          outcome.ok ? resolve(outcome.value) : reject(new Error(outcome.error)),
      });
      this.send({ type: "invoke", id, action, version: version ?? null, argsJson });
      this.refreshStatus();
    });
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
    // Everything below is about this execution only: by the time a timer
    // fires it may have ended and another begun, which was not asked to stop.
    const stillRunning = () => current !== undefined && this.running.has(current);
    const signal = (repeats: number) => {
      if (this.interruptAcked || !this.interrupt || !stillRunning()) return;
      // Python takes the signal by setting the byte back to 0. Taken but still
      // running means it was raised where it was swallowed: in the preparation
      // before the user's code (IPython's hooks catch it and go on), after
      // which the code itself would run on with nothing left to stop it. So
      // it is sent again, a second apart, a few times. Code that catches
      // KeyboardInterrupt to tidy up has that second to do it in.
      if (this.interrupt[0] === 0) this.interrupt[0] = 2;
      if (repeats > 0) setTimeout(() => signal(repeats - 1), 1000);
    };
    setTimeout(() => signal(3), 150);
    // Only offer the forced restart once the polite request has had a moment.
    setTimeout(() => {
      if (stillRunning() && !this.inputBuffer) {
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
        // Once Python is up, it reports what an input is waiting for: a package being loaded.
        else if (this.running.size > 0 && !this.state.interrupting) {
          this.setState({ message: message.message || "Running…" });
        }
        break;
      case "actions":
        this.setActions(message.catalog);
        break;
      case "echo": {
        const run = this.running.get(message.id);
        if (run) history.update(run.historyId, { code: message.code });
        break;
      }
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
          run.error = message.message ? `${message.name}: ${message.message}` : message.name;
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
        // A block is closed by the code that opened it; one still open when its
        // input ends (opened by hand, say) would hold its changes forever.
        if (dropStage(this.options.doc)) {
          history.appendOutput(run.historyId, {
            kind: "stream",
            name: "stderr",
            text: "An op.atomic() block was still open at the end, so its changes were dropped.\n",
          });
        }
        history.update(run.historyId, {
          status: message.ok ? "ok" : "error",
          durationMs: Date.now() - run.startedAt,
        });
        if (message.ok) {
          const reply = (message.result ? JSON.parse(message.result) : {}) as { result?: unknown };
          run.settle?.({ ok: true, value: reply.result ?? null });
        } else {
          run.settle?.({ ok: false, error: run.error ?? "The action failed." });
        }
        // The input that would not stop has ended: the one running now was not asked to.
        if (this.running.size > 0 && this.state.interrupting) {
          this.setState({ message: "Running…", interrupting: false });
        }
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
        if (message.method === "invokePlugin") {
          this.answerPlugin(message.paramsJson, message.buffer);
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

  /** Answers Python's request to run a plugin's action once the plugin is done with it. */
  private answerPlugin(paramsJson: string, buffer: SharedArrayBuffer): void {
    const reply = (json: string) => {
      // Python may have been restarted meanwhile; then nobody waits on this buffer.
      if (!this.worker) return;
      const answer = { json, data: null };
      this.pendingReply = writeSyncReply(buffer, json, null) ? null : answer;
    };
    const fail = (error: unknown) =>
      reply(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    let params: { action?: unknown; args?: unknown };
    try {
      params = JSON.parse(paramsJson) as typeof params;
    } catch (error) {
      fail(error);
      return;
    }
    const run = this.options.invokePlugin;
    if (
      !run ||
      typeof params.action !== "string" ||
      typeof params.args !== "object" ||
      params.args === null
    ) {
      fail(new Error("Plugins cannot be run here."));
      return;
    }
    run(params.action, params.args as Record<string, unknown>, openStage(this.options.doc)).then(
      (result) => reply(JSON.stringify({ ok: true, result: result ?? null })),
      fail,
    );
  }

  private failAll(reason: string): void {
    const { history } = this.options;
    // Python stopped: an atomic block it had open will never be finished.
    dropStage(this.options.doc);
    for (const run of this.running.values()) {
      history.appendOutput(run.historyId, {
        kind: "error",
        name: "Stopped",
        message: reason,
        traceback: reason,
      });
      history.update(run.historyId, { status: "error", durationMs: Date.now() - run.startedAt });
      run.settle?.({ ok: false, error: reason });
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

  private setActions(catalog: readonly ActionSpec[]): void {
    if (catalog.length === 0 && this.catalog.length === 0) return;
    this.catalog = catalog;
    for (const listener of this.actionListeners) listener();
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

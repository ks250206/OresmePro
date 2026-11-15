import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ActionSpec } from "../core/actions";
import { Doc } from "../core/doc/doc";
import { FileStore } from "../core/files/files";
import { History } from "../core/history/history";
import { KernelClient, type KernelOptions } from "./client";
import type { FromWorker, ToWorker } from "./protocol";

/** Stands in for the Python worker: records what it is sent, and answers as the test says. */
class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: ToWorker[] = [];
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: ToWorker): void {
    this.sent.push(message);
  }

  terminate(): void {}

  reply(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
}

const smooth: ActionSpec = {
  id: "core.smooth",
  version: 1,
  title: "Smooth",
  description: null,
  params: { wave: { type: "wave", optional: false } },
};

function client(): { kernel: KernelClient; history: History; worker: FakeWorker } {
  const history = new History();
  const kernel = new KernelClient({
    doc: new Doc(),
    history,
    files: new FileStore(),
    indexURL: "/pyodide/",
  } as unknown as KernelOptions);
  kernel.start();
  return { kernel, history, worker: FakeWorker.last! };
}

describe("KernelClient actions", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("crossOriginIsolated", true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the list of actions Python sends and tells its subscribers", () => {
    const { kernel, worker } = client();
    const seen: (readonly ActionSpec[])[] = [];
    kernel.subscribeActions(() => seen.push(kernel.getActions()));
    expect(kernel.getActions()).toEqual([]);
    worker.reply({ type: "actions", catalog: [smooth] });
    worker.reply({ type: "ready" });
    expect(kernel.getActions()).toEqual([smooth]);
    expect(seen).toEqual([[smooth]]);
    // Restarting forgets them until the new Python sends its own.
    kernel.restart();
    expect(kernel.getActions()).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it("sends a call, shows it in the history as Python, and resolves to its result", async () => {
    const { kernel, history, worker } = client();
    worker.reply({ type: "ready" });
    const call = kernel.invoke("core.smooth", { wave: "sig" });
    const sent = worker.sent.at(-1)!;
    expect(sent).toEqual({
      type: "invoke",
      id: expect.any(Number) as number,
      action: "core.smooth",
      version: null,
      argsJson: '{"wave":"sig"}',
    });
    const id = (sent as { id: number }).id;
    const entry = () => history.getEntries().at(-1)!;
    expect(entry()).toMatchObject({
      source: "gui",
      code: 'op.invoke("core.smooth", {"wave": "sig"})',
      status: "queued",
    });
    expect(kernel.getState().status).toBe("busy");
    worker.reply({ type: "started", id });
    worker.reply({ type: "echo", id, code: 'op.smooth(op.wave("sig"))' });
    worker.reply({ type: "stream", id, name: "stdout", text: "done\n" });
    worker.reply({ type: "done", id, ok: true, result: '{"result": {"wave": "sig_smth"}}' });
    await expect(call).resolves.toEqual({ wave: "sig_smth" });
    expect(entry()).toMatchObject({
      code: 'op.smooth(op.wave("sig"))',
      status: "ok",
      outputs: [{ kind: "stream", name: "stdout", text: "done\n" }],
    });
    expect(kernel.getState().status).toBe("ready");
  });

  it("rejects a refused call with its error", async () => {
    const { kernel, history, worker } = client();
    worker.reply({ type: "ready" });
    const call = kernel.invoke("core.smooth", { wave: 3 }, 1);
    const id = (worker.sent.at(-1) as { id: number }).id;
    expect((worker.sent.at(-1) as { version: number }).version).toBe(1);
    worker.reply({ type: "started", id });
    worker.reply({
      type: "error",
      id,
      name: "OresmeError",
      message: "core.smooth: wave must be the name of a wave, not 3.",
      traceback: "",
    });
    worker.reply({ type: "done", id, ok: false });
    await expect(call).rejects.toThrow(
      "OresmeError: core.smooth: wave must be the name of a wave, not 3.",
    );
    expect(history.getEntries().at(-1)).toMatchObject({
      code: 'op.invoke("core.smooth", {"wave": 3}, version=1)',
      status: "error",
    });
  });

  it("rejects calls that Python will never answer", async () => {
    const { kernel, worker } = client();
    worker.reply({ type: "ready" });
    const call = kernel.invoke("core.smooth", { wave: "sig" });
    kernel.restart("Python was restarted.");
    await expect(call).rejects.toThrow("Python was restarted.");

    vi.stubGlobal("crossOriginIsolated", false);
    const unavailable = new KernelClient({
      doc: new Doc(),
      history: new History(),
      files: new FileStore(),
      indexURL: "/pyodide/",
    } as unknown as KernelOptions);
    unavailable.start();
    await expect(unavailable.invoke("core.smooth", { wave: "sig" })).rejects.toThrow(
      /Python is not running/,
    );
  });
});

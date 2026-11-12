import type { CompletionItem } from "./boot";

export type ToWorker =
  | { type: "init"; indexURL: string; interrupt: SharedArrayBuffer }
  | { type: "execute"; id: number; code: string }
  | { type: "complete"; id: number; code: string; cursor: number }
  /** Sent first on Ctrl+C; reaches the worker only if Python is not running synchronously. */
  | { type: "interrupt"; id: number };

export type FromWorker =
  | { type: "progress"; message: string }
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "started"; id: number }
  | { type: "stream"; id: number; name: "stdout" | "stderr"; text: string }
  | { type: "display"; id: number; bundle: Record<string, string> }
  | { type: "error"; id: number; name: string; message: string; traceback: string }
  | { type: "done"; id: number; ok: boolean }
  | { type: "interrupt-ack" }
  | { type: "completions"; id: number; items: CompletionItem[] }
  | {
      /** A blocking request; the worker sleeps on `buffer` until it is answered. */
      type: "rpc";
      execId: number;
      method: string;
      paramsJson: string;
      data: Float64Array | null;
      buffer: SharedArrayBuffer;
    }
  | { type: "rpc-resend"; buffer: SharedArrayBuffer };

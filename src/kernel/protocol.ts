import type { ActionSpec } from "../core/actions";
import type { CompletionItem } from "./boot";

export type ToWorker =
  | { type: "init"; indexURL: string; interrupt: SharedArrayBuffer }
  | { type: "execute"; id: number; code: string }
  /**
   * Calls a registered action, queued like an execution. `version` null
   * means the highest; `argsJson` is a JSON object of argument values.
   */
  | { type: "invoke"; id: number; action: string; version: number | null; argsJson: string }
  | { type: "complete"; id: number; code: string; cursor: number }
  /** Sent first on Ctrl+C; reaches the worker only if Python is not running synchronously. */
  | { type: "interrupt"; id: number };

export type FromWorker =
  | { type: "progress"; message: string }
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "started"; id: number }
  /** The registered actions: once before "ready", and again whenever they change. */
  | { type: "actions"; catalog: ActionSpec[] }
  /** An action call was accepted: the Python that does the same, for the history. */
  | { type: "echo"; id: number; code: string }
  | { type: "stream"; id: number; name: "stdout" | "stderr"; text: string }
  | { type: "display"; id: number; bundle: Record<string, string> }
  | { type: "error"; id: number; name: string; message: string; traceback: string }
  /** `result` is the JSON `{"result": ...}` of an action call that succeeded. */
  | { type: "done"; id: number; ok: boolean; result?: string }
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

import type { HistoryOutput } from "../history/history";
import { pluginPhase } from "../sandbox/validate";
import { ERROR_CLASSES, errorInfo } from "../doc/types";

/**
 * How the history shows a plugin's run that did not end well: named as
 * Python would name it (`PluginFailedError`, `InvalidArgumentError`, ...),
 * with the phase it failed at (`details.phase`) when it says. A run that
 * was stopped (`phase` "stopped") is not a failure: `cancelled`.
 */
export function pluginFailure(error: unknown): {
  output: Extract<HistoryOutput, { kind: "error" }>;
  cancelled: boolean;
} {
  const { code, message, details } = errorInfo(error);
  const phase = pluginPhase(error);
  const name = ERROR_CLASSES[code];
  return {
    output: {
      kind: "error",
      name,
      message,
      traceback: `${name}${phase ? ` (${phase})` : ""}: ${message}`,
      code,
      details: { ...details },
    },
    cancelled: phase === "stopped",
  };
}

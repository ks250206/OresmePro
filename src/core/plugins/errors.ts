import { DocError, type ErrorCode } from "../doc/errors";

/** A plugin, its package or a call of its action is refused: PLUGIN_FAILED unless said otherwise. */
export class PluginError extends DocError {
  constructor(
    message: string,
    code: ErrorCode = "PLUGIN_FAILED",
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, code, details);
    this.name = "PluginError";
  }
}

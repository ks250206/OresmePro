/** The errors the app reports, and a run that was stopped. */

/**
 * What kind of error the app reports, for code (Python, plugins, tools) to
 * tell them apart without reading the message. They are part of the public
 * API: changing or removing one is a breaking change (see CHANGELOG.md).
 */
export const ERROR_CODES = [
  /** A value, name or argument that is not allowed (`details.field` says which). */
  "INVALID_ARGUMENT",
  /** Something asked for by name is not there (`details.kind`, `details.name`). */
  "NOT_FOUND",
  /** A name is taken already (`details.kind`, `details.name`). */
  "ALREADY_EXISTS",
  /** Something cannot be removed while other things use it (`details.users`). */
  "IN_USE",
  /** What a step was computed from changed meanwhile: doing it again may work. */
  "CONFLICT",
  /** A file, format or package the app cannot handle. */
  "UNSUPPORTED",
  /** A plugin failed: it raised, timed out or returned what is not allowed. */
  "PLUGIN_FAILED",
  /** A fault of the app itself. */
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error as it crosses to Python and other callers: what it is, in words and in data. */
export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

/**
 * The app refused a request. `code` says what kind of refusal it is (see
 * {@link ERROR_CODES}); most are arguments that are not allowed, the default.
 */
export class DocError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ErrorCode = "INVALID_ARGUMENT",
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocError";
    this.code = code;
    this.details = details;
  }
}

/** An error of any kind as {@link ErrorInfo}: a DocError says its own; anything else is the app's fault. */
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof DocError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message, details: {} };
}

/** The Python class of each code (`op.NotFoundError`, ...): the name the history gives an error. */
export const ERROR_CLASSES: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "InvalidArgumentError",
  NOT_FOUND: "NotFoundError",
  ALREADY_EXISTS: "AlreadyExistsError",
  IN_USE: "InUseError",
  CONFLICT: "ConflictError",
  UNSUPPORTED: "UnsupportedError",
  PLUGIN_FAILED: "PluginFailedError",
  INTERNAL: "InternalError",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The argument or property an error is about (`details.field`), or null: a
 * value not allowed there, or a wave named there that is not to be found.
 * A name that is taken (ALREADY_EXISTS) is about the name.
 */
export function errorField(error: unknown): string | null {
  if (!(error instanceof DocError)) return null;
  const field = error.details.field;
  if (typeof field === "string" && field !== "") return field;
  return error.code === "ALREADY_EXISTS" ? "name" : null;
}

/**
 * A run that was stopped (interrupted, or its plugin stopped) before it
 * ended. It is not a failure, so it has no {@link ErrorCode}: the history
 * marks it as stopped, and a dialog that started it says nothing went wrong.
 */
export class CancelledError extends Error {
  constructor(message = "Stopped.") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

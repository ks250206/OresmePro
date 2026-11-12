import init, {
  PositionEncoding,
  Workspace,
  type Diagnostic as RuffDiagnostic,
  type InitInput,
} from "@astral-sh/ruff-wasm-web";
import {
  definedElsewhere,
  DEFAULT_LINE_LENGTH,
  LINT_IGNORE,
  LINT_SELECT,
  PREDEFINED,
  SAFE_FIXES,
  type FormatResult,
  type Problem,
  type Severity,
} from "./ruffSettings";

/** Where this module was loaded from, for keeping it offline: it is loaded only when needed. */
export const MODULE_URL = import.meta.url;

const SYNTAX = "invalid-syntax";

/** Offsets of the start of each line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

function offsetOf(starts: readonly number[], length: number, row: number, column: number): number {
  const start = starts[Math.min(Math.max(row, 1), starts.length) - 1]!;
  return Math.min(start + Math.max(column, 1) - 1, length);
}

function severityOf(diagnostic: RuffDiagnostic, code: string): Severity {
  // Errors are what stops the file from running at all.
  if (code === SYNTAX || code.startsWith("E9") || /^F70[1-7]$/.test(code)) return "error";
  if (diagnostic.tags.includes("unnecessary")) return "hint";
  return "warning";
}

/**
 * Ruff, compiled to WebAssembly: the linter and the formatter of procedure
 * windows. Settings are fixed when a Ruff workspace is made, so one is kept
 * for each set of settings in use.
 */
export class Ruff {
  readonly version: string;
  readonly #workspaces = new Map<string, Workspace>();

  private constructor() {
    this.version = Workspace.version();
  }

  /** Loads the WebAssembly module, from a URL or from its bytes. */
  static async load(wasm: InitInput | Promise<InitInput>): Promise<Ruff> {
    await init({ module_or_path: wasm });
    return new Ruff();
  }

  #workspace(settings: Record<string, unknown>): Workspace {
    const key = JSON.stringify(settings);
    let workspace = this.#workspaces.get(key);
    if (workspace) {
      // Most recently used last.
      this.#workspaces.delete(key);
    } else {
      workspace = new Workspace(settings, PositionEncoding.Utf16);
      if (this.#workspaces.size >= 4) {
        const [oldest, stale] = this.#workspaces.entries().next().value!;
        this.#workspaces.delete(oldest);
        stale.free();
      }
    }
    this.#workspaces.set(key, workspace);
    return workspace;
  }

  /** The problems in a file, in the order of the text. */
  check(text: string): Problem[] {
    const builtins = [...PREDEFINED, ...definedElsewhere(text)].sort();
    const workspace = this.#workspace({
      builtins,
      lint: { select: LINT_SELECT, ignore: LINT_IGNORE, fixable: SAFE_FIXES },
    });
    const diagnostics = workspace.check(text) as RuffDiagnostic[];
    const starts = lineStarts(text);
    const at = (location: { row: number; column: number }) =>
      offsetOf(starts, text.length, location.row, location.column);
    const problems = diagnostics.map((diagnostic): Problem => {
      const code = diagnostic.code ?? SYNTAX;
      const from = at(diagnostic.start_location);
      const to = Math.max(from, at(diagnostic.end_location));
      const fix =
        diagnostic.fix && diagnostic.fix.edits.length > 0
          ? {
              title: diagnostic.fix.message ?? "Fix",
              changes: diagnostic.fix.edits.map((edit) => ({
                from: at(edit.location),
                to: at(edit.end_location),
                insert: edit.content ?? "",
              })),
            }
          : null;
      return {
        from,
        to,
        line: diagnostic.start_location.row,
        column: diagnostic.start_location.column,
        severity: severityOf(diagnostic, code),
        code,
        message: diagnostic.message,
        fix,
        undefinedName: code === "F821" ? text.slice(from, to) : null,
      };
    });
    return problems.sort((a, b) => a.from - b.from || a.to - b.to);
  }

  /**
   * The file as Ruff formats it. A file that does not parse is not
   * formatted; the result says where the first syntax error is.
   */
  format(text: string, lineLength = DEFAULT_LINE_LENGTH): FormatResult {
    try {
      return { ok: true, text: this.#workspace({ "line-length": lineLength }).format(text) };
    } catch (error) {
      const syntax = this.check(text).find((problem) => problem.code === SYNTAX);
      if (syntax) {
        return {
          ok: false,
          message: `Syntax error on line ${syntax.line}: ${syntax.message}`,
          line: syntax.line,
          column: syntax.column,
        };
      }
      return { ok: false, message: String(error), line: null, column: null };
    }
  }
}

// How procedures are linted and formatted, and what can be worked out about
// it without Ruff itself, which is loaded only when a procedure window opens
// (see ruff.ts).

/**
 * Names a procedure can use without defining them: what the app imports
 * into Python's namespace (see src/kernel/python/oresme_kernel.py), and what
 * IPython adds to the builtins while code runs.
 */
export const PREDEFINED: readonly string[] = ["np", "op", "display", "get_ipython"];

/**
 * Ruff's rules for mistakes, not for style: syntax errors, undefined and
 * unused names, comparisons and escapes that do not do what they look like.
 * Left out are those that only have an opinion on how a script is laid out
 * (imports in the middle of a script, `l` as a name, `lambda` assigned to a
 * name, several statements on a line), which a scientist's script has every
 * right to do, and `x == None` and `x == True`, which are what one writes for
 * NumPy arrays. With a star import, names that may come from it are not
 * reported one by one: the import itself says that names cannot be checked.
 */
export const LINT_SELECT: readonly string[] = ["E4", "E7", "E9", "F", "W6"];
export const LINT_IGNORE: readonly string[] = [
  "E401",
  "E402",
  "E701",
  "E702",
  "E703",
  "E711",
  "E712",
  "E731",
  "E741",
  "F405",
];

/**
 * Rules whose fixes Ruff counts as safe: they never change what the code
 * does. Ruff's WebAssembly build does not say which fixes are safe, so the
 * others (removing an unused variable whose value has side effects, say) are
 * not offered.
 */
export const SAFE_FIXES: readonly string[] = ["F401", "F541", "W605", "E713", "E714"];

export const DEFAULT_LINE_LENGTH = 88;

export type Severity = "error" | "warning" | "info" | "hint";

/** A replacement of the text from `from` to `to`, in UTF-16 offsets as JavaScript counts them. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface Problem {
  from: number;
  to: number;
  /** 1-based, for messages. */
  line: number;
  column: number;
  severity: Severity;
  /** Ruff's rule code, or "invalid-syntax". */
  code: string;
  message: string;
  fix: { title: string; changes: TextChange[] } | null;
  /** For an undefined name, the name. */
  undefinedName: string | null;
}

export type FormatResult =
  | { ok: true; text: string }
  | { ok: false; message: string; line: number | null; column: number | null };

const DIRECTIVE = /^[ \t]*#[ \t]*defined elsewhere:(.*)$/gim;
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/**
 * The names a file says are defined elsewhere, in comments such as
 * `# defined elsewhere: fit_peaks, data`: what another procedure or the
 * command line defines, which no linter can see.
 */
export function definedElsewhere(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(DIRECTIVE)) {
    for (const name of match[1]!.split(/[\s,]+/)) {
      if (IDENTIFIER.test(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The change that adds a name to the file's `# defined elsewhere:` comment, starting one if need be. */
export function addDefinedElsewhere(text: string, name: string): TextChange {
  DIRECTIVE.lastIndex = 0;
  const match = DIRECTIVE.exec(text);
  DIRECTIVE.lastIndex = 0;
  if (!match) return { from: 0, to: 0, insert: `# defined elsewhere: ${name}\n` };
  const end = match.index + match[0].replace(/\s+$/, "").length;
  const listed = match[1]!.trim();
  return { from: end, to: end, insert: listed ? `, ${name}` : ` ${name}` };
}

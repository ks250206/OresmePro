import {
  acceptCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { indentLess, indentMore, isolateHistory } from "@codemirror/commands";
import { globalCompletion, localCompletionSource } from "@codemirror/lang-python";
import { getIndentUnit } from "@codemirror/language";
import { type Action, type Diagnostic, forceLinting, type LintSource } from "@codemirror/lint";
import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { kernel } from "../app/session";
import { diffText } from "./diff";
import { loadRuff } from "./loadRuff";
import { addDefinedElsewhere, DEFAULT_LINE_LENGTH, type Problem } from "./ruffSettings";

/** Indentation levels with a guide drawn for them; deeper ones draw these. */
const GUIDE_LEVELS = 8;

/** The indentation level of a line, or null for a blank line. */
function levelOf(text: string, unit: number): number | null {
  const indent = /^ */.exec(text)![0].length;
  return indent === text.length ? null : Math.floor(indent / unit);
}

/**
 * Faint vertical lines at each level of indentation, so that what belongs to
 * which block can be seen down a long function. A blank line takes the
 * guides of the lines around it, so that they do not break at a gap.
 */
export const indentationGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }

    build(view: EditorView): DecorationSet {
      const { doc } = view.state;
      const unit = getIndentUnit(view.state);
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pending: number[] = [];
        let previous = 0;
        for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number += 1) {
          const line = doc.line(number);
          const level = levelOf(line.text, unit);
          if (level === null) {
            pending.push(line.from);
            continue;
          }
          // Blank lines between two lines take the guides both have.
          const blank = Math.min(previous, level);
          for (const start of pending) add(builder, start, blank);
          pending = [];
          add(builder, line.from, level);
          previous = level;
        }
        for (const start of pending) add(builder, start, 0);
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const guideMarks = Array.from({ length: GUIDE_LEVELS + 1 }, (_, level) =>
  Decoration.line({ class: `cm-indent-${level}` }),
);

function add(builder: RangeSetBuilder<Decoration>, at: number, level: number) {
  if (level > 0) builder.add(at, at, guideMarks[Math.min(level, GUIDE_LEVELS)]!);
}

/** Tab indents: at the cursor, to the next stop; with a selection, the lines it covers. */
export function indentWithTab(view: EditorView): boolean {
  if (acceptCompletion(view)) return true;
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  const unit = getIndentUnit(state);
  view.dispatch(
    state.changeByRange((range) => {
      const column = range.head - state.doc.lineAt(range.head).from;
      const insert = " ".repeat(unit - (column % unit));
      return {
        changes: { from: range.head, insert },
        range: EditorSelection.cursor(range.head + insert.length),
      };
    }),
    { userEvent: "input.indent", scrollIntoView: true },
  );
  return true;
}

export { indentLess };

const COMPLETION_TYPES: Record<string, string> = {
  function: "function",
  class: "class",
  module: "namespace",
  instance: "variable",
  statement: "variable",
  keyword: "keyword",
  attribute: "property",
  variable: "variable",
};

/**
 * Completion in a procedure: names Python knows (what the procedures and the
 * command line have defined, members of `op.` and of modules), together with
 * the names of this file and Python's keywords and builtins, which are there
 * even before Python has started. Only the line is sent to Python: the rest
 * of the file is not something it has run.
 */
export async function completePython(context: CompletionContext): Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  // While typing, offer names once a word is under way or after a dot.
  if (!context.explicit && !/(?:[A-Za-z_]\w|\.\w*)$/.test(before)) return null;
  const local = [
    localCompletionSource(context),
    globalCompletion(context) as CompletionResult | null,
  ].filter((result): result is CompletionResult => result !== null);
  const items = await kernel.complete(line.text, context.pos - line.from);
  if (context.aborted) return null;
  const first = items[0];
  const word = context.matchBefore(/\w*$/)!;
  const options = new Map<string, Completion>();
  let from = word.from;
  if (first) {
    from = line.from + first.start;
    for (const item of items) {
      if (item.start !== first.start || options.has(item.text)) continue;
      options.set(item.text, {
        label: item.text,
        type: COMPLETION_TYPES[item.type] ?? "variable",
        boost: 1,
      });
    }
  }
  for (const result of local) {
    if (result.from !== from) continue;
    for (const option of result.options) {
      if (!options.has(option.label)) options.set(option.label, option);
    }
  }
  if (options.size === 0) return null;
  return { from, options: [...options.values()], validFor: /^\w*$/ };
}

const LINE_LENGTH_KEY = "oresme.lineLength";
export const LINE_LENGTHS: readonly number[] = [79, 88, 100, 120];

/** The line length the formatter wraps at, a preference of this browser. */
export function lineLength(): number {
  try {
    const stored = Number(localStorage.getItem(LINE_LENGTH_KEY));
    return LINE_LENGTHS.includes(stored) ? stored : DEFAULT_LINE_LENGTH;
  } catch {
    return DEFAULT_LINE_LENGTH;
  }
}

export function setLineLength(length: number): void {
  try {
    localStorage.setItem(LINE_LENGTH_KEY, String(length));
  } catch {
    // Without storage it lasts as long as nothing: the default is used.
  }
}

/** What the linter is doing, for the status line. */
export type LintStatus =
  | { kind: "loading" }
  | { kind: "ready"; version: string }
  | { kind: "failed"; reason: string };

function toDiagnostic(problem: Problem): Diagnostic {
  const actions: Action[] = [];
  const { fix, undefinedName } = problem;
  if (fix) {
    actions.push({
      name: "Fix",
      apply: (view, from) => {
        // The fix was worked out on the text as it was; edits since have moved it.
        const shift = from - problem.from;
        const length = view.state.doc.length;
        const changes = fix.changes.map((change) => ({
          from: Math.min(Math.max(change.from + shift, 0), length),
          to: Math.min(Math.max(change.to + shift, 0), length),
          insert: change.insert,
        }));
        view.dispatch({ changes, userEvent: "input.fix", scrollIntoView: true });
      },
    });
  }
  if (undefinedName) {
    actions.push({
      name: "Defined elsewhere",
      apply: (view) => {
        view.dispatch({
          changes: addDefinedElsewhere(view.state.doc.toString(), undefinedName),
          userEvent: "input.fix",
        });
      },
    });
  }
  return {
    from: problem.from,
    to: problem.to,
    severity: problem.severity,
    source: problem.code === "invalid-syntax" ? "syntax" : problem.code,
    message:
      problem.code === "F821"
        ? `${problem.message}. If another procedure or the command line defines it, say so with “Defined elsewhere”.`
        : problem.message,
    markClass: problem.severity === "hint" ? "cm-unnecessary" : undefined,
    actions,
  };
}

/** Lints with Ruff, loading it the first time; tells `status` how that goes. */
export function ruffLinter(status: (status: LintStatus) => void): LintSource {
  let reported = false;
  return async (view) => {
    try {
      const ruff = await loadRuff();
      if (!reported) status({ kind: "ready", version: ruff.version });
      reported = true;
      return ruff.check(view.state.doc.toString()).map(toDiagnostic);
    } catch (error) {
      if (!reported) status({ kind: "failed", reason: String(error) });
      reported = true;
      return [];
    }
  };
}

/**
 * Replaces the text with Ruff's formatting of it, as one step of the
 * editor's undo. Only what changes is replaced, so the cursor stays where
 * it was in the lines that do not. Resolves to a message for the status
 * line: why the text was left alone, or null.
 */
export async function formatDocument(view: EditorView): Promise<string | null> {
  let ruff;
  try {
    ruff = await loadRuff();
  } catch (error) {
    return `Not formatted: the formatter could not be loaded (${String(error)}).`;
  }
  const text = view.state.doc.toString();
  const result = ruff.format(text, lineLength());
  if (!result.ok) return `Not formatted. ${result.message}`;
  const changes = diffText(text, result.text);
  if (changes.length === 0) return "Already formatted.";
  view.dispatch({
    changes,
    userEvent: "input.format",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
  forceLinting(view);
  return null;
}

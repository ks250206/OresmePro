import { redoDepth, undoDepth } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";

/** Removes the indentation that all the lines with text have in common, as textwrap.dedent does. */
export function dedent(text: string): string {
  const lines = text.split("\n");
  let common: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)![0];
    if (common === null) common = indent;
    else {
      let length = 0;
      while (length < common.length && common[length] === indent[length]) length += 1;
      common = common.slice(0, length);
    }
  }
  if (!common) return text;
  return lines.map((line) => (line.startsWith(common) ? line.slice(common.length) : "")).join("\n");
}

/**
 * The code that Run Selection runs: the selection, or the line the cursor is
 * on. A selection over several lines runs those lines whole, so that a block
 * picked out roughly still parses, and without the indentation they share,
 * so that the body of a loop or a function can be tried on its own. Several
 * selections (each dedented on its own) run one after the other.
 */
export function codeToRun(state: EditorState): string {
  const { doc } = state;
  const parts = state.selection.ranges.map((range) => {
    const first = doc.lineAt(range.from);
    if (range.empty) return first.text;
    // A selection that ends at the start of a line does not take that line.
    const last = doc.lineAt(
      range.to > first.to && range.to === doc.lineAt(range.to).from ? range.to - 1 : range.to,
    );
    if (first.number === last.number) return doc.sliceString(range.from, range.to);
    return doc.sliceString(first.from, last.to);
  });
  return parts
    .map((part) =>
      dedent(part)
        .replace(/^(?:[ \t]*\n)+/, "")
        .replace(/\s+$/, ""),
    )
    .filter(Boolean)
    .join("\n");
}

/** What the editing commands of a context menu can do in an editor, for enabling them. */
export interface EditMenuState {
  canUndo: boolean;
  canRedo: boolean;
  /** Some text is selected: Cut and Copy have something to act on. */
  hasSelection: boolean;
  /** There is text, so Select All and Format Document have something to act on. */
  hasText: boolean;
  /** Run Selection would run something. */
  canRunSelection: boolean;
}

export function editMenuState(state: EditorState): EditMenuState {
  return {
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    hasSelection: state.selection.ranges.some((range) => !range.empty),
    hasText: state.doc.length > 0,
    canRunSelection: codeToRun(state) !== "",
  };
}

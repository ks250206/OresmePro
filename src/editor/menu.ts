import { redo, selectAll, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { isMac, type MenuItem } from "../app/session";
import { openContextMenu } from "../ui/Menu";
import { editMenuState } from "./commands";

/** The editor that has the keyboard focus, if one has. */
export function focusedEditor(): EditorView | null {
  const element = document.activeElement?.closest(".cm-editor");
  return element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
}

/**
 * Undo and Redo of the Edit menu: in an editor that has the focus, its
 * typing, as its keys do; elsewhere, the document.
 */
export const editorUndo = (): boolean => {
  const view = focusedEditor();
  return view ? (undo(view), true) : false;
};
export const editorRedo = (): boolean => {
  const view = focusedEditor();
  return view ? (redo(view), true) : false;
};

/** A shortcut as it is written in menus on this platform. */
export const keys = (mac: string, other: string): string => (isMac ? mac : other);

/**
 * Copies or cuts the selection. The browser's own command is tried first:
 * it goes through CodeMirror's copy and cut handlers (which copy the whole
 * line when nothing is selected) and needs no permission while a menu item
 * is being clicked. The clipboard API is the way left where it is refused.
 */
function copy(view: EditorView, cut: boolean, report: (message: string) => void): void {
  view.focus();
  if (document.execCommand(cut ? "cut" : "copy")) return;
  const { state } = view;
  const text = state.selection.ranges
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
  if (!navigator.clipboard) {
    report(`The browser did not allow copying from the menu: press ${keys("⌘C", "Ctrl+C")}.`);
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      if (cut) view.dispatch(state.replaceSelection(""), { userEvent: "delete.cut" });
    },
    () => report(`The browser did not allow copying from the menu: press ${keys("⌘C", "Ctrl+C")}.`),
  );
}

/** Whether the page may be able to read the clipboard: some browsers ask the user first. */
export const canReadClipboard = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

/**
 * Pastes what is on the clipboard, read with the clipboard API. Browsers
 * ask before letting a page read it (Chrome once per site, Firefox and
 * Safari with a Paste button each time); where it is refused or not
 * available, the keyboard shortcut still works and the message says so.
 */
async function paste(view: EditorView, report: (message: string) => void): Promise<void> {
  const refused = `The browser did not let the page read the clipboard: press ${keys("⌘V", "Ctrl+V")} to paste.`;
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    report(refused);
    return;
  }
  view.focus();
  view.dispatch(view.state.replaceSelection(text), {
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

/** Undo, Redo, Cut, Copy, Paste and Select All, for an editor's context menu. */
export function editingItems(view: EditorView, report: (message: string) => void): MenuItem[] {
  const state = editMenuState(view.state);
  return [
    {
      label: "Undo",
      shortcut: keys("⌘Z", "Ctrl+Z"),
      disabled: !state.canUndo,
      onSelect: () => undo(view),
    },
    {
      label: "Redo",
      shortcut: keys("⇧⌘Z", "Ctrl+Y"),
      disabled: !state.canRedo,
      onSelect: () => redo(view),
    },
    { separator: true },
    {
      label: "Cut",
      shortcut: keys("⌘X", "Ctrl+X"),
      disabled: !state.hasSelection,
      onSelect: () => copy(view, true, report),
    },
    {
      label: "Copy",
      shortcut: keys("⌘C", "Ctrl+C"),
      disabled: !state.hasSelection,
      onSelect: () => copy(view, false, report),
    },
    {
      label: "Paste",
      shortcut: keys("⌘V", "Ctrl+V"),
      disabled: !canReadClipboard(),
      onSelect: () => void paste(view, report),
    },
    {
      label: "Select All",
      shortcut: keys("⌘A", "Ctrl+A"),
      disabled: !state.hasText,
      onSelect: () => selectAll(view),
    },
  ];
}

/**
 * Right-clicking in an editor: the cursor goes to the click unless it is in
 * the selection, which is kept for the menu to act on, as in other editors.
 * The browser is kept from moving the caret itself.
 */
export const rightClickKeepsSelection = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 2) return false;
    event.preventDefault();
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const inside = view.state.selection.ranges.some(
      (range) => at !== null && range.from <= at && at <= range.to,
    );
    if (at !== null && !inside) view.dispatch({ selection: { anchor: at } });
    view.focus();
    return true;
  },
});

/**
 * Opens the app's context menu for an editor in place of the browser's.
 * The fields of a search panel keep the browser's menu, as other text
 * fields do. A menu asked for from the keyboard opens at the cursor.
 */
export function openEditorMenu(
  event: { clientX: number; clientY: number; target: EventTarget; preventDefault(): void },
  view: EditorView | null,
  items: (view: EditorView) => MenuItem[],
): void {
  if (!view || (event.target as Element).closest?.("input, textarea, select")) return;
  event.preventDefault();
  if (!view.hasFocus) view.focus();
  let position = { clientX: event.clientX, clientY: event.clientY };
  if (event.clientX === 0 && event.clientY === 0) {
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords) position = { clientX: coords.left, clientY: coords.bottom };
  }
  openContextMenu(position, items(view));
}

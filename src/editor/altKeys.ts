import { EditorView } from "@codemirror/view";

/** A shortcut with Alt (Option on a Mac), by the place of its key: "KeyF" for F. */
export interface AltKey {
  code: string;
  shift?: boolean;
  run: (view: EditorView) => boolean;
}

/** The binding a key event is for: Alt, perhaps Shift, and no Ctrl or ⌘. */
export function altKeyFor(
  bindings: readonly AltKey[],
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "code">,
): AltKey | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey) return undefined;
  return bindings.find(
    (binding) => binding.code === event.code && Boolean(binding.shift) === event.shiftKey,
  );
}

/**
 * Shortcuts with Alt, matched by the key's place rather than by what it types.
 * On a Mac, Option+F types "ƒ" (Shift+Option+F "Ï"), and CodeMirror's
 * keymap then never sees an F: "Alt-f" works on Windows and Linux only.
 */
export function altKeys(bindings: readonly AltKey[]) {
  return EditorView.domEventHandlers({
    keydown(event, view) {
      const binding = altKeyFor(bindings, event);
      if (!binding?.run(view)) return false;
      event.preventDefault();
      return true;
    },
  });
}

import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  completionStatus,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history as editHistory,
  historyKeymap,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { history, kernel, ui, useUi } from "../app/session";
import { recallList, stepRecall, suggestCompletion } from "../core/history/history";
import { isCompleteInput } from "../core/history/inputState";

/** Marks edits made by history recall, so they do not end the recall. */
const fromRecall = Annotation.define<boolean>();

let cachedEntries: unknown = null;
let cachedCommands: string[] = [];
/** The recallable commands, recomputed only when the history changes. */
function commands(): string[] {
  const entries = history.getEntries();
  if (entries !== cachedEntries) {
    cachedEntries = entries;
    cachedCommands = recallList(entries);
  }
  return cachedCommands;
}

class GhostText extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  override eq(other: GhostText): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The greyed-out remainder of the latest matching command, when the cursor is at the end. */
function suggestionFor(state: EditorState): string {
  const { main } = state.selection;
  if (!main.empty || main.head !== state.doc.length) return "";
  return suggestCompletion(commands(), state.doc.toString());
}

const ghost = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const text = view.hasFocus ? suggestionFor(view.state) : "";
      if (!text) return Decoration.none;
      return Decoration.set(
        Decoration.widget({ widget: new GhostText(text), side: 1 }).range(view.state.doc.length),
      );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function acceptSuggestion(view: EditorView, wordOnly: boolean): boolean {
  const text = suggestionFor(view.state);
  if (!text) return false;
  const insert = wordOnly ? (/^\s*\S+?(?=\b|\s|$)\W*/.exec(text)?.[0] ?? text) : text;
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
  return true;
}

const COMPLETION_TYPES: Record<string, string> = {
  function: "function",
  class: "class",
  module: "namespace",
  instance: "variable",
  statement: "variable",
  keyword: "keyword",
  magic: "keyword",
  path: "text",
  attribute: "property",
  variable: "variable",
};

async function completeFromPython(context: CompletionContext): Promise<CompletionResult | null> {
  if (!context.explicit) return null;
  const items = await kernel.complete(context.state.doc.toString(), context.pos);
  const first = items[0];
  if (!first || context.aborted) return null;
  return {
    from: first.start,
    to: first.end,
    options: items
      .filter((item) => item.start === first.start)
      .map((item) => ({ label: item.text, type: COMPLETION_TYPES[item.type] ?? "variable" })),
    validFor: /^[\w%]*$/,
  };
}

export interface CommandLineProps {
  onOpenSearch: (query: string) => void;
}

/**
 * The command line: a CodeMirror editor with shell-style history. Up/Down
 * recall commands starting with what is typed, the latest match is offered
 * as greyed-out text, and Enter runs the input once it is a complete
 * statement.
 */
export function CommandLine({ onOpenSearch }: CommandLineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const openSearch = useRef(onOpenSearch);
  openSearch.current = onOpenSearch;
  const insert = useUi((state) => state.commandLineInsert);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    // Position in the recall list while stepping with Up/Down.
    let recall: { index: number; prefix: string; draft: string } | null = null;

    const setText = (view: EditorView, text: string, recalled: boolean) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
        annotations: recalled ? fromRecall.of(true) : undefined,
        scrollIntoView: true,
      });
    };

    const step = (view: EditorView, direction: -1 | 1): boolean => {
      if (view.composing || completionStatus(view.state) === "active") return false;
      const { doc, selection } = view.state;
      const line = doc.lineAt(selection.main.head).number;
      if (!recall && (direction === -1 ? line !== 1 : line !== doc.lines)) return false;
      const list = commands();
      const text = doc.toString();
      recall ??= { index: list.length, prefix: text, draft: text };
      const next = stepRecall(list, recall.prefix, recall.index, direction);
      if (next === null) {
        if (direction === 1) {
          // Past the newest entry: back to what was being typed.
          setText(view, recall.draft, false);
          recall = null;
        }
        return true;
      }
      recall.index = next;
      setText(view, list[next]!, true);
      return true;
    };

    const submit = (view: EditorView): boolean => {
      const code = view.state.doc.toString().replace(/\s+$/, "");
      if (!code) return true;
      kernel.execute(code);
      setText(view, "", false);
      recall = null;
      return true;
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          editHistory(),
          python(),
          syntaxHighlighting(classHighlighter),
          bracketMatching(),
          closeBrackets(),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          EditorView.lineWrapping,
          placeholder(
            "Python — Enter to run, Shift+Enter for a new line, Ctrl+R to search history",
          ),
          autocompletion({ override: [completeFromPython], activateOnTyping: false, icons: false }),
          ghost,
          EditorView.updateListener.of((update) => {
            // Editing or moving the cursor ends recall; until then Up/Down keep
            // stepping through history even inside a multi-line entry.
            const recalled = update.transactions.some((tr) => tr.annotation(fromRecall));
            if ((update.docChanged || update.selectionSet) && !recalled) recall = null;
          }),
          Prec.high(
            keymap.of([
              {
                key: "Enter",
                run: (target) => {
                  if (target.composing) return false;
                  const { doc, selection } = target.state;
                  const atEnd = selection.main.empty && selection.main.head === doc.length;
                  if ((atEnd || doc.lines === 1) && isCompleteInput(doc.toString())) {
                    return submit(target);
                  }
                  return insertNewlineAndIndent(target);
                },
              },
              { key: "Mod-Enter", run: submit },
              { key: "Shift-Enter", run: insertNewlineAndIndent },
              { key: "ArrowUp", run: (target) => step(target, -1) },
              { key: "ArrowDown", run: (target) => step(target, 1) },
              { key: "Ctrl-p", run: (target) => step(target, -1) },
              { key: "Ctrl-n", run: (target) => step(target, 1) },
              { key: "ArrowRight", run: (target) => acceptSuggestion(target, false) },
              { key: "End", run: (target) => acceptSuggestion(target, false) },
              { key: "Ctrl-e", run: (target) => acceptSuggestion(target, false) },
              { key: "Ctrl-ArrowRight", run: (target) => acceptSuggestion(target, true) },
              { key: "Alt-ArrowRight", run: (target) => acceptSuggestion(target, true) },
              { key: "Alt-f", run: (target) => acceptSuggestion(target, true) },
              {
                key: "Tab",
                run: (target) => {
                  if (acceptCompletion(target)) return true;
                  const { head } = target.state.selection.main;
                  const line = target.state.doc.lineAt(head);
                  if (line.text.slice(0, head - line.from).trim() === "") {
                    target.dispatch(target.state.replaceSelection("    "));
                    return true;
                  }
                  return startCompletion(target);
                },
              },
              {
                key: "Ctrl-r",
                preventDefault: true,
                run: (target) => {
                  openSearch.current(target.state.doc.toString());
                  return true;
                },
              },
              {
                key: "Ctrl-c",
                run: (target) => {
                  // With a selection this is Copy; otherwise it interrupts, as in a shell.
                  if (!target.state.selection.main.empty) return false;
                  if (kernel.getState().status !== "busy") return false;
                  kernel.interruptExecution();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          EditorView.contentAttributes.of({ "aria-label": "Command line" }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Text sent from elsewhere (history, search) replaces the input.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !insert) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: insert.text },
      selection: { anchor: insert.text.length },
    });
    view.focus();
    ui.set({ commandLineInsert: null });
  }, [insert]);

  return (
    <div
      className="flex min-h-0 shrink-0 items-start border-t border-line bg-paper"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) viewRef.current?.focus();
      }}
    >
      <span className="select-none py-[5px] pl-2 pr-1.5 font-mono text-[12.5px] leading-[1.45] text-accent">
        {">>>"}
      </span>
      <div ref={hostRef} className="selectable min-w-0 flex-1" />
    </div>
  );
}

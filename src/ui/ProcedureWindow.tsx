import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history as editHistory,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  toggleComment,
  undo,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeLintPanel,
  diagnosticCount,
  lintGutter,
  linter,
  lintKeymap,
  openLintPanel,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../app/store";
import {
  doc,
  kernel,
  procedureRuns,
  runProcedure,
  useDoc,
  useKernelState,
  type MenuItem,
} from "../app/session";
import { codeToRun, editMenuState } from "../editor/commands";
import { diffText } from "../editor/diff";
import {
  completePython,
  formatDocument,
  indentationGuides,
  indentWithTab,
  LINE_LENGTHS,
  lineLength,
  ruffLinter,
  setLineLength,
  type LintStatus,
} from "../editor/extensions";
import { loadRuff } from "../editor/loadRuff";
import { editingItems, keys, openEditorMenu, rightClickKeepsSelection } from "../editor/menu";
import { Button, Checkbox } from "./controls";

/** Marks changes that came from the document, so they are not sent back to it. */
const fromDocument = Annotation.define<boolean>();

/** CodeMirror's words in its panels, written as the rest of the app writes its buttons. */
const PHRASES = {
  next: "Next",
  previous: "Previous",
  all: "Select All",
  "match case": "Match case",
  regexp: "Regular expression",
  "by word": "Whole words",
  replace: "Replace",
  "replace all": "Replace All",
  close: "Close",
  go: "Go",
  Diagnostics: "Problems",
  "No diagnostics": "No problems",
};

const FORMAT_KEYS = keys("⇧⌥F", "Shift+Alt+F");
const RUN_KEYS = keys("⌘↩", "Ctrl+Enter");
const RUN_SELECTION_KEYS = keys("⇧↩", "Shift+Enter");

/**
 * A procedure window: a Python file that belongs to the experiment, the
 * counterpart of Igor's procedure windows. The text is kept in the document
 * as it is typed, so it is saved with everything else.
 *
 * The editor and its undo history last as long as the procedure: one that
 * goes away (closed, or its creation undone) and comes back, or a new one
 * under the same name, gets a new editor, never the old one's history.
 */
export function ProcedureWindow({ name }: { name: string }) {
  const exists = useDoc((state) => Object.hasOwn(state.procedures, name));
  const [generation, setGeneration] = useState(0);
  const [shown, setShown] = useState(exists);
  if (exists !== shown) {
    setShown(exists);
    if (!exists) setGeneration(generation + 1);
  }
  if (!exists) return null;
  return <ProcedureEditor key={generation} name={name} />;
}

interface Status {
  line: number;
  column: number;
  problems: number;
}

function ProcedureEditor({ name }: { name: string }) {
  const procedure = useDoc((state) => state.procedures[name]!);
  const ranCode = useStore(procedureRuns, (state) => state.code[name]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The text the editor and the document last agreed on.
  const synced = useRef(procedure.code);
  const kernelStatus = useKernelState().status;
  const canRun = kernelStatus === "ready" || kernelStatus === "busy" || kernelStatus === "starting";
  const [status, setStatus] = useState<Status>({ line: 1, column: 1, problems: 0 });
  const [lint, setLint] = useState<LintStatus>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);

  const run = () => {
    runProcedure(name);
  };
  /** Runs the selection, or the line the cursor is on, as if typed in the command line. */
  const runSelection = (view: EditorView): boolean => {
    const code = codeToRun(view.state);
    if (code) kernel.execute(code);
    return true;
  };
  const format = (view: EditorView): boolean => {
    void formatDocument(view).then(setMessage);
    return true;
  };
  const actions = useRef({ run, runSelection, format });
  actions.current = { run, runSelection, format };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // Start fetching the linter now rather than when the first lint is due.
    loadRuff().catch(() => {});
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: synced.current,
        extensions: [
          lineNumbers(),
          foldGutter(),
          lintGutter(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          editHistory(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          python(),
          syntaxHighlighting(classHighlighter),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ override: [completePython], icons: false }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          linter(ruffLinter(setLint), { delay: 400 }),
          indentationGuides,
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          rightClickKeepsSelection,
          EditorView.updateListener.of((update) => {
            const { state } = update;
            if (update.docChanged) {
              const external = update.transactions.some((tr) => tr.annotation(fromDocument));
              if (!external) {
                synced.current = state.doc.toString();
                doc.dispatch({ op: "setProcedure", name, code: synced.current });
                setMessage(null);
              }
            }
            const linted = update.transactions.some((tr) =>
              tr.effects.some((effect) => effect.is(setDiagnosticsEffect)),
            );
            if (update.docChanged || update.selectionSet || linted) {
              const { head } = state.selection.main;
              const line = state.doc.lineAt(head);
              setStatus({
                line: line.number,
                column: head - line.from + 1,
                problems: diagnosticCount(state),
              });
            }
          }),
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  actions.current.run();
                  return true;
                },
              },
              { key: "Shift-Enter", run: (target) => actions.current.runSelection(target) },
              {
                key: "Shift-Alt-f",
                run: (target) => actions.current.format(target),
                preventDefault: true,
              },
              // Ctrl+G as in VS Code on Windows and Linux (on a Mac, ⌘G stays Find Next).
              { key: "Ctrl-g", run: gotoLine, preventDefault: true },
              { key: "Alt-g", run: gotoLine, preventDefault: true },
              // Tab indents. Escape then Tab leaves the editor, as CodeMirror provides.
              { key: "Tab", run: indentWithTab, shift: indentLess },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
          ]),
          EditorState.phrases.of(PHRASES),
          EditorView.contentAttributes.of({ "aria-label": `${name}.py` }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [name]);

  // Text set from elsewhere (Python's p.code = ..., a script added from a
  // dialog) replaces what the editor shows. Only what differs is replaced,
  // so the cursor stays where it was, and it can be undone like an edit.
  const code = procedure.code;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || code === synced.current) return;
    const changes = diffText(view.state.doc.toString(), code);
    synced.current = code;
    view.dispatch({ changes, annotations: fromDocument.of(true) });
  }, [code]);

  const menuItems = (view: EditorView): MenuItem[] => {
    const state = editMenuState(view.state);
    const length = lineLength();
    return [
      ...editingItems(view, setMessage),
      { separator: true },
      {
        label: "Comment/Uncomment Lines",
        shortcut: keys("⌘/", "Ctrl+/"),
        onSelect: () => toggleComment(view),
      },
      { label: "Indent Lines", shortcut: keys("⌘]", "Ctrl+]"), onSelect: () => indentMore(view) },
      { label: "Outdent Lines", shortcut: keys("⌘[", "Ctrl+["), onSelect: () => indentLess(view) },
      {
        label: "Format Document",
        shortcut: FORMAT_KEYS,
        disabled: !state.hasText || lint.kind === "failed",
        onSelect: () => format(view),
      },
      {
        label: "Line Length for Formatting",
        submenu: LINE_LENGTHS.map((value) => ({
          label: String(value),
          checked: value === length,
          onSelect: () => setLineLength(value),
        })),
      },
      { separator: true },
      {
        label: "Find and Replace…",
        shortcut: keys("⌘F", "Ctrl+F"),
        onSelect: () => openSearchPanel(view),
      },
      { label: "Go to Line…", shortcut: keys("⌃G", "Ctrl+G"), onSelect: () => gotoLine(view) },
      {
        label: "Show Problems",
        shortcut: keys("⇧⌘M", "Ctrl+Shift+M"),
        disabled: diagnosticCount(view.state) === 0,
        onSelect: () => openLintPanel(view),
      },
      { separator: true },
      { label: "Run Procedure", shortcut: RUN_KEYS, disabled: !canRun, onSelect: run },
      {
        label: "Run Selection",
        shortcut: RUN_SELECTION_KEYS,
        disabled: !canRun || !state.canRunSelection,
        onSelect: () => runSelection(view),
      },
      {
        label: "Run When the Experiment Opens",
        checked: procedure.autoRun,
        onSelect: () => doc.dispatch({ op: "setProcedure", name, autoRun: !procedure.autoRun }),
      },
    ];
  };

  const edited =
    ranCode === undefined
      ? "Not run yet"
      : ranCode === code
        ? "Unchanged since run"
        : "Edited since run";
  const problems = status.problems === 1 ? "1 problem" : `${status.problems} problems`;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-chrome px-2 text-[11.5px]">
        <Button
          className="!h-5 !px-2"
          disabled={!canRun}
          title={`Run the whole file (${RUN_KEYS}). ${RUN_SELECTION_KEYS} runs the selection or the current line.`}
          onClick={run}
        >
          Run
        </Button>
        <Button
          className="!h-5 !px-2"
          disabled={lint.kind === "failed"}
          title={`Format the file with Ruff (${FORMAT_KEYS})`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (viewRef.current) format(viewRef.current);
          }}
        >
          Format
        </Button>
        <Checkbox
          label="Run when the experiment opens"
          checked={procedure.autoRun}
          onChange={(event) =>
            doc.dispatch({ op: "setProcedure", name, autoRun: event.target.checked })
          }
        />
        <span className="min-w-0 flex-1 truncate text-right text-muted">import {name}</span>
      </div>
      <div
        ref={hostRef}
        className="procedure-editor selectable min-h-0 flex-1 bg-paper"
        onContextMenu={(event) => openEditorMenu(event, viewRef.current, menuItems)}
        onKeyDown={(event) => {
          // On a button or box of a panel (after Replace All, say), Ctrl+Z still
          // undoes the editor's text; in the panel's text fields it is theirs.
          const view = viewRef.current;
          const target = event.target as HTMLElement;
          const field =
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLInputElement && target.type === "text");
          if (!view || field || view.contentDOM.contains(target)) return;
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key === "z" || key === "y") {
            event.preventDefault();
            if (key === "y" || event.shiftKey) redo(view);
            else undo(view);
          }
        }}
      />
      <div
        className="flex h-5 shrink-0 items-center gap-3 border-t border-line bg-chrome px-2 text-[11px] text-muted"
        data-editor-status
      >
        <span>
          Ln {status.line}, Col {status.column}
        </span>
        {lint.kind === "failed" ? (
          <span className="text-danger" title={lint.reason}>
            Linting is not available
          </span>
        ) : lint.kind === "loading" ? (
          <span>Loading the linter…</span>
        ) : (
          <button
            type="button"
            className="hover:text-ink"
            title={`Problems found by Ruff ${lint.version}. Click to list them (${keys("⇧⌘M", "Ctrl+Shift+M")}).`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const view = viewRef.current;
              if (view && !closeLintPanel(view)) openLintPanel(view);
            }}
          >
            {problems}
          </button>
        )}
        <span>{edited}</span>
        {message ? (
          <span className="min-w-0 flex-1 truncate text-right text-ink" title={message}>
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

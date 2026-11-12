import { autocompletion, closeBrackets, type CompletionContext } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history as editHistory,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { doc, kernel, runProcedureCode, useDoc, useKernelState } from "../app/session";
import { Button, Checkbox } from "./controls";

/** Marks changes that came from the document, so they are not sent back to it. */
const fromDocument = Annotation.define<boolean>();

/** Names from Python, when completion is asked for with Ctrl+Space. */
async function completeFromPython(context: CompletionContext) {
  if (!context.explicit) return null;
  // Only the line is sent: the rest of the file is not something Python has run.
  const line = context.state.doc.lineAt(context.pos);
  const items = await kernel.complete(line.text, context.pos - line.from);
  const first = items[0];
  if (!first || context.aborted) return null;
  return {
    from: line.from + first.start,
    to: line.from + first.end,
    options: items
      .filter((item) => item.start === first.start)
      .map((item) => ({ label: item.text })),
    validFor: /^[\w%]*$/,
  };
}

/**
 * A procedure window: a Python file that belongs to the experiment, the
 * counterpart of Igor's procedure windows. The text is kept in the document
 * as it is typed, so it is saved with everything else.
 */
export function ProcedureWindow({ name }: { name: string }) {
  const procedure = useDoc((state) => state.procedures[name]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const status = useKernelState().status;
  const canRun = status === "ready" || status === "busy" || status === "starting";

  const run = () => {
    kernel.execute(runProcedureCode(name));
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    /** Runs the selection, or the line the cursor is on, as if typed in the command line. */
    const runSelection = (view: EditorView): boolean => {
      const { main } = view.state.selection;
      const text = main.empty
        ? view.state.doc.lineAt(main.head).text
        : view.state.sliceDoc(main.from, main.to);
      if (text.trim()) kernel.execute(text.replace(/\s+$/, ""));
      return true;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: doc.getState().procedures[name]?.code ?? "",
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          editHistory(),
          python(),
          syntaxHighlighting(classHighlighter),
          bracketMatching(),
          closeBrackets(),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          autocompletion({ override: [completeFromPython], activateOnTyping: false, icons: false }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((transaction) => transaction.annotation(fromDocument))) {
              return;
            }
            doc.dispatch({ op: "setProcedure", name, code: update.state.doc.toString() });
          }),
          Prec.high(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  runRef.current();
                  return true;
                },
              },
              { key: "Shift-Enter", run: runSelection },
            ]),
          ),
          keymap.of([...historyKeymap, indentWithTab, ...defaultKeymap]),
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
  // dialog) replaces what the editor shows.
  const code = procedure?.code;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || code === undefined || code === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: code },
      annotations: fromDocument.of(true),
    });
  }, [code]);

  if (!procedure) return null;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-line bg-chrome px-2 text-[11.5px]">
        <Button
          className="!h-5 !px-2"
          disabled={!canRun}
          title="Run the whole file (Ctrl+Enter). Shift+Enter runs the selection or the current line."
          onClick={run}
        >
          Run
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
      <div ref={hostRef} className="procedure-editor selectable min-h-0 flex-1 bg-paper" />
    </div>
  );
}

import {
  defaultKeymap,
  history as editHistory,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { exportNote, importNotes } from "../app/notes";
import { doc, ui, useDoc, type MenuItem } from "../app/session";
import { INLINE_IMAGE, markdownToHtml, SAFE_LINK } from "../core/markdown";
import { diffText } from "../editor/diff";
import { editingItems, openEditorMenu, rightClickKeepsSelection } from "../editor/menu";
import { openContextMenu } from "./Menu";

/** Marks changes that came from the document, so they are not sent back to it. */
const fromDocument = Annotation.define<boolean>();

const MODES = ["Edit", "Split", "View"] as const;
type Mode = (typeof MODES)[number];

/**
 * What a note's HTML may hold once cleaned: what Markdown makes, and no
 * more. markdown-it already leaves out HTML typed in the text; this is a
 * second guard, so that a mistake there still cannot run code or restyle
 * the app.
 */
const purify = DOMPurify(window);
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "em",
  "strong",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];
const ALLOWED_ATTR = ["href", "title", "src", "alt", "target", "rel", "start", "style"];
const ALIGN = /^text-align:(left|right|center)$/;
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  // Only the alignment of table columns, which markdown-it writes as a style.
  if (data.attrName === "style" && !ALIGN.test(data.attrValue.replace(/\s+/g, ""))) {
    data.keepAttr = false;
  }
});
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (SAFE_LINK.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else {
      node.removeAttribute("href");
    }
  }
  if (node.tagName === "IMG" && !INLINE_IMAGE.test(node.getAttribute("src") ?? "")) {
    node.removeAttribute("src");
  }
});

/** A note's Markdown as HTML that is safe to show. */
export function noteHtml(text: string): string {
  return purify.sanitize(markdownToHtml(text), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

/**
 * A note: Markdown text kept in the experiment, typed on the left and shown
 * formatted on the right as it is typed. Like a procedure's, the editor and
 * its undo history last as long as the note.
 */
export function NoteWindow({ name }: { name: string }) {
  const exists = useDoc((state) => Object.hasOwn(state.notes, name));
  const [generation, setGeneration] = useState(0);
  const [shown, setShown] = useState(exists);
  if (exists !== shown) {
    setShown(exists);
    if (!exists) setGeneration(generation + 1);
  }
  if (!exists) return null;
  return <NoteEditor key={generation} name={name} />;
}

function NoteEditor({ name }: { name: string }) {
  const text = useDoc((state) => state.notes[name]!.text);
  // A note with something in it opens to be read; an empty one to be written.
  const [mode, setMode] = useState<Mode>(() => (text.trim() ? "View" : "Split"));
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The text the editor and the document last agreed on.
  const synced = useRef(text);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: synced.current,
        extensions: [
          highlightSpecialChars(),
          editHistory(),
          drawSelection(),
          dropCursor(),
          markdown(),
          syntaxHighlighting(classHighlighter),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          EditorView.lineWrapping,
          rightClickKeepsSelection,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((tr) => tr.annotation(fromDocument))) return;
            synced.current = update.state.doc.toString();
            doc.dispatch({ op: "setNote", name, text: synced.current });
          }),
          keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ "aria-label": `${name} text` }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [name]);

  // Text set from elsewhere (Python's n.text = ...) replaces what the editor
  // shows, only where it differs, so it can be undone like an edit.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || text === synced.current) return;
    const changes = diffText(view.state.doc.toString(), text);
    synced.current = text;
    view.dispatch({ changes, annotations: fromDocument.of(true) });
  }, [text]);

  const html = useMemo(() => noteHtml(text), [text]);

  const windowItems: MenuItem[] = [
    { label: "Rename Note…", onSelect: () => ui.set({ dialog: { kind: "renameWindow", name } }) },
    { label: `Export as ${name}.md`, onSelect: () => exportNote(name) },
    { label: "Import Markdown…", onSelect: importNotes },
  ];
  const editorItems = (view: EditorView): MenuItem[] => [
    ...editingItems(view, () => {}),
    { separator: true },
    ...windowItems,
  ];

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-chrome px-2 text-[11.5px]">
        <div role="radiogroup" aria-label="Show" className="flex rounded border border-line">
          {MODES.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={mode === item}
              className="px-2 leading-[18px] text-muted first:rounded-l last:rounded-r hover:text-ink aria-checked:bg-paper aria-checked:text-ink"
              onClick={() => setMode(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-right text-muted">Markdown</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={hostRef}
          className={`procedure-editor selectable min-h-0 min-w-0 flex-1 bg-paper ${
            mode === "View" ? "hidden" : ""
          } ${mode === "Split" ? "border-r border-line" : ""}`}
          onContextMenu={(event) => openEditorMenu(event, viewRef.current, editorItems)}
        />
        {mode === "Edit" ? null : (
          <div
            className="note-preview selectable min-h-0 min-w-0 flex-1 overflow-auto bg-paper px-4 py-3"
            role="document"
            aria-label={`${name} preview`}
            onContextMenu={(event) => {
              if (window.getSelection()?.toString()) return;
              event.preventDefault();
              openContextMenu(event, windowItems);
            }}
            // Cleaned by noteHtml: only what Markdown makes, with safe links.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}

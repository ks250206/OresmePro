import { pythonLanguage } from "@codemirror/lang-python";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { kernel, requestCommandLine, useHistoryEntries } from "../app/session";
import { renderTerminalText, type Span } from "../core/history/ansi";
import {
  recallList,
  searchHistory,
  type HistoryEntry,
  type HistoryOutput,
} from "../core/history/history";
import { CommandLine } from "./CommandLine";

/** Python source with syntax colors, using the same classes as the editor. */
function highlight(code: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let position = 0;
  highlightTree(pythonLanguage.parser.parse(code), classHighlighter, (from, to, classes) => {
    if (from > position) parts.push(code.slice(position, from));
    parts.push(
      <span key={from} className={classes}>
        {code.slice(from, to)}
      </span>,
    );
    position = to;
  });
  if (position < code.length) parts.push(code.slice(position));
  return parts;
}

const MAX_LINES = 400;

function TerminalText({ text, className = "" }: { text: string; className?: string }) {
  const lines = useMemo(() => renderTerminalText(text), [text]);
  const hidden = Math.max(0, lines.length - MAX_LINES);
  const shown = hidden > 0 ? lines.slice(-MAX_LINES) : lines;
  const style = (span: Span) => ({
    color: span.fg,
    backgroundColor: span.bg,
    fontWeight: span.bold ? 600 : undefined,
    fontStyle: span.italic ? "italic" : undefined,
    textDecoration: span.underline ? "underline" : undefined,
  });
  return (
    <pre className={`selectable m-0 whitespace-pre-wrap break-words font-mono ${className}`}>
      {hidden > 0 ? (
        <div className="text-muted">{`[${hidden} earlier lines not shown]`}</div>
      ) : null}
      {shown.map((line, index) => (
        <div key={index} className="min-h-[1.45em]">
          {line.map((span, at) => (
            <span key={at} style={style(span)}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}

function Output({ output }: { output: HistoryOutput }) {
  if (output.kind === "stream") {
    return (
      <TerminalText text={output.text} className={output.name === "stderr" ? "text-danger" : ""} />
    );
  }
  if (output.kind === "error") return <TerminalText text={output.traceback} />;
  if (output.svg) {
    return (
      <img
        alt={output.text}
        title={output.text}
        className="my-1 max-h-60 max-w-full rounded border border-line-soft bg-white"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(output.svg)}`}
      />
    );
  }
  if (output.png) {
    return (
      <img
        alt={output.text}
        className="my-1 max-h-60 max-w-full rounded border border-line-soft bg-white"
        src={`data:image/png;base64,${output.png}`}
      />
    );
  }
  return <TerminalText text={output.text} />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const EntryView = memo(function EntryView({ entry }: { entry: HistoryEntry }) {
  const code = useMemo(() => highlight(entry.code), [entry.code]);
  if (entry.source === "system") {
    return <div className="px-2 py-0.5 pl-6 italic text-muted">{entry.code}</div>;
  }
  const failed = entry.status === "error";
  return (
    <div className="group relative flex gap-1.5 px-2 py-[2px] hover:bg-chrome/70">
      <span
        className={`flex h-[1.45em] w-3 shrink-0 items-center justify-center ${
          failed ? "text-danger" : entry.source === "gui" ? "text-muted/70" : "text-ink"
        }`}
        title={entry.source === "gui" ? "From a menu or dialog" : undefined}
      >
        {entry.status === "running" ? (
          <span className="spinner" role="status" aria-label="Running" />
        ) : entry.status === "queued" ? (
          "…"
        ) : (
          "•"
        )}
      </span>
      <div className="min-w-0 flex-1">
        <pre
          className={`selectable m-0 whitespace-pre-wrap break-words font-mono ${
            entry.source === "gui" ? "opacity-75" : ""
          }`}
          onDoubleClick={() => requestCommandLine(entry.code)}
        >
          {code}
        </pre>
        {entry.outputs.map((output, index) => (
          <Output key={index} output={output} />
        ))}
      </div>
      <div className="flex h-[1.45em] shrink-0 items-center gap-1 text-[11px] text-muted">
        {entry.durationMs !== null && entry.durationMs >= 200 ? (
          <span>{formatDuration(entry.durationMs)}</span>
        ) : null}
        <button
          type="button"
          title="Put in command line"
          aria-label="Put in command line"
          className="rounded px-1 opacity-0 hover:bg-chrome-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => requestCommandLine(entry.code)}
        >
          {"↵"}
        </button>
        <button
          type="button"
          title="Run again"
          aria-label="Run again"
          className="rounded px-1 opacity-0 hover:bg-chrome-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => kernel.execute(entry.code)}
        >
          {"▶"}
        </button>
      </div>
    </div>
  );
});

function HistoryView({ entries }: { entries: readonly HistoryEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);
  const lastScrollTop = useRef(0);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 10,
    getItemKey: (index) => entries[index]!.id,
  });
  const totalSize = virtualizer.getTotalSize();

  // Follow new output unless the user has scrolled up to read something.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToEnd.current) element.scrollTop = element.scrollHeight;
  }, [entries, totalSize]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Command history"
      className="min-h-0 flex-1 overflow-y-auto bg-paper text-[12.5px] leading-[1.45]"
      onScroll={(event) => {
        const element = event.currentTarget;
        const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 4;
        // Only the user scrolling up stops the view from following new output;
        // content growing below does not move scrollTop, so it never counts.
        if (atEnd) stickToEnd.current = true;
        else if (element.scrollTop < lastScrollTop.current - 1) stickToEnd.current = false;
        lastScrollTop.current = element.scrollTop;
      }}
    >
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-muted">
          Everything you run, and everything you do through menus, is recorded here as Python.
        </div>
      ) : null}
      <div className="relative w-full" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <EntryView entry={entries[item.index]!} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ctrl+R: incremental search through earlier commands, newest first. */
function HistorySearch({
  entries,
  initialQuery,
  onClose,
}: {
  entries: readonly HistoryEntry[];
  initialQuery: string;
  onClose: (accepted: string | null) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  // Closing removes the input, which can fire a blur; report only the first close.
  const closed = useRef(false);
  const close = (accepted: string | null) => {
    if (closed.current) return;
    closed.current = true;
    onClose(accepted);
  };
  const matches = useMemo(
    () => searchHistory(recallList(entries), query).slice(0, 200),
    [entries, query],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const current = Math.min(index, Math.max(0, matches.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, matches]);

  return (
    <div className="flex max-h-[60%] shrink-0 flex-col border-t border-line bg-chrome">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Matching commands"
        className="min-h-0 overflow-y-auto"
      >
        {matches.length === 0 ? (
          <div className="px-3 py-1 text-muted">No matching command.</div>
        ) : null}
        {/* Newest at the bottom, next to the input, like a shell. */}
        {[...matches].reverse().map((command, reversed) => {
          const at = matches.length - 1 - reversed;
          return (
            <div
              key={at}
              role="option"
              aria-selected={at === current}
              className={`cursor-default truncate px-3 py-[1px] font-mono text-[12px] ${
                at === current ? "bg-accent text-white" : ""
              }`}
              onPointerEnter={() => setIndex(at)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => close(command)}
            >
              {command.replace(/\n/g, " ⏎ ")}
            </div>
          );
        })}
      </div>
      <label className="flex items-center gap-2 border-t border-line-soft px-2 py-1">
        <span className="text-muted">search history:</span>
        <input
          autoFocus
          aria-label="Search history"
          value={query}
          spellCheck={false}
          className="selectable min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none"
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onBlur={() => close(null)}
          onKeyDown={(event) => {
            const older = event.key === "ArrowUp" || (event.ctrlKey && event.key === "r");
            const newer = event.key === "ArrowDown" || (event.ctrlKey && event.key === "s");
            if (older || newer) {
              event.preventDefault();
              setIndex(Math.max(0, Math.min(matches.length - 1, current + (older ? 1 : -1))));
            } else if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              close(matches[current] ?? null);
            } else if (event.key === "Escape" || (event.ctrlKey && event.key === "g")) {
              event.preventDefault();
              close(null);
            }
          }}
        />
        <span className="text-[11px] text-muted">
          {matches.length > 0 ? `${current + 1}/${matches.length}` : ""} &nbsp;Enter: use &nbsp;Esc:
          cancel
        </span>
      </label>
    </div>
  );
}

/** History above, command line below: the layout of Igor's command window. */
export function CommandWindow() {
  const entries = useHistoryEntries();
  const [search, setSearch] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <HistoryView entries={entries} />
      {search !== null ? (
        <HistorySearch
          entries={entries}
          initialQuery={search}
          onClose={(accepted) => {
            setSearch(null);
            // Hand the text (or just the focus) back to the command line.
            requestCommandLine(accepted ?? search);
          }}
        />
      ) : null}
      <div className={search !== null ? "hidden" : ""}>
        <CommandLine onOpenSearch={setSearch} />
      </div>
    </div>
  );
}

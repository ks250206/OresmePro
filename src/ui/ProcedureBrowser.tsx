import { useMemo, useState } from "react";
import { exportProcedure, importProcedures, openProcedure } from "../app/procedures";
import { runProcedure, ui, useDoc, useKernelState, type MenuItem } from "../app/session";
import { outlineOf, type OutlineItem } from "../editor/outline";
import { Button, Checkbox, TextInput } from "./controls";
import { openContextMenu } from "./Menu";

type Kind = "class" | "function" | "method";

/** The look of each kind of definition: a letter on a colored square, as editors' outlines show them. */
const KINDS: Record<Kind, { letter: string; color: string; label: string }> = {
  class: { letter: "C", color: "#d97706", label: "class" },
  function: { letter: "ƒ", color: "#7c3aed", label: "function" },
  method: { letter: "m", color: "#0d9488", label: "method" },
};

/** A definition's icon: its letter on a square of its color. */
function KindIcon({ kind }: { kind: Kind }) {
  const { letter, color, label } = KINDS[kind];
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={color} />
      <text
        x="7"
        y="10.4"
        textAnchor="middle"
        fontSize={letter === "ƒ" ? 10.5 : 9.5}
        fontWeight="700"
        fontStyle={letter === "ƒ" ? "italic" : "normal"}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="#ffffff"
      >
        {letter}
      </text>
    </svg>
  );
}

/** A Python file: a page with its corner folded, and the blue and yellow of Python. */
function FileIcon() {
  return (
    <svg viewBox="0 0 14 16" width="13" height="15" aria-hidden className="shrink-0">
      <path
        d="M2 1.5h6.5L12 5v9.5H2z"
        fill="var(--color-paper)"
        stroke="var(--color-muted)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.5V5H12" fill="none" stroke="var(--color-muted)" strokeWidth="1" />
      <rect x="4" y="8" width="3" height="3" rx="0.8" fill="#3776ab" />
      <rect x="7" y="10" width="3" height="3" rx="0.8" fill="#f2c94c" />
    </svg>
  );
}

/** The arrow that opens and closes a file's list, turned when it is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      aria-hidden
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** A small label beside a file's name: how it is imported, whether it is closed or runs at opening. */
function Badge({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-full border border-line bg-chrome px-1.5 text-[10.5px] leading-[15px] text-muted"
    >
      {children}
    </span>
  );
}

/** The definitions whose name has the words, and those that hold one. */
function filtered(items: readonly OutlineItem[], words: readonly string[]): OutlineItem[] {
  if (words.length === 0) return [...items];
  return items.flatMap((item) => {
    const children = filtered(item.children, words);
    const name = item.name.toLowerCase();
    const hit = words.every((word) => name.includes(word));
    return hit || children.length > 0
      ? [{ ...item, children: hit ? item.children : children }]
      : [];
  });
}

const count = (items: readonly OutlineItem[]): number =>
  items.reduce((total, item) => total + 1 + count(item.children), 0);

/**
 * The procedures of the experiment and what each defines, as Igor's
 * Procedure Browser shows them: the files, and their classes, functions and
 * methods nested as they are written, with their signatures if asked for.
 * Clicking a definition opens its procedure at its line.
 */
export function ProcedureBrowser() {
  const procedures = useDoc((state) => state.procedures);
  const windows = useDoc((state) => state.windows);
  const kernel = useKernelState();
  const canRun = kernel.status === "ready" || kernel.status === "busy";
  const [signatures, setSignatures] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const [find, setFind] = useState("");
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const files = useMemo(
    () =>
      Object.values(procedures)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((procedure) => ({ procedure, items: outlineOf(procedure.code) })),
    [procedures],
  );
  const shown = files
    .map((file) => ({ ...file, matches: filtered(file.items, words) }))
    .filter(
      (file) =>
        words.length === 0 ||
        file.matches.length > 0 ||
        words.every((word) => file.procedure.name.toLowerCase().includes(word)),
    );
  const current = selected !== null && Object.hasOwn(procedures, selected) ? selected : null;
  const closed = (name: string) => windows.find((window) => window.name === name)?.hidden === true;

  const fileMenu = (event: React.MouseEvent, name: string) => {
    event.preventDefault();
    setSelected(name);
    const items: MenuItem[] = [
      { label: "Open", onSelect: () => openProcedure(name) },
      { label: "Run Procedure", disabled: !canRun, onSelect: () => runProcedure(name) },
      { separator: true },
      { label: `Export as ${name}.py`, onSelect: () => exportProcedure(name) },
      {
        label: "Rename Procedure…",
        onSelect: () => ui.set({ dialog: { kind: "renameWindow", name } }),
      },
    ];
    openContextMenu(event, items);
  };

  const renderItems = (
    name: string,
    items: readonly OutlineItem[],
    depth: number,
    inClass: boolean,
  ) =>
    items.map((item) => {
      const kind: Kind = item.kind === "class" ? "class" : inClass ? "method" : "function";
      return (
        <li key={`${item.line}:${item.name}`} role="none">
          <button
            type="button"
            role="treeitem"
            aria-label={`${item.name} in ${name}`}
            title={`${KINDS[kind].label} ${item.name}, ${name}.py line ${item.line}`}
            className="group flex h-[22px] w-full min-w-0 items-center gap-1.5 pr-2 text-left hover:bg-accent-soft"
            style={{ paddingLeft: 26 + depth * 16 }}
            onClick={() => {
              setSelected(name);
              openProcedure(name, item.line);
            }}
          >
            <KindIcon kind={kind} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
              <span className="text-ink">{item.name}</span>
              {signatures ? (
                <span className="text-muted">
                  {item.signature}
                  {item.returns}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-muted/70 group-hover:text-muted">
              {item.line}
            </span>
          </button>
          {item.children.length > 0 ? (
            <ul role="group" className="relative m-0 list-none p-0">
              {/* A guide down from the definition to what it holds. */}
              <span
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-1 w-px bg-line"
                style={{ left: 33 + depth * 16 }}
              />
              {renderItems(name, item.children, depth + 1, item.kind === "class")}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <div className="absolute inset-0 flex flex-col text-[12px]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Button className="!h-5 !px-2" onClick={() => ui.set({ dialog: { kind: "newProcedure" } })}>
          New…
        </Button>
        <Button className="!h-5 !px-2" onClick={importProcedures}>
          Import…
        </Button>
        <Button
          className="!h-5 !px-2"
          disabled={current === null}
          title={current ? `Save ${current}.py` : "Select a procedure"}
          onClick={() => current && exportProcedure(current)}
        >
          Export
        </Button>
        <Button
          className="!h-5 !px-2"
          disabled={current === null || !canRun}
          title={current ? `Run ${current}.py` : "Select a procedure"}
          onClick={() => current && runProcedure(current)}
        >
          Run
        </Button>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
        <TextInput
          aria-label="Find definitions"
          placeholder="Find a function or class"
          className="!h-5 min-w-0 flex-1"
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
        <Checkbox
          label="Signatures"
          checked={signatures}
          onChange={(event) => setSignatures(event.target.checked)}
        />
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto bg-paper py-1">
        {files.length === 0 ? (
          <p className="m-0 px-3 py-2 text-muted">
            No procedures yet. Make one with New…, or bring in a .py file with Import….
          </p>
        ) : shown.length === 0 ? (
          <p className="m-0 px-3 py-2 text-muted">Nothing is called “{find.trim()}”.</p>
        ) : (
          <ul role="tree" aria-label="Procedures" className="m-0 list-none p-0">
            {shown.map(({ procedure, items, matches }) => {
              const { name } = procedure;
              // Finding opens every file that has something found.
              const open = words.length > 0 || !collapsed.includes(name);
              const definitions = count(items);
              return (
                <li key={name} role="none">
                  <div
                    role="treeitem"
                    aria-label={`${name}.py`}
                    aria-expanded={items.length > 0 ? open : undefined}
                    aria-selected={current === name}
                    tabIndex={0}
                    className={`flex h-6 min-w-0 cursor-default items-center gap-1.5 pr-2 pl-1 ${
                      current === name ? "bg-accent-soft" : "hover:bg-chrome"
                    }`}
                    onClick={() => setSelected(name)}
                    onDoubleClick={() => openProcedure(name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openProcedure(name);
                    }}
                    onContextMenu={(event) => fileMenu(event, name)}
                  >
                    <button
                      type="button"
                      aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
                      className="grid h-4 w-4 shrink-0 place-items-center text-muted hover:text-ink"
                      onClick={(event) => {
                        event.stopPropagation();
                        setCollapsed(
                          open ? [...collapsed, name] : collapsed.filter((item) => item !== name),
                        );
                      }}
                    >
                      {items.length > 0 ? <Chevron open={open} /> : null}
                    </button>
                    <FileIcon />
                    <span className="min-w-0 truncate font-medium">{name}.py</span>
                    {procedure.importAs ? (
                      <Badge title={`Run makes it the module ${procedure.importAs}`}>
                        <span className="font-mono">as {procedure.importAs}</span>
                      </Badge>
                    ) : null}
                    {closed(name) ? (
                      <Badge title="Its window is closed; it opens again when a definition is clicked">
                        closed
                      </Badge>
                    ) : null}
                    {procedure.autoRun ? null : (
                      <Badge title="Does not run when the experiment opens">no auto-run</Badge>
                    )}
                    <span className="flex-1" />
                    <span
                      className="shrink-0 text-[10.5px] text-muted"
                      title={`${definitions} classes and functions`}
                    >
                      {definitions || ""}
                    </span>
                  </div>
                  {open && matches.length > 0 ? (
                    <ul role="group" className="m-0 list-none p-0">
                      {renderItems(name, matches, 0, false)}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

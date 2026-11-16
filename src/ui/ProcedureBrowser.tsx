import { useMemo, useState } from "react";
import { exportProcedure, importProcedures, openProcedure } from "../app/procedures";
import { runProcedure, ui, useDoc, useKernelState, type MenuItem } from "../app/session";
import { outlineOf, type OutlineItem } from "../editor/outline";
import { Button, Checkbox } from "./controls";
import { openContextMenu } from "./Menu";

/**
 * The procedures of the experiment and what each defines, as Igor's
 * Procedure Browser shows them: the files, and their classes and functions
 * nested as they are written, with their signatures if asked for. Clicking a
 * definition opens its procedure at its line.
 */
export function ProcedureBrowser() {
  const procedures = useDoc((state) => state.procedures);
  const windows = useDoc((state) => state.windows);
  const kernel = useKernelState();
  const canRun = kernel.status === "ready" || kernel.status === "busy";
  const [signatures, setSignatures] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const files = useMemo(
    () =>
      Object.values(procedures)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((procedure) => ({ procedure, items: outlineOf(procedure.code) })),
    [procedures],
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

  const renderItems = (name: string, items: readonly OutlineItem[], depth: number) =>
    items.map((item) => (
      <li key={`${item.line}:${item.name}`} role="none">
        <button
          type="button"
          role="treeitem"
          aria-label={`${item.name} in ${name}`}
          title={`${name}.py, line ${item.line}`}
          className="flex w-full min-w-0 items-baseline gap-1 truncate rounded px-1 text-left hover:bg-accent-soft"
          style={{ paddingLeft: 18 + depth * 14 }}
          onClick={() => {
            setSelected(name);
            openProcedure(name, item.line);
          }}
        >
          <span className="w-3 shrink-0 text-center text-[10px] text-muted">
            {item.kind === "class" ? "C" : "ƒ"}
          </span>
          <span className="min-w-0 truncate font-mono">
            {item.name}
            {signatures ? (
              <span className="text-muted">
                {item.signature}
                {item.returns}
              </span>
            ) : null}
          </span>
        </button>
        {item.children.length > 0 ? (
          <ul role="group" className="m-0 list-none p-0">
            {renderItems(name, item.children, depth + 1)}
          </ul>
        ) : null}
      </li>
    ));

  return (
    <div className="absolute inset-0 flex flex-col text-[12px]">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
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
          onClick={() => current && runProcedure(current)}
        >
          Run
        </Button>
        <span className="flex-1" />
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
        ) : (
          <ul role="tree" aria-label="Procedures" className="m-0 list-none p-0">
            {files.map(({ procedure, items }) => {
              const { name } = procedure;
              const open = !collapsed.includes(name);
              return (
                <li key={name} role="none">
                  <div
                    role="treeitem"
                    aria-label={`${name}.py`}
                    aria-expanded={items.length > 0 ? open : undefined}
                    aria-selected={current === name}
                    tabIndex={0}
                    className={`flex min-w-0 cursor-default items-center gap-1 px-1 ${
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
                      className="w-4 shrink-0 text-[10px] text-muted"
                      onClick={(event) => {
                        event.stopPropagation();
                        setCollapsed(
                          open ? [...collapsed, name] : collapsed.filter((item) => item !== name),
                        );
                      }}
                    >
                      {items.length > 0 ? (open ? "▾" : "▸") : ""}
                    </button>
                    <span className="truncate font-medium">{name}.py</span>
                    {closed(name) ? <span className="text-muted">(closed)</span> : null}
                    {procedure.autoRun ? null : (
                      <span className="text-muted" title="Does not run when the experiment opens">
                        · not run at opening
                      </span>
                    )}
                  </div>
                  {open && items.length > 0 ? (
                    <ul role="group" className="m-0 list-none p-0">
                      {renderItems(name, items, 0)}
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

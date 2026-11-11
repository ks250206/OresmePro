import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { runGui, ui, useDoc } from "../app/session";
import type { Command } from "../core/doc/commands";
import { formatNumber } from "../core/plot/ticks";
import { openContextMenu } from "./Menu";

const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type Features = typeof features;
/** Rows come straight from the waves through the virtualizer, not from a row model. */
const NO_ROWS: never[] = [];

const ROW_HEIGHT = 20;
const POINT_COLUMN = "__point";

interface Cell {
  row: number;
  /** Index into the table's wave columns. */
  column: number;
}

function parseCell(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return Number.NaN;
  if (/^[+-]?nan$/i.test(trimmed)) return Number.NaN;
  const value = Number(trimmed);
  return Number.isNaN(value) ? null : value;
}

export function TableWindow({ name }: { name: string }) {
  const table = useDoc((state) => state.tables[name]);
  const waves = useDoc((state) => state.waves);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Cell>({ row: 0, column: 0 });
  const [editing, setEditing] = useState<{ text: string; invalid: boolean } | null>(null);

  const columnNames = useMemo(() => table?.columns ?? [], [table]);
  const columns = useMemo<ColumnDef<Features, never>[]>(
    () => [
      { id: POINT_COLUMN, header: "Point", size: 64, minSize: 44, enableResizing: false },
      ...columnNames.map((wave) => ({ id: wave, header: wave, size: 96, minSize: 48 })),
    ],
    [columnNames],
  );
  const model = useTable({ data: NO_ROWS, columns, features, columnResizeMode: "onChange" });
  const headers = model.getHeaderGroups()[0]?.headers ?? [];

  const longest = columnNames.reduce(
    (max, wave) => Math.max(max, waves[wave]?.data.length ?? 0),
    0,
  );
  // One extra row, so there is always a cell to type the next point into.
  const rowCount = longest + 1;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const column = Math.min(selected.column, Math.max(0, columnNames.length - 1));
  const row = Math.min(selected.row, rowCount - 1);
  const selectedWave = columnNames[column];

  useEffect(() => {
    if (!editing) scrollRef.current?.focus({ preventScroll: true });
  }, [editing]);

  if (!table) return null;

  const select = (next: Cell) => {
    const clamped = {
      row: Math.max(0, Math.min(rowCount - 1, next.row)),
      column: Math.max(0, Math.min(columnNames.length - 1, next.column)),
    };
    setSelected(clamped);
    virtualizer.scrollToIndex(clamped.row);
  };

  const cellText = (wave: string | undefined, index: number): string => {
    const data = wave ? waves[wave]?.data : undefined;
    return data && index < data.length ? formatNumber(data[index]!, 8) : "";
  };

  /** A cell can be edited if it is an existing point or the first empty one. */
  const editable = (wave: string | undefined, index: number): boolean =>
    wave !== undefined && index <= (waves[wave]?.data.length ?? -1);

  const beginEdit = (text: string) => {
    if (editable(selectedWave, row)) setEditing({ text, invalid: false });
  };

  const commit = (move: Cell | null) => {
    if (!editing || !selectedWave) return;
    const value = parseCell(editing.text);
    if (value === null) {
      setEditing({ ...editing, invalid: true });
      return;
    }
    const data = waves[selectedWave]?.data;
    const unchanged = data && row < data.length && Object.is(data[row], value);
    const blankAppend = row === data?.length && editing.text.trim() === "";
    if (!unchanged && !blankAppend) {
      runGui({ op: "setWavePoints", name: selectedWave, start: row, values: [value] });
    }
    setEditing(null);
    if (move) select(move);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 200) / ROW_HEIGHT) - 2);
    const moves: Record<string, Cell> = {
      ArrowUp: { row: row - 1, column },
      ArrowDown: { row: row + 1, column },
      ArrowLeft: { row, column: column - 1 },
      ArrowRight: { row, column: column + 1 },
      Tab: { row, column: column + (event.shiftKey ? -1 : 1) },
      PageUp: { row: row - page, column },
      PageDown: { row: row + page, column },
      Home: { row: 0, column },
      End: { row: rowCount - 1, column },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      select(move);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit(cellText(selectedWave, row));
    } else if (event.key.length === 1 && /[0-9+\-.eEnN]/.test(event.key)) {
      event.preventDefault();
      beginEdit(event.key);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    event.preventDefault();
    const rows = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split(/\t|,/));
    const commands: Command[] = [];
    const width = Math.max(...rows.map((cells) => cells.length));
    for (let offset = 0; offset < width; offset += 1) {
      const wave = columnNames[column + offset];
      if (!wave) break;
      const values = rows.map((cells) => parseCell(cells[offset] ?? "") ?? Number.NaN);
      const length = waves[wave]?.data.length ?? 0;
      // A paste below the end of a wave starts at its first free point.
      commands.push({ op: "setWavePoints", name: wave, start: Math.min(row, length), values });
    }
    runGui(commands);
  };

  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", cellText(selectedWave, row));
  };

  const headerMenu = (event: React.MouseEvent, wave: string) => {
    event.preventDefault();
    openContextMenu(event, [
      { label: `Display ${wave}`, onSelect: () => runGui({ op: "display", y: [wave] }) },
      {
        label: "Change Wave Scaling…",
        onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave } }),
      },
      { label: "Rename…", onSelect: () => ui.set({ dialog: { kind: "renameWave", wave } }) },
      { separator: true },
      {
        label: `Remove ${wave} from Table`,
        onSelect: () => runGui({ op: "removeFromTable", table: name, waves: [wave] }),
      },
    ]);
  };

  const cellMenu = (event: React.MouseEvent, cell: Cell) => {
    event.preventDefault();
    select(cell);
    const wave = columnNames[cell.column];
    const length = wave ? (waves[wave]?.data.length ?? 0) : 0;
    if (!wave) return;
    openContextMenu(event, [
      {
        label: "Insert Point",
        disabled: cell.row > length,
        onSelect: () => runGui({ op: "insertPoints", name: wave, at: cell.row, count: 1 }),
      },
      {
        label: "Delete Point",
        disabled: cell.row >= length,
        onSelect: () => runGui({ op: "deletePoints", name: wave, at: cell.row, count: 1 }),
      },
    ]);
  };

  const totalWidth = headers.reduce((sum, header) => sum + header.getSize(), 0);

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-label={name}
      aria-rowcount={rowCount}
      className="absolute inset-0 overflow-auto bg-paper font-mono text-[11.5px] outline-none"
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onCopy={onCopy}
    >
      <div
        role="row"
        className="sticky top-0 z-10 flex border-b border-line bg-chrome font-sans text-[11.5px]"
        style={{ width: totalWidth, height: ROW_HEIGHT + 2 }}
      >
        {headers.map((header) => {
          const isPoint = header.column.id === POINT_COLUMN;
          return (
            <div
              key={header.id}
              role="columnheader"
              className={`relative flex shrink-0 items-center border-r border-line-soft px-1.5 font-medium ${
                isPoint ? "sticky left-0 z-10 justify-center bg-chrome text-muted" : ""
              } ${!isPoint && header.column.id === selectedWave ? "bg-accent-soft" : ""}`}
              style={{ width: header.getSize() }}
              onContextMenu={isPoint ? undefined : (event) => headerMenu(event, header.column.id)}
            >
              <span className="truncate">{String(header.column.columnDef.header)}</span>
              {header.column.getCanResize() ? (
                <div
                  className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
                  onPointerDown={header.getResizeHandler()}
                  onDoubleClick={() => header.column.resetSize()}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="relative" style={{ height: virtualizer.getTotalSize(), width: totalWidth }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="row"
            aria-rowindex={item.index + 1}
            className="absolute left-0 flex"
            style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
          >
            {headers.map((header, index) => {
              if (header.column.id === POINT_COLUMN) {
                return (
                  <div
                    key={header.id}
                    role="rowheader"
                    className={`sticky left-0 flex shrink-0 items-center justify-end border-b border-r border-line-soft px-1.5 text-muted ${
                      item.index === row ? "bg-accent-soft" : "bg-chrome"
                    }`}
                    style={{ width: header.getSize() }}
                  >
                    {item.index}
                  </div>
                );
              }
              const cell = { row: item.index, column: index - 1 };
              const wave = header.column.id;
              const active = cell.row === row && cell.column === column;
              const open = editable(wave, item.index);
              return (
                <div
                  key={header.id}
                  role="gridcell"
                  aria-selected={active}
                  className={`relative flex shrink-0 items-center justify-end border-b border-r border-line-soft px-1.5 ${
                    open ? "" : "bg-chrome/60"
                  } ${active ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
                  style={{ width: header.getSize() }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    if (editing) commit(null);
                    select(cell);
                  }}
                  onDoubleClick={() => {
                    if (open) setEditing({ text: cellText(wave, item.index), invalid: false });
                  }}
                  onContextMenu={(event) => cellMenu(event, cell)}
                >
                  {active && editing ? (
                    <input
                      autoFocus
                      aria-label={`${wave} point ${item.index}`}
                      aria-invalid={editing.invalid}
                      value={editing.text}
                      spellCheck={false}
                      className={`absolute inset-0 w-full bg-paper px-1.5 text-right outline outline-2 -outline-offset-2 ${
                        editing.invalid ? "outline-danger" : "outline-accent"
                      }`}
                      onChange={(event) => setEditing({ text: event.target.value, invalid: false })}
                      onPointerDown={(event) => event.stopPropagation()}
                      onBlur={() => commit(null)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commit({ row: row + 1, column });
                        } else if (event.key === "Tab") {
                          event.preventDefault();
                          commit({ row, column: column + (event.shiftKey ? -1 : 1) });
                        } else if (event.key === "Escape") {
                          setEditing(null);
                        }
                      }}
                    />
                  ) : (
                    <span className="truncate">{cellText(wave, item.index)}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

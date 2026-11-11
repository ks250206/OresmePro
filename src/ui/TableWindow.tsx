import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { doc, runGui, showError, ui, useDoc, type MenuItem } from "../app/session";
import type { Command } from "../core/doc/commands";
import {
  cellIndex,
  clearCommands,
  pointCommands,
  selectionRange,
  tableEditCommands,
  type Cell,
  type CellEdit,
  type TableColumn,
} from "../core/doc/tableEdit";
import { DATE_UNIT, leafName } from "../core/doc/types";
import { formatDate, formatNumber } from "../core/plot/ticks";
import { openContextMenu } from "./Menu";

const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type Features = typeof features;
/** Rows come straight from the waves through the virtualizer, not from a row model. */
const NO_ROWS: never[] = [];

const ROW_HEIGHT = 20;
const HEADER_HEIGHT = ROW_HEIGHT + 2;
const POINT_WIDTH = 64;
const COLUMN_WIDTH = 96;
/** Copying more cells than this at once is refused rather than freezing the page. */
const MAX_COPY_CELLS = 2_000_000;

interface ColumnInfo extends TableColumn {
  id: string;
  title: string;
}

export function TableWindow({ name }: { name: string }) {
  const table = useDoc((state) => state.tables[name]);
  const waves = useDoc((state) => state.waves);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The active cell, where typing goes, and the opposite corner of the selection. */
  const [anchor, setAnchor] = useState<Cell>({ row: 0, column: 0 });
  const [focus, setFocus] = useState<Cell>({ row: 0, column: 0 });
  const [editing, setEditing] = useState<{ text: string; invalid: boolean } | null>(null);
  /** Which plane of 3-D and 4-D waves the table shows. */
  const [plane, setPlane] = useState({ layer: 0, chunk: 0 });
  const dragging = useRef(false);

  const waveNames = useMemo(() => table?.columns ?? [], [table]);
  // The column layout depends on each wave's shape, not on its values.
  const shapeKey = waveNames.map((wave) => waves[wave]?.shape.join("x")).join(",");
  const columnInfos = useMemo<ColumnInfo[]>(
    () =>
      waveNames.flatMap((wave): ColumnInfo[] => {
        const shape = doc.getState().waves[wave]?.shape ?? [0];
        if (shape.length < 2) return [{ id: wave, wave, title: leafName(wave), j: null }];
        return Array.from({ length: shape[1]! }, (_, j) => ({
          id: `${wave}[${j}]`,
          wave,
          title: `${leafName(wave)}[][${j}]`,
          j,
        }));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shapeKey stands in for the shapes
    [waveNames, shapeKey],
  );

  // TanStack Table models the columns and their resizing; the widths themselves
  // live in the document, per wave, so they are saved with the experiment.
  const widths = table?.widths;
  const columns = useMemo<ColumnDef<Features, never>[]>(
    () => columnInfos.map((info) => ({ id: info.id, header: info.title, minSize: 40 })),
    [columnInfos],
  );
  const columnSizing = useMemo(() => {
    const sizing: Record<string, number> = {};
    for (const info of columnInfos) sizing[info.id] = widths?.[info.wave] ?? COLUMN_WIDTH;
    return sizing;
  }, [columnInfos, widths]);
  const model = useTable({
    data: NO_ROWS,
    columns,
    features,
    columnResizeMode: "onChange",
    state: { columnSizing },
    onColumnSizingChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnSizing) : updater;
      for (const info of columnInfos) {
        const width = next[info.id];
        if (width !== undefined && width !== columnSizing[info.id]) {
          doc.dispatch({ op: "resizeColumn", table: name, wave: info.wave, width });
          return;
        }
      }
    },
  });
  const headers = model.getHeaderGroups()[0]?.headers ?? [];

  const longest = waveNames.reduce((max, wave) => Math.max(max, waves[wave]?.shape[0] ?? 0), 0);
  // One extra row, so there is always a cell to type the next point into.
  const rowCount = longest + 1;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The header and the point column stay put over the cells: scrolling a
    // cell into view must stop short of them.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  // Columns are virtual too: a matrix can have thousands.
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columnInfos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => columnSizing[columnInfos[index]!.id] ?? COLUMN_WIDTH,
    overscan: 3,
    paddingStart: POINT_WIDTH,
    scrollPaddingStart: POINT_WIDTH,
  });
  useEffect(() => {
    columnVirtualizer.measure();
  }, [columnVirtualizer, columnSizing]);

  const lastColumn = Math.max(0, columnInfos.length - 1);
  const clamp = (cell: Cell): Cell => ({
    row: Math.max(0, Math.min(rowCount - 1, cell.row)),
    column: Math.max(0, Math.min(lastColumn, cell.column)),
  });
  const active = clamp(anchor);
  const range = selectionRange(active, clamp(focus));
  const activeInfo = columnInfos[active.column];

  useEffect(() => {
    if (!editing) scrollRef.current?.focus({ preventScroll: true });
  }, [editing]);

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    return () => window.removeEventListener("pointerup", stop);
  }, []);

  if (!table) return null;
  const digits = table.digits;

  /** Selects one cell, or with `extend` moves only the far corner of the selection. */
  const select = (cell: Cell, extend = false) => {
    const next = clamp(cell);
    if (!extend) setAnchor(next);
    setFocus(next);
    rowVirtualizer.scrollToIndex(next.row);
    columnVirtualizer.scrollToIndex(next.column);
  };

  const rowsOf = (info: ColumnInfo | undefined): number =>
    info ? (waves[info.wave]?.shape[0] ?? 0) : 0;

  const cellText = (info: ColumnInfo | undefined, index: number, precision = digits): string => {
    const wave = info ? waves[info.wave] : undefined;
    if (!wave || index >= (wave.shape[0] ?? 0)) return "";
    if (wave.text) return wave.text[index] ?? "";
    const value = wave.data[cellIndex(wave, index, info!.j, plane)]!;
    return wave.unit === DATE_UNIT ? formatDate(value) : formatNumber(value, precision);
  };

  /** A cell can be edited if it is an existing point or, in a 1-D wave, the first empty one. */
  const editable = (info: ColumnInfo | undefined, index: number): boolean => {
    const wave = info ? waves[info.wave] : undefined;
    if (!wave) return false;
    const rows = wave.shape[0] ?? 0;
    return wave.shape.length === 1 ? index <= rows : index < rows;
  };

  const beginEdit = (text: string) => {
    if (!editable(activeInfo, active.row)) return;
    setFocus(active);
    setEditing({ text, invalid: false });
  };

  const commit = (move: Cell | null) => {
    if (!editing || !activeInfo) return;
    const appending = active.row === rowsOf(activeInfo);
    // Compare at full precision: the cell may show fewer digits than it holds.
    const unchanged = !appending && editing.text === cellText(activeInfo, active.row, 17);
    if (!unchanged && !(appending && editing.text.trim() === "")) {
      const edit = { wave: activeInfo.wave, j: activeInfo.j, row: active.row, text: editing.text };
      const commands = tableEditCommands(waves, [edit], plane);
      if (!commands) {
        setEditing({ ...editing, invalid: true });
        return;
      }
      runGui(commands);
    }
    setEditing(null);
    if (move) select(move);
  };

  /** The selected cells as tab-separated text, at full precision. */
  const selectionText = (): string | null => {
    const cellCount = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (cellCount > MAX_COPY_CELLS) {
      showError(
        "Too much to copy",
        `The selection has ${cellCount.toLocaleString("en-US")} cells.`,
      );
      return null;
    }
    const picked = columnInfos.slice(range.left, range.right + 1);
    // Rows past the end of every selected wave are empty: leave them out.
    const last = Math.min(range.bottom, Math.max(...picked.map(rowsOf)) - 1);
    const lines: string[] = [];
    for (let index = range.top; index <= last; index += 1) {
      lines.push(picked.map((info) => cellText(info, index, 17)).join("\t"));
    }
    return lines.join("\n");
  };

  const clearSelection = () => runGui(clearCommands(waves, columnInfos, range, plane));

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.altKey) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod) {
      if (event.key.toLowerCase() === "a") {
        event.preventDefault();
        setAnchor({ row: 0, column: 0 });
        setFocus({ row: rowCount - 1, column: lastColumn });
      }
      return;
    }
    const from = event.shiftKey ? clamp(focus) : active;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 200) / ROW_HEIGHT) - 2);
    const moves: Record<string, Cell> = {
      ArrowUp: { row: from.row - 1, column: from.column },
      ArrowDown: { row: from.row + 1, column: from.column },
      ArrowLeft: { row: from.row, column: from.column - 1 },
      ArrowRight: { row: from.row, column: from.column + 1 },
      PageUp: { row: from.row - page, column: from.column },
      PageDown: { row: from.row + page, column: from.column },
      Home: { row: 0, column: from.column },
      End: { row: rowCount - 1, column: from.column },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      select(move, event.shiftKey);
    } else if (event.key === "Tab") {
      event.preventDefault();
      select({ row: active.row, column: active.column + (event.shiftKey ? -1 : 1) });
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit(cellText(activeInfo, active.row, 17));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearSelection();
    } else if (
      event.key.length === 1 &&
      (waves[activeInfo?.wave ?? ""]?.text ? event.key !== " " : /[0-9+\-.eEnN]/.test(event.key))
    ) {
      event.preventDefault();
      beginEdit(event.key);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    event.preventDefault();
    // Tabs if there are any (spreadsheets), commas otherwise.
    const separator = text.includes("\t") ? "\t" : ",";
    const rows = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split(separator));
    // Collect every pasted cell first: the cells of one wave must be written together.
    const edits: CellEdit[] = [];
    rows.forEach((cells, down) => {
      cells.forEach((value, across) => {
        const info = columnInfos[range.left + across];
        const wave = info ? waves[info.wave] : undefined;
        if (!info || !wave) return;
        // A paste below the end of a 1-D wave starts at its first free point.
        const start = wave.shape.length === 1 ? Math.min(range.top, wave.shape[0] ?? 0) : range.top;
        edits.push({ wave: info.wave, j: info.j, row: start + down, text: value });
      });
    });
    const commands = tableEditCommands(waves, edits, plane);
    if (commands) runGui(commands);
    else showError("Could not paste", "Some of the pasted cells are not numbers.");
  };

  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>, cut = false) => {
    if (editing) return;
    event.preventDefault();
    const text = selectionText();
    if (text === null) return;
    event.clipboardData.setData("text/plain", text);
    if (cut) clearSelection();
  };

  const headerMenu = (event: React.MouseEvent, info: ColumnInfo) => {
    event.preventDefault();
    const { wave } = info;
    const plain = !waves[wave]?.text && waves[wave]?.shape.length === 1;
    openContextMenu(event, [
      {
        label: `Display ${leafName(wave)}`,
        disabled: !plain,
        onSelect: () => runGui({ op: "display", y: [wave] }),
      },
      {
        label: "Change Wave Scaling…",
        disabled: Boolean(waves[wave]?.text),
        onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave } }),
      },
      {
        label: "Rename or Move…",
        onSelect: () => ui.set({ dialog: { kind: "renameWave", wave } }),
      },
      { separator: true },
      {
        label: `Remove ${leafName(wave)} from Table`,
        onSelect: () => runGui({ op: "removeFromTable", table: name, waves: [wave] }),
      },
    ]);
  };

  const cellMenu = (event: React.MouseEvent, cell: Cell) => {
    event.preventDefault();
    // Right-clicking outside the selection moves it; inside, the selection is the target.
    const inside =
      cell.row >= range.top &&
      cell.row <= range.bottom &&
      cell.column >= range.left &&
      cell.column <= range.right;
    const target = inside ? range : selectionRange(cell, cell);
    if (!inside) select(cell);
    const count = target.bottom - target.top + 1;
    const points = (action: "insert" | "delete"): Command[] =>
      pointCommands(waves, columnInfos, target, action);
    const plural = count === 1 ? "Point" : `${count} Points`;
    const items: MenuItem[] = [
      {
        label: "Clear",
        shortcut: "Del",
        onSelect: () => runGui(clearCommands(waves, columnInfos, target, plane)),
      },
      { separator: true },
      {
        label: `Insert ${plural}`,
        disabled: points("insert").length === 0,
        onSelect: () => runGui(points("insert")),
      },
      {
        label: `Delete ${plural}`,
        disabled: points("delete").length === 0,
        onSelect: () => runGui(points("delete")),
      },
    ];
    // Back to the grid afterwards, so the keyboard keeps working on the selection.
    const refocus = (item: MenuItem): MenuItem => ({
      ...item,
      onSelect: item.onSelect
        ? () => {
            item.onSelect!();
            scrollRef.current?.focus({ preventScroll: true });
          }
        : undefined,
    });
    openContextMenu(event, items.map(refocus));
  };

  // Waves with more than two dimensions are shown one plane at a time.
  const deep = waveNames.map((wave) => waves[wave]).filter((wave) => wave && wave.shape.length > 2);
  const layers = Math.max(1, ...deep.map((wave) => wave!.shape[2] ?? 1));
  const chunks = Math.max(1, ...deep.map((wave) => wave!.shape[3] ?? 1));
  const stepper = (label: string, key: "layer" | "chunk", count: number) => (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        aria-label={label}
        min={0}
        max={count - 1}
        value={Math.min(plane[key], count - 1)}
        className="h-5 w-14 rounded border border-line bg-paper px-1 font-mono"
        onChange={(event) => {
          const value = Math.max(
            0,
            Math.min(count - 1, Math.round(Number(event.target.value) || 0)),
          );
          setPlane({ ...plane, [key]: value });
        }}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <span className="text-muted">of {count}</span>
    </label>
  );

  const totalWidth = columnVirtualizer.getTotalSize();
  const visibleColumns = columnVirtualizer.getVirtualItems();
  const selectedCells = (range.bottom - range.top + 1) * (range.right - range.left + 1);

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Like Igor's entry line: which cell is active, and its value at full precision. */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-line bg-chrome px-2 text-[11.5px]">
        <span className="shrink-0 font-mono text-muted">R{active.row}</span>
        <span className="shrink-0 font-medium">{activeInfo?.title ?? ""}</span>
        <output aria-label="Cell value" className="selectable min-w-0 flex-1 truncate font-mono">
          {cellText(activeInfo, active.row, 17)}
        </output>
        {selectedCells > 1 ? (
          <span className="shrink-0 text-muted">{selectedCells.toLocaleString("en-US")} cells</span>
        ) : null}
        {deep.length > 0 ? stepper("Layer", "layer", layers) : null}
        {chunks > 1 ? stepper("Chunk", "chunk", chunks) : null}
        <label className="flex shrink-0 items-center gap-1">
          Digits
          <select
            aria-label="Digits"
            value={digits}
            className="h-5 rounded border border-line bg-paper font-mono"
            onChange={(event) =>
              runGui({
                op: "modifyTable",
                table: name,
                props: { digits: Number(event.target.value) },
              })
            }
          >
            {[3, 4, 5, 6, 8, 10, 12, 15, 17].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          tabIndex={0}
          role="grid"
          aria-label={name}
          aria-rowcount={rowCount}
          aria-colcount={columnInfos.length}
          className="absolute inset-0 overflow-auto bg-paper font-mono text-[11.5px] outline-none"
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={onCopy}
          onCut={(event) => onCopy(event, true)}
        >
          <div
            role="row"
            className="sticky top-0 z-20 border-b border-line bg-chrome font-sans text-[11.5px]"
            style={{ width: totalWidth, height: HEADER_HEIGHT }}
          >
            <div
              role="columnheader"
              className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-line-soft bg-chrome font-medium text-muted"
              style={{ width: POINT_WIDTH }}
              onPointerDown={() => {
                setAnchor({ row: 0, column: 0 });
                setFocus({ row: rowCount - 1, column: lastColumn });
              }}
            >
              Point
            </div>
            {visibleColumns.map((virtual) => {
              const info = columnInfos[virtual.index]!;
              const header = headers[virtual.index];
              const inRange = virtual.index >= range.left && virtual.index <= range.right;
              return (
                <div
                  key={info.id}
                  role="columnheader"
                  aria-colindex={virtual.index + 1}
                  className={`absolute top-0 flex h-full items-center border-r border-line-soft px-1.5 font-medium ${
                    inRange ? "bg-accent-soft" : ""
                  }`}
                  style={{ left: virtual.start, width: virtual.size }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    // A click on a header selects the whole column; Shift extends across columns.
                    const bottom = Math.max(0, rowsOf(info) - 1);
                    if (!event.shiftKey) setAnchor({ row: 0, column: virtual.index });
                    setFocus({ row: bottom, column: virtual.index });
                  }}
                  onContextMenu={(event) => headerMenu(event, info)}
                >
                  <span className="truncate">{info.title}</span>
                  {header ? (
                    <div
                      className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        header.getResizeHandler()(event);
                      }}
                      onDoubleClick={() =>
                        doc.dispatch({
                          op: "resizeColumn",
                          table: name,
                          wave: info.wave,
                          width: COLUMN_WIDTH,
                        })
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          <div
            className="relative"
            style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth }}
          >
            {rowVirtualizer.getVirtualItems().map((item) => {
              const rowSelected = item.index >= range.top && item.index <= range.bottom;
              return (
                <div
                  key={item.key}
                  role="row"
                  aria-rowindex={item.index + 1}
                  className="absolute left-0"
                  style={{
                    height: ROW_HEIGHT,
                    width: totalWidth,
                    transform: `translateY(${item.start - HEADER_HEIGHT}px)`,
                  }}
                >
                  <div
                    role="rowheader"
                    className={`sticky left-0 z-10 flex h-full items-center justify-end border-b border-r border-line-soft px-1.5 text-muted ${
                      rowSelected ? "bg-accent-soft" : "bg-chrome"
                    }`}
                    style={{ width: POINT_WIDTH }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      // A click on a point number selects the whole row; Shift extends down or up.
                      if (!event.shiftKey) setAnchor({ row: item.index, column: 0 });
                      setFocus({ row: item.index, column: lastColumn });
                    }}
                  >
                    {item.index}
                  </div>
                  {visibleColumns.map((virtual) => {
                    const info = columnInfos[virtual.index]!;
                    const cell = { row: item.index, column: virtual.index };
                    const isText = Boolean(waves[info.wave]?.text);
                    const isActive = cell.row === active.row && cell.column === active.column;
                    const selected =
                      rowSelected && cell.column >= range.left && cell.column <= range.right;
                    const open = editable(info, item.index);
                    return (
                      <div
                        key={info.id}
                        role="gridcell"
                        aria-colindex={virtual.index + 1}
                        aria-selected={selected}
                        className={`absolute top-0 flex h-full items-center ${isText ? "justify-start" : "justify-end"} border-b border-r border-line-soft px-1.5 ${
                          selected && !isActive ? "bg-accent-soft" : open ? "" : "bg-chrome/60"
                        } ${isActive ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
                        style={{ left: virtual.start, width: virtual.size }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          if (editing) commit(null);
                          select(cell, event.shiftKey);
                          dragging.current = true;
                        }}
                        onPointerEnter={() => {
                          if (dragging.current) setFocus(cell);
                        }}
                        onDoubleClick={() => {
                          if (open)
                            setEditing({ text: cellText(info, item.index, 17), invalid: false });
                        }}
                        onContextMenu={(event) => cellMenu(event, cell)}
                      >
                        {isActive && editing ? (
                          <input
                            autoFocus
                            aria-label={`${info.wave} point ${item.index}`}
                            aria-invalid={editing.invalid}
                            value={editing.text}
                            spellCheck={false}
                            className={`absolute inset-0 w-full bg-paper px-1.5 ${isText ? "text-left" : "text-right"} outline outline-2 -outline-offset-2 ${
                              editing.invalid ? "outline-danger" : "outline-accent"
                            }`}
                            onChange={(event) =>
                              setEditing({ text: event.target.value, invalid: false })
                            }
                            onPointerDown={(event) => event.stopPropagation()}
                            onBlur={() => commit(null)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commit({ row: active.row + 1, column: active.column });
                              } else if (event.key === "Tab") {
                                event.preventDefault();
                                commit({
                                  row: active.row,
                                  column: active.column + (event.shiftKey ? -1 : 1),
                                });
                              } else if (event.key === "Escape") {
                                setEditing(null);
                              }
                            }}
                          />
                        ) : (
                          <span className="truncate">{cellText(info, item.index)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

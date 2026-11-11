import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { doc, runGui, showError, ui, useDoc } from "../app/session";
import { DATE_UNIT, leafName } from "../core/doc/types";
import { cellIndex, tableEditCommands, type CellEdit } from "../core/doc/tableEdit";
import { formatDate, formatNumber } from "../core/plot/ticks";
import { openContextMenu } from "./Menu";

const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type Features = typeof features;
/** Rows come straight from the waves through the virtualizer, not from a row model. */
const NO_ROWS: never[] = [];

const ROW_HEIGHT = 20;
const POINT_COLUMN = "__point";

interface Cell {
  row: number;
  /** Index into the table's data columns. */
  column: number;
}

/** One column of the table: a 1-D wave, or one column of a 2-D wave. */
interface ColumnInfo {
  id: string;
  wave: string;
  title: string;
  /** Index along the second dimension, for a 2-D wave. */
  j: number | null;
}

/** A 2-D wave shows at most this many of its columns. */
const MAX_MATRIX_COLUMNS = 256;

export function TableWindow({ name }: { name: string }) {
  const table = useDoc((state) => state.tables[name]);
  const waves = useDoc((state) => state.waves);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Cell>({ row: 0, column: 0 });
  const [editing, setEditing] = useState<{ text: string; invalid: boolean } | null>(null);
  /** Which plane of 3-D and 4-D waves the table shows. */
  const [plane, setPlane] = useState({ layer: 0, chunk: 0 });

  const waveNames = useMemo(() => table?.columns ?? [], [table]);
  // The column layout depends on each wave's shape, not on its values.
  const shapeKey = waveNames.map((wave) => waves[wave]?.shape.join("x")).join(",");
  const columnInfos = useMemo<ColumnInfo[]>(
    () =>
      waveNames.flatMap((wave): ColumnInfo[] => {
        const shape = doc.getState().waves[wave]?.shape ?? [0];
        if (shape.length < 2) return [{ id: wave, wave, title: leafName(wave), j: null }];
        return Array.from({ length: Math.min(shape[1]!, MAX_MATRIX_COLUMNS) }, (_, j) => ({
          id: `${wave}[${j}]`,
          wave,
          title: `${leafName(wave)}[][${j}]`,
          j,
        }));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shapeKey stands in for the shapes
    [waveNames, shapeKey],
  );
  const columns = useMemo<ColumnDef<Features, never>[]>(
    () => [
      { id: POINT_COLUMN, header: "Point", size: 64, minSize: 44, enableResizing: false },
      ...columnInfos.map((info) => ({ id: info.id, header: info.title, size: 96, minSize: 48 })),
    ],
    [columnInfos],
  );
  const model = useTable({ data: NO_ROWS, columns, features, columnResizeMode: "onChange" });
  const headers = model.getHeaderGroups()[0]?.headers ?? [];

  const longest = waveNames.reduce((max, wave) => Math.max(max, waves[wave]?.shape[0] ?? 0), 0);
  // One extra row, so there is always a cell to type the next point into.
  const rowCount = longest + 1;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const column = Math.min(selected.column, Math.max(0, columnInfos.length - 1));
  const row = Math.min(selected.row, rowCount - 1);
  const selectedInfo = columnInfos[column];

  useEffect(() => {
    if (!editing) scrollRef.current?.focus({ preventScroll: true });
  }, [editing]);

  if (!table) return null;

  const select = (next: Cell) => {
    const clamped = {
      row: Math.max(0, Math.min(rowCount - 1, next.row)),
      column: Math.max(0, Math.min(columnInfos.length - 1, next.column)),
    };
    setSelected(clamped);
    virtualizer.scrollToIndex(clamped.row);
  };

  const cellText = (info: ColumnInfo | undefined, index: number): string => {
    const wave = info ? waves[info.wave] : undefined;
    if (!wave || index >= (wave.shape[0] ?? 0)) return "";
    if (wave.text) return wave.text[index] ?? "";
    const value = wave.data[cellIndex(wave, index, info!.j, plane)]!;
    return wave.unit === DATE_UNIT ? formatDate(value) : formatNumber(value, 8);
  };

  /** A cell can be edited if it is an existing point or, in a 1-D wave, the first empty one. */
  const editable = (info: ColumnInfo | undefined, index: number): boolean => {
    const wave = info ? waves[info.wave] : undefined;
    if (!wave) return false;
    const rows = wave.shape[0] ?? 0;
    return wave.shape.length === 1 ? index <= rows : index < rows;
  };

  const beginEdit = (text: string) => {
    if (editable(selectedInfo, row)) setEditing({ text, invalid: false });
  };

  const commit = (move: Cell | null) => {
    if (!editing || !selectedInfo) return;
    const wave = waves[selectedInfo.wave];
    const appending = row === (wave?.shape[0] ?? 0);
    const unchanged = !appending && editing.text === cellText(selectedInfo, row);
    if (!unchanged && !(appending && editing.text.trim() === "")) {
      const edit = { wave: selectedInfo.wave, j: selectedInfo.j, row, text: editing.text };
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
      beginEdit(cellText(selectedInfo, row));
    } else if (
      event.key.length === 1 &&
      (waves[selectedInfo?.wave ?? ""]?.text ? event.key !== " " : /[0-9+\-.eEnN]/.test(event.key))
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
    const rows = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split(/\t|,/));
    // Collect every pasted cell first: the cells of one wave must be written together.
    const edits: CellEdit[] = [];
    rows.forEach((cells, down) => {
      cells.forEach((text, across) => {
        const info = columnInfos[column + across];
        const wave = info ? waves[info.wave] : undefined;
        if (!info || !wave) return;
        // A paste below the end of a 1-D wave starts at its first free point.
        const start = wave.shape.length === 1 ? Math.min(row, wave.shape[0] ?? 0) : row;
        edits.push({ wave: info.wave, j: info.j, row: start + down, text });
      });
    });
    const commands = tableEditCommands(waves, edits, plane);
    if (commands) runGui(commands);
    else showError("Could not paste", "Some of the pasted cells are not numbers.");
  };

  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", cellText(selectedInfo, row));
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
        label: "Change Wave Scaling\u2026",
        disabled: Boolean(waves[wave]?.text),
        onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave } }),
      },
      {
        label: "Rename or Move\u2026",
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
    select(cell);
    const wave = waves[columnInfos[cell.column]?.wave ?? ""];
    if (!wave || wave.shape.length !== 1) return;
    const length = wave.shape[0]!;
    openContextMenu(event, [
      {
        label: "Insert Point",
        disabled: cell.row > length,
        onSelect: () => runGui({ op: "insertPoints", name: wave.name, at: cell.row, count: 1 }),
      },
      {
        label: "Delete Point",
        disabled: cell.row >= length,
        onSelect: () => runGui({ op: "deletePoints", name: wave.name, at: cell.row, count: 1 }),
      },
    ]);
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

  const totalWidth = headers.reduce((sum, header) => sum + header.getSize(), 0);

  return (
    <div className="absolute inset-0 flex flex-col">
      {deep.length > 0 ? (
        <div className="flex h-7 shrink-0 items-center gap-4 border-b border-line bg-chrome px-2 text-[11.5px]">
          {stepper("Layer", "layer", layers)}
          {chunks > 1 ? stepper("Chunk", "chunk", chunks) : null}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
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
                  } ${!isPoint && header.column.id === selectedInfo?.id ? "bg-accent-soft" : ""}`}
                  style={{ width: header.getSize() }}
                  onContextMenu={
                    isPoint
                      ? undefined
                      : (event) => {
                          const info = columnInfos.find((item) => item.id === header.column.id);
                          if (info) headerMenu(event, info);
                        }
                  }
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
          <div
            className="relative"
            style={{ height: virtualizer.getTotalSize(), width: totalWidth }}
          >
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
                  const info = columnInfos[index - 1];
                  const wave = info?.wave ?? "";
                  const isText = Boolean(waves[wave]?.text);
                  const active = cell.row === row && cell.column === column;
                  const open = editable(info, item.index);
                  return (
                    <div
                      key={header.id}
                      role="gridcell"
                      aria-selected={active}
                      className={`relative flex shrink-0 items-center ${isText ? "justify-start" : "justify-end"} border-b border-r border-line-soft px-1.5 ${
                        open ? "" : "bg-chrome/60"
                      } ${active ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
                      style={{ width: header.getSize() }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        if (editing) commit(null);
                        select(cell);
                      }}
                      onDoubleClick={() => {
                        if (open) setEditing({ text: cellText(info, item.index), invalid: false });
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
                        <span className="truncate">{cellText(info, item.index)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

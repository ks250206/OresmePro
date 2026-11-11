import { parseDate, UTC, type TimeZone } from "../plot/ticks";
import type { Command } from "./commands";
import { DATE_UNIT, type Wave } from "./types";

/** One cell typed or pasted into a table. */
export interface CellEdit {
  wave: string;
  /** Index along the second dimension, for a wave with more than one. */
  j: number | null;
  row: number;
  text: string;
}

export interface TablePlane {
  layer: number;
  chunk: number;
}

/** Reads a number as typed into a cell: empty and "nan" are NaN; null if it is not a number. */
export function parseCell(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return Number.NaN;
  if (/^[+-]?nan$/i.test(trimmed)) return Number.NaN;
  const value = Number(trimmed);
  return Number.isNaN(value) ? null : value;
}

/** Position in a wave's data of a table cell, on the plane being shown. */
export function cellIndex(wave: Wave, row: number, j: number | null, plane: TablePlane): number {
  const [, ny = 1, nz = 1, nc = 1] = wave.shape;
  const layer = Math.min(plane.layer, nz - 1);
  const chunk = Math.min(plane.chunk, nc - 1);
  return ((row * ny + (j ?? 0)) * nz + layer) * nc + chunk;
}

/**
 * The commands that store a set of cell edits, one command per wave.
 *
 * Every edit to a wave is applied to a single working copy before the
 * command is made. Cells of a matrix column are not adjacent in memory, so a
 * command per column would each carry a stale copy of the cells between
 * them, and the later ones would undo the earlier.
 *
 * Returns null if any cell does not hold a valid value. Cells outside a
 * multi-dimensional wave are ignored; a 1-D wave grows to take new rows.
 */
export function tableEditCommands(
  waves: Readonly<Record<string, Wave>>,
  edits: readonly CellEdit[],
  plane: TablePlane,
  zone: TimeZone = UTC,
): Command[] | null {
  const byWave = new Map<string, CellEdit[]>();
  for (const edit of edits) {
    const list = byWave.get(edit.wave);
    if (list) list.push(edit);
    else byWave.set(edit.wave, [edit]);
  }
  const commands: Command[] = [];
  for (const [name, cells] of byWave) {
    const wave = waves[name];
    if (!wave) continue;
    const rows = wave.shape[0] ?? 0;
    const flat = wave.shape.length === 1;
    const inside = cells.filter((cell) => cell.row >= 0 && (flat || cell.row < rows));
    if (inside.length === 0) continue;

    // Loops rather than Math.min(...): a paste can have more cells than a call takes arguments.
    if (wave.text) {
      let first = Infinity;
      let last = -Infinity;
      for (const cell of inside) {
        first = Math.min(first, cell.row);
        last = Math.max(last, cell.row);
      }
      const values = Array.from(
        { length: last - first + 1 },
        (_, offset) => wave.text![first + offset] ?? "",
      );
      for (const cell of inside) values[cell.row - first] = cell.text;
      commands.push({ op: "setWaveText", name, start: first, values });
      continue;
    }

    let first = Infinity;
    let last = -Infinity;
    const writes: [number, number][] = [];
    for (const cell of inside) {
      // Dates are typed as dates and stored as seconds.
      const value =
        wave.unit === DATE_UNIT && cell.text.trim() !== ""
          ? parseDate(cell.text, zone)
          : parseCell(cell.text);
      if (value === null) return null;
      const at = flat ? cell.row : cellIndex(wave, cell.row, cell.j, plane);
      writes.push([at, value]);
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
    // One stretch from the first to the last cell touched, holding the
    // current values (NaN beyond the end of a growing wave) with the edits on top.
    const values = Array.from({ length: last - first + 1 }, (_, offset) =>
      first + offset < wave.data.length ? wave.data[first + offset]! : Number.NaN,
    );
    for (const [at, value] of writes) values[at - first] = value;
    commands.push({ op: "setWavePoints", name, start: first, values });
  }
  return commands;
}

/** A cell of a table: a row and the index of a column. */
export interface Cell {
  row: number;
  column: number;
}

/** What a table column shows: a 1-D wave, or one column of a matrix. */
export interface TableColumn {
  wave: string;
  j: number | null;
}

/** A rectangle of cells; all four edges are inside it. */
export interface CellRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The rectangle of cells between two corners, whichever way it was dragged. */
export function selectionRange(a: Cell, b: Cell): CellRange {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.column, b.column),
    right: Math.max(a.column, b.column),
  };
}

/** The commands that blank a range of cells: NaN in numeric waves, "" in text waves. */
export function clearCommands(
  waves: Readonly<Record<string, Wave>>,
  columns: readonly TableColumn[],
  range: CellRange,
  plane: TablePlane,
): Command[] {
  const edits: CellEdit[] = [];
  for (const { wave, j } of columns.slice(range.left, range.right + 1)) {
    // Only points that exist: clearing must not grow a wave.
    const last = Math.min(range.bottom, (waves[wave]?.shape[0] ?? 0) - 1);
    for (let row = range.top; row <= last; row += 1) edits.push({ wave, j, row, text: "" });
  }
  return tableEditCommands(waves, edits, plane) ?? [];
}

/**
 * The commands that insert or delete the rows of a range in every 1-D wave
 * the range touches. Matrices keep their shape, so they are left alone.
 */
export function pointCommands(
  waves: Readonly<Record<string, Wave>>,
  columns: readonly TableColumn[],
  range: CellRange,
  action: "insert" | "delete",
): Command[] {
  const commands: Command[] = [];
  const seen = new Set<string>();
  for (const { wave: name } of columns.slice(range.left, range.right + 1)) {
    const wave = waves[name];
    if (!wave || wave.shape.length !== 1 || seen.has(name)) continue;
    seen.add(name);
    const length = wave.shape[0]!;
    const count = range.bottom - range.top + 1;
    if (action === "insert") {
      if (range.top <= length) commands.push({ op: "insertPoints", name, at: range.top, count });
    } else if (range.top < length) {
      const kept = Math.min(count, length - range.top);
      commands.push({ op: "deletePoints", name, at: range.top, count: kept });
    }
  }
  return commands;
}

import { sanitizeName } from "../doc/commands";
import { parseDate } from "../plot/ticks";

export interface DelimitedResult {
  /** Legal, unique wave names, one per column. */
  names: string[];
  /** Numeric columns as numbers; columns that hold text as strings. */
  columns: (Float64Array | string[])[];
  /** True for columns of dates, stored as seconds since 1970-01-01 UTC. */
  dates: boolean[];
  rows: number;
}

function detectDelimiter(lines: string[]): string | RegExp {
  const sample = lines.slice(0, 20);
  for (const candidate of ["\t", ",", ";"]) {
    const counts = sample.map((line) => line.split(candidate).length - 1);
    if (counts[0]! > 0 && counts.every((count) => count === counts[0])) return candidate;
  }
  for (const candidate of ["\t", ",", ";"]) {
    if (sample.every((line) => line.includes(candidate))) return candidate;
  }
  return /\s+/;
}

const toNumber = (cell: string): number => {
  const text = cell.trim();
  if (text === "") return Number.NaN;
  const value = Number(text);
  return Number.isNaN(value) && !/^[+-]?nan$/i.test(text) ? Number.NaN : value;
};

const isNumeric = (cell: string): boolean => {
  const text = cell.trim();
  return text === "" || /^[+-]?nan$/i.test(text) || !Number.isNaN(Number(text));
};

/**
 * Parses delimited text (CSV, TSV, whitespace-separated) into columns of
 * numbers or text. The delimiter and the presence of a header row are detected.
 * Lines starting with `#` are ignored.
 */
export function parseDelimited(text: string, taken: (name: string) => boolean): DelimitedResult {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (lines.length === 0) return { names: [], columns: [], dates: [], rows: 0 };

  const delimiter = detectDelimiter(lines);
  const split = (line: string): string[] => {
    const cells = (typeof delimiter === "string" ? line : line.trim()).split(delimiter);
    return cells.map((cell) => cell.trim().replace(/^"(.*)"$/, "$1"));
  };
  const rows = lines.map(split);
  const hasHeader = rows[0]!.some((cell) => cell.trim() !== "" && !isNumeric(cell));
  const header = hasHeader ? rows.shift()! : [];
  const width = Math.max(header.length, ...rows.map((row) => row.length));

  const names: string[] = [];
  const columns: (Float64Array | string[])[] = [];
  const dates: boolean[] = [];
  const used = new Set<string>();
  for (let column = 0; column < width; column += 1) {
    const title = header[column]?.trim() || `column${column}`;
    const data = new Float64Array(rows.length);
    let numeric = 0;
    let filled = 0;
    rows.forEach((row, index) => {
      const cell = row[column] ?? "";
      data[index] = toNumber(cell);
      if (cell.trim() !== "") {
        filled += 1;
        if (isNumeric(cell)) numeric += 1;
      }
    });
    // A column counts as text when most of its filled cells are not numbers...
    let isText = filled > 0 && numeric < filled / 2;
    // ...unless every filled cell is a date, which is stored as a number of seconds.
    let isDate = false;
    if (isText) {
      const seconds = rows.map((row) => {
        const cell = (row[column] ?? "").trim();
        return cell === "" ? Number.NaN : parseDate(cell);
      });
      if (seconds.every((value) => value !== null)) {
        data.set(seconds as number[]);
        isText = false;
        isDate = true;
      }
    }
    const base = sanitizeName(title, "wave");
    let name = base;
    for (let suffix = 1; used.has(name) || taken(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    names.push(name);
    columns.push(isText ? rows.map((row) => row[column] ?? "") : data);
    dates.push(isDate);
  }
  return { names, columns, dates, rows: rows.length };
}

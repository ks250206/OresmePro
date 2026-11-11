import { sanitizeName } from "../doc/commands";
import { parseDate, UTC, type TimeZone } from "../plot/ticks";

export interface DelimitedResult {
  /** Legal, unique wave names, one per column. */
  names: string[];
  /** Numeric columns as numbers; columns that hold text as strings. */
  columns: (Float64Array | string[])[];
  /** True for columns of dates, stored as seconds since 1970-01-01 UTC. */
  dates: boolean[];
  rows: number;
}

/**
 * Splits one record on a single-character delimiter, honouring double
 * quotes: a quoted field may contain the delimiter, and `""` inside quotes
 * is a literal quote. Returns null if a quote is left open, which means the
 * record continues on the next line.
 */
export function splitQuoted(record: string, delimiter: string): string[] | null {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  /** True once the field has had a quoted part; its spacing is then kept. */
  let wasQuoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const char = record[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (record[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"' && cell.trim() === "") {
      quoted = true;
      wasQuoted = true;
      cell = "";
    } else if (char === delimiter) {
      cells.push(wasQuoted ? cell : cell.trim());
      cell = "";
      wasQuoted = false;
    } else if (!wasQuoted || char.trim() !== "") {
      cell += char;
    }
  }
  if (quoted) return null;
  cells.push(wasQuoted ? cell : cell.trim());
  return cells;
}

/**
 * Splits lines into records of fields. A quoted field can hold a line
 * break, so lines are joined until the quotes close.
 */
function splitRecords(lines: readonly string[], delimiter: string): string[][] {
  const rows: string[][] = [];
  let pending = "";
  for (const line of lines) {
    const record = pending === "" ? line : `${pending}\n${line}`;
    const cells = splitQuoted(record, delimiter);
    if (cells) {
      rows.push(cells);
      pending = "";
    } else {
      pending = record;
    }
  }
  // An unclosed quote at the end of the file: take the rest as it stands.
  if (pending !== "") rows.push(pending.split(delimiter).map((cell) => cell.trim()));
  return rows;
}

function detectDelimiter(lines: string[]): string | RegExp {
  // Judge by records, not lines, and by delimiters outside quotes, so that
  // "a,b" and quoted line breaks do not disguise the structure.
  const sample = lines.slice(0, 40);
  const candidates = ["\t", ",", ";"].map((candidate) => ({
    candidate,
    counts: splitRecords(sample, candidate).map((cells) => cells.length - 1),
  }));
  const regular = candidates.find(
    ({ counts }) => counts[0]! > 0 && counts.every((count) => count === counts[0]),
  );
  if (regular) return regular.candidate;
  const present = candidates.find(({ counts }) => counts.every((count) => count > 0));
  return present ? present.candidate : /\s+/;
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
 * Lines starting with `#` are ignored. Dates written without a UTC offset
 * are taken to be in `zone`.
 */
export function parseDelimited(
  text: string,
  taken: (name: string) => boolean,
  zone: TimeZone = UTC,
): DelimitedResult {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (lines.length === 0) return { names: [], columns: [], dates: [], rows: 0 };

  const delimiter = detectDelimiter(lines);
  const rows =
    typeof delimiter === "string"
      ? splitRecords(lines, delimiter)
      : lines.map((line) => line.trim().split(delimiter));
  const hasHeader = rows[0]!.some((cell) => cell.trim() !== "" && !isNumeric(cell));
  const header = hasHeader ? rows.shift()! : [];
  // A loop, not Math.max(...): a file can have more rows than a call can take arguments.
  let width = header.length;
  for (const row of rows) width = Math.max(width, row.length);

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
        return cell === "" ? Number.NaN : parseDate(cell, zone);
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

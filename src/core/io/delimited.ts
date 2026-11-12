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

/** Excel's error values, which it also writes into CSV files. */
const EXCEL_ERRORS = /^#(?:N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!)$/i;

/**
 * Words that stand for a missing value. "NA" only in one case: "Na" is
 * sodium, which is as likely in scientific data as R's "not available".
 */
const MISSING = /^(?:[+-]?nan|n\/a|null|none|-|--)$/i;

const INFINITY = /^([+-]?)inf(?:inity)?$/i;

/** What a cell holds, as far as deciding the type of its column goes. */
type CellKind = "empty" | "missing" | "number" | "date" | "text";

function cellKind(cell: string): CellKind {
  const text = cell.trim();
  if (text === "") return "empty";
  if (isMissing(text)) return "missing";
  if (!Number.isNaN(Number(text)) || INFINITY.test(text)) return "number";
  return parseDate(text) === null ? "text" : "date";
}

function isMissing(text: string): boolean {
  return text === "NA" || text === "na" || MISSING.test(text) || EXCEL_ERRORS.test(text);
}

/** The value of a cell of a numeric column: NaN for a missing value. */
function numberOf(cell: string): number {
  const text = cell.trim();
  const infinity = INFINITY.exec(text);
  if (infinity) return infinity[1] === "-" ? -Infinity : Infinity;
  return text === "" || isMissing(text) ? Number.NaN : Number(text);
}

/**
 * The type of a column from the kinds of its cells: numbers when every
 * filled cell is a number or a missing value, dates when every one is a date
 * or missing, text otherwise.
 */
function columnKind(kinds: readonly CellKind[]): "number" | "date" | "text" {
  const dates = kinds.includes("date");
  if (kinds.includes("text") || (dates && kinds.includes("number"))) return "text";
  return dates ? "date" : "number";
}

/**
 * A line starting with `#` is a comment, unless it starts with one of
 * Excel's error values, such as `#N/A`, in its first cell.
 */
function isComment(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith("#") && !EXCEL_ERRORS.test(/^[^\s,;]*/.exec(text)![0]);
}

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
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "" && !isComment(line));
  if (lines.length === 0) return { names: [], columns: [], dates: [], rows: 0 };

  const delimiter = detectDelimiter(lines);
  const rows =
    typeof delimiter === "string"
      ? splitRecords(lines, delimiter)
      : lines.map((line) => line.trim().split(delimiter));
  return columnsFromRows(rows, taken, zone);
}

/**
 * Turns rows of cells (from delimited text or a spreadsheet) into columns:
 * numbers, dates or text, named from a header row if there is one.
 */
export function columnsFromRows(
  rows: string[][],
  taken: (name: string) => boolean,
  zone: TimeZone = UTC,
): DelimitedResult {
  if (rows.length === 0) return { names: [], columns: [], dates: [], rows: 0 };
  rows = [...rows];
  const hasHeader = rows[0]!.some((cell) => ["text", "date"].includes(cellKind(cell)));
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
    const cells = rows.map((row) => row[column] ?? "");
    const kind = columnKind(cells.map(cellKind));
    const isText = kind === "text";
    const isDate = kind === "date";
    const data = new Float64Array(rows.length);
    if (isDate) {
      // Dates are stored as seconds; parseDate is not null for any cell judged a date.
      cells.forEach((cell, index) => {
        data[index] = cellKind(cell) === "date" ? parseDate(cell.trim(), zone)! : Number.NaN;
      });
    } else if (!isText) {
      cells.forEach((cell, index) => (data[index] = numberOf(cell)));
    }
    const base = sanitizeName(title, "wave");
    let name = base;
    for (let suffix = 1; used.has(name) || taken(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    names.push(name);
    columns.push(isText ? cells : data);
    dates.push(isDate);
  }
  return { names, columns, dates, rows: rows.length };
}

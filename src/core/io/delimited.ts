import { sanitizeName } from "../doc/commands";
import { parseDate, UTC, type TimeZone } from "../plot/ticks";

/** How a column is read: `auto` decides from its cells, `skip` leaves it out. */
export type ColumnType = "auto" | "number" | "date" | "text" | "skip";

/** What the user chose for one column, overriding what the file suggests. */
export interface ColumnChoice {
  name?: string;
  type?: ColumnType;
  unit?: string;
}

/** How a table of cells is turned into columns. Everything left out is detected. */
export interface TableOptions {
  /** Rows (for text: lines) above the table to pass over. */
  skip?: number;
  /** Whether the first row names the columns. */
  header?: "auto" | "yes" | "no";
  /**
   * Where units are written: `auto` takes them from a header such as
   * "Voltage (V)" or "Voltage [V]", `slash` from "Voltage/V", `row` from the
   * row below the header.
   */
  units?: "auto" | "slash" | "row" | "none";
  /** The decimal mark of the numbers. With a comma, a point groups thousands. */
  decimal?: "." | ",";
  /** Choices by column, counted from 0 in the file. */
  columns?: Readonly<Record<number, ColumnChoice>>;
}

export type Delimiter = "tab" | "comma" | "semicolon" | "space";

export interface TextOptions extends TableOptions {
  delimiter?: "auto" | Delimiter;
  /** Lines starting with this are passed over; "" for none. */
  comment?: string;
  /** Reads no more than this many rows, for a preview of a long file. */
  limit?: number;
}

export interface DelimitedResult {
  /** Legal, unique wave names, one per column. */
  names: string[];
  /** Numeric columns as numbers; columns that hold text as strings. */
  columns: (Float64Array | string[])[];
  /** True for columns of dates, stored as seconds since 1970-01-01 UTC. */
  dates: boolean[];
  /** The unit of each column, "" if none was found or given. */
  units: string[];
  /** Which column of the file each one is: columns can be left out. */
  indices: number[];
  /**
   * For each column, the rows whose cell says something that could not be
   * read as the column's type and became NaN. Only a column whose type was
   * chosen has any: one left to be detected becomes text instead.
   */
  unreadable: number[][];
  rows: number;
  /** How the table was found to be laid out. */
  hasHeader: boolean;
  /** Null for a table that did not come from text. */
  delimiter: Delimiter | null;
  /** The lines (for a sheet: rows) passed over above the table, given or found. */
  skip: number;
  /** The cells the columns were read from, row by row, all columns of the file. */
  cells: string[][];
  /** The cells of the header row, or [] without one. */
  header: string[];
  /** How many columns the file has, counting those left out. */
  width: number;
}

const EMPTY: DelimitedResult = {
  names: [],
  columns: [],
  dates: [],
  units: [],
  indices: [],
  unreadable: [],
  rows: 0,
  hasHeader: false,
  delimiter: null,
  skip: 0,
  cells: [],
  header: [],
  width: 0,
};

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
 * Splits lines into records of fields, at most `limit` of them. A quoted
 * field can hold a line break, so lines are joined until the quotes close.
 * Blank lines and comments are skipped only between records: inside a
 * quoted field they are part of its text.
 */
function splitRecords(
  lines: readonly string[],
  delimiter: string,
  comment: string,
  limit = Infinity,
): string[][] {
  const rows: string[][] = [];
  let pending = "";
  for (const line of lines) {
    if (rows.length >= limit) return rows;
    if (pending === "" && skipped(line, comment)) continue;
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

const DELIMITERS: Record<Exclude<Delimiter, "space">, string> = {
  tab: "\t",
  comma: ",",
  semicolon: ";",
};

/** How many lines are looked at to find where the table starts and what separates its columns. */
const SAMPLE_LINES = 400;

/**
 * Finds what separates the columns and how many lines stand above the
 * table. Instruments write a few lines about the measurement first; the
 * table is where the lines begin to have the same number of columns, and
 * the delimiter is the one for which that happens earliest.
 */
function detectLayout(
  lines: readonly string[],
  comment: string,
  decimal: string,
): { delimiter: Delimiter; skip: number } {
  const sample = lines.slice(0, SAMPLE_LINES);
  // Where the comma is the decimal mark it does not also separate the columns.
  const names = (["tab", "comma", "semicolon", "space"] as const).filter(
    (name) => !(name === "comma" && decimal === ","),
  );
  let best: { delimiter: Delimiter; skip: number } | null = null;
  for (const delimiter of names) {
    // The number of delimiters on each line that holds a record, with the line's index.
    const counts: [number, number][] = [];
    sample.forEach((line, index) => {
      if (skipped(line, comment)) return;
      const cells =
        delimiter === "space" ? line.trim().split(/\s+/) : splitQuoted(line, DELIMITERS[delimiter]);
      // A quote left open continues on the next line: such a file is not judged by lines.
      counts.push([index, cells ? cells.length - 1 : -1]);
    });
    if (counts.length === 0) continue;
    const last = counts.at(-1)![1];
    if (last <= 0) continue;
    let start = counts.length - 1;
    while (start > 0 && counts[start - 1]![1] === last) start -= 1;
    // One line alone is no table, unless it is all there is.
    if (counts.length - start < 2 && counts.length > 1) continue;
    const skip = start === 0 ? 0 : counts[start]![0];
    if (!best || skip < best.skip) best = { delimiter, skip };
  }
  if (best) return best;
  // No run of like lines (quoted cells that span lines, ragged rows): judge by
  // records instead, by delimiters outside quotes.
  const candidates = names
    .filter((name) => name !== "space")
    .map((candidate) => ({
      candidate,
      counts: splitRecords(sample, DELIMITERS[candidate], comment, 40).map(
        (cells) => cells.length - 1,
      ),
    }));
  const regular = candidates.find(
    ({ counts }) => counts[0]! > 0 && counts.every((count) => count === counts[0]),
  );
  if (regular) return { delimiter: regular.candidate, skip: 0 };
  const present = candidates.find(({ counts }) => counts.every((count) => count > 0));
  return { delimiter: present ? present.candidate : "space", skip: 0 };
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

/** A number written with a decimal comma, with or without points grouping thousands. */
const COMMA_NUMBER = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d*)(?:,\d*)?(?:[eE][+-]?\d+)?$/;

/** The number a cell's text says, or NaN if it is not one. */
function toNumber(text: string, decimal: string): number {
  const infinity = INFINITY.exec(text);
  if (infinity) return infinity[1] === "-" ? -Infinity : Infinity;
  // A number written with a point still reads in a file of decimal commas.
  if (decimal !== "," || !text.includes(",")) return Number(text);
  return COMMA_NUMBER.test(text) ? Number(text.replaceAll(".", "").replace(",", ".")) : Number.NaN;
}

/**
 * The number a cell says, as a table takes it when typed or pasted: NaN for
 * an empty cell or a marker of a missing value, null if it is not a number.
 */
export function readNumber(cell: string): number | null {
  const text = cell.trim();
  if (text === "" || isMissing(text)) return Number.NaN;
  const value = toNumber(text, ".");
  return Number.isNaN(value) ? null : value;
}

function cellKind(cell: string, decimal: string): CellKind {
  const text = cell.trim();
  if (text === "") return "empty";
  if (isMissing(text)) return "missing";
  if (!Number.isNaN(toNumber(text, decimal))) return "number";
  return parseDate(text) === null ? "text" : "date";
}

function isMissing(text: string): boolean {
  return text === "NA" || text === "na" || MISSING.test(text) || EXCEL_ERRORS.test(text);
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
 * A line starting with the comment marker is a comment, unless (the marker
 * being `#`) it starts with one of Excel's error values, such as `#N/A`.
 */
function isComment(line: string, comment: string): boolean {
  if (comment === "") return false;
  const text = line.trimStart();
  if (!text.startsWith(comment)) return false;
  return comment !== "#" || !EXCEL_ERRORS.test(/^[^\s,;]*/.exec(text)![0]);
}

/** A line that holds no record: blank, or a comment. */
const skipped = (line: string, comment: string): boolean =>
  line.trim() === "" || isComment(line, comment);

/**
 * Parses delimited text (CSV, TSV, whitespace-separated) into columns of
 * numbers, dates or text. What the options leave out is detected: the
 * delimiter, whether there is a header row, and the type of each column.
 * Blank lines and comment lines are ignored, except inside a quoted field.
 * Dates written without a UTC offset are taken to be in `zone`.
 */
export function parseDelimited(
  text: string,
  taken: (name: string) => boolean,
  zone: TimeZone = UTC,
  options: TextOptions = {},
): DelimitedResult {
  const comment = options.comment ?? "#";
  let lines = text.split(/\r\n|\n|\r/).slice(Math.max(0, options.skip ?? 0));
  if (lines.every((line) => skipped(line, comment))) return EMPTY;

  const chosen = options.delimiter ?? "auto";
  // Lines above the table are looked for only when their number was not given.
  const layout = detectLayout(lines, comment, options.decimal ?? ".");
  const delimiter = chosen === "auto" ? layout.delimiter : chosen;
  const skip = options.skip ?? (chosen === "auto" ? layout.skip : 0);
  if (options.skip === undefined) lines = lines.slice(skip);
  // A header and a row of units are records too: two more than the rows asked for.
  const limit = options.limit === undefined ? Infinity : options.limit + 2;
  let rows: string[][];
  if (delimiter === "space") {
    rows = [];
    for (const line of lines) {
      if (rows.length >= limit) break;
      if (!skipped(line, comment)) rows.push(line.trim().split(/\s+/));
    }
  } else {
    rows = splitRecords(lines, DELIMITERS[delimiter], comment, limit);
  }
  return { ...columnsFromRows(rows, taken, zone, { ...options, skip: 0 }), delimiter, skip };
}

/**
 * Whether the first row names the columns, judged column by column. Text
 * above a column of numbers or dates says it does; a number or date above a
 * column of the same says it is data; anything else says nothing. With
 * nothing to go on either way, the first row is a header if it has text.
 */
function isHeader(kinds: readonly CellKind[][]): boolean {
  const [first, ...rest] = kinds;
  let against = false;
  for (let column = 0; column < first!.length; column += 1) {
    const top = first![column]!;
    if (top === "empty" || top === "missing") continue;
    const below = rest.map((row) => row[column] ?? "empty");
    const kind = columnKind(below);
    // A column with nothing but missing values below is no evidence.
    if (kind === "text" || !below.includes(kind)) continue;
    if (top === "text") return true;
    if (top === kind) against = true;
  }
  return !against && first!.includes("text");
}

const BRACKETED = /^(.*?\S)\s*(?:\(([^()]{1,24})\)|\[([^[\]]{1,24})\])$/;
const SLASHED = /^(.*?\S)\s*\/\s*([^/\s]{1,24})$/;

/** A header cell as a title and the unit written with it. */
function splitUnit(title: string, units: TableOptions["units"]): [string, string] {
  const text = title.trim();
  if (units === "auto") {
    const match = BRACKETED.exec(text);
    if (match) return [match[1]!, (match[2] ?? match[3])!.trim()];
  } else if (units === "slash") {
    const match = SLASHED.exec(text);
    if (match) return [match[1]!, match[2]!];
  }
  return [text, ""];
}

/** How many rows of a column are listed as unreadable; a preview shows no more. */
const UNREADABLE_LISTED = 1000;

/**
 * Turns rows of cells (from delimited text or a spreadsheet) into columns:
 * numbers, dates or text, named from a header row if there is one.
 */
export function columnsFromRows(
  rows: string[][],
  taken: (name: string) => boolean,
  zone: TimeZone = UTC,
  options: TableOptions = {},
): DelimitedResult {
  const skip = Math.max(0, options.skip ?? 0);
  rows = rows.slice(skip);
  if (rows.length === 0) return EMPTY;
  const decimal = options.decimal ?? ".";
  const units = options.units ?? "auto";
  // Each cell is judged once; the header and the columns are both decided from this.
  let kinds = rows.map((row) => row.map((cell) => cellKind(cell, decimal)));
  const hasHeader = options.header === "yes" || (options.header !== "no" && isHeader(kinds));
  const header = hasHeader ? rows[0]! : [];
  let first = hasHeader ? 1 : 0;
  // A row of units is one with no number or date in it.
  const unitRow =
    units === "row" &&
    hasHeader &&
    rows.length > first &&
    kinds[first]!.every((kind) => kind === "text" || kind === "empty" || kind === "missing")
      ? rows[first]!
      : null;
  if (unitRow) first += 1;
  rows = rows.slice(first);
  kinds = kinds.slice(first);
  // A loop, not Math.max(...): a file can have more rows than a call can take arguments.
  let width = header.length;
  for (const row of rows) width = Math.max(width, row.length);

  const result: DelimitedResult = {
    ...EMPTY,
    names: [],
    columns: [],
    dates: [],
    units: [],
    indices: [],
    unreadable: [],
    rows: rows.length,
    hasHeader,
    skip,
    cells: rows,
    header,
    width,
  };
  const used = new Set<string>();
  for (let column = 0; column < width; column += 1) {
    const choice = options.columns?.[column] ?? {};
    if (choice.type === "skip") continue;
    const [title, written] = splitUnit(header[column] ?? "", units);
    const columnKinds = kinds.map((row) => row[column] ?? "empty");
    const kind =
      choice.type === undefined || choice.type === "auto" ? columnKind(columnKinds) : choice.type;
    const cells = rows.map((row) => row[column] ?? "");
    const data = new Float64Array(kind === "text" ? 0 : rows.length);
    const unreadable: number[] = [];
    if (kind !== "text") {
      cells.forEach((cell, index) => {
        const held = columnKinds[index]!;
        if (held === kind) {
          const text = cell.trim();
          // parseDate is not null for a cell judged a date.
          data[index] = kind === "date" ? parseDate(text, zone)! : toNumber(text, decimal);
          return;
        }
        data[index] = Number.NaN;
        if (held !== "empty" && held !== "missing" && unreadable.length < UNREADABLE_LISTED) {
          unreadable.push(index);
        }
      });
    }
    const base = sanitizeName(choice.name?.trim() || title || `column${column}`, "wave");
    let name = base;
    for (let suffix = 1; used.has(name) || taken(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    result.names.push(name);
    result.columns.push(kind === "text" ? cells : data);
    result.dates.push(kind === "date");
    result.units.push(choice.unit ?? (unitRow?.[column]?.trim() || written));
    result.indices.push(column);
    result.unreadable.push(unreadable);
  }
  return result;
}

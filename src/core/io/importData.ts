import { uniqueName, type Command } from "../doc/commands";
import { pyLiteral } from "../doc/echo";
import { DATE_UNIT, type DocState } from "../doc/types";
import { timeZone } from "../plot/ticks";
import {
  columnsFromRows,
  parseDelimited,
  type ColumnChoice,
  type DelimitedResult,
  type TextOptions,
} from "./delimited";
import { readXlsx, type Sheet } from "./xlsx";

export const ENCODINGS = [
  "auto",
  "utf-8",
  "shift_jis",
  "euc-jp",
  "utf-16le",
  "utf-16be",
  "windows-1252",
] as const;
export type Encoding = (typeof ENCODINGS)[number];

/**
 * How a file of data is read into waves: what the reader of the table is
 * told (see TextOptions), and what is made of the columns afterwards.
 * Everything left out is detected or takes its default.
 */
export interface ImportSettings extends TextOptions {
  /** How the bytes of a text file spell characters. */
  encoding?: Encoding;
  /** Workbooks: the sheets to read; all that have cells if left out. */
  sheets?: readonly string[];
  /** Whether a table of the new waves is opened. Defaults to true. */
  table?: boolean;
  /** Whether a graph of the numeric columns is made. */
  graph?: boolean;
  /** The column (counted from 0 in the file) the others are plotted against. */
  x?: number;
  /** Error bars: for a column of values, the column that holds its uncertainties. */
  errors?: Readonly<Record<number, number>>;
}

/** The text a file's bytes spell, and the encoding that was used to read them. */
export function decodeText(
  bytes: Uint8Array,
  encoding: Encoding = "auto",
): { text: string; encoding: Exclude<Encoding, "auto"> } {
  const decode = (name: string, fatal: boolean) => new TextDecoder(name, { fatal }).decode(bytes);
  if (encoding !== "auto") return { text: decode(encoding, false), encoding };
  // A byte order mark settles it (the decoder drops the mark itself).
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode("utf-8", false), encoding: "utf-8" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode("utf-16le", false), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode("utf-16be", false), encoding: "utf-16be" };
  }
  // Otherwise the first encoding the bytes are valid in. Text in UTF-8 is
  // rarely valid Shift_JIS and the reverse, so the order decides little; the
  // last one accepts any bytes.
  for (const name of ["utf-8", "shift_jis", "euc-jp"] as const) {
    try {
      return { text: decode(name, true), encoding: name };
    } catch {
      // Not this one.
    }
  }
  return { text: decode("windows-1252", false), encoding: "windows-1252" };
}

/** One table read from a file: a sheet of a workbook, or the whole of a text file. */
export interface ImportedTable {
  /** The sheet's name; null for a text file. */
  sheet: string | null;
  result: DelimitedResult;
}

export interface ImportPlan {
  tables: ImportedTable[];
  /** The commands that make the waves, the tables and the graph. */
  commands: Command[];
  /** One line per table saying what was read, for the history. */
  summary: string[];
  /** The encoding a text file was read in. */
  encoding: Exclude<Encoding, "auto"> | null;
}

const isWorkbook = (name: string): boolean => /\.(xlsx|xlsm|xls)$/i.test(name);

/** Whether a file is read as a workbook rather than as text. */
export const importKind = (name: string): "excel" | "text" => (isWorkbook(name) ? "excel" : "text");

/** The sheets of a workbook that the settings ask for. */
export function chosenSheets(sheets: readonly Sheet[], settings: ImportSettings): Sheet[] {
  if (!settings.sheets) return [...sheets];
  for (const name of settings.sheets) {
    if (!sheets.some((sheet) => sheet.name === name)) {
      throw new Error(
        `There is no sheet named ${JSON.stringify(name)}. Sheets: ${sheets.map((sheet) => sheet.name).join(", ")}.`,
      );
    }
  }
  return sheets.filter((sheet) => settings.sheets!.includes(sheet.name));
}

/**
 * Reads a file and works out the commands that bring it into the document:
 * a wave per column, a table per sheet and, if asked for, a graph. Nothing is
 * changed here; the caller runs the commands.
 *
 * `source` names the file in the notes of the waves; `digest` (a hash of its
 * bytes), if given, is recorded with it so that the data can be traced back
 * to the file it came from.
 */
export function planImport(
  bytes: Uint8Array,
  filename: string,
  settings: ImportSettings,
  state: DocState,
  digest?: string,
  kind: "excel" | "text" = importKind(filename),
): ImportPlan {
  const zone = timeZone(state.timeZone);
  // Columns of later sheets are named to avoid those of the sheets before.
  const made = new Set<string>();
  const taken = (name: string) => name in state.waves || made.has(name);
  const tables: ImportedTable[] = [];
  let encoding: ImportPlan["encoding"] = null;
  if (kind === "excel") {
    for (const sheet of chosenSheets(readXlsx(bytes), settings)) {
      const result = columnsFromRows(sheet.rows, taken, zone, settings);
      for (const name of result.names) made.add(name);
      tables.push({ sheet: sheet.name, result });
    }
  } else {
    const decoded = decodeText(bytes, settings.encoding);
    encoding = decoded.encoding;
    tables.push({ sheet: null, result: parseDelimited(decoded.text, taken, zone, settings) });
  }

  const commands: Command[] = [];
  const summary: string[] = [];
  const windows = new Set(state.windows.map((window) => window.name));
  for (const { sheet, result } of tables) {
    if (result.names.length === 0) continue;
    const source = sheet === null ? filename : `${filename}, sheet ${sheet}`;
    const note = `Loaded from ${source}${digest ? ` (SHA-256 ${digest})` : ""}`;
    result.names.forEach((name, index) => {
      const column = result.columns[index]!;
      const unit = result.dates[index] ? DATE_UNIT : result.units[index];
      const loaded = { op: "makeWave" as const, name, note, ...(unit ? { unit } : {}) };
      commands.push(
        column instanceof Float64Array ? { ...loaded, data: column } : { ...loaded, text: column },
      );
    });
    if (settings.table !== false) commands.push({ op: "edit", waves: result.names });
    if (settings.graph) commands.push(...graphCommands(result, settings, windows));
    const unread = result.unreadable
      .map((rows, index) => (rows.length > 0 ? `${result.names[index]} (${rows.length})` : ""))
      .filter(Boolean);
    summary.push(
      `${sheet === null ? "" : `${sheet}: `}${result.names.join(", ")} (${result.rows} points each)` +
        (unread.length > 0 ? `; cells that could not be read: ${unread.join(", ")}` : ""),
    );
  }
  return { tables, commands, summary, encoding };
}

/** A graph of a table's numeric columns against its X column, with error bars as chosen. */
function graphCommands(
  result: DelimitedResult,
  settings: ImportSettings,
  windows: Set<string>,
): Command[] {
  const nameOf = (column: number | undefined): string | undefined => {
    const index = column === undefined ? -1 : result.indices.indexOf(column);
    return index >= 0 && result.columns[index] instanceof Float64Array
      ? result.names[index]
      : undefined;
  };
  const x = nameOf(settings.x);
  const errors = Object.entries(settings.errors ?? {});
  const errorColumns = new Set(errors.map(([, column]) => column));
  const y = result.names.filter(
    (name, index) =>
      result.columns[index] instanceof Float64Array &&
      name !== x &&
      !errorColumns.has(result.indices[index]!),
  );
  if (y.length === 0) return [];
  // Named here, so that the traces can be given their error bars below.
  const graph = uniqueName("Graph", (name) => windows.has(name));
  windows.add(graph);
  const commands: Command[] = [{ op: "display", y, x: x ?? null, name: graph }];
  for (const [column, errorColumn] of errors) {
    const trace = nameOf(Number(column));
    const error = nameOf(errorColumn);
    if (trace && error && y.includes(trace)) {
      commands.push({ op: "modifyTrace", graph, trace, props: { yError: error } });
    }
  }
  return commands;
}

/** The settings that differ from what is detected or default, in a stable order. */
function givenSettings(settings: ImportSettings): [string, unknown][] {
  const given: [string, unknown][] = [];
  const add = (key: string, value: unknown, fallback: unknown) => {
    if (value !== undefined && value !== fallback) given.push([key, value]);
  };
  add("sheets", settings.sheets, undefined);
  add("encoding", settings.encoding, "auto");
  add("delimiter", settings.delimiter, "auto");
  add("decimal", settings.decimal, ".");
  add("comment", settings.comment, "#");
  add("skip", settings.skip, undefined);
  add("header", settings.header, "auto");
  add("units", settings.units, "auto");
  const columns = Object.entries(settings.columns ?? {}).filter(
    ([, choice]) => Object.keys(cleanChoice(choice)).length > 0,
  );
  if (columns.length > 0) given.push(["columns", columns]);
  add("x", settings.x, undefined);
  if (Object.keys(settings.errors ?? {}).length > 0) given.push(["errors", settings.errors]);
  add("graph", settings.graph, false);
  add("table", settings.table, true);
  return given;
}

/** A column's choices without those that say nothing. */
function cleanChoice(choice: ColumnChoice): ColumnChoice {
  const clean: ColumnChoice = {};
  if (choice.name?.trim()) clean.name = choice.name.trim();
  if (choice.type && choice.type !== "auto") clean.type = choice.type;
  if (choice.unit !== undefined) clean.unit = choice.unit;
  return clean;
}

const pyDict = (entries: [string, string][]): string =>
  `{${entries.map(([key, value]) => `${key}: ${value}`).join(", ")}}`;

/** The Python that reads a file of the experiment the way these settings say. */
export function importPython(filename: string, settings: ImportSettings): string {
  const args = [pyLiteral(filename)];
  for (const [key, value] of givenSettings(settings)) {
    if (key === "columns") {
      const columns = (value as [string, ColumnChoice][]).map(
        ([column, choice]): [string, string] => [
          column,
          pyDict(
            Object.entries(cleanChoice(choice)).map(([name, item]): [string, string] => [
              pyLiteral(name),
              pyLiteral(item),
            ]),
          ),
        ],
      );
      args.push(`columns=${pyDict(columns)}`);
    } else if (key === "errors") {
      const errors = Object.entries(value as Record<number, number>);
      args.push(`errors=${pyDict(errors.map(([column, error]) => [column, String(error)]))}`);
    } else {
      args.push(`${key}=${pyLiteral(value)}`);
    }
  }
  return `op.${importKind(filename) === "excel" ? "load_excel" : "load_text"}(${args.join(", ")})`;
}

/** Settings as they came from somewhere else (Python, a saved preset), checked. */
export function checkSettings(value: unknown): ImportSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Import settings must be an object.");
  }
  const input = value as Record<string, unknown>;
  const settings: ImportSettings = {};
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const item = input[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new Error(`${key} must be one of ${allowed.join(", ")}.`);
    }
    return item as T;
  };
  const count = (key: string): number | undefined => {
    const item = input[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0) {
      throw new Error(`${key} must be a whole number, 0 or more.`);
    }
    return item;
  };
  const flag = (key: string): boolean | undefined => {
    const item = input[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "boolean") throw new Error(`${key} must be true or false.`);
    return item;
  };
  const known = new Set([
    "encoding",
    "sheets",
    "delimiter",
    "decimal",
    "comment",
    "skip",
    "header",
    "units",
    "columns",
    "x",
    "errors",
    "graph",
    "table",
    "limit",
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`Unknown import setting ${JSON.stringify(key)}.`);
  }
  const assign = <K extends keyof ImportSettings>(key: K, item: ImportSettings[K] | undefined) => {
    if (item !== undefined) settings[key] = item;
  };
  assign("encoding", oneOf("encoding", ENCODINGS));
  assign("delimiter", oneOf("delimiter", ["auto", "tab", "comma", "semicolon", "space"] as const));
  assign("decimal", oneOf("decimal", [".", ","] as const));
  assign("header", oneOf("header", ["auto", "yes", "no"] as const));
  assign("units", oneOf("units", ["auto", "slash", "row", "none"] as const));
  assign("skip", count("skip"));
  assign("limit", count("limit"));
  assign("x", count("x"));
  assign("graph", flag("graph"));
  assign("table", flag("table"));
  if (input.comment !== undefined && input.comment !== null) {
    if (typeof input.comment !== "string") throw new Error("comment must be text.");
    settings.comment = input.comment;
  }
  if (input.sheets !== undefined && input.sheets !== null) {
    if (!Array.isArray(input.sheets) || input.sheets.some((name) => typeof name !== "string")) {
      throw new Error("sheets must be a list of sheet names.");
    }
    settings.sheets = input.sheets as string[];
  }
  const index = (key: string, what: string): number => {
    const column = Number(key);
    if (!Number.isInteger(column) || column < 0) {
      throw new Error(`${what} are given by column number, counted from 0; got ${key}.`);
    }
    return column;
  };
  if (input.columns !== undefined && input.columns !== null) {
    if (typeof input.columns !== "object" || Array.isArray(input.columns)) {
      throw new Error("columns must map column numbers to their choices.");
    }
    const columns: Record<number, ColumnChoice> = {};
    for (const [key, choice] of Object.entries(input.columns as Record<string, unknown>)) {
      if (typeof choice !== "object" || choice === null) {
        throw new Error(`The choices for column ${key} must be an object.`);
      }
      const { name, type, unit, ...rest } = choice as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        throw new Error(
          `A column can be given a name, a type and a unit; got ${Object.keys(rest).join(", ")}.`,
        );
      }
      const types = ["auto", "number", "date", "text", "skip"] as const;
      if (type !== undefined && !types.includes(type as (typeof types)[number])) {
        throw new Error(`A column's type must be one of ${types.join(", ")}.`);
      }
      if (
        (name !== undefined && typeof name !== "string") ||
        (unit !== undefined && typeof unit !== "string")
      ) {
        throw new Error("A column's name and unit must be text.");
      }
      columns[index(key, "Columns")] = cleanChoice({ name, type, unit } as ColumnChoice);
    }
    settings.columns = columns;
  }
  if (input.errors !== undefined && input.errors !== null) {
    if (typeof input.errors !== "object" || Array.isArray(input.errors)) {
      throw new Error("errors must map a column of values to its column of uncertainties.");
    }
    const errors: Record<number, number> = {};
    for (const [key, column] of Object.entries(input.errors as Record<string, unknown>)) {
      if (typeof column !== "number" || !Number.isInteger(column) || column < 0) {
        throw new Error("errors must map a column of values to its column of uncertainties.");
      }
      errors[index(key, "Error bars")] = column;
    }
    settings.errors = errors;
  }
  return settings;
}

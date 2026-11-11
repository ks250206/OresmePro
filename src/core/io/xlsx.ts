import { strFromU8, unzipSync } from "fflate";
import { formatDate } from "../plot/ticks";

/**
 * Reads Excel workbooks (.xlsx, .xlsm): a zip archive of XML files. Only
 * what is needed to get the cells out is understood: sheet names, shared
 * strings, numbers, booleans, cached formula results, and which cells are
 * formatted as dates.
 */
export interface Sheet {
  name: string;
  /**
   * The used range as rows of cells, each written as text would be in a
   * CSV file: numbers in full precision, dates as `YYYY-MM-DD HH:MM:SS`.
   */
  rows: string[][];
}

interface Tag {
  /** Element name without any namespace prefix; "" for text. */
  name: string;
  kind: "open" | "close" | "empty" | "text";
  attributes: string;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeText(text: string): string {
  return (
    text
      .replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, code: string) => {
        if (code[0] !== "#") return ENTITIES[code] ?? whole;
        const point = code[1] === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
        return String.fromCodePoint(point);
      })
      // Excel writes control characters as _xHHHH_.
      .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
  );
}

const TAG = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(?:[\w.-]+:)?([\w.-]+)([^<>]*?)(\/?)>|([^<]+)/g;

/** Walks an XML document tag by tag. Enough for the files Excel writes. */
function* tags(xml: string): Generator<Tag> {
  TAG.lastIndex = 0;
  for (let match = TAG.exec(xml); match; match = TAG.exec(xml)) {
    if (match[5] !== undefined) {
      yield { name: "", kind: "text", attributes: "", text: match[5] };
    } else if (match[2] !== undefined) {
      yield {
        name: match[2],
        kind: match[1] ? "close" : match[4] ? "empty" : "open",
        attributes: match[3] ?? "",
        text: "",
      };
    }
  }
}

function attribute(tag: Tag, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    tag.attributes,
  );
  return match ? decodeText(match[1] ?? match[2] ?? "") : undefined;
}

/** Number formats that Excel itself defines as dates or times. */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** Whether a number format shows a date or time: it names a day, month, year, hour or second. */
function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "");
  return /[dmyhs]/i.test(bare) && !/general/i.test(bare);
}

/** For each cell style, whether it formats numbers as dates. */
function dateStyles(xml: string | undefined): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, boolean>();
  const styles: boolean[] = [];
  let inCellFormats = false;
  for (const tag of tags(xml)) {
    if (tag.name === "numFmt" && tag.kind !== "close") {
      custom.set(
        Number(attribute(tag, "numFmtId")),
        isDateFormat(attribute(tag, "formatCode") ?? ""),
      );
    } else if (tag.name === "cellXfs") {
      inCellFormats = tag.kind === "open";
    } else if (inCellFormats && tag.name === "xf" && tag.kind !== "close") {
      const id = Number(attribute(tag, "numFmtId") ?? 0);
      styles.push(custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id));
    }
  }
  return styles;
}

/** The strings that cells refer to by number. Phonetic guides (furigana) are left out. */
function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  let current = "";
  let inText = false;
  let phonetic = 0;
  for (const tag of tags(xml)) {
    if (tag.name === "rPh") phonetic += tag.kind === "open" ? 1 : tag.kind === "close" ? -1 : 0;
    else if (tag.name === "si" && tag.kind === "open") current = "";
    else if (tag.name === "si" && tag.kind === "close") strings.push(current);
    else if (tag.name === "si" && tag.kind === "empty") strings.push("");
    else if (tag.name === "t") inText = tag.kind === "open";
    else if (tag.kind === "text" && inText && phonetic === 0) current += decodeText(tag.text);
  }
  return strings;
}

/** Column number (0 for A) of a cell reference such as "BC12". */
function columnOf(reference: string): number {
  let column = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const code = reference.charCodeAt(index) & ~32;
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

/** An Excel date (days since the end of 1899, or 1903 on old Mac workbooks) as text. */
function serialDate(serial: number, date1904: boolean): string {
  const days = serial + (date1904 ? 1462 : 0) - 25569;
  return formatDate(Math.round(days * 86400 * 1000) / 1000);
}

function sheetRows(
  xml: string,
  strings: string[],
  dates: boolean[],
  date1904: boolean,
): string[][] {
  const cells: { row: number; column: number; text: string }[] = [];
  let row = -1;
  let column = -1;
  let type = "";
  let style = 0;
  let value: string | null = null;
  let reading: "v" | "t" | null = null;
  for (const tag of tags(xml)) {
    if (tag.name === "row" && tag.kind !== "close") {
      const given = Number(attribute(tag, "r"));
      row = Number.isInteger(given) && given > 0 ? given - 1 : row + 1;
      column = -1;
    } else if (tag.name === "c" && tag.kind !== "close") {
      const reference = attribute(tag, "r");
      column = reference ? columnOf(reference) : column + 1;
      type = attribute(tag, "t") ?? "n";
      style = Number(attribute(tag, "s") ?? 0);
      value = null;
    } else if (tag.name === "v" || (tag.name === "t" && type === "inlineStr")) {
      reading = tag.kind === "open" ? (tag.name as "v" | "t") : null;
    } else if (tag.kind === "text" && reading) {
      value = (value ?? "") + decodeText(tag.text);
    } else if (tag.name === "c" && tag.kind === "close" && value !== null && row >= 0) {
      let text = value;
      if (type === "s") text = strings[Number(value)] ?? "";
      else if (type === "e") text = "";
      else if (type === "b") text = value === "1" ? "1" : "0";
      else if (type === "n" && dates[style] && Number(value) >= 1) {
        text = serialDate(Number(value), date1904);
      }
      if (text !== "") cells.push({ row, column, text });
    }
  }
  if (cells.length === 0) return [];
  // The used range: from the first row and column that hold anything to the last.
  let top = Infinity;
  let left = Infinity;
  let bottom = 0;
  let right = 0;
  for (const cell of cells) {
    top = Math.min(top, cell.row);
    bottom = Math.max(bottom, cell.row);
    left = Math.min(left, cell.column);
    right = Math.max(right, cell.column);
  }
  const rows = Array.from({ length: bottom - top + 1 }, () =>
    Array.from({ length: right - left + 1 }, () => ""),
  );
  for (const cell of cells) rows[cell.row - top]![cell.column - left] = cell.text;
  return tableOf(rows);
}

/**
 * The table in a sheet's used range: without empty rows and columns, and
 * without lines above it that are not part of it (a title, a note), which
 * show as rows with far fewer cells than the table is wide.
 */
function tableOf(rows: string[][]): string[][] {
  const filled = (cells: string[]) => cells.reduce((count, text) => count + (text ? 1 : 0), 0);
  let table = rows.filter((cells) => filled(cells) > 0);
  const widest = table.reduce((most, cells) => Math.max(most, filled(cells)), 0);
  if (widest >= 2) {
    const start = table.findIndex((cells) => filled(cells) >= Math.max(2, widest / 2));
    table = table.slice(start);
  }
  const used = (table[0] ?? []).map((_, column) => table.some((cells) => cells[column] !== ""));
  return table.map((cells) => cells.filter((_, column) => used[column]));
}

/** The sheets of a workbook, in order, leaving out those with no cells. */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => file.name.startsWith("xl/") && /\.(xml|rels)$/.test(file.name),
    });
  } catch {
    throw new Error(
      "This is not an Excel workbook (.xlsx). Older .xls files have to be saved as .xlsx first.",
    );
  }
  const read = (path: string): string | undefined =>
    files[path] ? strFromU8(files[path]) : undefined;
  const workbook = read("xl/workbook.xml");
  if (!workbook) {
    throw new Error(
      "This is not an Excel workbook (.xlsx). Older .xls files have to be saved as .xlsx first.",
    );
  }
  // Where each sheet's XML is, by relationship id.
  const targets = new Map<string, string>();
  for (const tag of tags(read("xl/_rels/workbook.xml.rels") ?? "")) {
    if (tag.name !== "Relationship" || tag.kind === "close") continue;
    const target = attribute(tag, "Target") ?? "";
    targets.set(
      attribute(tag, "Id") ?? "",
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    );
  }
  let date1904 = false;
  const listed: { name: string; path: string }[] = [];
  for (const tag of tags(workbook)) {
    if (tag.kind === "close") continue;
    if (tag.name === "workbookPr") {
      date1904 = ["1", "true"].includes(attribute(tag, "date1904") ?? "");
    } else if (tag.name === "sheet") {
      const path = targets.get(attribute(tag, "id") ?? "");
      if (path) listed.push({ name: attribute(tag, "name") ?? "Sheet", path });
    }
  }
  const strings = sharedStrings(read("xl/sharedStrings.xml"));
  const dates = dateStyles(read("xl/styles.xml"));
  const sheets: Sheet[] = [];
  for (const { name, path } of listed) {
    const xml = read(path);
    // Chart sheets and the like have no cells.
    if (!xml || !path.includes("worksheets/")) continue;
    const rows = sheetRows(xml, strings, dates, date1904);
    if (rows.length > 0) sheets.push({ name, rows });
  }
  return sheets;
}

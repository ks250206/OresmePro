/**
 * Turns raw program output into styled lines. Handles the subset of terminal
 * behaviour that Python programs rely on: SGR colors (tracebacks), carriage
 * return and erase-line (progress bars), and backspace. Other escape
 * sequences are dropped.
 */
export interface TextStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Span extends TextStyle {
  text: string;
}

/** The 16 base colors, chosen to be readable on a light background. */
const BASE_COLORS = [
  "#1f2328",
  "#c4282b",
  "#1a7f37",
  "#8a6500",
  "#0550ae",
  "#8250df",
  "#0e7c86",
  "#6e7781",
  "#57606a",
  "#e0383b",
  "#2da44e",
  "#b08800",
  "#218bff",
  "#a475f9",
  "#1b9aa5",
  "#8c959f",
];

function color256(index: number): string {
  if (index < 16) return BASE_COLORS[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const value = index - 16;
  const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return `rgb(${channel(Math.floor(value / 36))},${channel(Math.floor(value / 6) % 6)},${channel(value % 6)})`;
}

function applySgr(style: TextStyle, params: number[]): TextStyle {
  let next = { ...style };
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) delete next.bold;
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = BASE_COLORS[code - 30]!;
    else if (code >= 90 && code <= 97) next.fg = BASE_COLORS[code - 90 + 8]!;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = BASE_COLORS[code - 40]!;
    else if (code >= 100 && code <= 107) next.bg = BASE_COLORS[code - 100 + 8]!;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (params[index + 1] === 5 && params[index + 2] !== undefined) {
        next[key] = color256(params[index + 2]!);
        index += 2;
      } else if (params[index + 1] === 2 && params[index + 4] !== undefined) {
        next[key] = `rgb(${params[index + 2]},${params[index + 3]},${params[index + 4]})`;
        index += 4;
      }
    }
  }
  return next;
}

interface Cell {
  char: string;
  style: TextStyle;
}

const sameStyle = (a: TextStyle, b: TextStyle): boolean =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline;

function toSpans(cells: Cell[]): Span[] {
  const spans: Span[] = [];
  for (const cell of cells) {
    const last = spans.at(-1);
    if (last && sameStyle(last, cell.style)) last.text += cell.char;
    else spans.push({ ...cell.style, text: cell.char });
  }
  return spans;
}

// CSI: ESC [ params final. OSC: ESC ] ... BEL or ESC \. Anything else: ESC + one char.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[([0-9;?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/y;

export function renderTerminalText(raw: string): Span[][] {
  const lines: Span[][] = [];
  let cells: Cell[] = [];
  let column = 0;
  let style: TextStyle = {};

  for (let index = 0; index < raw.length;) {
    const char = raw[index]!;
    if (char === "\x1b") {
      ESCAPE.lastIndex = index;
      const match = ESCAPE.exec(raw);
      if (!match) {
        index += 1;
        continue;
      }
      index += match[0].length;
      if (match[2] === "m") {
        const params = (match[1] ?? "").split(";").map((part) => Number(part) || 0);
        style = applySgr(style, params);
      } else if (match[2] === "K") {
        const mode = Number(match[1]) || 0;
        if (mode === 2) {
          cells = [];
          column = 0;
        } else if (mode === 0) {
          cells.length = Math.min(cells.length, column);
        }
      }
      continue;
    }
    index += 1;
    if (char === "\n") {
      lines.push(toSpans(cells));
      cells = [];
      column = 0;
    } else if (char === "\r") {
      column = 0;
    } else if (char === "\b") {
      column = Math.max(0, column - 1);
    } else if (char === "\t") {
      const stop = (Math.floor(column / 8) + 1) * 8;
      while (column < stop) {
        cells[column] = { char: " ", style };
        column += 1;
      }
    } else if (char >= " ") {
      // Keep surrogate pairs together.
      const code = raw.codePointAt(index - 1)!;
      const text = code > 0xffff ? raw.slice(index - 1, index + 1) : char;
      if (code > 0xffff) index += 1;
      while (cells.length < column) cells.push({ char: " ", style: {} });
      cells[column] = { char: text, style };
      column += 1;
    }
  }
  if (cells.length > 0) lines.push(toSpans(cells));
  return lines;
}

/** The text with every escape sequence removed. */
export function stripAnsi(raw: string): string {
  return renderTerminalText(raw)
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n");
}

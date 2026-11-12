import type { FontStyle, MeasureText, Prim } from "./displayList";

/**
 * Rich text for labels, legends and text boxes. Two notations mix freely:
 *
 * - `^{...}` is a superscript and `_{...}` a subscript, e.g. `cm^{-1}` or
 *   `V_{out}`. They nest, and whatever changes inside the braces ends there.
 * - Igor's backslash codes, so that a label written for Igor reads the same
 *   here: `\Z14` and `\Zr150` set the size, `\f02` italic and so on (see
 *   {@link MARKUP_CODES}). A code holds until another changes it.
 *
 * Anything that is not a whole code (an unknown letter, missing digits, an
 * unclosed brace or quote) is drawn as it is written.
 */
export interface TextRun {
  text: string;
  size: number;
  /** Baseline offset from the line's, downward, so a superscript's is negative. */
  dy: number;
  bold?: true;
  italic?: true;
  underline?: true;
  /** A font named in the text with `\F'name'`. */
  font?: string;
  /** `#rrggbb`, from `\K(r,g,b)`. */
  color?: string;
}

/** Codes and what they do, as the dialogs list them. */
export const MARKUP_CODES: readonly (readonly [code: string, meaning: string])[] = [
  ["^{...}  _{...}", "superscript, subscript"],
  ["\\S  \\B", "superscript, subscript from here on (\\M ends it)"],
  ["\\f01  \\f02  \\f03", "bold, italic, bold italic (\\f04 underlines; add them up)"],
  ["\\f00", "plain again"],
  ["\\Z14", "font size 14 (two digits)"],
  ["\\Zr150", "150% of the current size (three digits)"],
  ["\\M", "back to the normal size, font and baseline"],
  ["\\F'Times'", "font by name"],
  ["\\K(65535,0,0)", "color, 0 to 65535 for red, green, blue"],
  ["\\[0  \\]0", "remember the look, and go back to it"],
  ["\\u", "the axis' units, with their prefix (axis labels only)"],
  ["\\\\", "a backslash"],
];

/** Height of capital letters and digits, as a fraction of the font size. */
export const CAP_HEIGHT = 0.72;
const DESCENT = 0.22;
const SCRIPT_SCALE = 0.7;
const SUPER_RISE = 0.4;
const SUB_DROP = 0.18;
/** Where an underline goes below the baseline, and how thick it is, per unit of size. */
const UNDERLINE_DROP = 0.1;
const UNDERLINE_WIDTH = 0.05;

interface State {
  size: number;
  dy: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  font: string | null;
  color: string | null;
}

/** The look text starts with: its size and, for an axis label, a style of its own. */
export interface TextBase extends FontStyle {
  size: number;
}

const script = (state: State, up: boolean): State => ({
  ...state,
  size: state.size * SCRIPT_SCALE,
  dy: up ? state.dy - state.size * SUPER_RISE : state.dy + state.size * SUB_DROP,
});

/** The brace that closes a group opened just before `from`, or -1 if there is none before `limit`. */
function closingBrace(markup: string, from: number, limit: number): number {
  let depth = 1;
  for (let index = from; index < limit; index += 1) {
    if (markup[index] === "{") depth += 1;
    else if (markup[index] === "}" && (depth -= 1) === 0) return index;
  }
  // Unbalanced braces inside: the first closing one ends the group, as it always has.
  const first = markup.indexOf("}", from);
  return first !== -1 && first < limit ? first : -1;
}

const hex = (value: number): string =>
  Math.round(value / 257)
    .toString(16)
    .padStart(2, "0");

/**
 * Reads the code after a backslash, from `rest` (the text after it, up to the
 * end of the group it is in). Returns how many characters it takes and the
 * look after it or the text it stands for; null if it is not a code.
 */
function readCode(
  rest: string,
  state: State,
  start: State,
  saved: Map<string, State>,
): { length: number; state?: State; text?: string } | null {
  let match: RegExpExecArray | null;
  if (rest[0] === "\\") return { length: 1, text: "\\" };
  if ((match = /^Zr(\d{3})/.exec(rest))) {
    const percent = Number(match[1]);
    return percent > 0
      ? { length: 5, state: { ...state, size: (state.size * percent) / 100 } }
      : null;
  }
  if ((match = /^Z(\d{2})/.exec(rest))) {
    const size = Number(match[1]);
    return size > 0 ? { length: 3, state: { ...state, size } } : null;
  }
  if ((match = /^f(\d{2})/.exec(rest))) {
    // Igor's bits: 1 bold, 2 italic, 4 underline. Outline and shadow (8, 16) are not drawn.
    const bits = Number(match[1]);
    const look = { bold: (bits & 1) !== 0, italic: (bits & 2) !== 0, underline: (bits & 4) !== 0 };
    return { length: 3, state: { ...state, ...look } };
  }
  if ((match = /^F'([^'"\\]+)'/.exec(rest)) && match[1]!.trim() !== "") {
    return { length: match[0].length, state: { ...state, font: match[1]!.trim() } };
  }
  if ((match = /^K\((\d{1,5}),(\d{1,5}),(\d{1,5})(?:,\d{1,5})?\)/.exec(rest))) {
    const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
    if (Math.max(r, g, b) > 65535) return null;
    return { length: match[0].length, state: { ...state, color: `#${hex(r)}${hex(g)}${hex(b)}` } };
  }
  if ((match = /^\[(\d)/.exec(rest))) {
    saved.set(match[1]!, state);
    return { length: 2, state };
  }
  if ((match = /^\](\d)/.exec(rest))) {
    return { length: 2, state: saved.get(match[1]!) ?? start };
  }
  switch (rest[0]) {
    case "M":
      return { length: 1, state: { ...state, size: start.size, dy: start.dy, font: null } };
    case "S":
      return { length: 1, state: script(state, true) };
    case "B":
      return { length: 1, state: script(state, false) };
    default:
      return null;
  }
}

const sameLook = (run: TextRun, state: State): boolean =>
  run.size === state.size &&
  run.dy === state.dy &&
  (run.bold ?? false) === state.bold &&
  (run.italic ?? false) === state.italic &&
  (run.underline ?? false) === state.underline &&
  (run.font ?? null) === state.font &&
  (run.color ?? null) === state.color;

/**
 * Splits markup into runs of one look each, with sizes and baseline offsets
 * worked out from `base`. Neighbouring text of the same look is one run, so
 * codes that change nothing leave the text as it would be without them.
 */
export function parseRichText(markup: string, base: TextBase = { size: 1 }): TextRun[] {
  const start: State = {
    size: base.size,
    dy: 0,
    bold: base.bold ?? false,
    italic: base.italic ?? false,
    underline: false,
    font: null,
    color: null,
  };
  const runs: TextRun[] = [];
  const saved = new Map<string, State>();
  const groups: { close: number; outside: State }[] = [];
  let state = start;
  const add = (text: string) => {
    const last = runs.at(-1);
    if (last && sameLook(last, state)) {
      last.text += text;
      return;
    }
    runs.push({
      text,
      size: state.size,
      dy: state.dy,
      ...(state.bold ? { bold: true } : {}),
      ...(state.italic ? { italic: true } : {}),
      ...(state.underline ? { underline: true } : {}),
      ...(state.font !== null ? { font: state.font } : {}),
      ...(state.color !== null ? { color: state.color } : {}),
    });
  };
  let index = 0;
  while (index < markup.length) {
    const group = groups.at(-1);
    if (group && index === group.close) {
      state = group.outside;
      groups.pop();
      index += 1;
      continue;
    }
    const limit = group ? group.close : markup.length;
    const char = markup[index]!;
    if ((char === "^" || char === "_") && markup[index + 1] === "{") {
      const close = closingBrace(markup, index + 2, limit);
      if (close !== -1) {
        groups.push({ close, outside: state });
        state = script(state, char === "^");
        index += 2;
        continue;
      }
    }
    if (char === "\\") {
      const code = readCode(markup.slice(index + 1, limit), state, start, saved);
      if (code) {
        if (code.text !== undefined) add(code.text);
        if (code.state) state = code.state;
        index += 1 + code.length;
        continue;
      }
    }
    add(char);
    index += 1;
  }
  return runs;
}

export interface TextPart extends FontStyle {
  text: string;
  dx: number;
  dy: number;
  size: number;
  width: number;
  underline?: boolean;
  /** Set only where the text names its own font or color. */
  family?: string;
  fill?: string;
}

export interface TextBlock {
  width: number;
  /** Extent above the baseline. */
  ascent: number;
  /** Extent below the baseline. */
  descent: number;
  /**
   * The largest size on the baseline (super- and subscripts aside): what a
   * line of this text is spaced for. The size given when nothing is larger.
   */
  lineSize: number;
  parts: TextPart[];
}

/** The font for text that names one: that font first, then the text's own as a fallback. */
const namedFont = (name: string, family: string): string =>
  `"${name.replace(/["\\;{}]/g, "")}", ${family}`;

/**
 * Lays out markup at `size` in `family`. `style` is the look the text starts
 * with (an axis label's own bold or italic); codes in the text change it from there.
 */
export function layoutText(
  markup: string,
  size: number,
  family: string,
  measure: MeasureText,
  style: FontStyle = {},
): TextBlock {
  const runs = parseRichText(markup, { size, ...style });
  const onBaseline = runs.filter((run) => run.dy === 0).map((run) => run.size);
  const lineSize = onBaseline.length > 0 ? Math.max(...onBaseline) : size;
  const parts: TextPart[] = [];
  let width = 0;
  let ascent = lineSize * CAP_HEIGHT;
  let descent = lineSize * DESCENT;
  for (const run of runs) {
    const font = run.font === undefined ? undefined : namedFont(run.font, family);
    const look = run.bold || run.italic ? { bold: run.bold, italic: run.italic } : undefined;
    const advance = measure(run.text, run.size, font ?? family, look);
    parts.push({
      text: run.text,
      dx: width,
      dy: run.dy,
      size: run.size,
      width: advance,
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.underline ? { underline: true } : {}),
      ...(font === undefined ? {} : { family: font }),
      ...(run.color === undefined ? {} : { fill: run.color }),
    });
    width += advance;
    ascent = Math.max(ascent, -run.dy + run.size * CAP_HEIGHT);
    descent = Math.max(descent, run.dy + run.size * DESCENT);
  }
  return { width, ascent, descent, lineSize, parts };
}

/**
 * Emits a laid-out block. (x, y) is the point on the baseline selected by
 * `align` (0 = left end, 0.5 = middle, 1 = right end); `rotate` turns the
 * whole block clockwise about that point.
 */
export function emitText(
  out: Prim[],
  block: TextBlock,
  x: number,
  y: number,
  options: { align?: number; rotate?: number; family: string; fill: string },
): void {
  const rotate = options.rotate ?? 0;
  const angle = (rotate * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offset = -block.width * (options.align ?? 0);
  // A point of the block's own frame (along the baseline, and down from it) on the page.
  const at = (along: number, down: number): [number, number] => [
    x + along * cos - down * sin,
    y + along * sin + down * cos,
  ];
  for (const part of block.parts) {
    const dx = offset + part.dx;
    const [px, py] = at(dx, part.dy);
    const fill = part.fill ?? options.fill;
    out.push({
      kind: "text",
      x: px,
      y: py,
      text: part.text,
      family: part.family ?? options.family,
      size: part.size,
      fill,
      ...(part.bold ? { bold: true } : {}),
      ...(part.italic ? { italic: true } : {}),
      ...(rotate ? { rotate } : {}),
    });
    if (part.underline) {
      const down = part.dy + part.size * UNDERLINE_DROP;
      out.push({
        kind: "segments",
        points: [...at(dx, down), ...at(dx + part.width, down)],
        stroke: fill,
        width: Math.max(0.5, part.size * UNDERLINE_WIDTH),
      });
    }
  }
}

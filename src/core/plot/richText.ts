import type { MeasureText, Prim } from "./displayList";

/**
 * Minimal rich text for scientific labels: `^{...}` is a superscript and
 * `_{...}` a subscript, e.g. `cm^{-1}` or `V_{out}`.
 */
export interface TextRun {
  text: string;
  /** 0 = normal, 1 = superscript, -1 = subscript. */
  shift: -1 | 0 | 1;
}

export function parseRichText(markup: string): TextRun[] {
  const runs: TextRun[] = [];
  const push = (text: string, shift: TextRun["shift"]) => {
    if (text) runs.push({ text, shift });
  };
  let plain = "";
  let index = 0;
  while (index < markup.length) {
    const char = markup[index]!;
    if ((char === "^" || char === "_") && markup[index + 1] === "{") {
      const close = markup.indexOf("}", index + 2);
      if (close !== -1) {
        push(plain, 0);
        plain = "";
        push(markup.slice(index + 2, close), char === "^" ? 1 : -1);
        index = close + 1;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  push(plain, 0);
  return runs;
}

/** Height of capital letters and digits, as a fraction of the font size. */
export const CAP_HEIGHT = 0.72;
const SCRIPT_SCALE = 0.7;
const SUPER_RISE = 0.4;
const SUB_DROP = 0.18;

export interface TextBlock {
  width: number;
  /** Extent above the baseline. */
  ascent: number;
  /** Extent below the baseline. */
  descent: number;
  parts: { text: string; dx: number; dy: number; size: number }[];
}

export function layoutText(
  markup: string,
  size: number,
  family: string,
  measure: MeasureText,
): TextBlock {
  const parts: TextBlock["parts"] = [];
  let width = 0;
  let ascent = size * CAP_HEIGHT;
  let descent = size * 0.22;
  for (const run of parseRichText(markup)) {
    const runSize = run.shift === 0 ? size : size * SCRIPT_SCALE;
    const dy = run.shift === 1 ? -size * SUPER_RISE : run.shift === -1 ? size * SUB_DROP : 0;
    parts.push({ text: run.text, dx: width, dy, size: runSize });
    width += measure(run.text, runSize, family);
    if (run.shift === 1) ascent = Math.max(ascent, -dy + runSize * CAP_HEIGHT);
    if (run.shift === -1) descent = Math.max(descent, dy + runSize * 0.22);
  }
  return { width, ascent, descent, parts };
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
  for (const part of block.parts) {
    const dx = offset + part.dx;
    out.push({
      kind: "text",
      x: x + dx * cos - part.dy * sin,
      y: y + dx * sin + part.dy * cos,
      text: part.text,
      family: options.family,
      size: part.size,
      fill: options.fill,
      ...(rotate ? { rotate } : {}),
    });
  }
}

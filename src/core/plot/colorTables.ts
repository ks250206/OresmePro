import type { ColorTable } from "../doc/types";

/** Control points of each table, evenly spaced from low to high. */
const STOPS: Record<ColorTable, readonly string[]> = {
  grays: ["#000000", "#ffffff"],
  viridis: [
    "#440154",
    "#482878",
    "#3e4989",
    "#31688e",
    "#26828e",
    "#1f9e89",
    "#35b779",
    "#6ece58",
    "#b5de2b",
    "#fde725",
  ],
  plasma: [
    "#0d0887",
    "#46039f",
    "#7201a8",
    "#9c179e",
    "#bd3786",
    "#d8576b",
    "#ed7953",
    "#fb9f3a",
    "#fdca26",
    "#f0f921",
  ],
  hot: ["#000000", "#8b0000", "#ff0000", "#ff8c00", "#ffd700", "#ffffaa", "#ffffff"],
  rainbow: ["#6a00ff", "#0000ff", "#00a0ff", "#00d080", "#80e000", "#ffe000", "#ff8000", "#ff0000"],
  bluered: ["#0b2a8a", "#3b6fd4", "#a9c8f2", "#f7f7f7", "#f4b6a0", "#d6503f", "#8a0b1b"],
};

const SIZE = 256;
const cache = new Map<ColorTable, Uint8Array>();

/** The table as 256 RGB triples. */
export function colorLookup(table: ColorTable): Uint8Array {
  const cached = cache.get(table);
  if (cached) return cached;
  const stops = STOPS[table].map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]);
  const lookup = new Uint8Array(SIZE * 3);
  for (let index = 0; index < SIZE; index += 1) {
    const position = (index / (SIZE - 1)) * (stops.length - 1);
    const lower = Math.min(stops.length - 2, Math.floor(position));
    const mix = position - lower;
    for (let channel = 0; channel < 3; channel += 1) {
      lookup[index * 3 + channel] = Math.round(
        stops[lower]![channel]! * (1 - mix) + stops[lower + 1]![channel]! * mix,
      );
    }
  }
  cache.set(table, lookup);
  return lookup;
}

/** The color at a fraction 0..1 of the table, as `#rrggbb`. */
export function colorAt(table: ColorTable, fraction: number): string {
  const lookup = colorLookup(table);
  const index = Math.round(Math.min(1, Math.max(0, fraction)) * (SIZE - 1)) * 3;
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${hex(lookup[index]!)}${hex(lookup[index + 1]!)}${hex(lookup[index + 2]!)}`;
}

interface MatrixColors {
  table: ColorTable;
  zMin: number;
  zMax: number;
  reverse: boolean;
}

/**
 * Renders a matrix (C order, `nx` by `ny`, first index horizontal) as RGBA
 * pixels of `cols` by `rows`, sampling the nearest element. Row 0 of the
 * result is the top of the picture; `flipX` and `flipY` reverse the data
 * direction (flipY false puts index 0 of the second dimension at the bottom).
 * NaN becomes transparent.
 */
export function renderMatrix(
  data: ArrayLike<number>,
  nx: number,
  ny: number,
  cols: number,
  rows: number,
  options: MatrixColors & { flipX: boolean; flipY: boolean },
): Uint8ClampedArray<ArrayBuffer> {
  const columns = new Int32Array(cols);
  for (let col = 0; col < cols; col += 1) {
    const sampleX = Math.min(nx - 1, Math.floor(((col + 0.5) * nx) / cols));
    columns[col] = options.flipX ? nx - 1 - sampleX : sampleX;
  }
  const lines = new Int32Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const sampleY = Math.min(ny - 1, Math.floor(((row + 0.5) * ny) / rows));
    lines[row] = options.flipY ? sampleY : ny - 1 - sampleY;
  }
  return renderCells(data, ny, columns, lines, options);
}

/**
 * Renders a matrix (C order, first index horizontal, `ny` elements in the
 * second dimension) as RGBA pixels: pixel (col, row) shows element
 * (columns[col], rows[row]), row 0 being the top. An index of -1, like NaN,
 * leaves the pixel transparent.
 */
export function renderCells(
  data: ArrayLike<number>,
  ny: number,
  columns: Int32Array,
  rows: Int32Array,
  options: MatrixColors,
): Uint8ClampedArray<ArrayBuffer> {
  const lookup = colorLookup(options.table);
  const cols = columns.length;
  const rgba = new Uint8ClampedArray(cols * rows.length * 4);
  const range = options.zMax - options.zMin;
  const scale = range === 0 ? 0 : (SIZE - 1) / range;
  for (let row = 0; row < rows.length; row += 1) {
    const j = rows[row]!;
    if (j < 0) continue;
    for (let col = 0; col < cols; col += 1) {
      const i = columns[col]!;
      if (i < 0) continue;
      const value = data[i * ny + j]!;
      const out = (row * cols + col) * 4;
      if (Number.isNaN(value)) continue;
      let index = Math.round((value - options.zMin) * scale);
      index = index < 0 ? 0 : index > SIZE - 1 ? SIZE - 1 : index;
      if (options.reverse) index = SIZE - 1 - index;
      rgba[out] = lookup[index * 3]!;
      rgba[out + 1] = lookup[index * 3 + 1]!;
      rgba[out + 2] = lookup[index * 3 + 2]!;
      rgba[out + 3] = 255;
    }
  }
  return rgba;
}

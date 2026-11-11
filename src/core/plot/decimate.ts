import type { Wave } from "../doc/types";
import type { Scale } from "./scale";

export interface Extent {
  min: number;
  max: number;
  /** Smallest value above zero, for log axes; Infinity if there is none. */
  minPositive: number;
}

const extentCache = new WeakMap<Float64Array, Extent>();

/** Finite range of an array, ignoring NaN and infinities. Cached per array. */
export function extentOf(data: Float64Array): Extent {
  const cached = extentCache.get(data);
  if (cached) return cached;
  let min = Infinity;
  let max = -Infinity;
  let minPositive = Infinity;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    if (value < min && value !== -Infinity) min = value;
    if (value > max && value !== Infinity) max = value;
    if (value > 0 && value < minPositive) minPositive = value;
  }
  const extent = { min, max, minPositive };
  extentCache.set(data, extent);
  return extent;
}

const orderCache = new WeakMap<Float64Array, -1 | 0 | 1>();

/** 1 if non-decreasing, -1 if non-increasing, 0 otherwise (or if it has NaN). */
export function monotonicity(data: Float64Array): -1 | 0 | 1 {
  const cached = orderCache.get(data);
  if (cached !== undefined) return cached;
  let rising = true;
  let falling = true;
  for (let index = 1; index < data.length && (rising || falling); index += 1) {
    const step = data[index]! - data[index - 1]!;
    if (!(step >= 0)) rising = false;
    if (!(step <= 0)) falling = false;
  }
  const order = data.length > 0 && Number.isNaN(data[0]!) ? 0 : rising ? 1 : falling ? -1 : 0;
  orderCache.set(data, order);
  return order;
}

/** X range of a trace: from the X wave if there is one, else from the scaling. */
export function xExtentOf(y: Wave, x: Wave | null): Extent {
  if (x) return extentOf(x.data);
  const count = y.data.length;
  if (count === 0) return { min: Infinity, max: -Infinity, minPositive: Infinity };
  const first = y.x0;
  const last = y.x0 + (count - 1) * y.dx;
  const min = Math.min(first, last);
  const max = Math.max(first, last);
  let minPositive = Infinity;
  if (max > 0) {
    if (min > 0) minPositive = min;
    else {
      // The first point whose X is above zero.
      const index = y.dx > 0 ? Math.floor(-y.x0 / y.dx) + 1 : Math.ceil(-y.x0 / y.dx) - 1;
      minPositive = y.x0 + index * y.dx;
    }
  }
  return { min, max, minPositive };
}

/** Index of the first element >= value (rising) or <= value (falling). */
function lowerBound(data: Float64Array, value: number, order: 1 | -1): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const before = order === 1 ? data[mid]! < value : data[mid]! > value;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The inclusive index range that can be visible between two X values, padded
 * by one point so lines run off the edge. `ordered` is false when X is not
 * monotonic, in which case every point has to be considered.
 */
export function visibleRange(
  y: Wave,
  x: Wave | null,
  xa: number,
  xb: number,
): { first: number; last: number; ordered: boolean } {
  const count = x ? Math.min(y.data.length, x.data.length) : y.data.length;
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  if (!x) {
    const a = (lo - y.x0) / y.dx;
    const b = (hi - y.x0) / y.dx;
    return {
      first: Math.max(0, Math.floor(Math.min(a, b)) - 1),
      last: Math.min(count - 1, Math.ceil(Math.max(a, b)) + 1),
      ordered: true,
    };
  }
  const order = monotonicity(x.data);
  if (order === 0) return { first: 0, last: count - 1, ordered: false };
  const a = lowerBound(x.data, order === 1 ? lo : hi, order);
  const b = lowerBound(x.data, order === 1 ? hi : lo, order);
  return { first: Math.max(0, a - 1), last: Math.min(count - 1, b + 1), ordered: true };
}

class PointBuffer {
  private data = new Float32Array(256);
  length = 0;

  push(x: number, y: number): void {
    if (this.length + 2 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length] = x;
    this.data[this.length + 1] = y;
    this.length += 2;
  }

  take(): Float32Array {
    const result = this.data.slice(0, this.length);
    this.length = 0;
    return result;
  }
}

/** Keeps coordinates in a range every renderer handles exactly. */
const LIMIT = 1e5;
const clamp = (value: number): number => (value > LIMIT ? LIMIT : value < -LIMIT ? -LIMIT : value);

export interface TracePixels {
  /** Connected runs of points (x, y pairs). A gap in the data ends a run. */
  runs: Float32Array[];
  /** True when points were merged per pixel column. */
  decimated: boolean;
}

/**
 * Converts a trace to pixel coordinates.
 *
 * When there are many more points than pixel columns, each column is reduced
 * to its first, lowest, highest and last point. Drawing those in index order
 * covers exactly the same pixels as drawing every point, so the picture is
 * unchanged while the work drops from O(points) drawn to O(width).
 */
export function tracePixels(y: Wave, x: Wave | null, xs: Scale, ys: Scale): TracePixels {
  const { first, last, ordered } = visibleRange(y, x, xs.min, xs.max);
  const runs: Float32Array[] = [];
  const buffer = new PointBuffer();
  const endRun = () => {
    if (buffer.length > 0) runs.push(buffer.take());
  };
  const yData = y.data;
  const xData = x?.data;
  const count = last - first + 1;
  const columns = Math.abs(xs.p1 - xs.p0);
  const decimated = ordered && count > 4 * Math.max(1, columns);

  if (!decimated) {
    for (let index = first; index <= last; index += 1) {
      const px = xs.toPixel(xData ? xData[index]! : y.x0 + index * y.dx);
      const py = ys.toPixel(yData[index]!);
      if (Number.isFinite(px) && Number.isFinite(py)) buffer.push(clamp(px), clamp(py));
      else endRun();
    }
    endRun();
    return { runs, decimated };
  }

  let column = Number.NaN;
  let firstX = 0;
  let firstY = 0;
  let lastX = 0;
  let lastY = 0;
  let lowX = 0;
  let lowY = 0;
  let lowAt = 0;
  let highX = 0;
  let highY = 0;
  let highAt = 0;
  let filled = 0;
  const flush = () => {
    if (filled === 0) return;
    buffer.push(firstX, firstY);
    if (filled > 1) {
      // The extremes, in the order they occur.
      if (lowAt < highAt) {
        if (lowY !== firstY) buffer.push(lowX, lowY);
        if (highY !== lowY) buffer.push(highX, highY);
      } else {
        if (highY !== firstY) buffer.push(highX, highY);
        if (lowY !== highY) buffer.push(lowX, lowY);
      }
      buffer.push(lastX, lastY);
    }
    filled = 0;
  };
  for (let index = first; index <= last; index += 1) {
    const px = xs.toPixel(xData ? xData[index]! : y.x0 + index * y.dx);
    const py = ys.toPixel(yData[index]!);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      flush();
      endRun();
      column = Number.NaN;
      continue;
    }
    const cx = clamp(px);
    const cy = clamp(py);
    const here = Math.floor(cx);
    if (here !== column) {
      flush();
      column = here;
      firstX = lowX = highX = cx;
      firstY = lowY = highY = cy;
      lowAt = highAt = index;
    } else {
      // Pixel Y grows downward: the lowest value has the largest py.
      if (cy > lowY) {
        lowY = cy;
        lowX = cx;
        lowAt = index;
      }
      if (cy < highY) {
        highY = cy;
        highX = cx;
        highAt = index;
      }
    }
    lastX = cx;
    lastY = cy;
    filled += 1;
  }
  flush();
  endRun();
  return { runs, decimated };
}

/**
 * Pixel positions of the points that fall inside the given bounds, for
 * markers. Consecutive points landing on the same pixel are drawn once.
 * `indices`, if given, receives the index of each point that was kept.
 */
export function markerPixels(
  y: Wave,
  x: Wave | null,
  xs: Scale,
  ys: Scale,
  bounds: { x: number; y: number; w: number; h: number },
  indices?: number[],
): Float32Array {
  const { first, last } = visibleRange(y, x, xs.min, xs.max);
  const buffer = new PointBuffer();
  const xData = x?.data;
  let previousX = Number.NaN;
  let previousY = Number.NaN;
  for (let index = first; index <= last; index += 1) {
    const px = xs.toPixel(xData ? xData[index]! : y.x0 + index * y.dx);
    const py = ys.toPixel(y.data[index]!);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (px < bounds.x || px > bounds.x + bounds.w || py < bounds.y || py > bounds.y + bounds.h) {
      continue;
    }
    const rx = Math.round(px * 2);
    const ry = Math.round(py * 2);
    if (rx === previousX && ry === previousY) continue;
    previousX = rx;
    previousY = ry;
    buffer.push(px, py);
    indices?.push(index);
  }
  return buffer.take();
}

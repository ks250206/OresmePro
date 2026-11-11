import { niceStep } from "./ticks";

/** Level values for a contour plot: explicit ones, or about `count` round values. */
export function contourLevels(
  levels: number | readonly number[],
  zMin: number,
  zMax: number,
): number[] {
  if (typeof levels !== "number") return [...levels];
  if (!(zMax > zMin)) return [];
  const step = niceStep(zMax - zMin, levels + 1);
  const values: number[] = [];
  for (let index = Math.floor(zMin / step) + 1; index * step < zMax; index += 1) {
    values.push(index * step || 0);
  }
  return values;
}

/**
 * Contour lines of a matrix at one level, by marching squares. The matrix is
 * `nx` by `ny` in C order. Returns line segments in index coordinates
 * (ax, ay, bx, by, ...), where a point (i, j) is element [i][j].
 */
export function contourSegments(
  data: Float64Array,
  nx: number,
  ny: number,
  level: number,
): Float64Array {
  const out: number[] = [];
  // Where the level crosses the edge between two corners, by linear interpolation.
  const cross = (a: number, b: number): number => (level - a) / (b - a);
  for (let i = 0; i < nx - 1; i += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      const v00 = data[i * ny + j]!;
      const v10 = data[(i + 1) * ny + j]!;
      const v11 = data[(i + 1) * ny + j + 1]!;
      const v01 = data[i * ny + j + 1]!;
      // NaN compares false everywhere, so cells touching NaN produce nothing.
      const code =
        (v00 > level ? 1 : 0) |
        (v10 > level ? 2 : 0) |
        (v11 > level ? 4 : 0) |
        (v01 > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      if (Number.isNaN(v00 + v10 + v11 + v01)) continue;
      // Edge crossing points: bottom (j), right (i+1), top (j+1), left (i).
      const bottom = () => [i + cross(v00, v10), j] as const;
      const right = () => [i + 1, j + cross(v10, v11)] as const;
      const top = () => [i + cross(v01, v11), j + 1] as const;
      const left = () => [i, j + cross(v00, v01)] as const;
      const line = (a: readonly [number, number], b: readonly [number, number]) => {
        out.push(a[0], a[1], b[0], b[1]);
      };
      switch (code) {
        case 1:
        case 14:
          line(left(), bottom());
          break;
        case 2:
        case 13:
          line(bottom(), right());
          break;
        case 3:
        case 12:
          line(left(), right());
          break;
        case 4:
        case 11:
          line(right(), top());
          break;
        case 6:
        case 9:
          line(bottom(), top());
          break;
        case 7:
        case 8:
          line(left(), top());
          break;
        default: {
          // Saddles (5 and 10): the cell centre decides which corners connect.
          const centreHigh = (v00 + v10 + v11 + v01) / 4 > level;
          if ((code === 5) === centreHigh) {
            line(left(), top());
            line(bottom(), right());
          } else {
            line(left(), bottom());
            line(right(), top());
          }
        }
      }
    }
  }
  return Float64Array.from(out);
}

/**
 * Joins the loose segments of one contour level into polylines (x0, y0,
 * x1, y1, ... each), so lines can be drawn with proper joins and labelled.
 */
export function chainSegments(segments: Float64Array): Float64Array[] {
  // Segment ends that meet were computed from the same cell edge, so they
  // agree to within rounding; a fine grid makes them compare equal.
  const key = (x: number, y: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const count = segments.length / 4;
  const ends = new Map<string, number[]>();
  for (let index = 0; index < count; index += 1) {
    for (const at of [0, 2]) {
      const k = key(segments[index * 4 + at]!, segments[index * 4 + at + 1]!);
      const list = ends.get(k);
      if (list) list.push(index);
      else ends.set(k, [index]);
    }
  }
  const used = new Uint8Array(count);
  /** Follows unused segments from a point, appending the far end of each. */
  const walk = (x: number, y: number, out: number[]) => {
    for (;;) {
      const next = ends.get(key(x, y))?.find((index) => !used[index]);
      if (next === undefined) return;
      used[next] = 1;
      const base = next * 4;
      const atStart = key(segments[base]!, segments[base + 1]!) === key(x, y);
      x = segments[base + (atStart ? 2 : 0)]!;
      y = segments[base + (atStart ? 3 : 1)]!;
      out.push(x, y);
    }
  };
  const chains: Float64Array[] = [];
  for (let index = 0; index < count; index += 1) {
    if (used[index]) continue;
    used[index] = 1;
    const base = index * 4;
    const forward = [segments[base + 2]!, segments[base + 3]!];
    walk(forward[0]!, forward[1]!, forward);
    const backward: number[] = [];
    walk(segments[base]!, segments[base + 1]!, backward);
    // backward holds points going away from the start: reverse it in pairs.
    const points: number[] = [];
    for (let at = backward.length - 2; at >= 0; at -= 2)
      points.push(backward[at]!, backward[at + 1]!);
    points.push(segments[base]!, segments[base + 1]!);
    // Not push(...forward): a long contour has more points than a call takes arguments.
    for (const value of forward) points.push(value);
    chains.push(Float64Array.from(points));
  }
  return chains;
}

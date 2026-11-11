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

/** Maps data values on one axis to pixel positions, linearly or by log10. */
export interface Scale {
  readonly min: number;
  readonly max: number;
  readonly log: boolean;
  /** Pixel position of `min` and `max`. */
  readonly p0: number;
  readonly p1: number;
  toPixel(value: number): number;
  toValue(pixel: number): number;
}

export function makeScale(min: number, max: number, log: boolean, p0: number, p1: number): Scale {
  if (log) {
    const a = Math.log10(min);
    const b = Math.log10(max);
    const k = (p1 - p0) / (b - a);
    return {
      min,
      max,
      log,
      p0,
      p1,
      toPixel: (value) => (value > 0 ? p0 + (Math.log10(value) - a) * k : Number.NaN),
      toValue: (pixel) => 10 ** (a + (pixel - p0) / k),
    };
  }
  const k = (p1 - p0) / (max - min);
  return {
    min,
    max,
    log,
    p0,
    p1,
    toPixel: (value) => p0 + (value - min) * k,
    toValue: (pixel) => min + (pixel - p0) / k,
  };
}

/**
 * Tick placement and labelling in the style of Igor Pro: major ticks on a
 * 1-2-5 grid, a common power of 1000 factored out of the labels (shown once
 * on the axis as an SI prefix or as x10^n), and decade ticks on log axes.
 */

export interface Tick {
  value: number;
  /** Rich-text markup (see richText.ts); empty for an unlabelled tick. */
  label: string;
}

export interface TickSet {
  major: Tick[];
  minor: number[];
  /** Power of ten divided out of every label; a multiple of 3, or 0. */
  exponent: number;
}

const MINUS = "−";

/** Values below this, or at/above HIGH_TRIP, get a factored-out exponent. */
const LOW_TRIP = 0.1;
const HIGH_TRIP = 1e5;

const SI_PREFIXES: Record<number, string> = {
  [-24]: "y",
  [-21]: "z",
  [-18]: "a",
  [-15]: "f",
  [-12]: "p",
  [-9]: "n",
  [-6]: "µ",
  [-3]: "m",
  0: "",
  3: "k",
  6: "M",
  9: "G",
  12: "T",
  15: "P",
  18: "E",
  21: "Z",
  24: "Y",
};

/** Step sizes are 1, 2 or 5 times a power of ten. */
export function niceStep(range: number, maxCount: number): number {
  const raw = range / Math.max(1, maxCount);
  const power = 10 ** Math.floor(Math.log10(raw));
  const mantissa = raw / power;
  const nice = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return nice * power;
}

function stepMantissa(step: number): number {
  const power = 10 ** Math.floor(Math.log10(step) + 1e-9);
  return Math.round(step / power);
}

function decimalsFor(step: number): number {
  const digits = -Math.floor(Math.log10(step) + 1e-9);
  return Math.min(12, Math.max(0, digits));
}

function fixed(value: number, decimals: number): string {
  let text = value.toFixed(decimals);
  if (Number(text) === 0) text = (0).toFixed(decimals);
  return text.startsWith("-") ? MINUS + text.slice(1) : text;
}

/** The power of 1000 to divide out of labels for a range reaching `maxAbs`. */
export function engineeringExponent(maxAbs: number): number {
  if (!(maxAbs > 0) || !Number.isFinite(maxAbs)) return 0;
  if (maxAbs >= LOW_TRIP && maxAbs < HIGH_TRIP) return 0;
  const exponent = Math.floor(Math.log10(maxAbs) + 1e-9);
  return Math.floor(exponent / 3) * 3;
}

export function linearTicks(lo: number, hi: number, maxCount: number, minor: boolean): TickSet {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(range)) return { major: [], minor: [], exponent: 0 };

  const step = niceStep(range, maxCount);
  const tolerance = range * 1e-9;
  const first = Math.ceil((min - tolerance) / step);
  const last = Math.floor((max + tolerance) / step);
  const exponent = engineeringExponent(Math.max(Math.abs(min), Math.abs(max)));
  const factor = 10 ** exponent;
  const decimals = decimalsFor(step / factor);

  const major: Tick[] = [];
  for (let index = first; index <= last; index += 1) {
    // `|| 0` turns -0 into 0.
    const value = index * step || 0;
    major.push({ value, label: fixed(value / factor, decimals) });
  }

  const minorValues: number[] = [];
  if (minor) {
    // Fifths between 1- and 5-steps, quarters between 2-steps.
    const divisions = stepMantissa(step) === 2 ? 4 : 5;
    const minorStep = step / divisions;
    const start = Math.ceil((min - tolerance) / minorStep);
    const end = Math.floor((max + tolerance) / minorStep);
    for (let index = start; index <= end; index += 1) {
      if (index % divisions !== 0) minorValues.push(index * minorStep);
    }
  }
  return { major, minor: minorValues, exponent };
}

export function logTicks(lo: number, hi: number, maxCount: number): TickSet {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (!(min > 0) || !Number.isFinite(max)) return { major: [], minor: [], exponent: 0 };
  const firstDecade = Math.ceil(Math.log10(min) - 1e-9);
  const lastDecade = Math.floor(Math.log10(max) + 1e-9);
  const decades = lastDecade - firstDecade + 1;

  // Less than two decade ticks would leave the axis nearly unlabelled, so
  // fall back to ordinary 1-2-5 ticks on the values.
  if (decades < 2) return linearTicks(min, max, maxCount, true);

  const stride = Math.max(1, Math.ceil(decades / Math.max(1, maxCount)));
  const major: Tick[] = [];
  for (let decade = firstDecade; decade <= lastDecade; decade += 1) {
    if ((decade - firstDecade) % stride !== 0) continue;
    const label = decade < 0 ? `10^{${MINUS}${-decade}}` : `10^{${decade}}`;
    major.push({ value: 10 ** decade, label });
  }
  const minor: number[] = [];
  for (let decade = firstDecade - 1; decade <= lastDecade; decade += 1) {
    if (stride === 1) {
      for (let digit = 2; digit <= 9; digit += 1) {
        const value = digit * 10 ** decade;
        if (value >= min && value <= max) minor.push(value);
      }
    } else if ((decade - firstDecade) % stride !== 0 && decade >= firstDecade) {
      minor.push(10 ** decade);
    }
  }
  return { major, minor, exponent: 0 };
}

/** Can this unit take an SI prefix ("V" yes, "%" or "°C" no)? */
const takesPrefix = (unit: string): boolean => /^\p{L}/u.test(unit);

/**
 * The text that accounts for the exponent factored out of the tick labels:
 * a prefixed unit ("mV") when the unit allows it, otherwise "x10^n" (followed
 * by the unit, if any). Empty when there is nothing to say.
 */
export function scaleSuffix(exponent: number, unit: string): string {
  if (exponent === 0) return unit;
  const prefix = SI_PREFIXES[exponent];
  if (unit && prefix !== undefined && takesPrefix(unit)) return `${prefix}${unit}`;
  const power = exponent < 0 ? `${MINUS}${-exponent}` : String(exponent);
  return unit ? `×10^{${power}} ${unit}` : `×10^{${power}}`;
}

/**
 * The axis label to draw. With no user label it is just the unit (with any
 * prefix); a user label is kept verbatim and the scale is appended only when
 * the tick labels have had an exponent divided out.
 */
export function axisLabelText(userLabel: string | null, exponent: number, unit: string): string {
  if (userLabel === null) return scaleSuffix(exponent, unit);
  if (exponent === 0) return userLabel;
  return userLabel ? `${userLabel} (${scaleSuffix(exponent, unit)})` : scaleSuffix(exponent, unit);
}

/** Formats a value compactly for readouts and tables (not for axes). */
export function formatNumber(value: number, digits = 6): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-4 && magnitude < 10 ** digits) {
    return String(Number(value.toPrecision(digits)));
  }
  return value
    .toExponential(digits - 1)
    .replace(/\.?0+e/, "e")
    .replace("e+", "e");
}

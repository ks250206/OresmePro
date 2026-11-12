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

/** Fixed notation with up to `decimals` digits, without trailing zeros. */
function trimmed(value: number, decimals: number): string {
  const text = fixed(value, decimals);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
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

const FORMAT_PATTERN = /^(\+)?(,)?(?:\.(\d{1,2}))?([fegd%])?$/;

/** Whether text is a tick label format this module understands. */
export const isTickFormat = (text: string): boolean => text !== "" && FORMAT_PATTERN.test(text);

const grouped = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Writes a number the way a Python format spec would (`format(value, spec)`),
 * for the subset that makes sense on an axis: an optional "+", "," for
 * thousands, a precision, and a type f, e, g, d or %. Exponents are set as
 * superscripts rather than "e+03".
 */
export function formatTick(value: number, format: string): string {
  const match = FORMAT_PATTERN.exec(format);
  if (!match || !Number.isFinite(value)) return formatNumber(value);
  const [, plus, comma, precisionText, type = precisionText === undefined ? "g" : "f"] = match;
  const precision = precisionText === undefined ? undefined : Number(precisionText);
  const magnitude = Math.abs(value);
  let body: string;
  if (type === "e") {
    const [mantissa, exponent] = magnitude.toExponential(precision ?? 1).split("e");
    body = magnitude === 0 ? "0" : `${mantissa}×10^{${Number(exponent)}}`.replace("-", MINUS);
  } else if (type === "g") {
    body = formatNumber(magnitude, precision ?? 6);
  } else {
    const scaled = type === "%" ? magnitude * 100 : magnitude;
    const text = scaled.toFixed(type === "d" ? 0 : (precision ?? (type === "%" ? 0 : 6)));
    const [whole, fraction] = text.split(".");
    body = (comma ? grouped(whole!) : whole!) + (fraction ? `.${fraction}` : "");
    if (type === "%") body += "%";
  }
  const zero = !/[1-9]/.test(body.split("×")[0]!);
  const sign = value < 0 && !zero ? MINUS : plus ? "+" : "";
  return sign + body;
}

export interface TickOptions {
  /** Distance between major ticks, instead of one chosen to fit `maxCount`. */
  step?: number | null;
  /** A format for the labels (see formatTick), instead of factoring out an exponent. */
  format?: string | null;
}

/** More ticks than this cannot be what was meant; the step is chosen automatically instead. */
const MAX_MANUAL_TICKS = 400;

export function linearTicks(
  lo: number,
  hi: number,
  maxCount: number,
  minor: boolean,
  options: TickOptions = {},
): TickSet {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(range)) return { major: [], minor: [], exponent: 0 };

  const manual =
    options.step && options.step > 0 && range / options.step <= MAX_MANUAL_TICKS
      ? options.step
      : null;
  const step = manual ?? niceStep(range, maxCount);
  const tolerance = range * 1e-9;
  const first = Math.ceil((min - tolerance) / step);
  const last = Math.floor((max + tolerance) / step);
  const { format } = options;
  const exponent = format ? 0 : engineeringExponent(Math.max(Math.abs(min), Math.abs(max)));
  const factor = 10 ** exponent;
  const decimals = decimalsFor(step / factor);

  const major: Tick[] = [];
  for (let index = first; index <= last; index += 1) {
    // `|| 0` turns -0 into 0.
    const value = index * step || 0;
    major.push({
      value,
      label: format
        ? formatTick(value, format)
        : manual
          ? // A step such as 0.25 needs more digits than its size suggests.
            trimmed(value / factor, decimals + 3)
          : fixed(value / factor, decimals),
    });
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

export function logTicks(
  lo: number,
  hi: number,
  maxCount: number,
  format: string | null = null,
): TickSet {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  if (!(min > 0) || !Number.isFinite(max)) return { major: [], minor: [], exponent: 0 };
  const firstDecade = Math.ceil(Math.log10(min) - 1e-9);
  const lastDecade = Math.floor(Math.log10(max) + 1e-9);
  const decades = lastDecade - firstDecade + 1;

  // Less than two decade ticks would leave the axis nearly unlabelled, so
  // fall back to ordinary 1-2-5 ticks on the values.
  if (decades < 2) return linearTicks(min, max, maxCount, true, { format });

  const stride = Math.max(1, Math.ceil(decades / Math.max(1, maxCount)));
  const major: Tick[] = [];
  for (let decade = firstDecade; decade <= lastDecade; decade += 1) {
    if ((decade - firstDecade) % stride !== 0) continue;
    const label = format
      ? formatTick(10 ** decade, format)
      : decade < 0
        ? `10^{${MINUS}${-decade}}`
        : `10^{${decade}}`;
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
 * A label with Igor's `\U` and `\u` (the axis' units) replaced by `units`, or
 * null if it has neither. A backslash escapes the character after it, so
 * `\\u` is a backslash and a "u".
 */
function withUnits(label: string, units: string): string | null {
  let out = "";
  let found = false;
  for (let index = 0; index < label.length; index += 1) {
    const char = label[index]!;
    const next = label[index + 1];
    if (char === "\\" && (next === "u" || next === "U")) {
      out += units;
      found = true;
    } else if (char === "\\" && next !== undefined) {
      out += char + next;
    } else {
      out += char;
      continue;
    }
    index += 1;
  }
  return found ? out : null;
}

/**
 * The axis label to draw. With no user label it is just the unit (with any
 * prefix); a user label is kept verbatim and the scale is appended only when
 * the tick labels have had an exponent divided out, unless the label says
 * where the units go with `\u`.
 */
export function axisLabelText(userLabel: string | null, exponent: number, unit: string): string {
  if (userLabel === null) return scaleSuffix(exponent, unit);
  const placed = withUnits(userLabel, scaleSuffix(exponent, unit));
  if (placed !== null) return placed;
  if (exponent === 0) return userLabel;
  if (!userLabel) return scaleSuffix(exponent, unit);
  // A label that changes its own look with codes has that look end with it,
  // so the scale after it is written as the label began.
  return userLabel.includes("\\")
    ? `\\[9${userLabel}\\]9 (${scaleSuffix(exponent, unit)})`
    : `${userLabel} (${scaleSuffix(exponent, unit)})`;
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

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
/** Tick spacings for time axes that land on round clock and calendar values. */
const TIME_STEPS = [
  1,
  2,
  5,
  10,
  15,
  30,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/**
 * A time zone for reading and writing dates. Dates are stored as seconds
 * since 1970-01-01 UTC; the zone says what the clock showed at that moment.
 */
export interface TimeZone {
  /** "UTC", "local" or an IANA name such as "Asia/Tokyo". */
  readonly name: string;
  /** What to call it on an axis. */
  readonly label: string;
  /** Seconds to add to UTC for the wall-clock time at a moment. */
  offsetAt(seconds: number): number;
}

export const UTC: TimeZone = { name: "UTC", label: "UTC", offsetAt: () => 0 };

const zones = new Map<string, TimeZone>([["UTC", UTC]]);

/**
 * The time zone with a name: "UTC", "local" (the zone of this computer) or
 * an IANA name. Throws a RangeError for a name that is none of those.
 */
export function timeZone(name: string): TimeZone {
  const known = zones.get(name);
  if (known) return known;
  const id = name === "local" ? new Intl.DateTimeFormat().resolvedOptions().timeZone : name;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  // Offsets change only at a transition, and those fall on quarter hours:
  // one lookup serves every moment in the same quarter hour.
  const cache = new Map<number, number>();
  const zone: TimeZone = {
    name,
    label: id,
    offsetAt: (seconds) => {
      if (!Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12) return 0;
      const slot = Math.floor(seconds / (15 * MINUTE));
      let offset = cache.get(slot);
      if (offset === undefined) {
        const at = slot * 15 * MINUTE;
        const parts: Record<string, number> = {};
        for (const part of format.formatToParts(new Date(at * 1000))) {
          if (part.type !== "literal") parts[part.type] = Number(part.value);
        }
        const wall =
          Date.UTC(
            parts.year!,
            parts.month! - 1,
            parts.day!,
            parts.hour!,
            parts.minute!,
            parts.second!,
          ) / 1000;
        offset = wall - at;
        if (cache.size > 50_000) cache.clear();
        cache.set(slot, offset);
      }
      return offset;
    },
  };
  zones.set(name, zone);
  return zone;
}

export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string") return false;
  try {
    timeZone(name);
    return true;
  } catch {
    return false;
  }
}

/** The moment at which the clock of a zone shows a wall-clock time (given in seconds as if UTC). */
function wallToUtc(wall: number, zone: TimeZone): number {
  if (zone === UTC) return wall;
  // The offset at the moment itself, found from a first guess; right except
  // inside the hour a clock change skips or repeats.
  return wall - zone.offsetAt(wall - zone.offsetAt(wall));
}

const two = (value: number): string => String(value).padStart(2, "0");
const dayOf = (date: Date): string =>
  `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;

/**
 * Formats seconds since 1970-01-01 UTC as `YYYY-MM-DD HH:MM:SS` in a time
 * zone, leaving out a time of midnight and adding milliseconds only when
 * there are some.
 */
export function formatDate(seconds: number, zone: TimeZone = UTC): string {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 8.64e12) return formatNumber(seconds);
  const date = new Date(Math.round((seconds + zone.offsetAt(seconds)) * 1000));
  const millis = date.getUTCMilliseconds();
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  if (time === "00:00:00" && millis === 0) return dayOf(date);
  return `${dayOf(date)} ${time}${millis ? `.${String(millis).padStart(3, "0")}` : ""}`;
}

const DATE_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parses `YYYY-MM-DD`, optionally with a time and a UTC offset, to seconds
 * since 1970-01-01 UTC. A time without an offset is taken to be in the given zone.
 * Returns null for anything else.
 */
export function parseDate(text: string, zone: TimeZone = UTC): number | null {
  const match = DATE_PATTERN.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", offset] = match;
  const millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let seconds = millis / 1000 + Number(second);
  if (!offset) {
    seconds = wallToUtc(seconds, zone);
  } else if (offset.toUpperCase() !== "Z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    seconds -= sign * (Number(digits.slice(0, 2)) * HOUR + Number(digits.slice(2)) * MINUTE);
  }
  return Number.isFinite(seconds) ? seconds : null;
}

export interface DateTickSet extends TickSet {
  /** What the labels leave out, for the axis label: the day, or the year. */
  context: string;
}

/**
 * Ticks for an axis of dates (seconds since 1970-01-01 UTC) on round clock
 * or calendar values of a time zone. Returns null when the range is too
 * short for that (under a few seconds), where ordinary numeric ticks serve
 * better.
 */
export function dateTicks(
  lo: number,
  hi: number,
  maxCount: number,
  zone: TimeZone = UTC,
): DateTickSet | null {
  const from = Math.min(lo, hi);
  const to = Math.max(lo, hi);
  const target = (to - from) / Math.max(1, maxCount);
  if (!(target >= 0.5) || !Number.isFinite(target) || Math.abs(to) > 8.64e12) return null;
  // Everything below works on wall-clock time: the range as the zone's clock
  // shows it. A tick goes back to a moment only when it is stored.
  const min = from + zone.offsetAt(from);
  const max = to + zone.offsetAt(to);
  const major: Tick[] = [];
  const add = (wall: number, label: string) => {
    const value = wallToUtc(wall, zone);
    if (value >= from && value <= to) major.push({ value, label });
  };
  const first = new Date(min * 1000);
  const last = new Date(max * 1000);
  const sameDay = dayOf(first) === dayOf(last);
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  let context = "";

  const step = TIME_STEPS.find((candidate) => candidate >= target);
  if (step !== undefined) {
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
      const date = new Date(value * 1000);
      const clock = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
      const label =
        step < MINUTE
          ? `${clock}:${two(date.getUTCSeconds())}`
          : step < DAY
            ? sameDay
              ? clock
              : `${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${clock}`
            : `${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
      add(value, label);
    }
    // With times of day on the axis, it matters whose clock they are.
    const clockOf = step < DAY ? ` ${zone.label}` : "";
    context =
      step < DAY && sameDay
        ? `${dayOf(first)}${clockOf}`
        : sameYear
          ? `${first.getUTCFullYear()}${clockOf}`
          : `${first.getUTCFullYear()}–${last.getUTCFullYear()}${clockOf}`;
    return { major, minor: [], exponent: 0, context };
  }

  const months = [1, 3, 6].find((candidate) => candidate * 30.44 * DAY >= target);
  if (months !== undefined) {
    let year = first.getUTCFullYear();
    let month = Math.ceil(first.getUTCMonth() / months) * months;
    for (;;) {
      const value = Date.UTC(year, month, 1) / 1000;
      if (value > max) break;
      if (value >= min) {
        const date = new Date(value * 1000);
        add(value, `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}`);
      }
      month += months;
      year += Math.floor(month / 12);
      month %= 12;
    }
    return { major, minor: [], exponent: 0, context };
  }

  const years = Math.max(1, niceStep((max - min) / (365.25 * DAY), maxCount));
  for (let year = Math.ceil(first.getUTCFullYear() / years) * years; ; year += years) {
    const value = Date.UTC(year, 0, 1) / 1000;
    if (value > max) break;
    if (value >= min) add(value, String(year));
  }
  return { major, minor: [], exponent: 0, context };
}

/** Ticks for a category axis: one per category in view, thinned to at most `maxCount`. */
export function categoryTicks(
  lo: number,
  hi: number,
  maxCount: number,
  categories: readonly string[],
): TickSet {
  const first = Math.max(0, Math.ceil(Math.min(lo, hi)));
  const last = Math.min(categories.length - 1, Math.floor(Math.max(lo, hi)));
  const stride = Math.max(1, Math.ceil((last - first + 1) / Math.max(1, maxCount)));
  const major: Tick[] = [];
  for (let index = first; index <= last; index += stride) {
    major.push({ value: index, label: categories[index] ?? "" });
  }
  return { major, minor: [], exponent: 0 };
}

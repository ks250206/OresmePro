/**
 * XPS peak models as the XPS Peak Fitting window draws them while they are
 * edited: CasaXPS's line shapes, the backgrounds under a region, and the
 * constraints between components. The fit itself is op.xps_fit, in
 * src/kernel/python/_oresme_xps.py; this is the same arithmetic, so that what
 * is dragged on the screen is what Python will start from, and what it
 * returns is drawn as it computed it. Keep the two in step.
 */

export const XPS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const XPS_PARAMS = ["position", "fwhm", "area"] as const;
export type XpsParam = (typeof XPS_PARAMS)[number];
export const XPS_BACKGROUNDS = ["shirley", "linear", "tougaard", "none"] as const;
export type XpsBackground = (typeof XPS_BACKGROUNDS)[number];
/** Line shapes offered in the window's menu; any other can be typed. */
export const XPS_SHAPES = [
  "GL(30)",
  "GL(0)",
  "GL(50)",
  "GL(100)",
  "SGL(30)",
  "GL(30)T(1)",
  "LA(1.53,243)",
] as const;
export const FWHM_LIMITS: readonly [number, number] = [0.05, 20];
export const TOUGAARD_C = 1643;
const AREA_POINTS = 20000;
const LN2 = Math.log(2);
const SIGMA_PER_FWHM = 1 / (2 * Math.sqrt(2 * LN2));

/** A component as the window holds it and op.xps_fit takes it. */
export interface XpsComponent {
  name: string;
  shape: string;
  position: number;
  fwhm: number;
  area: number;
  rsf: number;
  gauss: number;
  constraints: Record<XpsParam, string>;
}

// --- Line shapes ---------------------------------------------------------------------

export interface Shape {
  kind: "GL" | "SGL" | "LA";
  m: number;
  k: number | null;
  alpha: number;
  beta: number;
  text: string;
}

const UNSIGNED = String.raw`\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*`;
const GL_RE = new RegExp(String.raw`^(S?GL)\(${UNSIGNED}\)(?:T\(${UNSIGNED}\))?$`, "i");
const LA_RE = new RegExp(String.raw`^LA\(${UNSIGNED},${UNSIGNED}\)$`, "i");

/** The shape CasaXPS's notation names, or the reason it is not one. */
export function parseShape(text: string): Shape | string {
  const plain = text.trim().replace(/ /g, "");
  let match = GL_RE.exec(plain);
  if (match) {
    const kind = match[1]!.toUpperCase() as "GL" | "SGL";
    const m = Number(match[2]);
    const k = match[3] === undefined ? null : Number(match[3]);
    if (!(m >= 0 && m <= 100)) return `The m of ${text} is from 0 (Gaussian) to 100 (Lorentzian).`;
    if (k !== null && !(k > 0)) return `The tail k of ${text} must be more than 0.`;
    return { kind, m, k, alpha: 0, beta: 0, text: `${kind}(${m})${k === null ? "" : `T(${k})`}` };
  }
  match = LA_RE.exec(plain);
  if (match) {
    const alpha = Number(match[1]);
    const beta = Number(match[2]);
    if (!(alpha > 0.5 && beta > 0.5))
      return `α and β of ${text} must be more than 0.5, for a finite area.`;
    return { kind: "LA", m: 0, k: null, alpha, beta, text: `LA(${alpha},${beta})` };
  }
  return `${JSON.stringify(text)} is not a line shape: GL(m), SGL(m), GL(m)T(k), SGL(m)T(k) or LA(α,β).`;
}

/** The shape at u = (BE − E) / F: 1 at the position. */
export function profile(shape: Shape, u: number): number {
  if (shape.kind === "LA") {
    const base = 1 + 4 * u * u;
    return base ** -(u >= 0 ? shape.alpha : shape.beta);
  }
  const mix = shape.m / 100;
  const body =
    shape.kind === "GL"
      ? Math.exp(-4 * LN2 * (1 - mix) * u * u) / (1 + 4 * mix * u * u)
      : (1 - mix) * Math.exp(-4 * LN2 * u * u) + mix / (1 + 4 * u * u);
  if (shape.k === null || !(u > 0)) return body;
  return body + (1 - body) * Math.exp(-shape.k * u);
}

function sharpness(shape: Shape): number {
  if (shape.kind !== "LA") return 0.4;
  const power = Math.max(shape.alpha, shape.beta);
  return Math.min(0.4, 0.5 * Math.sqrt(2 ** (1 / power) - 1));
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let sum = c[0]!;
  for (let i = 1; i < 9; i += 1) sum += c[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function halfLorentzArea(power: number): number {
  return 0.25 * Math.sqrt(Math.PI) * Math.exp(lgamma(power - 0.5) - lgamma(power));
}

/** ∫_0^∞ f(u) du by Simpson's rule after u = t / (1 − t), as Python's _half_area. */
export function halfArea(f: (u: number) => number): number {
  const n = 2 * AREA_POINTS;
  const h = 1 / n;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i * h;
    const value = f(t / (1 - t)) / (1 - t) ** 2;
    sum += (i === 0 ? 1 : i % 2 === 1 ? 4 : 2) * value;
  }
  const far = 1e8;
  sum += f(far) * far * far;
  return (sum * h) / 3;
}

const areas = new Map<string, number>();

/** The area under a shape's profile for F = 1. */
export function unitArea(shape: Shape): number {
  const known = areas.get(shape.text);
  if (known !== undefined) return known;
  const mix = shape.m / 100;
  let area: number;
  if (shape.kind === "LA") area = halfLorentzArea(shape.alpha) + halfLorentzArea(shape.beta);
  else if (shape.k === null && shape.kind === "SGL")
    area = (1 - mix) * 0.5 * Math.sqrt(Math.PI / LN2) + (mix * Math.PI) / 2;
  else if (shape.k === null && mix === 1) area = Math.PI / 2;
  else if (shape.k === null && mix === 0) area = 0.5 * Math.sqrt(Math.PI / LN2);
  else area = halfArea((u) => profile(shape, u)) + halfArea((u) => profile(shape, -u));
  areas.set(shape.text, area);
  return area;
}

/** The height of a component of this area and width parameter at its position, without a Gaussian. */
export function peakHeight(shape: Shape, fwhm: number, area: number): number {
  return area / (unitArea(shape) * Math.max(fwhm, 1e-9));
}

/** The area that gives a component this height (without a Gaussian). */
export function areaForHeight(shape: Shape, fwhm: number, height: number): number {
  return height * unitArea(shape) * Math.max(fwhm, 1e-9);
}

/** A component of this shape at the binding energies `be`, convolved with a Gaussian of FWHM `gauss`. */
export function curve(
  shape: Shape,
  be: ArrayLike<number>,
  position: number,
  fwhm: number,
  area: number,
  gauss = 0,
): Float64Array {
  const out = new Float64Array(be.length);
  const width = Math.max(fwhm, 1e-9);
  const height = area / (unitArea(shape) * width);
  if (!(gauss > 0) || be.length === 0) {
    for (let i = 0; i < be.length; i += 1)
      out[i] = height * profile(shape, (be[i]! - position) / width);
    return out;
  }
  const sigma = gauss * SIGMA_PER_FWHM;
  const reach = 5 * sigma;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < be.length; i += 1) {
    lowest = Math.min(lowest, be[i]!);
    highest = Math.max(highest, be[i]!);
  }
  const low = lowest - reach;
  const high = highest + reach;
  let step = Math.min((width * sharpness(shape)) / 15, sigma / 10);
  if ((high - low) / step > 400_000) step = (high - low) / 400_000;
  const first = Math.floor((low - position) / step);
  const last = Math.ceil((high - position) / step);
  const count = last - first + 1;
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = profile(shape, ((first + i) * step) / width);
  const half = Math.ceil(reach / step);
  const kernel = new Float64Array(2 * half + 1);
  let total = 0;
  for (let j = -half; j <= half; j += 1) {
    const value = Math.exp(-0.5 * ((j * step) / sigma) ** 2);
    kernel[j + half] = value;
    total += value;
  }
  for (let j = 0; j < kernel.length; j += 1) kernel[j]! /= total;
  const smoothed = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    const from = Math.max(0, i - half);
    const to = Math.min(count - 1, i + half);
    for (let j = from; j <= to; j += 1) sum += samples[j]! * kernel[i - j + half]!;
    smoothed[i] = sum;
  }
  for (let i = 0; i < be.length; i += 1) {
    const at = (be[i]! - position) / step - first;
    const index = Math.floor(at);
    if (index < 0) out[i] = height * smoothed[0]!;
    else if (index >= count - 1) out[i] = height * smoothed[count - 1]!;
    else {
      const fraction = at - index;
      out[i] = height * (smoothed[index]! * (1 - fraction) + smoothed[index + 1]! * fraction);
    }
  }
  return out;
}

// --- Constraints -----------------------------------------------------------------------

export type Constraint =
  | { kind: "free"; low: number; high: number }
  | { kind: "fixed" }
  | { kind: "tied"; ref: number; scale: number; offset: number };

const NUM = String.raw`[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?`;
const TIED_RE = new RegExp(String.raw`^([A-Za-z])\s*(?:([-+*/])\s*(${NUM}))?$`);
const LIMITS_RE = new RegExp(
  String.raw`^\[?\s*(${NUM})\s*(?:,|;|:|\.\.|\s+to\s+|\s)\s*(${NUM})\s*\]?$`,
  "i",
);

/** A constraint as op.xps_fit reads it: "", "284, 286", "fixed", "A", "A+1.5", "A*0.5", "A/2". */
export function parseConstraint(
  text: string,
  limits: readonly [number, number],
  count: number,
  self: number,
): Constraint | string {
  const plain = text.trim();
  if (["fixed", "fix", "!", "hold", "held"].includes(plain.toLowerCase())) return { kind: "fixed" };
  const tied = TIED_RE.exec(plain);
  if (tied) {
    const letter = tied[1]!.toUpperCase();
    const ref = XPS_LETTERS.indexOf(letter);
    if (ref >= count) return `There is no component ${letter}.`;
    if (ref === self) return "A parameter cannot be tied to itself.";
    const amount = tied[3] === undefined ? 0 : Number(tied[3]);
    switch (tied[2]) {
      case "+":
        return { kind: "tied", ref, scale: 1, offset: amount };
      case "-":
        return { kind: "tied", ref, scale: 1, offset: -amount };
      case "*":
        return { kind: "tied", ref, scale: amount, offset: 0 };
      case "/":
        return amount === 0
          ? "It divides by 0."
          : { kind: "tied", ref, scale: 1 / amount, offset: 0 };
      default:
        return { kind: "tied", ref, scale: 1, offset: 0 };
    }
  }
  if (plain === "") return { kind: "free", low: limits[0], high: limits[1] };
  const match = LIMITS_RE.exec(plain);
  if (!match)
    return `${JSON.stringify(plain)} is not a constraint: leave it empty, or write limits "284, 286", "fixed", or "A", "A+1.5", "A*0.5".`;
  const low = Math.min(Number(match[1]), Number(match[2]));
  const high = Math.max(Number(match[1]), Number(match[2]));
  if (!(low < high)) return "The limits leave nothing between them.";
  return { kind: "free", low, high };
}

export interface Resolved {
  /** The values each component has, ties worked out: position, fwhm, area. */
  values: Record<XpsParam, number>[];
  /** What is wrong, by component and parameter ("A.position"), or by component ("A"). */
  errors: Record<string, string>;
  shapes: (Shape | null)[];
}

/** The values the components have with their constraints applied, as op.xps_fit starts from them. */
export function resolveComponents(
  components: readonly XpsComponent[],
  region: readonly [number, number],
): Resolved {
  const errors: Record<string, string> = {};
  const count = components.length;
  const limits: Record<XpsParam, readonly [number, number]> = {
    position: region,
    fwhm: FWHM_LIMITS,
    area: [0, Infinity],
  };
  const constraints = components.map(
    (component, index) =>
      Object.fromEntries(
        XPS_PARAMS.map((param) => {
          const parsed = parseConstraint(
            component.constraints[param] ?? "",
            limits[param],
            count,
            index,
          );
          if (typeof parsed === "string") {
            errors[`${XPS_LETTERS[index]}.${param}`] = parsed;
            return [param, { kind: "free", low: -Infinity, high: Infinity }];
          }
          return [param, parsed];
        }),
      ) as Record<XpsParam, Constraint>,
  );
  const shapes = components.map((component, index) => {
    const shape = parseShape(component.shape || "GL(30)");
    if (typeof shape === "string") {
      errors[XPS_LETTERS[index]!] = shape;
      return null;
    }
    return shape;
  });
  const values = components.map(() => ({ position: NaN, fwhm: NaN, area: NaN }));
  for (const param of XPS_PARAMS) {
    const done = new Map<number, number>();
    const resolve = (index: number, seen: number[]): number => {
      const known = done.get(index);
      if (known !== undefined) return known;
      if (seen.includes(index)) {
        const chain = [...seen, index].map((i) => `${XPS_LETTERS[i]}.${param}`).join(" → ");
        errors[`${XPS_LETTERS[index]}.${param}`] =
          `The constraints go round in a circle: ${chain}.`;
        return NaN;
      }
      const rule = constraints[index]![param];
      const given = components[index]![param];
      let value: number;
      if (rule.kind === "fixed") value = given;
      else if (rule.kind === "free") value = Math.min(Math.max(given, rule.low), rule.high);
      else value = rule.scale * resolve(rule.ref, [...seen, index]) + rule.offset;
      done.set(index, value);
      return value;
    };
    for (let index = 0; index < count; index += 1) values[index]![param] = resolve(index, []);
  }
  return { values, errors, shapes };
}

// --- Energies, region and background ----------------------------------------------------

/** The binding energy of each point: the X values, turned from kinetic if need be, plus the shift. */
export function bindingEnergies(
  x: ArrayLike<number>,
  energy: "binding" | "kinetic",
  photonEnergy: number,
  shift: number,
): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i += 1)
    out[i] = (energy === "kinetic" ? photonEnergy - x[i]! : x[i]!) + shift;
  return out;
}

/** The run of points [first, stop) whose binding energies lie within `bounds` (all if null), or why not. */
export function regionPoints(
  be: ArrayLike<number>,
  y: ArrayLike<number>,
  bounds: readonly [number, number] | null,
): { first: number; stop: number } | string {
  const [low, high] = bounds ? [Math.min(...bounds), Math.max(...bounds)] : [-Infinity, Infinity];
  let first = -1;
  let last = -1;
  let inside = 0;
  for (let i = 0; i < be.length; i += 1) {
    if (Number.isFinite(be[i]) && Number.isFinite(y[i]) && be[i]! >= low && be[i]! <= high) {
      if (first < 0) first = i;
      last = i;
      inside += 1;
    }
  }
  if (inside < 5) return `The region has ${inside} points with values; it needs at least 5.`;
  for (let i = first; i <= last; i += 1)
    if (!Number.isFinite(be[i]) || !Number.isFinite(y[i]))
      return "The region has points without values (NaN); choose a region without them.";
  const rising = be[first + 1]! > be[first]!;
  for (let i = first + 1; i <= last; i += 1)
    if (be[i]! > be[i - 1]! !== rising || be[i] === be[i - 1])
      return "The energies must rise or fall steadily across the region.";
  return { first, stop: last + 1 };
}

function shirley(
  x: Float64Array,
  y: Float64Array,
  low: number,
  high: number,
): Float64Array | string {
  let maxAbs = 0;
  for (const value of y) maxAbs = Math.max(maxAbs, Math.abs(value));
  const target = 1e-7 * Math.max(Math.abs(high - low), Number.EPSILON * maxAbs);
  let background = new Float64Array(y.length).fill(low);
  const area = new Float64Array(y.length);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    area[0] = 0;
    for (let i = 1; i < y.length; i += 1) {
      const step = Math.abs(x[i]! - x[i - 1]!);
      area[i] =
        area[i - 1]! + ((y[i]! - background[i]! + y[i - 1]! - background[i - 1]!) / 2) * step;
    }
    const total = area[y.length - 1]!;
    if (!(Number.isFinite(total) && total !== 0))
      return "There is no peak above the background to build a Shirley background on.";
    const next = new Float64Array(y.length);
    let change = 0;
    for (let i = 0; i < y.length; i += 1) {
      next[i] = low + ((high - low) * area[i]!) / total;
      change = Math.max(change, Math.abs(next[i]! - background[i]!));
    }
    background = next;
    if (change <= target) return background;
  }
  return "The Shirley background did not settle in 200 iterations.";
}

function tougaardIntegral(x: Float64Array, y: Float64Array, C: number): Float64Array {
  // x rises: electrons appear at a point after losing energy from the points below it.
  const out = new Float64Array(x.length);
  for (let index = 1; index < x.length; index += 1) {
    let sum = 0;
    let previous = 0;
    for (let j = 0; j <= index; j += 1) {
      const lost = Math.abs(x[index]! - x[j]!);
      const value = (lost / (C + lost * lost) ** 2) * y[j]!;
      if (j > 0) sum += ((value + previous) / 2) * Math.abs(x[j]! - x[j - 1]!);
      previous = value;
    }
    out[index] = sum;
  }
  return out;
}

/** The background under the points of a region, in their order (see op.xps_fit), or why there is none. */
export function background(
  be: ArrayLike<number>,
  y: ArrayLike<number>,
  method: XpsBackground,
  average: number,
): Float64Array | string {
  const n = be.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => be[a]! - be[b]! || a - b);
  const x = Float64Array.from(order, (i) => be[i]!);
  const data = Float64Array.from(order, (i) => y[i]!);
  const out = new Float64Array(n);
  if (method === "none") return out;
  const count = Math.trunc(average);
  if (count < 1 || 2 * count >= n)
    return `The ends are averaged over ${count} points; the region has ${n}, so it is 1 to ${Math.max(1, Math.floor((n - 1) / 2))}.`;
  const mean = (values: Float64Array, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += values[i]!;
    return sum / (to - from);
  };
  const low = mean(data, 0, count);
  const high = mean(data, n - count, n);
  let sorted: Float64Array;
  if (method === "linear") {
    const left = mean(x, 0, count);
    const right = mean(x, n - count, n);
    sorted = Float64Array.from(
      x,
      (value) => low + ((high - low) * (value - left)) / (right - left),
    );
  } else if (method === "shirley") {
    const made = shirley(x, data, low, high);
    if (typeof made === "string") return made;
    sorted = made;
  } else {
    const loss = tougaardIntegral(
      x,
      Float64Array.from(data, (value) => value - low),
      TOUGAARD_C,
    );
    const tail = mean(loss, n - count, n);
    if (!(tail > 0)) return "There is no peak to scale the Tougaard background to.";
    sorted = Float64Array.from(loss, (value) => low + ((high - low) / tail) * value);
  }
  order.forEach((index, at) => {
    out[index] = sorted[at]!;
  });
  return out;
}

// --- A whole model -----------------------------------------------------------------------

export interface XpsModelInput {
  /** Binding energies and data of every point of the spectrum. */
  be: Float64Array;
  y: ArrayLike<number>;
  region: readonly [number, number] | null;
  background: XpsBackground;
  average: number;
  components: readonly XpsComponent[];
}

export interface XpsModel {
  /** The region's points: [first, stop) of the spectrum. */
  first: number;
  stop: number;
  be: Float64Array;
  data: Float64Array;
  /** The background, null with the reason in `problem` when it cannot be made. */
  background: Float64Array | null;
  /** Each component alone (not on the background), drawn as its values say. */
  components: Float64Array[];
  envelope: Float64Array | null;
  residual: Float64Array | null;
  resolved: Resolved;
  /** Why the region or its background cannot be made, if so. */
  problem: string | null;
}

/** Everything the window draws for a model: the region, its background, each component and the sum. */
export function evaluateModel(input: XpsModelInput): XpsModel | string {
  const points = regionPoints(input.be, input.y, input.region);
  if (typeof points === "string") return points;
  const { first, stop } = points;
  const be = input.be.slice(first, stop);
  const data = Float64Array.from({ length: stop - first }, (_, i) => Number(input.y[first + i]));
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of be) {
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  const made = background(be, data, input.background, input.average);
  const bg = typeof made === "string" ? null : made;
  const resolved = resolveComponents(input.components, [lo, hi]);
  const components = input.components.map((component, index) => {
    const shape = resolved.shapes[index];
    const values = resolved.values[index]!;
    if (!shape || !XPS_PARAMS.every((param) => Number.isFinite(values[param])))
      return new Float64Array(be.length);
    return curve(shape, be, values.position, values.fwhm, values.area, component.gauss);
  });
  let envelope: Float64Array | null = null;
  let residual: Float64Array | null = null;
  if (bg) {
    envelope = Float64Array.from(bg);
    for (const part of components) for (let i = 0; i < be.length; i += 1) envelope[i]! += part[i]!;
    residual = Float64Array.from(data, (value, i) => value - envelope![i]!);
  }
  return {
    first,
    stop,
    be,
    data,
    background: bg,
    components,
    envelope,
    residual,
    resolved,
    problem: typeof made === "string" ? made : null,
  };
}

/** Linear interpolation of (x, y) at `at`; x in either order. */
export function interpolate(x: ArrayLike<number>, y: ArrayLike<number>, at: number): number {
  const n = x.length;
  if (n === 0) return NaN;
  const rising = x[n - 1]! >= x[0]!;
  let lo = 0;
  let hi = n - 1;
  const before = (value: number) => (rising ? value <= at : value >= at);
  if (!before(x[0]!)) return y[0]!;
  if (before(x[n - 1]!)) return y[n - 1]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (before(x[mid]!)) lo = mid;
    else hi = mid;
  }
  const span = x[hi]! - x[lo]!;
  return span === 0 ? y[lo]! : y[lo]! + ((y[hi]! - y[lo]!) * (at - x[lo]!)) / span;
}

/** A new component at a binding energy, as tall as the data above the background there. */
export function newComponent(
  model: XpsModel,
  position: number,
  index: number,
  shape = "GL(30)",
  fwhm = 1.2,
): XpsComponent {
  const parsed = parseShape(shape);
  const net = model.background
    ? Float64Array.from(model.data, (value, i) => value - model.background![i]!)
    : model.data;
  // What the other components already account for there is not this one's.
  let others = 0;
  for (const part of model.components) others += interpolate(model.be, part, position);
  let peak = 0;
  for (const value of net) peak = Math.max(peak, Math.abs(value));
  const height = Math.max(interpolate(model.be, net, position) - others, 0.05 * peak);
  return {
    name: XPS_LETTERS[index] ?? "",
    shape,
    position,
    fwhm,
    area: typeof parsed === "string" ? 0 : areaForHeight(parsed, fwhm, height),
    rsf: 1,
    gauss: 0,
    constraints: { position: "", fwhm: "", area: "" },
  };
}

/**
 * The components after one is taken out: ties to it are let go (the tied
 * value kept as a plain one), and ties to those after it move up a letter.
 */
export function removeComponent(
  components: readonly XpsComponent[],
  index: number,
  values: readonly Record<XpsParam, number>[],
): XpsComponent[] {
  return components
    .map((component, at) => {
      const constraints = { ...component.constraints };
      const next = { ...component };
      for (const param of XPS_PARAMS) {
        const tied = TIED_RE.exec(constraints[param].trim());
        if (!tied) continue;
        const ref = XPS_LETTERS.indexOf(tied[1]!.toUpperCase());
        if (ref === index) {
          constraints[param] = "";
          const value = values[at]?.[param];
          if (value !== undefined && Number.isFinite(value)) next[param] = value;
        } else if (ref > index) {
          constraints[param] = XPS_LETTERS[ref - 1]! + constraints[param].trim().slice(1);
        }
      }
      return { ...next, constraints };
    })
    .filter((_, at) => at !== index);
}

/** The components as op.xps_fit takes them: plain values, leaving out what is as by default. */
export function componentsArg(components: readonly XpsComponent[]): Record<string, unknown>[] {
  return components.map((component) => {
    const out: Record<string, unknown> = {
      name: component.name,
      shape: component.shape,
      position: round(component.position),
      fwhm: round(component.fwhm),
      area: round(component.area),
    };
    if (component.rsf !== 1) out.rsf = component.rsf;
    if (component.gauss !== 0) out.gauss = component.gauss;
    const constraints = Object.fromEntries(
      XPS_PARAMS.filter((param) => component.constraints[param].trim() !== "").map((param) => [
        param,
        component.constraints[param].trim(),
      ]),
    );
    if (Object.keys(constraints).length > 0) out.constraints = constraints;
    return out;
  });
}

/** Ten significant digits: enough to start a fit where it was, short enough to read in the history. */
function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(10)) : value;
}

/** Reading the Hold and Constraints fields of the Curve Fitting dialog. */

const PARAMETER = "[A-Za-z_][A-Za-z0-9_]*";
const NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";

/**
 * Turns "y0=0, width=1.5" into a Python dict of parameters to keep fixed.
 * Returns "" for nothing to hold and null if the text cannot be read.
 */
export function parseHold(text: string): string | null {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const entries: string[] = [];
  for (const item of items) {
    const match = new RegExp(`^(${PARAMETER})\\s*=\\s*(${NUMBER})$`).exec(item);
    if (!match) return null;
    entries.push(`${JSON.stringify(match[1])}: ${Number(match[2])}`);
  }
  return entries.length > 0 ? `{${entries.join(", ")}}` : "";
}

/**
 * Turns "A > 0, 2 < x0 < 5" into a Python dict of (low, high) limits.
 * Returns "" for no constraints and null if the text cannot be read.
 */
export function parseConstraints(text: string): string | null {
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const limits = new Map<string, [number | null, number | null]>();
  const limit = (name: string) => {
    if (!limits.has(name)) limits.set(name, [null, null]);
    return limits.get(name)!;
  };
  for (const item of items) {
    const between = new RegExp(`^(${NUMBER})\\s*<=?\\s*(${PARAMETER})\\s*<=?\\s*(${NUMBER})$`).exec(
      item,
    );
    const right = new RegExp(`^(${PARAMETER})\\s*([<>])=?\\s*(${NUMBER})$`).exec(item);
    const left = new RegExp(`^(${NUMBER})\\s*([<>])=?\\s*(${PARAMETER})$`).exec(item);
    if (between) {
      limits.set(between[2]!, [Number(between[1]), Number(between[3])]);
    } else if (right) {
      limit(right[1]!)[right[2] === ">" ? 0 : 1] = Number(right[3]);
    } else if (left) {
      // "0 < A" bounds A from below; "5 > A" from above.
      limit(left[3]!)[left[2] === "<" ? 0 : 1] = Number(left[1]);
    } else {
      return null;
    }
  }
  const py = (value: number | null) => (value === null ? "None" : String(value));
  const entries = [...limits].map(
    ([name, [low, high]]) => `${JSON.stringify(name)}: (${py(low)}, ${py(high)})`,
  );
  return entries.length > 0 ? `{${entries.join(", ")}}` : "";
}

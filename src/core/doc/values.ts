import type { Wave } from "./types";

interface Seen {
  readonly imag: object | null;
  readonly type: string;
  readonly shape: string;
  readonly id: number;
}

/** Per array of values: the ids given to it, with what else they went with. */
const seen = new WeakMap<object, Seen[]>();
let last = 0;

/**
 * A number for a wave's values: its numbers (or texts), their type and their
 * shape. Two states of a wave have the same number exactly when these are
 * the same, whatever else changed (its note, units, scaling, name).
 *
 * Values are never changed in place: a command that changes them makes new
 * arrays, and undo keeps the arrays it shares with the state before. So the
 * arrays themselves tell values apart, and this number follows them. It is
 * for what keeps or sends values (the saved files, Python's copies), where
 * `rev`, which changes with everything about the wave, would make them
 * write or send the same numbers again after the note was edited.
 *
 * Numbers are unique for as long as the page runs; they do not survive it.
 */
export function valuesId(wave: Wave): number {
  const key: object = wave.text ?? wave.data;
  const shape = wave.shape.join("x");
  let list = seen.get(key);
  if (!list) {
    list = [];
    seen.set(key, list);
  }
  const found = list.find(
    (item) => item.imag === wave.imag && item.type === wave.type && item.shape === shape,
  );
  if (found) return found.id;
  const id = ++last;
  list.push({ imag: wave.imag, type: wave.type, shape, id });
  return id;
}

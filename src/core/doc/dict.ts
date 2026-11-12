/**
 * Everything the document keeps by name (waves, graphs, tables, procedures,
 * page layouts, a graph's axes and cursors, a table's column widths) is held
 * in an object without a prototype. In an ordinary object `waves.constructor`
 * or `"toString" in waves` finds what every object inherits, so a wave named
 * "constructor" would be taken for one that exists before it was made. With no
 * prototype, a name finds only what was stored under it, and "__proto__" is
 * an ordinary key rather than a way to replace the object's prototype.
 *
 * Spreading one (`{ ...waves }`) or `Object.fromEntries` gives an ordinary
 * object again, so these records are built only with the functions here.
 */
export type Dict<T> = Readonly<Record<string, T>>;

/** A record without a prototype, holding the given entries. */
export function dict<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) result[key] = value;
  return result;
}

/** A copy of a record (an ordinary one, say, as read from JSON) without a prototype. */
export const dictFrom = <T>(record: Dict<T> | null | undefined): Record<string, T> =>
  dict(record ? Object.entries(record) : []);

/** A copy of a record with one entry added or replaced. */
export function withEntry<T>(record: Dict<T>, key: string, value: T): Dict<T> {
  const result = dictFrom(record);
  result[key] = value;
  return result;
}

/** A copy of a record without some entries. */
export function withoutEntries<T>(record: Dict<T>, keys: Iterable<string>): Dict<T> {
  const result = dictFrom(record);
  for (const key of keys) delete result[key];
  return result;
}

/** The entries of a record that pass a test, as a record of the same kind. */
export function filterDict<T>(
  record: Dict<T>,
  keep: (value: T, key: string) => boolean,
): Record<string, T> {
  return dict(Object.entries(record).filter(([key, value]) => keep(value, key)));
}

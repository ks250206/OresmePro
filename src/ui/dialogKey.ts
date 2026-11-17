import type { DialogRequest } from "../app/session";

/** A number for each dialog opened, which tells it from the one before it. */
const keys = new WeakMap<DialogRequest, number>();
let last = 0;

/**
 * Which dialog this is. Each request opens a dialog of its own, with fresh
 * fields, so the key goes by the request and not by what it holds: Load
 * Data's holds the bytes of every file dropped.
 */
export function dialogKey(dialog: DialogRequest): number {
  let key = keys.get(dialog);
  if (key === undefined) {
    key = ++last;
    keys.set(dialog, key);
  }
  return key;
}

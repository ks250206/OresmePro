import { dict, type Dict } from "./dict";
import { DocError, parentFolder, type DocState } from "./types";

/*
 * Attributes describe a sample: its composition, thickness, temperature,
 * cycle, instrument, date. They are kept on a data folder (a sample's
 * folder, as a template run takes samples by folder) or on a wave, and a
 * wave has those of the folders it is in, from root down, with its own on
 * top. A result has the attributes of the wave it read, so results can be
 * set beside and plotted against what was measured.
 */

/** A value of an attribute: a number (a composition, 2.5) or text (an instrument). */
export type AttributeValue = number | string;
export type Attributes = Record<string, AttributeValue>;

/**
 * The key a data folder's attributes are kept under: its path and ":", so
 * that a folder and a wave of the same name stay apart.
 */
export const folderKey = (folder: string): string => `${folder}:`;
export const isFolderKey = (key: string): boolean => key.endsWith(":");

const NAME = /^[\p{L}][\p{L}\p{N}_]*$/u;

/** Checks an attribute's name: a letter, then letters, digits and "_", at most 64 of them. */
export function checkAttributeName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64) {
    throw new DocError(
      `${JSON.stringify(name)} is not an attribute name: start with a letter, then letters, digits and _.`,
    );
  }
  return name;
}

/** Checks an attribute's value: a finite number or text (at most 1000 characters). */
export function checkAttributeValue(value: unknown, name: string): AttributeValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1000) return value;
  throw new DocError(`${name} must be a finite number or text.`, "INVALID_ARGUMENT", {
    field: name,
  });
}

/** The attributes a wave has: those of its folders, from root down, then its own. */
export function waveAttributes(state: Pick<DocState, "attributes">, wave: string): Attributes {
  const folders: string[] = [];
  for (let folder = parentFolder(wave); folder !== ""; folder = parentFolder(folder)) {
    folders.unshift(folder);
  }
  const merged: Attributes = {};
  for (const folder of folders) Object.assign(merged, state.attributes[folderKey(folder)]);
  Object.assign(merged, state.attributes[wave]);
  return merged;
}

/** The attributes of a data folder: those of the folders it is in, then its own. */
export function folderAttributes(state: Pick<DocState, "attributes">, folder: string): Attributes {
  if (folder === "") return {};
  return {
    ...folderAttributes(state, parentFolder(folder)),
    ...state.attributes[folderKey(folder)],
  };
}

/** The attributes, with the key of each renamed wave and folder changed (see renameReferences). */
export function renameAttributeKeys(
  attributes: Dict<Attributes>,
  rename: (name: string) => string,
): Dict<Attributes> {
  let changed = false;
  const next = dict<Attributes>();
  for (const [key, values] of Object.entries(attributes)) {
    const moved = isFolderKey(key) ? folderKey(rename(key.slice(0, -1))) : rename(key);
    if (moved !== key) changed = true;
    next[moved] = values;
  }
  return changed ? next : attributes;
}

/** The attributes, without those of the waves and folders `gone` says are gone. */
export function dropAttributes(
  attributes: Dict<Attributes>,
  gone: (key: string) => boolean,
): Dict<Attributes> {
  const keys = Object.keys(attributes).filter(gone);
  if (keys.length === 0) return attributes;
  return dict(Object.entries(attributes).filter(([key]) => !keys.includes(key)));
}

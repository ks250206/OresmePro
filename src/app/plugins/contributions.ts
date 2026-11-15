import { uniqueName, windowTaken, type Command } from "../../core/doc/commands";
import { readPanelFile } from "../../core/doc/panels";
import type { DocState } from "../../core/doc/types";
import type { ContributionKind } from "../../core/plugins/manifest";
import { GRAPH_TEMPLATES, readLibrary, STYLES, type LibraryKind } from "../styleLibrary";

/**
 * What a plugin brings as data made into the commands that put it in the
 * experiment.
 *
 * Graph templates and styles: a file is either what the app exports (Graph
 * Templates… › Export, a styles file: several entries by name) or one entry,
 * named by its "name" or else by the file's name; one of the same name in
 * the experiment is replaced, as importing does.
 *
 * Panels and templates: one per file, as the app exports a panel and as
 * `op.set_template` takes a template. They get a name nothing in `state`
 * (or in `chosen`, the names given to the other files of a batch) has: the
 * experiment's own are never replaced by a plugin's.
 */
export function contributionCommands(
  kind: ContributionKind,
  path: string,
  bytes: Uint8Array,
  state?: Pick<DocState, "templates" | "windows" | "graphs" | "tables" | "pages" | "panels">,
  chosen: Set<string> = new Set(),
): Command[] {
  const text = new TextDecoder().decode(bytes);
  const fallback = path.replace(/^.*\//, "").replace(/\.json$/i, "");
  const free = (name: string, taken: (name: string) => boolean): string => {
    const busy = (item: string) => taken(item) || chosen.has(item);
    const found = busy(name) ? uniqueName(`${name}_`, busy) : name;
    chosen.add(found);
    return found;
  };
  if (kind === "panels") {
    const { name, ...panel } = readPanelFile(text);
    const windows = state ? windowTaken(state as DocState) : () => false;
    return [{ op: "setPanel", name: free(name, windows), panel }];
  }
  if (kind === "templates") {
    const data = JSON.parse(text) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`${path} does not hold a template.`);
    }
    const { name, ...template } = data as Record<string, unknown>;
    const wanted = typeof name === "string" ? name : fallback;
    const name_ = free(wanted, (item) => Boolean(state && item in state.templates));
    return [{ op: "setTemplate", name: name_, template }];
  }
  const library: LibraryKind<unknown> = kind === "styles" ? STYLES : GRAPH_TEMPLATES;
  const data = JSON.parse(text) as unknown;
  const command = (name: string, value: unknown): Command =>
    kind === "styles"
      ? { op: "setStyle", name, style: value }
      : { op: "setGraphTemplate", name, template: value };
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${path} does not hold ${library.plural}.`);
  }
  if ((data as { format?: unknown }).format === library.format) {
    const { items, skipped } = readLibrary(library, text);
    if (skipped.length > 0) throw new Error(`${path}: ${skipped.join(" ")}`);
    return items.map(([name, value]) => command(name, value));
  }
  const { name, ...entry } = data as Record<string, unknown>;
  return [command(typeof name === "string" ? name : fallback, entry)];
}

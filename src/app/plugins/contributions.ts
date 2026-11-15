import type { Command } from "../../core/doc/commands";
import { GRAPH_TEMPLATES, readLibrary, STYLES, type LibraryKind } from "../styleLibrary";

/**
 * What a plugin brings as data (graph templates, styles) made into the
 * commands that put it in the experiment. A file is either what the app
 * exports (Graph Templates… › Export, a styles file: several entries by
 * name) or one entry, named by its "name" or else by the file's name.
 */
export function contributionCommands(
  kind: "graphTemplates" | "styles",
  path: string,
  bytes: Uint8Array,
): Command[] {
  const library: LibraryKind<unknown> = kind === "styles" ? STYLES : GRAPH_TEMPLATES;
  const text = new TextDecoder().decode(bytes);
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
  const fallback = path.replace(/^.*\//, "").replace(/\.json$/i, "");
  return [command(typeof name === "string" ? name : fallback, entry)];
}

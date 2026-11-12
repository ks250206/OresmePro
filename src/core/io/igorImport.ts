import { sanitizeName, type Command } from "../doc/commands";
import type { DocState } from "../doc/types";
import {
  IgorError,
  readBinaryWave,
  readPackedExperiment,
  type IgorWave,
  type PackedRest,
} from "./igor";

/** Whether a file is one of Igor's that the app reads: a binary wave or a packed experiment. */
export const isIgorFile = (name: string): boolean => /\.(ibw|pxp|pxt)$/i.test(name);

/** Packed experiments and their templates; anything else is read as a binary wave. */
const isPacked = (name: string): boolean => /\.(pxp|pxt)$/i.test(name);

export interface IgorPlan {
  /** The commands that make the waves (their data folders come with them). */
  commands: Command[];
  /** The names the waves have here, in the order of the file. */
  waves: string[];
  /** For the history: what was loaded, under which names, and what was not. */
  summary: string;
  /** The waves of the file that were not loaded, each with the reason. */
  skipped: string[];
}

/** A name Igor would accept without quotes; others are written 'like this', as Igor does. */
const igorName = (name: string): string =>
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : `'${name}'`;
const igorPath = (folder: readonly string[], name: string): string =>
  ["root", ...folder, name].map((part, index) => (index === 0 ? part : igorName(part))).join(":");

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** A list that stops after a few items, saying how many more there are. */
function someOf(items: readonly string[], limit = 12): string {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

/** What a wave is, in a few words: "float64, 100 points", "uint16, 512×512", "text, 5 strings". */
function describe(wave: IgorWave): string {
  if (wave.text) return `text, ${plural(wave.text.length, "string")}`;
  return wave.shape.length === 1
    ? `${wave.type}, ${plural(wave.shape[0]!, "point")}`
    : `${wave.type}, ${wave.shape.join("×")}`;
}

/**
 * Chooses names for what a file brings in. Igor allows names with spaces
 * and punctuation ("liberal" names); they become legal names here. A wave
 * whose name is taken gets a suffix, as text imports do, so nothing in the
 * experiment is overwritten. A data folder that exists already is used, but
 * two folders of the file whose names become the same here stay apart.
 */
class Names {
  private readonly state: DocState;
  private readonly folders: Set<string>;
  private readonly made = new Set<string>();
  /** Folders here, by the Igor folder they hold. */
  private readonly mapped = new Map<string, string>();
  /** The Igor folder each folder here holds, to keep two of the file apart. */
  private readonly claimed = new Map<string, string>();
  readonly renamed: string[] = [];

  constructor(state: DocState) {
    this.state = state;
    this.folders = new Set(state.folders);
  }

  private isWave(path: string): boolean {
    return path in this.state.waves || this.made.has(path);
  }

  /** The folder here for a data folder of the file, as a path below root ("" for root). */
  folder(igor: readonly string[]): string {
    if (igor.length === 0) return "";
    const key = igor.join("\0");
    const known = this.mapped.get(key);
    if (known !== undefined) return known;
    const parent = this.folder(igor.slice(0, -1));
    const base = sanitizeName(igor.at(-1)!, "folder");
    const pathOf = (name: string) => (parent ? `${parent}:${name}` : name);
    let name = base;
    for (let suffix = 1; ; suffix += 1) {
      const path = pathOf(name);
      const holder = this.claimed.get(path);
      if (!this.isWave(path) && (holder === undefined || holder === key)) break;
      name = `${base}_${suffix}`;
    }
    const path = pathOf(name);
    this.claimed.set(path, key);
    this.mapped.set(key, path);
    if (name !== igor.at(-1))
      this.renamed.push(`${igorPath(igor.slice(0, -1), igor.at(-1)!)} → ${path}`);
    return path;
  }

  /** The name here of a wave of the file. */
  wave(igor: readonly string[], name: string): string {
    const folder = this.folder(igor);
    const base = sanitizeName(name, "wave");
    const pathOf = (leaf: string) => (folder ? `${folder}:${leaf}` : leaf);
    let leaf = base;
    for (let suffix = 1; ; suffix += 1) {
      const path = pathOf(leaf);
      if (!this.isWave(path) && !this.folders.has(path) && !this.claimed.has(path)) break;
      leaf = `${base}_${suffix}`;
    }
    const path = pathOf(leaf);
    this.made.add(path);
    if (leaf !== name) this.renamed.push(`${igorPath(igor, name)} → ${path}`);
    return path;
  }
}

/**
 * The wave's note: where it came from first, then what could not be kept as
 * Igor had it, then Igor's own note as it was, under a line of its own.
 */
function noteFor(wave: IgorWave, source: string, path: string, digest?: string): string {
  const lines = [
    `Loaded from ${source}${digest ? ` (SHA-256 ${digest})` : ""}: Igor wave ${path}, binary wave version ${wave.version}, ${wave.igorType}.`,
    ...wave.remarks,
  ];
  if (wave.note) lines.push("Igor's note:", wave.note);
  return lines.join("\n");
}

function makeCommand(wave: IgorWave, name: string, note: string): Command {
  // A text wave of several dimensions is a list here; Igor's scaling does not fit it.
  const flattened = wave.text !== null && wave.dims.length > 1;
  const [x, y] = flattened ? [] : wave.dims;
  const scaling = {
    x0: x?.start ?? 0,
    dx: x?.delta ?? 1,
    xUnit: x?.unit ?? "",
    y0: y?.start ?? 0,
    dy: y?.delta ?? 1,
    yUnit: y?.unit ?? "",
  };
  const common = {
    op: "makeWave" as const,
    name,
    overwrite: false,
    unit: wave.unit,
    note,
    ...scaling,
  };
  if (wave.text) return { ...common, text: wave.text };
  return {
    ...common,
    data: wave.data,
    ...(wave.imag ? { imag: wave.imag } : {}),
    type: wave.type,
    shape: wave.shape,
  };
}

/** What of a packed experiment is not brought over, in words; "" if nothing. */
function restWords(rest: PackedRest): string {
  const parts: string[] = [];
  const windows = Object.entries(rest.windows).map(([kind, count]) =>
    plural(count, kind.toLowerCase()),
  );
  if (windows.length > 0) parts.push(`${windows.join(", ")} (Igor's window recreation macros)`);
  if (rest.procedure) parts.push("the procedure window");
  if (rest.packedFiles > 0)
    parts.push(
      plural(
        rest.packedFiles,
        "packed notebook or procedure file",
        "packed notebooks or procedure files",
      ),
    );
  if (rest.variables > 0 || rest.strings > 0) {
    parts.push(
      [
        rest.variables > 0 ? plural(rest.variables, "variable") : "",
        rest.strings > 0 ? plural(rest.strings, "string") : "",
      ]
        .filter(Boolean)
        .join(" and "),
    );
  }
  if (rest.history) parts.push("the history");
  if (rest.other > 0)
    parts.push(
      plural(
        rest.other,
        "record of a kind this reader does not know",
        "records of kinds this reader does not know",
      ),
    );
  return parts.join(", ");
}

/**
 * Reads an Igor file and works out the commands that bring its waves into
 * the document: one for a binary wave (.ibw), all the waves of a packed
 * experiment (.pxp, .pxt) under their data folders. Nothing is changed here;
 * the caller runs the commands, as one step to undo. A file that cannot be
 * read whole is refused (IgorError) before anything is made.
 *
 * `digest` (a hash of the file), if given, goes into the notes of the waves
 * with the file's name, so that the data can be traced back to the file.
 */
export function planIgorImport(
  bytes: Uint8Array,
  filename: string,
  state: DocState,
  digest?: string,
): IgorPlan {
  const names = new Names(state);
  if (!isPacked(filename)) {
    const wave = readBinaryWave(bytes);
    if (wave.missingValues) {
      throw new IgorError(
        `There are no values to load: ${wave.remarks.at(-1) ?? "the file does not hold the wave's values."}`,
      );
    }
    const name = names.wave([], wave.name || filename.replace(/\.[^.]*$/, ""));
    const note = noteFor(wave, filename, igorName(wave.name), digest);
    const renamed = name === wave.name ? "" : ` (Igor's name: ${wave.name})`;
    return {
      commands: [makeCommand(wave, name, note)],
      waves: [name],
      summary: [
        `Loaded ${name} (${describe(wave)}) from ${filename}${renamed}.`,
        ...wave.remarks,
      ].join("\n"),
      skipped: [],
    };
  }

  const experiment = readPackedExperiment(bytes);
  const commands: Command[] = [];
  const waves: string[] = [];
  const skipped: string[] = [];
  const counts = new Map<string, number>();
  for (const { folder, wave } of experiment.waves) {
    const path = igorPath(folder, wave.name);
    if (wave.missingValues) {
      skipped.push(`${path} (Igor computes it from a formula and did not save its values)`);
      continue;
    }
    const name = names.wave(folder, wave.name);
    commands.push(makeCommand(wave, name, noteFor(wave, filename, path, digest)));
    waves.push(name);
    const at = name.includes(":") ? name.slice(0, name.lastIndexOf(":")) : "root";
    counts.set(at, (counts.get(at) ?? 0) + 1);
  }
  const holding = new Set(
    experiment.waves
      .filter((item) => !item.wave.missingValues)
      .map((item) => item.folder.join("\0")),
  );
  const empty = experiment.folders.filter(
    (folder) =>
      ![...holding].some(
        (key) => key === folder.join("\0") || key.startsWith(`${folder.join("\0")}\0`),
      ),
  );
  const lines = [
    waves.length > 0
      ? `Loaded ${plural(waves.length, "wave")} from ${filename}: ${someOf([...counts].map(([folder, count]) => `${count} in ${folder}`))}.`
      : `${filename} has no waves to load.`,
  ];
  if (names.renamed.length > 0) {
    lines.push(`Renamed to names allowed here, or taken already: ${someOf(names.renamed)}.`);
  }
  if (skipped.length > 0) lines.push(`Not loaded: ${someOf(skipped)}.`);
  if (empty.length > 0) {
    lines.push(
      `Data folders without waves are not made: ${someOf(empty.map((folder) => igorPath(folder.slice(0, -1), folder.at(-1)!)))}.`,
    );
  }
  const rest = restWords(experiment.rest);
  if (rest) lines.push(`Not brought over: ${rest}.`);
  return { commands, waves, summary: lines.join("\n"), skipped };
}

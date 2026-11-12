import { checkName, type Command } from "./commands";
import { echoMake, echoPython } from "./echo";
import { DocError, newWaveData, type DocState, type WaveType } from "./types";

/** What the Make Waves dialog asks for: empty waves, all alike, in one data folder. */
export interface MakeWavesRequest {
  /** Names within `folder`. */
  names: readonly string[];
  /** "" for root. */
  folder: string;
  /** Points per dimension: rows, then columns, layers and chunks if used. */
  shape: readonly number[];
  type: WaveType;
  x0: number;
  dx: number;
  xUnit: string;
  unit: string;
  overwrite: boolean;
  /** Also open a table of the new waves. */
  edit: boolean;
}

/**
 * The most points one wave may have when made from the dialog. A wave lives in
 * the tab's memory and is copied when Python reads it: a mistyped size should
 * be refused, not take the tab down.
 */
export const MAX_POINTS = 50_000_000;

/** Names typed in one box, separated by commas, semicolons or spaces. */
export const splitNames = (text: string): string[] => text.split(/[\s,;]+/).filter(Boolean);

export const wavePath = (folder: string, name: string): string =>
  folder ? `${folder}:${name}` : name;

/**
 * What is wrong with each name, in the order given; null where it is fine.
 * The rule is the document's own, so what passes here is accepted there.
 */
export function nameProblems(
  state: DocState,
  names: readonly string[],
  folder: string,
  overwrite: boolean,
): (string | null)[] {
  return names.map((name, index) => {
    try {
      checkName(name, "wave");
    } catch (error) {
      return (error as Error).message;
    }
    if (names.indexOf(name) < index) return `${name} is named twice.`;
    const path = wavePath(folder, name);
    if (!overwrite && path in state.waves) {
      return `A wave named ${path} already exists. Tick "Overwrite existing waves" to replace it.`;
    }
    return null;
  });
}

/**
 * Reads the sizes typed for each dimension: rows must be given; columns,
 * layers and chunks are used when given and not 0, as in Igor, and only in
 * that order. Returns the shape, or what is wrong with it.
 */
export function parseShape(texts: readonly string[]): readonly number[] | string {
  const labels = ["Rows", "Columns", "Layers", "Chunks"];
  const sizes: number[] = [];
  for (const [index, text] of texts.entries()) {
    const trimmed = text.trim();
    if (index > 0 && (trimmed === "" || Number(trimmed) === 0)) {
      sizes.push(0);
      continue;
    }
    const size = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(size) || size < 0) {
      return `${labels[index]} must be a whole number, 0 or more.`;
    }
    sizes.push(size);
  }
  let last = sizes.length - 1;
  while (last > 0 && sizes[last] === 0) last -= 1;
  const shape = sizes.slice(0, last + 1);
  const gap = shape.findIndex((size, index) => index > 0 && size === 0);
  if (gap > 0) {
    return `${labels[last]} need a number of ${labels[gap]!.toLowerCase()} too.`;
  }
  const total = shape.reduce((product, size) => product * size, 1);
  if (total > MAX_POINTS) {
    return `That is ${total.toLocaleString("en")} points a wave; at most ${MAX_POINTS.toLocaleString("en")} can be made here.`;
  }
  return shape;
}

/**
 * The commands that make the waves, and the Python that does the same for
 * the history. Refuses the whole request, before anything is made, if any
 * name is wrong or taken (unless taken names are to be overwritten).
 */
export function planMakeWaves(
  state: DocState,
  request: MakeWavesRequest,
): { commands: Command[]; echo: string } {
  if (request.names.length === 0) throw new DocError("Give at least one name.");
  if (request.folder && !state.folders.includes(request.folder)) {
    throw new DocError(`There is no data folder named ${request.folder}.`);
  }
  const problems = nameProblems(state, request.names, request.folder, request.overwrite).filter(
    (problem): problem is string => problem !== null,
  );
  if (problems.length > 0) throw new DocError(problems.join("\n"));
  const total = request.shape.reduce((product, size) => product * size, 1);
  const commands: Command[] = [];
  const lines: string[] = [];
  for (const name of request.names) {
    const path = wavePath(request.folder, name);
    const command = {
      op: "makeWave" as const,
      name: path,
      data: newWaveData(request.type, total),
      type: request.type,
      shape: [...request.shape],
      x0: request.x0,
      dx: request.dx,
      xUnit: request.xUnit,
      unit: request.unit,
      overwrite: request.overwrite,
    };
    commands.push(command);
    lines.push(echoMake(command, state.waves[path]));
  }
  if (request.edit) {
    const edit: Command = {
      op: "edit",
      waves: request.names.map((name) => wavePath(request.folder, name)),
    };
    commands.push(edit);
    lines.push(echoPython(edit)!);
  }
  return { commands, echo: lines.join("\n") };
}

/** The commands on waves and data folders, and the formulas that follow them. (Applied through ./commands.) */
import { dropAttributes, isFolderKey, renameAttributeKeys } from "./attributes";
import { dict, withEntry, withoutEntries } from "./dict";
import {
  checkCycle,
  evaluateFormula,
  formulaCurrent,
  formulaOrder,
  FormulaError,
  parseFormula,
  renameInFormula,
  type FormulaOutcome,
} from "./formula";
import { renameInResult, type AnalysisResult } from "./results";
import { renameInPanels } from "./panels";
import { renameInRun, type TemplateRun } from "./analysisTemplates";
import {
  DocError,
  WAVE_TYPES,
  isComplexType,
  newWaveData,
  storeValues,
  toWaveData,
  leafName,
  parentFolder,
  type DocState,
  type Formula,
  type GraphSpec,
  type TableSpec,
  type TraceSpec,
  type Wave,
} from "./types";
import type { Command, CommandOutcome } from "./commandTypes";
import {
  bool,
  changed,
  checkPath,
  removeWaves,
  withoutFormula,
  contentOf,
  finite,
  nextItemName,
  nextRev,
  oneOf,
  putWave,
  requireNumeric,
  requireWave,
  resized,
  step,
  withFolders,
} from "./commandSupport";

/**
 * Rewrites every reference to a wave after waves have been renamed or moved.
 * `previous` holds the waves as they were before: a formula that was up to
 * date with an input stays so when only the input's name changed.
 */
export function renameReferences(
  state: DocState,
  rename: (name: string) => string,
  previous: DocState["waves"],
): DocState {
  const graphs = dict<GraphSpec>();
  for (const graph of Object.values(state.graphs)) {
    const traces: TraceSpec[] = [];
    const traceNames = new Map<string, string>();
    for (const trace of graph.traces) {
      const y = rename(trace.y);
      // A trace is named after its Y wave, so it follows a rename.
      const name = y === trace.y ? trace.name : nextItemName(traces, leafName(y));
      traceNames.set(trace.name, name);
      traces.push({
        ...trace,
        name,
        y,
        x: trace.x === null ? null : rename(trace.x),
        yError: typeof trace.yError === "string" ? rename(trace.yError) : trace.yError,
        xError: typeof trace.xError === "string" ? rename(trace.xError) : trace.xError,
        colorWave: trace.colorWave === null ? null : rename(trace.colorWave),
        textMarker: trace.textMarker === null ? null : rename(trace.textMarker),
      });
    }
    const cursors: GraphSpec["cursors"] = dict(
      Object.entries(graph.cursors).map(([key, cursor]) => [
        key,
        { ...cursor, trace: traceNames.get(cursor.trace) ?? cursor.trace },
      ]),
    );
    graphs[graph.name] = {
      ...graph,
      traces,
      cursors,
      annotations: graph.annotations.map((item) =>
        item.trace === null ? item : { ...item, trace: traceNames.get(item.trace) ?? item.trace },
      ),
      images: graph.images.map((image) => ({ ...image, wave: rename(image.wave) })),
      contours: graph.contours.map((contour) => ({ ...contour, wave: rename(contour.wave) })),
    };
  }
  const tables = dict<TableSpec>();
  for (const table of Object.values(state.tables)) {
    tables[table.name] = {
      ...table,
      columns: table.columns.map(rename),
      widths: dict(Object.entries(table.widths).map(([wave, width]) => [rename(wave), width])),
    };
  }
  const results = dict<AnalysisResult>();
  for (const result of Object.values(state.results)) {
    results[result.name] = renameInResult(result, rename);
  }
  const runs = dict<TemplateRun>();
  for (const run of Object.values(state.runs)) runs[run.name] = renameInRun(run, rename);
  let waves = state.waves;
  for (const wave of Object.values(state.waves)) {
    const formula = wave.formula;
    if (!formula || !Object.keys(formula.inputs).some((input) => rename(input) !== input)) {
      continue;
    }
    const inputs = dict<number | null>();
    for (const [input, rev] of Object.entries(formula.inputs)) {
      const name = rename(input);
      inputs[name] =
        rev !== null && previous[input]?.rev === rev ? (state.waves[name]?.rev ?? null) : rev;
    }
    const expr = renameInFormula(formula.expr, rename);
    // Only where the values come from has changed, not the values: no new revision.
    waves = withEntry(waves, wave.name, { ...wave, formula: { ...formula, expr, inputs } });
  }
  const panels = renameInPanels(state.panels, rename);
  // A sample's attributes go where its wave or folder goes.
  const attributes = renameAttributeKeys(state.attributes, rename);
  return { ...state, waves, graphs, tables, results, panels, runs, attributes };
}

/** A wave under a new name; a formula that was up to date with it stays so. */
export function moved(wave: Wave, name: string): Wave {
  const next = changed(wave, { name });
  const { formula } = wave;
  return formula && formula.rev === wave.rev
    ? { ...next, formula: { ...formula, rev: next.rev } }
    : next;
}

/**
 * After a change to `before` that no formula reads (its note, say), the
 * formulas that were up to date with it, its own and those it is an input
 * of, are kept up to date with `after` rather than computed again.
 */
export function keepFormulasCurrent(state: DocState, before: Wave, after: Wave): DocState {
  let waves = state.waves;
  for (const wave of Object.values(waves)) {
    const formula = wave.formula;
    if (!formula) continue;
    const own = wave.name === after.name && formula.rev === before.rev;
    const input = formula.inputs[before.name] === before.rev;
    if (!own && !input) continue;
    const current = wave.name === after.name ? after : wave;
    waves = withEntry(waves, wave.name, {
      ...current,
      formula: {
        ...formula,
        rev: own ? after.rev : formula.rev,
        inputs: input
          ? dict([...Object.entries(formula.inputs), [before.name, after.rev]])
          : formula.inputs,
      },
    });
  }
  return waves === state.waves ? state : { ...state, waves };
}

/** Writes what a formula computed into its wave, making the wave if it does not exist. */
export function putFormulaResult(
  state: DocState,
  name: string,
  formula: Pick<Formula, "expr" | "auto">,
  outcome: FormulaOutcome,
): DocState {
  const existing = state.waves[name];
  const rev = nextRev();
  const content = {
    data: outcome.values,
    imag: null,
    type: "float64" as const,
    text: null,
    shape: [outcome.values.length],
    rev,
  };
  const wave: Wave = existing
    ? { ...existing, ...content }
    : {
        name,
        ...content,
        x0: outcome.x0,
        dx: outcome.dx,
        xUnit: outcome.xUnit,
        y0: 0,
        dy: 1,
        yUnit: "",
        unit: "",
        note: "",
      };
  return putWave(state, {
    ...wave,
    formula: {
      expr: formula.expr,
      auto: formula.auto,
      inputs: outcome.inputs,
      rev,
      error: null,
      zeroDivisions: outcome.zeroDivisions,
    },
  });
}

/**
 * Computes a wave's formula again. If that fails, the values stay as they
 * were and the formula keeps why, as of the inputs as they are now: it is
 * not tried again until one of them (or the wave) changes.
 */
export function recompute(state: DocState, name: string): DocState {
  const wave = state.waves[name]!;
  const formula = wave.formula!;
  try {
    return putFormulaResult(state, name, formula, evaluateFormula(state, name, formula.expr));
  } catch (error) {
    if (!(error instanceof DocError)) throw error;
    const inputs = dict<number | null>(
      Object.keys(formula.inputs).map((input) => [input, state.waves[input]?.rev ?? null]),
    );
    const message = error instanceof FormulaError ? `${error.detail}.` : error.message;
    return putWave(state, {
      ...wave,
      formula: { ...formula, inputs, rev: wave.rev, error: message },
    });
  }
}

/**
 * Brings every automatic formula up to date with its inputs, inputs before
 * the waves computed from them. The document runs every change through
 * this, so that in every state it holds, automatic formulas are up to date
 * and their recomputation belongs to the change that made it necessary.
 */
export function settleFormulas(state: DocState): DocState {
  const outdated = Object.values(state.waves).some(
    (wave) => wave.formula?.auto && !formulaCurrent(state, wave.name, wave.formula),
  );
  if (!outdated) return state;
  let next = state;
  for (const name of formulaOrder(state)) {
    const formula = next.waves[name]?.formula;
    if (formula?.auto && !formulaCurrent(next, name, formula)) next = recompute(next, name);
  }
  return next;
}

export function requireItem<T extends { name: string }>(
  items: readonly T[],
  name: string,
  graph: string,
  what: string,
): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item)
    throw new DocError(`${graph} has no ${what} named ${JSON.stringify(name)}.`, "NOT_FOUND", {
      kind: what,
      name: name,
    });
  return item;
}

/** Checks that an error-bar wave exists and matches its trace. */
export function checkErrorWaves(state: DocState, trace: TraceSpec): void {
  const length = state.waves[trace.y]?.data.length;
  if (trace.colorWave !== null) {
    const wave = requireNumeric(state, trace.colorWave, 1, "used to color a trace");
    if (length !== undefined && wave.data.length !== length) {
      throw new DocError(
        `Color wave ${wave.name} has ${wave.data.length} points but ${trace.y} has ${length}.`,
      );
    }
  }
  if (trace.textMarker !== null) {
    const wave = requireWave(state, trace.textMarker);
    if (wave.shape.length !== 1) {
      throw new DocError(`Text marker wave ${wave.name} must have one dimension.`);
    }
    const points = wave.text ? wave.text.length : wave.data.length;
    if (length !== undefined && points !== length) {
      throw new DocError(
        `Text marker wave ${wave.name} has ${points} points but ${trace.y} has ${length}.`,
      );
    }
  }
  for (const source of [trace.yError, trace.xError]) {
    if (typeof source !== "string") continue;
    const wave = requireNumeric(state, source, 1, "used for error bars");
    if (length !== undefined && wave.data.length !== length) {
      throw new DocError(
        `Error wave ${wave.name} has ${wave.data.length} points but ${trace.y} has ${length}.`,
      );
    }
  }
}

/** The commands applied here. */
export const WAVE_OPS = [
  "makeWave",
  "setWaveData",
  "setWavePoints",
  "redimension",
  "setWaveText",
  "insertPoints",
  "deletePoints",
  "setWaveScale",
  "setWaveMeta",
  "renameWave",
  "duplicateWave",
  "killWaves",
  "setFormula",
  "recalculate",
  "newFolder",
  "renameFolder",
  "killFolder",
] as const;
export type WaveCommand = Extract<Command, { op: (typeof WAVE_OPS)[number] }>;
const WAVE_OPS_SET: ReadonlySet<string> = new Set(WAVE_OPS);
export const isWaveCommand = (command: Command): command is WaveCommand =>
  WAVE_OPS_SET.has(command.op);

export function applyWaveCommand(state: DocState, command: WaveCommand): CommandOutcome {
  switch (command.op) {
    case "makeWave": {
      const name = checkPath(command.name, "wave");
      const existing = state.waves[name];
      if (existing && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(name)} already exists.`, "ALREADY_EXISTS", {
          name: name,
        });
      }
      const wave: Wave = {
        name,
        ...contentOf(command),
        x0: finite(command.x0 ?? existing?.x0 ?? 0, "x0"),
        dx: step(command.dx ?? existing?.dx ?? 1, "dx"),
        xUnit: command.xUnit ?? existing?.xUnit ?? "",
        y0: finite(command.y0 ?? existing?.y0 ?? 0, "y0"),
        dy: step(command.dy ?? existing?.dy ?? 1, "dy"),
        yUnit: command.yUnit ?? existing?.yUnit ?? "",
        unit: command.unit ?? existing?.unit ?? "",
        note: command.note ?? existing?.note ?? "",
        rev: nextRev(),
      };
      return { state: putWave(state, wave), result: name };
    }
    case "setWaveData": {
      const wave = requireWave(state, command.name);
      // New values of the same total size keep the wave's shape.
      const sameSize = command.data !== undefined && command.data.length === wave.data.length;
      const content = contentOf({
        ...command,
        shape: command.shape ?? (sameSize && !wave.text ? wave.shape : undefined),
      });
      return { state: putWave(state, changed(wave, content)), result: null };
    }
    case "setWavePoints": {
      const wave = requireWave(state, command.name);
      if (wave.text) throw new DocError(`${wave.name} is a text wave.`);
      const { start, values } = command;
      if (command.imag && !wave.imag) {
        throw new DocError(`${wave.name} is not a complex wave.`);
      }
      if (command.imag && command.imag.length !== values.length) {
        throw new DocError("The real and imaginary parts have different lengths.");
      }
      const growable = wave.shape.length === 1;
      const limit = growable ? wave.data.length : wave.data.length - values.length;
      if (!Number.isInteger(start) || start < 0 || start > limit) {
        throw new DocError(
          `Point ${start} is out of range for ${JSON.stringify(wave.name)} (${wave.data.length} points).`,
        );
      }
      const grown = Math.max(0, start + values.length - wave.data.length);
      const data = resized(wave.data, wave.data.length, 0, grown, 0);
      storeValues(data, wave.type, values, start);
      let { imag } = wave;
      if (imag && (grown > 0 || command.imag)) {
        imag = resized(imag, imag.length, 0, grown, 0);
        if (command.imag) storeValues(imag, wave.type, command.imag, start);
      }
      const shape = growable ? [data.length] : wave.shape;
      return { state: putWave(state, changed(wave, { data, imag, shape })), result: null };
    }
    case "redimension": {
      const wave = requireWave(state, command.name);
      if (wave.text) throw new DocError(`${wave.name} is a text wave; it has no number type.`);
      const type = oneOf(command.type, WAVE_TYPES, "type");
      if (type === wave.type) return { state, result: null };
      const data = toWaveData(wave.data, type);
      // Becoming complex adds a zero imaginary part; becoming real keeps the real part.
      const imag = isComplexType(type)
        ? wave.imag
          ? toWaveData(wave.imag, type)
          : newWaveData(type, data.length)
        : null;
      return { state: putWave(state, changed(wave, { data, imag, type })), result: null };
    }
    case "setWaveText": {
      const wave = requireWave(state, command.name);
      if (!wave.text) throw new DocError(`${wave.name} is not a text wave.`);
      const { start, values } = command;
      if (!Number.isInteger(start) || start < 0 || start > wave.text.length) {
        throw new DocError(`Point ${start} is out of range for ${JSON.stringify(wave.name)}.`);
      }
      const text = [...wave.text];
      values.forEach((value, offset) => {
        text[start + offset] = String(value);
      });
      return { state: putWave(state, changed(wave, { text, shape: [text.length] })), result: null };
    }
    case "insertPoints":
    case "deletePoints": {
      const wave = requireWave(state, command.name);
      if (wave.shape.length !== 1) {
        throw new DocError("Points can be inserted or deleted only in a 1-D wave.");
      }
      const length = wave.shape[0]!;
      const { at, count } = command;
      const inserting = command.op === "insertPoints";
      if (!Number.isInteger(at) || at < 0 || (inserting ? at > length : at >= length)) {
        throw new DocError(`Point ${at} is out of range.`);
      }
      if (!Number.isInteger(count) || count < 1)
        throw new DocError("count must be at least 1.", "INVALID_ARGUMENT", { field: "count" });
      const end = inserting ? at : Math.min(length, at + count);
      if (wave.text) {
        // Built by concatenation: a spread into splice() fails for very large counts.
        const text = [
          ...wave.text.slice(0, at),
          ...(inserting ? Array.from({ length: count }, () => "") : []),
          ...wave.text.slice(end),
        ];
        return {
          state: putWave(state, changed(wave, { text, shape: [text.length] })),
          result: null,
        };
      }
      const added = inserting ? count : 0;
      // New points are NaN (0 in an integer wave, which has no NaN).
      const data = resized(wave.data, at, end - at, added, Number.NaN);
      const imag = wave.imag ? resized(wave.imag, at, end - at, added, Number.NaN) : null;
      return {
        state: putWave(state, changed(wave, { data, imag, shape: [data.length] })),
        result: null,
      };
    }
    case "setWaveScale": {
      const wave = requireWave(state, command.name);
      return {
        state: putWave(
          state,
          changed(wave, {
            x0: finite(command.x0 ?? wave.x0, "x0"),
            dx: step(command.dx ?? wave.dx, "dx"),
            xUnit: command.xUnit ?? wave.xUnit,
            y0: finite(command.y0 ?? wave.y0, "y0"),
            dy: step(command.dy ?? wave.dy, "dy"),
            yUnit: command.yUnit ?? wave.yUnit,
          }),
        ),
        result: null,
      };
    }
    case "setWaveMeta": {
      const wave = requireWave(state, command.name);
      const next = changed(wave, {
        unit: command.unit ?? wave.unit,
        note: command.note ?? wave.note,
      });
      // No formula reads a wave's unit or note: those up to date stay so, and are not computed again.
      return { state: keepFormulasCurrent(putWave(state, next), wave, next), result: null };
    }
    case "renameWave": {
      const wave = requireWave(state, command.name);
      const newName = checkPath(command.newName, "wave");
      if (newName === wave.name) return { state, result: null };
      if (newName in state.waves) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`, "ALREADY_EXISTS", {
          name: newName,
        });
      }
      const waves = withEntry(
        withoutEntries(state.waves, [wave.name]),
        newName,
        moved(wave, newName),
      );
      const renamed = renameReferences(
        {
          ...withFolders(state, parentFolder(newName)),
          waves,
          waveOrder: state.waveOrder.map((name) => (name === wave.name ? newName : name)),
        },
        (name) => (name === wave.name ? newName : name),
        state.waves,
      );
      return { state: renamed, result: newName };
    }
    case "duplicateWave": {
      const wave = requireWave(state, command.name);
      const newName = checkPath(command.newName, "wave");
      if (newName in state.waves && command.overwrite === false) {
        throw new DocError(`Wave ${JSON.stringify(newName)} already exists.`, "ALREADY_EXISTS", {
          name: newName,
        });
      }
      return {
        // The copy has the values but not the formula, as in Igor.
        state: putWave(
          state,
          withoutFormula(
            changed(wave, {
              name: newName,
              data: wave.data.slice(),
              imag: wave.imag?.slice() ?? null,
            }),
          ),
        ),
        result: newName,
      };
    }
    case "killWaves": {
      const names = command.names.map((name) => requireWave(state, name).name);
      return { state: removeWaves(state, names), result: null };
    }
    case "setFormula": {
      const name = checkPath(command.name, "wave");
      if (command.expr === null) {
        const wave = requireWave(state, name);
        if (!wave.formula) return { state, result: null };
        return { state: putWave(state, withoutFormula(wave)), result: null };
      }
      if (typeof command.expr !== "string") throw new DocError("A formula must be text.");
      const auto = command.auto === undefined ? true : bool(command.auto, "auto");
      const expr = command.expr.trim();
      const parsed = parseFormula(expr);
      checkCycle(state, name, parsed);
      const outcome = evaluateFormula(state, name, parsed);
      return { state: putFormulaResult(state, name, { expr, auto }, outcome), result: name };
    }
    case "recalculate": {
      let names: Set<string> | null = null;
      if (command.names !== undefined) {
        names = new Set();
        for (const given of command.names) {
          const wave = requireWave(state, given);
          if (!wave.formula) throw new DocError(`${wave.name} has no formula.`);
          names.add(wave.name);
        }
      }
      let next = state;
      for (const name of formulaOrder(state)) {
        if (names && !names.has(name)) continue;
        const formula = next.waves[name]!.formula!;
        // What failed is tried again: the reason may lie outside its inputs (the wave's scaling).
        if (formula.error === null && formulaCurrent(next, name, formula)) continue;
        next = recompute(next, name);
      }
      return { state: next, result: null };
    }
    case "newFolder": {
      const path = checkPath(command.path, "data folder");
      if (state.folders.includes(path)) {
        throw new DocError(
          `Data folder ${JSON.stringify(path)} already exists.`,
          "ALREADY_EXISTS",
          { name: path },
        );
      }
      return { state: withFolders(state, path), result: path };
    }
    case "renameFolder": {
      const path = checkPath(command.path, "data folder");
      const newPath = checkPath(command.newPath, "data folder");
      if (!state.folders.includes(path)) {
        throw new DocError(`No data folder named ${JSON.stringify(path)}.`, "NOT_FOUND", {
          kind: "data folder",
          name: path,
        });
      }
      if (newPath === path) return { state, result: null };
      if (state.folders.includes(newPath) || newPath.startsWith(`${path}:`)) {
        throw new DocError(`Cannot move ${path} to ${newPath}.`);
      }
      const move = (name: string) =>
        name === path || name.startsWith(`${path}:`) ? newPath + name.slice(path.length) : name;
      const waves = dict<Wave>();
      for (const wave of Object.values(state.waves)) {
        const name = move(wave.name);
        if (name !== wave.name && name in state.waves) {
          throw new DocError(`Wave ${JSON.stringify(name)} already exists.`, "ALREADY_EXISTS", {
            name: name,
          });
        }
        waves[name] = name === wave.name ? wave : moved(wave, name);
      }
      const renamed = renameReferences(
        {
          ...state,
          waves,
          waveOrder: state.waveOrder.map(move),
          folders: state.folders.map(move),
        },
        move,
        state.waves,
      );
      return { state: withFolders(renamed, parentFolder(newPath)), result: newPath };
    }
    case "killFolder": {
      const path = checkPath(command.path, "data folder");
      if (!state.folders.includes(path)) {
        throw new DocError(`No data folder named ${JSON.stringify(path)}.`, "NOT_FOUND", {
          kind: "data folder",
          name: path,
        });
      }
      const inside = (name: string) => name === path || name.startsWith(`${path}:`);
      const emptied = removeWaves(state, state.waveOrder.filter(inside));
      return {
        state: {
          ...emptied,
          folders: state.folders.filter((folder) => !inside(folder)),
          attributes: dropAttributes(
            emptied.attributes,
            (key) => isFolderKey(key) && inside(key.slice(0, -1)),
          ),
        },
        result: null,
      };
    }
  }
}

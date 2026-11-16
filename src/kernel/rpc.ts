import { arrangeLayout } from "../core/doc/arrange";
import { folderAttributes, isFolderKey, waveAttributes } from "../core/doc/attributes";
import type { Command } from "../core/doc/commands";
import { uniqueName } from "../core/doc/commands";
import type { Doc, DocWriter, Stage } from "../core/doc/doc";
import { graphScript } from "../core/doc/recreate";
import { formulaOrder, formulaStatus } from "../core/doc/formula";
import { changedInputs } from "../core/doc/results";
import { changedSampleInputs } from "../core/doc/analysisTemplates";
import { templateWarnings } from "../core/doc/graphTemplates";
import { resolveButton } from "../core/doc/panels";
import {
  DocError,
  type DocState,
  type GraphTemplate,
  type PanelSpec,
  type Wave,
} from "../core/doc/types";
import { bytesToWords, wordsToBytes, type FileStore } from "../core/files/files";
import { checkSettings, planImport, type ImportSettings } from "../core/io/importData";
import { planIgorImport } from "../core/io/igorImport";
import type { MeasureText } from "../core/plot/displayList";
import { tracePosition, traceX } from "../core/plot/layout";

export interface RpcContext {
  doc: Doc;
  /** The experiment's files; Python's working directory mirrors them. */
  files: FileStore;
  /** Renders a graph as SVG at the given size (or its window's size). */
  renderSvg(graph: string, width: number | null, height: number | null, cursors: boolean): string;
  /** Saves a graph to a file the user downloads; the format follows the extension. */
  exportGraph(graph: string, filename: string, cursors: boolean): void;
  /** The same for page layouts. */
  renderPageSvg(page: string): string;
  exportPage(page: string, filename: string): void;
  /** Measures text as it is drawn, to know how much room text on a page takes. */
  measureText: MeasureText;
  /** The import presets kept by the app, for `op.load_text(..., preset=...)`. */
  importPresets(): readonly NamedImportSettings[];
  /** The actions of the plugins that are on (see src/app/plugins/host.ts). */
  pluginCatalog?: () => readonly unknown[];
}

/** A named set of import settings, as the app keeps them for the files of an instrument. */
export interface NamedImportSettings {
  name: string;
  settings: ImportSettings;
}

export interface RpcReply {
  result: unknown;
  data?: Float64Array;
}

/** A wave's formula as Python reads it, with how it stands; null for a wave without one. */
function formulaInfo(state: DocState, wave: Wave) {
  const { formula } = wave;
  if (!formula) return null;
  const { status, message } = formulaStatus(state, wave.name, formula);
  return {
    name: wave.name,
    expr: formula.expr,
    auto: formula.auto,
    status,
    message,
    inputs: Object.keys(formula.inputs),
    zeroDivisions: formula.zeroDivisions,
  };
}

const waveInfo = (state: DocState, wave: Wave) => ({
  name: wave.name,
  kind: wave.text ? "text" : "numeric",
  type: wave.type,
  shape: wave.shape,
  x0: wave.x0,
  dx: wave.dx,
  xUnit: wave.xUnit,
  y0: wave.y0,
  dy: wave.dy,
  yUnit: wave.yUnit,
  unit: wave.unit,
  note: wave.note,
  rev: wave.rev,
  formula: formulaInfo(state, wave),
});

/** A wave's numbers as they are sent to Python: float64, real parts then imaginary parts. */
function transportData(wave: Wave): Float64Array {
  if (!wave.imag) {
    return wave.data instanceof Float64Array ? wave.data : Float64Array.from(wave.data);
  }
  const both = new Float64Array(wave.data.length * 2);
  both.set(wave.data);
  both.set(wave.imag, wave.data.length);
  return both;
}

function requireTemplate(state: DocState, name: unknown): GraphTemplate {
  const template = typeof name === "string" ? state.graphTemplates[name] : undefined;
  if (!template) throw new DocError(`No graph template named ${JSON.stringify(name)}.`);
  return template;
}

function requirePanel(state: DocState, name: unknown): PanelSpec {
  const panel =
    typeof name === "string" && Object.hasOwn(state.panels, name) ? state.panels[name] : undefined;
  if (!panel) throw new DocError(`No panel named ${JSON.stringify(name)}.`);
  return panel;
}

const withoutRoot = (name: string): string => (name.startsWith("root:") ? name.slice(5) : name);

function requireWave(state: DocState, name: unknown): Wave {
  const wave = typeof name === "string" ? state.waves[withoutRoot(name)] : undefined;
  if (!wave) throw new DocError(`No wave named ${JSON.stringify(name)}.`);
  return wave;
}

/**
 * The changes of the `op.atomic()` block Python has open, by document. Kept
 * here rather than in the context, which may be made anew for each request.
 */
const stages = new WeakMap<Doc, Stage>();

/**
 * Drops the changes of an atomic block that will not be finished: Python
 * stopped, or the execution ended with the block still open. Returns whether
 * there was one.
 */
export function dropStage(doc: Doc): boolean {
  const stage = stages.get(doc);
  if (!stage) return false;
  stages.delete(doc);
  stage.discard();
  return true;
}

/** Whether Python has an atomic block open on the document. */
export const hasStage = (doc: Doc): boolean => stages.has(doc);

/** The atomic block Python has open on the document, if any: where its plugin runs put their waves. */
export const openStage = (doc: Doc): Stage | null => stages.get(doc) ?? null;

/**
 * Answers one request from the Python side. `group` ties the commands of one
 * Python execution together so they undo as a unit.
 */
export function handleRpc(
  context: RpcContext,
  method: string,
  params: Record<string, unknown>,
  data: Float64Array | null,
  group: string | undefined,
): RpcReply {
  const { doc } = context;
  // Inside an atomic block, Python reads and changes the block's own state;
  // the document sees nothing until the block ends.
  const stage = stages.get(doc);
  const state = stage ? stage.getState() : doc.getState();
  /** Changes the document (or the open block) with commands that go in together or not at all. */
  const write = <T>(fn: (writer: DocWriter) => T): T =>
    stage ? fn(stage) : doc.transact(fn, { group });
  /** A wave Python reads, noted so the block does not keep what it computed from an outdated one. */
  const readWave = (name: unknown): Wave => {
    const wave = requireWave(state, name);
    stage?.read(wave.name);
    return wave;
  };
  /** Pictures and files are made from the experiment as it is, which the block has not changed yet. */
  const outsideBlock = (what: string) => {
    if (stage) throw new DocError(`${what} waits for the end of the op.atomic() block.`);
  };
  switch (method) {
    case "dispatch": {
      const command = { ...params } as Record<string, unknown>;
      if (command.op === "makeWave" || command.op === "setWaveData") {
        // Numbers arrive as binary data; a text wave's values are in the command.
        // They travel as float64 whatever the wave's type (which the command
        // names), a complex wave as its real parts followed by its imaginary parts.
        if (data && command.complex === true) {
          command.data = data.subarray(0, data.length / 2);
          command.imag = data.subarray(data.length / 2);
        } else if (data) {
          command.data = data;
        }
        delete command.complex;
      } else if (command.op === "setWavePoints") {
        if (!data) throw new DocError("Missing point values.");
        if (command.complex === true) {
          command.values = data.subarray(0, data.length / 2);
          command.imag = data.subarray(data.length / 2);
        } else {
          command.values = data;
        }
        delete command.complex;
      }
      if (command.op === "addResult" && typeof command.result === "object" && command.result) {
        // Stamped here: the document's commands do not read the clock.
        command.result = { created: Date.now(), ...command.result };
      }
      if (command.op === "addRun" && typeof command.run === "object" && command.run) {
        command.run = { created: Date.now(), ...command.run };
      }
      if (command.op === "updateRunSample" && command.attempted === true) {
        command.finished ??= Date.now();
      }
      return { result: write((writer) => writer.dispatch(command as unknown as Command)) };
    }
    case "beginAtomic": {
      if (stage) stage.mark();
      else stages.set(doc, doc.stage());
      return { result: null };
    }
    case "commitAtomic": {
      if (!stage) throw new DocError("No op.atomic() block is open.");
      if (stage.depth > 0) {
        stage.release();
      } else {
        stages.delete(doc);
        stage.commit({ group });
      }
      return { result: null };
    }
    case "abortAtomic": {
      if (!stage) return { result: null };
      if (stage.depth > 0) {
        stage.rollback();
      } else {
        stages.delete(doc);
        stage.discard();
      }
      return { result: null };
    }
    case "pluginActions":
      return { result: context.pluginCatalog?.() ?? [] };
    case "waveInfo":
      return { result: waveInfo(state, readWave(params.name)) };
    case "waveData": {
      const wave = readWave(params.name);
      if (wave.text) return { result: { ...waveInfo(state, wave), text: wave.text } };
      // The caller says which revision it has cached; skip the copy if current.
      return params.rev === wave.rev
        ? { result: waveInfo(state, wave) }
        : { result: waveInfo(state, wave), data: transportData(wave) };
    }
    case "listWaves":
      return { result: state.waveOrder };
    case "formulas":
      return {
        result: formulaOrder(state).map((name) => formulaInfo(state, state.waves[name]!)),
      };
    case "timeZone":
      return { result: state.timeZone };
    case "listFolders":
      return { result: state.folders };
    case "attributes": {
      const target = typeof params.target === "string" ? params.target : "";
      if (isFolderKey(target)) {
        const folder = target.slice(0, -1);
        if (!state.folders.includes(folder)) {
          throw new DocError(`No data folder named ${JSON.stringify(folder)}.`);
        }
        return {
          result: params.own ? { ...state.attributes[target] } : folderAttributes(state, folder),
        };
      }
      const wave = readWave(target);
      return {
        result: params.own ? { ...state.attributes[wave.name] } : waveAttributes(state, wave.name),
      };
    }
    case "uniqueName": {
      const base = typeof params.base === "string" ? params.base : "wave";
      return { result: uniqueName(base, (name) => name in state.waves) };
    }
    case "cursorInfo": {
      const graph = typeof params.graph === "string" ? state.graphs[params.graph] : undefined;
      if (!graph) throw new DocError(`No graph named ${JSON.stringify(params.graph)}.`);
      const cursor = graph.cursors[params.cursor as "A" | "B"];
      if (!cursor) throw new DocError(`Cursor ${String(params.cursor)} is not on ${graph.name}.`);
      const trace = graph.traces.find((item) => item.name === cursor.trace);
      const position = trace ? tracePosition(trace, state.waves) : null;
      if (!position) throw new DocError(`Cursor ${String(params.cursor)} has lost its trace.`);
      stage?.read(position.y.name);
      if (position.x) stage?.read(position.x.name);
      return {
        result: {
          trace: cursor.trace,
          point: cursor.point,
          x: traceX(position.y, position.x, cursor.point) ?? null,
          y: position.y.data[cursor.point] ?? null,
        },
      };
    }
    case "exportGraph": {
      if (typeof params.name !== "string" || !state.graphs[params.name]) {
        throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      }
      const filename = typeof params.filename === "string" ? params.filename : "";
      if (!/\.(pdf|svg|png)$/i.test(filename)) {
        throw new DocError("The file name must end in .pdf, .svg or .png.");
      }
      outsideBlock("Saving a graph");
      context.exportGraph(params.name, filename, params.cursors === true);
      return { result: null };
    }
    case "listWindows":
      return {
        result: state.windows
          .filter(
            (window) =>
              (params.kind === undefined || params.kind === null || window.kind === params.kind) &&
              (params.closed !== false || !window.hidden),
          )
          .map((window) => window.name),
      };
    case "graphInfo": {
      const graph = typeof params.name === "string" ? state.graphs[params.name] : undefined;
      if (!graph) throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      return { result: graph };
    }
    case "listStyles":
      return { result: { names: Object.keys(state.styles), default: state.defaultStyle } };
    case "styleInfo": {
      const style = typeof params.name === "string" ? state.styles[params.name] : undefined;
      if (!style) throw new DocError(`No style named ${JSON.stringify(params.name)}.`);
      return { result: style };
    }
    case "listGraphTemplates":
      return { result: Object.keys(state.graphTemplates) };
    case "graphTemplateInfo":
      return { result: requireTemplate(state, params.name) };
    case "graphTemplateWarnings": {
      const samples = Array.isArray(params.samples) ? (params.samples as unknown[]) : [];
      return { result: templateWarnings(state, requireTemplate(state, params.name), samples) };
    }
    case "tableInfo": {
      const table = typeof params.name === "string" ? state.tables[params.name] : undefined;
      if (!table) throw new DocError(`No table named ${JSON.stringify(params.name)}.`);
      return { result: table };
    }
    case "pageInfo": {
      const page = typeof params.name === "string" ? state.pages[params.name] : undefined;
      if (!page) throw new DocError(`No page layout named ${JSON.stringify(params.name)}.`);
      return { result: page };
    }
    case "pageSvg": {
      if (typeof params.name !== "string" || !state.pages[params.name]) {
        throw new DocError(`No page layout named ${JSON.stringify(params.name)}.`);
      }
      outsideBlock("Drawing a page layout");
      return { result: context.renderPageSvg(params.name) };
    }
    case "exportPage": {
      if (typeof params.name !== "string" || !state.pages[params.name]) {
        throw new DocError(`No page layout named ${JSON.stringify(params.name)}.`);
      }
      const filename = typeof params.filename === "string" ? params.filename : "";
      if (!/\.(pdf|svg|png)$/i.test(filename)) {
        throw new DocError("The file name must end in .pdf, .svg or .png.");
      }
      outsideBlock("Saving a page layout");
      context.exportPage(params.name, filename);
      return { result: null };
    }
    case "arrangeLayout": {
      const layout = typeof params.layout === "string" ? params.layout : "";
      const { commands, leftOut } = arrangeLayout(state, layout, params, context.measureText);
      write((writer) => {
        for (const command of commands) writer.dispatch(command);
      });
      return { result: { leftOut } };
    }
    case "panelInfo":
      return { result: requirePanel(state, params.name) };
    case "panelCall": {
      // A press of a button from Python: the call as a click would make it.
      const { call, problems } = resolveButton(
        requirePanel(state, params.panel),
        String(params.button),
        { waveExists: (name) => name in state.waves },
      );
      if (!call) throw new DocError(problems.join(" "));
      return { result: call };
    }
    case "procedureInfo": {
      const procedure = typeof params.name === "string" ? state.procedures[params.name] : undefined;
      if (!procedure) throw new DocError(`No procedure named ${JSON.stringify(params.name)}.`);
      return { result: procedure };
    }
    case "graphScript": {
      if (typeof params.name !== "string" || !state.graphs[params.name]) {
        throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      }
      return { result: graphScript(state, params.name) };
    }
    // The three below keep Python's working directory and the experiment's
    // files the same: Python asks what there is before running an input and
    // reports what the input wrote or deleted afterwards.
    case "filesState":
      return {
        result: {
          procedures: Object.values(state.procedures).map(({ name, code }) => ({ name, code })),
          files: Object.fromEntries(context.files.list().map((file) => [file.path, file.version])),
        },
      };
    case "readFile": {
      const file = typeof params.path === "string" ? context.files.get(params.path) : undefined;
      if (!file) throw new DocError(`The experiment has no file ${JSON.stringify(params.path)}.`);
      return {
        result: { size: file.bytes.byteLength, version: file.version },
        data: bytesToWords(file.bytes),
      };
    }
    case "putFile": {
      const bytes = wordsToBytes(data, Number(params.size));
      return { result: context.files.put(String(params.path), bytes) };
    }
    case "listResults":
      return {
        result: Object.values(state.results)
          .sort((a, b) => a.created - b.created)
          .map((result) => result.name),
      };
    case "resultInfo": {
      const name = params.name;
      const result =
        typeof name === "string" && Object.hasOwn(state.results, name)
          ? state.results[name]
          : undefined;
      if (!result) throw new DocError(`No result named ${JSON.stringify(name)}.`);
      return { result: { ...result, changed: changedInputs(state, result) } };
    }
    case "listTemplates":
      return { result: Object.keys(state.templates) };
    case "templateInfo": {
      const template = typeof params.name === "string" ? state.templates[params.name] : undefined;
      if (!template) throw new DocError(`No template named ${JSON.stringify(params.name)}.`);
      return { result: template };
    }
    case "listRuns":
      return {
        result: Object.values(state.runs)
          .sort((a, b) => a.created - b.created)
          .map((run) => run.name),
      };
    case "runInfo": {
      const run = typeof params.name === "string" ? state.runs[params.name] : undefined;
      if (!run) throw new DocError(`No run named ${JSON.stringify(params.name)}.`);
      return {
        result: {
          ...run,
          samples: run.samples.map((sample) => ({
            ...sample,
            changed: changedSampleInputs(state, sample),
          })),
        },
      };
    }
    case "importData": {
      const filename = String(params.filename);
      let settings = checkSettings(params.settings ?? {});
      if (typeof params.preset === "string") {
        const preset = context.importPresets().find((item) => item.name === params.preset);
        if (!preset) {
          const names = context.importPresets().map((item) => item.name);
          throw new DocError(
            `No import preset named ${JSON.stringify(params.preset)}. Presets: ${names.join(", ") || "none"}.`,
          );
        }
        // What the call says goes before the preset, column by column.
        settings = {
          ...preset.settings,
          ...settings,
          columns: { ...preset.settings.columns, ...settings.columns },
        };
      }
      const digest = typeof params.digest === "string" ? params.digest : undefined;
      const bytes = wordsToBytes(data, Number(params.size));
      const kind = params.kind === "excel" ? "excel" : "text";
      const plan = planImport(bytes, filename, settings, state, digest, kind);
      if (plan.commands.length === 0) throw new DocError(`${filename} has no columns.`);
      const made: string[] = [];
      write((writer) => {
        for (const command of plan.commands) {
          const result = writer.dispatch(command);
          if (command.op !== "makeWave" && result) made.push(result);
        }
      });
      return {
        result: {
          tables: plan.tables.map(({ sheet, result }) => ({
            sheet,
            waves: result.names,
            unreadable: result.unreadable.map((rows) => rows.length),
          })),
          windows: made,
          summary: plan.summary,
          encoding: plan.encoding,
        },
      };
    }
    case "importIgor": {
      const filename = String(params.filename);
      const digest = typeof params.digest === "string" ? params.digest : undefined;
      const bytes = wordsToBytes(data, Number(params.size));
      const plan = planIgorImport(bytes, filename, state, digest);
      if (plan.waves.length === 0) throw new DocError(plan.summary);
      write((writer) => {
        for (const command of plan.commands) writer.dispatch(command);
      });
      return { result: { waves: plan.waves, summary: plan.summary, skipped: plan.skipped } };
    }
    case "removeFile":
      return { result: context.files.remove(String(params.path)) };
    case "graphSvg": {
      if (typeof params.name !== "string" || !state.graphs[params.name]) {
        throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      }
      const size = (value: unknown) => (typeof value === "number" && value > 0 ? value : null);
      outsideBlock("Drawing a graph");
      return {
        result: context.renderSvg(
          params.name,
          size(params.width),
          size(params.height),
          params.cursors === true,
        ),
      };
    }
    default:
      throw new DocError(`Unknown request ${JSON.stringify(method)}.`);
  }
}

/** Runs a request and packs the outcome the way the Python side expects. */
export function answerRpc(
  context: RpcContext,
  method: string,
  paramsJson: string,
  data: Float64Array | null,
  group: string | undefined,
): { json: string; data: Float64Array | null } {
  try {
    const params = JSON.parse(paramsJson) as Record<string, unknown>;
    const reply = handleRpc(context, method, params, data, group);
    return {
      json: JSON.stringify({ ok: true, result: reply.result ?? null }),
      data: reply.data ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { json: JSON.stringify({ ok: false, error: message }), data: null };
  }
}

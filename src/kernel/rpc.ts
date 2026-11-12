import { arrangeLayout } from "../core/doc/arrange";
import type { Command } from "../core/doc/commands";
import { uniqueName } from "../core/doc/commands";
import type { Doc } from "../core/doc/doc";
import { graphScript } from "../core/doc/recreate";
import { DocError, type Wave } from "../core/doc/types";
import { bytesToWords, wordsToBytes, type FileStore } from "../core/files/files";
import { checkSettings, planImport, type ImportSettings } from "../core/io/importData";
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

const waveInfo = (wave: Wave) => ({
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

const withoutRoot = (name: string): string => (name.startsWith("root:") ? name.slice(5) : name);

function requireWave(doc: Doc, name: unknown): Wave {
  const wave = typeof name === "string" ? doc.getState().waves[withoutRoot(name)] : undefined;
  if (!wave) throw new DocError(`No wave named ${JSON.stringify(name)}.`);
  return wave;
}

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
  const state = doc.getState();
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
      return { result: doc.dispatch(command as unknown as Command, { group }) };
    }
    case "waveInfo":
      return { result: waveInfo(requireWave(doc, params.name)) };
    case "waveData": {
      const wave = requireWave(doc, params.name);
      if (wave.text) return { result: { ...waveInfo(wave), text: wave.text } };
      // The caller says which revision it has cached; skip the copy if current.
      return params.rev === wave.rev
        ? { result: waveInfo(wave) }
        : { result: waveInfo(wave), data: transportData(wave) };
    }
    case "listWaves":
      return { result: state.waveOrder };
    case "timeZone":
      return { result: state.timeZone };
    case "listFolders":
      return { result: state.folders };
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
      context.exportGraph(params.name, filename, params.cursors === true);
      return { result: null };
    }
    case "listWindows":
      return {
        result: state.windows
          .filter((window) => window.kind === params.kind)
          .map((window) => window.name),
      };
    case "graphInfo": {
      const graph = typeof params.name === "string" ? state.graphs[params.name] : undefined;
      if (!graph) throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      return { result: graph };
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
      context.exportPage(params.name, filename);
      return { result: null };
    }
    case "arrangeLayout": {
      const layout = typeof params.layout === "string" ? params.layout : "";
      const { commands, leftOut } = arrangeLayout(state, layout, params, context.measureText);
      for (const command of commands) doc.dispatch(command, { group });
      return { result: { leftOut } };
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
      for (const command of plan.commands) {
        const result = doc.dispatch(command, { group });
        if (command.op !== "makeWave" && result) made.push(result);
      }
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
    case "removeFile":
      return { result: context.files.remove(String(params.path)) };
    case "graphSvg": {
      if (typeof params.name !== "string" || !state.graphs[params.name]) {
        throw new DocError(`No graph named ${JSON.stringify(params.name)}.`);
      }
      const size = (value: unknown) => (typeof value === "number" && value > 0 ? value : null);
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

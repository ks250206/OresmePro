/** The commands that change the document, and what applying one gives. (Applied through ./commands.) */
import type { SampleOutcome } from "./analysisTemplates";
import {
  DocError,
  type WaveData,
  type DocState,
  type EditorMemory,
  MAX_EDITOR_MEMORY,
} from "./types";

export type Props = Readonly<Record<string, unknown>>;

/**
 * Every change to the document is one of these. GUI actions and the Python
 * API both go through {@link applyCommand}, so they cannot disagree.
 */
export type Command =
  | {
      op: "makeWave";
      name: string;
      /** Numeric values in C order. Give either this or `text`. */
      data?: WaveData;
      /** The imaginary parts, for a complex wave. */
      imag?: WaveData;
      /** The number type; by default the type of `data`. Values are converted to it. */
      type?: string;
      text?: readonly string[];
      /** Defaults to one dimension. */
      shape?: readonly number[];
      x0?: number;
      dx?: number;
      xUnit?: string;
      y0?: number;
      dy?: number;
      yUnit?: string;
      unit?: string;
      note?: string;
      /** Defaults to true, like Igor's Make/O. */
      overwrite?: boolean;
    }
  | {
      op: "setWaveData";
      name: string;
      data?: WaveData;
      imag?: WaveData;
      type?: string;
      text?: readonly string[];
      shape?: readonly number[];
    }
  | {
      /**
       * Writes a run of points from `start`. `imag` holds the imaginary parts
       * for a complex wave; left out, they stay as they are.
       */
      op: "setWavePoints";
      name: string;
      start: number;
      values: ArrayLike<number>;
      imag?: ArrayLike<number>;
    }
  /** Changes a wave's number type, converting its values (Igor's Redimension). */
  | { op: "redimension"; name: string; type: string }
  | { op: "setWaveText"; name: string; start: number; values: readonly string[] }
  | { op: "insertPoints"; name: string; at: number; count: number }
  | { op: "deletePoints"; name: string; at: number; count: number }
  | {
      op: "setWaveScale";
      name: string;
      x0?: number;
      dx?: number;
      xUnit?: string;
      y0?: number;
      dy?: number;
      yUnit?: string;
    }
  | { op: "setWaveMeta"; name: string; unit?: string; note?: string }
  | { op: "renameWave"; name: string; newName: string }
  /**
   * Gives a wave a formula and computes it now, making the wave if it does
   * not exist (see ./formula). `auto` (true when left out) keeps it up to
   * date as its inputs change; otherwise it is computed again only by
   * recalculate. An `expr` of null removes the formula and keeps the values.
   */
  | { op: "setFormula"; name: string; expr: string | null; auto?: boolean }
  /** Computes again the formulas of these waves (all, when left out) that are out of date or failed. */
  | { op: "recalculate"; names?: readonly string[] }
  | { op: "duplicateWave"; name: string; newName: string; overwrite?: boolean }
  | { op: "killWaves"; names: readonly string[] }
  | { op: "newFolder"; path: string }
  | { op: "renameFolder"; path: string; newPath: string }
  | { op: "killFolder"; path: string }
  | {
      op: "display";
      y: readonly string[];
      x?: string | null;
      name?: string;
      /** The style to give the new graph: left out, the default style; null, none. */
      style?: string | null;
    }
  | {
      op: "appendTraces";
      graph: string;
      y: readonly string[];
      x?: string | null;
      vAxis?: string;
      hAxis?: string;
    }
  | { op: "removeTraces"; graph: string; traces: readonly string[] }
  | { op: "modifyTrace"; graph: string; trace: string; props: Props }
  | { op: "addAxis"; graph: string; name: string; side: string }
  | { op: "removeAxis"; graph: string; axis: string }
  | { op: "modifyAxis"; graph: string; axis: string; props: Props }
  | { op: "modifyGraph"; graph: string; props: Props }
  | {
      op: "appendImage";
      graph: string;
      wave: string;
      vAxis?: string;
      hAxis?: string;
      props?: Props;
    }
  | { op: "modifyImage"; graph: string; image: string; props: Props }
  | { op: "removeImage"; graph: string; image: string }
  | {
      op: "appendContour";
      graph: string;
      wave: string;
      vAxis?: string;
      hAxis?: string;
      props?: Props;
    }
  | { op: "modifyContour"; graph: string; contour: string; props: Props }
  | { op: "removeContour"; graph: string; contour: string }
  | { op: "setCursor"; graph: string; cursor: string; trace: string; point: number }
  | { op: "removeCursor"; graph: string; cursor: string }
  | {
      op: "addAnnotation";
      graph: string;
      kind: string;
      text?: string;
      anchor?: string;
      frame?: boolean;
      x?: number;
      y?: number;
      /** For a tag: what it points at. */
      trace?: string;
      point?: number;
    }
  | { op: "modifyAnnotation"; graph: string; annotation: string; props: Props }
  | { op: "removeAnnotation"; graph: string; annotation: string }
  /** Draws a shape or text on a graph (see DrawingSpec); returns its name. */
  | { op: "addDrawing"; graph: string; kind: string; points: readonly number[]; props?: Props }
  | { op: "modifyDrawing"; graph: string; drawing: string; props: Props }
  | { op: "removeDrawing"; graph: string; drawing: string }
  /** Puts a drawing in front of the others of its layer, or behind them. */
  | { op: "orderDrawing"; graph: string; drawing: string; place: string }
  | { op: "edit"; waves: readonly string[]; name?: string }
  | { op: "appendToTable"; table: string; waves: readonly string[] }
  | { op: "removeFromTable"; table: string; waves: readonly string[] }
  | { op: "modifyTable"; table: string; props: Props }
  | { op: "resizeColumn"; table: string; wave: string; width: number }
  | { op: "setTimeZone"; zone: string }
  | { op: "newLayout"; name?: string; width?: number; height?: number }
  | { op: "modifyLayout"; layout: string; props: Props }
  | {
      /** Puts a graph or a block of text on a page. Left out, the place is chosen. */
      op: "addLayoutItem";
      layout: string;
      kind: string;
      graph?: string;
      text?: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      size?: number;
    }
  | { op: "modifyLayoutItem"; layout: string; item: string; props: Props }
  | { op: "removeLayoutItem"; layout: string; item: string }
  /** Makes an empty panel (see PanelSpec) with its window. */
  | { op: "newPanel"; name?: string; title?: string }
  /**
   * Gives a panel its title and controls, as data (see checkPanel): an
   * imported panel, say. Makes the panel and its window if there is none.
   */
  | { op: "setPanel"; name: string; panel: unknown }
  | { op: "modifyPanel"; panel: string; props: Props }
  /** Adds a control at the end. Left out, the name is chosen from its kind. */
  | { op: "addControl"; panel: string; kind: string; name?: string; props?: Props }
  /** Changes a control's properties; `name` among them renames it, and buttons follow. */
  | { op: "modifyControl"; panel: string; control: string; props: Props }
  | { op: "removeControl"; panel: string; control: string }
  /** Puts a control at a place in the panel's order, counted from 0. */
  | { op: "moveControl"; panel: string; control: string; to: number }
  | { op: "setControlValue"; panel: string; control: string; value: unknown }
  | {
      op: "newProcedure";
      name?: string;
      code?: string;
      autoRun?: boolean;
      importAs?: string | null;
    }
  | {
      op: "setProcedure";
      name: string;
      code?: string;
      autoRun?: boolean;
      importAs?: string | null;
    }
  | { op: "newNote"; name?: string; text?: string }
  | { op: "setNote"; name: string; text: string }
  /** Keeps the look of a graph as a style; with `size`, the size it is drawn at too. */
  | { op: "saveStyle"; name: string; graph: string; size?: boolean }
  /** Defines a style from its parts (see StyleSpec), replacing one of that name. */
  | { op: "setStyle"; name: string; style: unknown }
  | { op: "removeStyle"; name: string }
  | { op: "renameStyle"; name: string; newName: string }
  | { op: "applyStyle"; style: string; graphs: readonly string[] }
  | { op: "setDefaultStyle"; name: string | null }
  /**
   * Keeps a graph as a template (see GraphTemplate). The axes in `fixed`
   * keep their ranges; the others are worked out from the data of each graph.
   */
  | { op: "saveGraphTemplate"; name: string; graph: string; fixed?: readonly string[] }
  /** Defines a template from its parts, replacing one of that name. */
  | { op: "setGraphTemplate"; name: string; template: unknown }
  | { op: "removeGraphTemplate"; name: string }
  | { op: "renameGraphTemplate"; name: string; newName: string }
  /**
   * Makes a graph from a template for each sample: wave names by slot. All
   * are made or none. `names` names the graphs; left out, they are chosen.
   */
  | {
      op: "makeGraphs";
      template: string;
      samples: readonly Readonly<Record<string, string | null>>[];
      names?: readonly string[];
    }
  /** Keeps the outcome of an analysis. `result` is as Python reports it (see checkResult). */
  | { op: "addResult"; result: unknown; name?: string }
  | { op: "removeResults"; names: readonly string[] }
  | { op: "renameResult"; name: string; newName: string }
  /** Defines an analysis template (see AnalysisTemplate), replacing one of that name. */
  | { op: "setTemplate"; name: string; template: unknown }
  | { op: "removeTemplate"; name: string }
  | { op: "renameTemplate"; name: string; newName: string }
  /**
   * Keeps the record of a template run on samples (see TemplateRun), as
   * Python starts it: every sample pending. Named Run0, Run1, ... unless named.
   */
  | { op: "addRun"; run: unknown; name?: string }
  /** Records how one sample of a run went; the inputs are fingerprinted as they are now. */
  | ({ op: "updateRunSample"; run: string; index: number } & SampleOutcome)
  | { op: "removeRuns"; names: readonly string[] }
  | { op: "killWindow"; name: string }
  /**
   * Records Python packages the experiment uses, as op.install found them
   * installed (see ./pythonEnv), under the Pyodide version it ran.
   */
  | { op: "recordPackages"; packages: readonly unknown[]; pyodide: string }
  /** Stops using packages: they and what only they needed are no longer recorded. */
  | { op: "forgetPackages"; names: readonly string[] }
  /**
   * Links graphs (at least two) so that their axes zoom together, the
   * bottom ("x") or the bottom and the left ("xy"), and, with `cursors`,
   * their cursors follow each other by X. They leave any group they were in.
   */
  | { op: "linkGraphs"; graphs: readonly string[]; axes?: string; cursors?: boolean }
  | { op: "unlinkGraphs"; graphs: readonly string[] }
  /**
   * Sets attributes of a sample: of a data folder ("run1:", with a colon) or
   * of a wave. A value of null removes that attribute.
   */
  | { op: "setAttributes"; target: string; values: Record<string, unknown> }
  /** Closes a window but keeps what it shows, to reopen it (see WindowState.hidden). */
  | { op: "closeWindow"; name: string }
  | { op: "reopenWindow"; name: string }
  /** Gives a graph, table, procedure, page layout, panel or note and its window another name. */
  | { op: "renameWindow"; name: string; newName: string }
  | { op: "moveWindow"; name: string; x?: number; y?: number; w?: number; h?: number }
  | { op: "activateWindow"; name: string }
  /**
   * Keeps what a plugin's editor or view has in its window (see
   * EditorMemory); a state of null forgets it.
   */
  | { op: "keepEditorState"; plugin: string; editor: string; version: string; state: unknown };

/**
 * Window geometry, focus and column widths are view state: not undoable and
 * not echoed. Neither is the text of a procedure or a note: its editor has
 * its own undo.
 */
export const EDITOR_PART = /^[a-z][a-z0-9_-]{0,63}$/;
export const EDITOR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const editorMemoryKey = (plugin: string, editor: string): string => {
  if (typeof plugin !== "string" || !EDITOR_PART.test(plugin))
    throw new DocError(`${JSON.stringify(plugin)} is not a plugin's name.`, "INVALID_ARGUMENT", {
      field: "plugin",
    });
  if (typeof editor !== "string" || !EDITOR_NAME.test(editor))
    throw new DocError(`${JSON.stringify(editor)} is not an editor's name.`, "INVALID_ARGUMENT", {
      field: "editor",
    });
  return `${plugin}/${editor}`;
};

/** An editor's state as kept: plain JSON (a copy), not too large. */
export function checkEditorMemory(value: unknown): EditorMemory {
  const given = (value ?? {}) as Partial<EditorMemory>;
  editorMemoryKey(given.plugin as string, given.editor as string);
  if (typeof given.version !== "string" || given.version.length > 64)
    throw new DocError("An editor's state needs the plugin's version.", "INVALID_ARGUMENT", {
      field: "version",
    });
  let text: string | undefined;
  try {
    text = JSON.stringify(given.state);
  } catch {
    text = undefined;
  }
  if (text === undefined)
    throw new DocError("An editor's state is plain JSON.", "INVALID_ARGUMENT", { field: "state" });
  if (text.length > MAX_EDITOR_MEMORY)
    throw new DocError(
      `An editor's state is larger than ${MAX_EDITOR_MEMORY / 1024} KiB.`,
      "INVALID_ARGUMENT",
      { field: "state" },
    );
  return {
    plugin: given.plugin!,
    editor: given.editor!,
    version: given.version,
    state: JSON.parse(text) as unknown,
  };
}

export const isTransient = (command: Command): boolean =>
  command.op === "moveWindow" ||
  command.op === "activateWindow" ||
  command.op === "resizeColumn" ||
  command.op === "setProcedure" ||
  command.op === "setNote" ||
  command.op === "keepEditorState";

export interface CommandOutcome {
  state: DocState;
  /** Name of whatever the command created, when it created something. */
  result: string | null;
}

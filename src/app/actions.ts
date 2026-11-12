import {
  arrangeLayout,
  readingOrder,
  type AlignEdge,
  type Arrangement,
  type DistributeDirection,
  type MatchDimension,
} from "../core/doc/arrange";
import { type Command, uniqueName } from "../core/doc/commands";
import { dict } from "../core/doc/dict";
import { echoArrangement } from "../core/doc/echo";
import { DATE_UNIT, leafName, type DocState, type PageSpec } from "../core/doc/types";
import { columnsFromRows, parseDelimited, type DelimitedResult } from "../core/io/delimited";
import { unzipExperiment, zipExperiment } from "../core/io/experiment";
import { readXlsx } from "../core/io/xlsx";
import { drawPrims } from "../core/plot/canvas";
import type { Prim } from "../core/plot/displayList";
import { toSvg } from "../core/plot/svg";
import { toPdf, type RasterText } from "../core/plot/pdf";
import { timeZone } from "../core/plot/ticks";
import { measureText } from "./measure";
import {
  activeWindow,
  doc,
  exportLayout,
  files,
  history,
  kernel,
  MOD,
  note,
  pageLayout,
  runGui,
  setExportHandler,
  setPageExportHandler,
  showError,
  ui,
  type MenuItem,
  type UiState,
} from "./session";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Draws text to pixels at four times its size, for the PDF writer to use
 * where the fonts built into PDF viewers cannot show the characters.
 */
function rasterizeText(
  text: string,
  family: string,
  size: number,
  fill: string,
): RasterText | null {
  const scale = 4;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  const font = `${size * scale}px ${family}`;
  context.font = font;
  const metrics = context.measureText(text);
  const ascent = Math.ceil(metrics.fontBoundingBoxAscent ?? size * scale);
  const descent = Math.ceil(metrics.fontBoundingBoxDescent ?? size * scale * 0.3);
  canvas.width = Math.max(1, Math.ceil(metrics.width));
  canvas.height = Math.max(1, ascent + descent);
  // Resizing a canvas resets its state.
  context.font = font;
  context.fillStyle = fill;
  context.textBaseline = "alphabetic";
  context.fillText(text, 0, ascent);
  return {
    cols: canvas.width,
    rows: canvas.height,
    rgba: context.getImageData(0, 0, canvas.width, canvas.height)
      .data as Uint8ClampedArray<ArrayBuffer>,
    width: canvas.width / scale,
    ascent: ascent / scale,
    descent: descent / scale,
  };
}

/**
 * Saves a drawing as .pdf, .svg or .png, chosen by the file name. `points`
 * is how many PDF points one unit of the drawing is: 0.75 for a graph, which
 * is in CSS pixels, and 1 for a page layout.
 */
function exportDrawing(
  layout: { prims: readonly Prim[]; width: number; height: number },
  filename: string,
  points: number,
): void {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "svg") {
    download(
      new Blob([toSvg(layout.prims, layout.width, layout.height)], { type: "image/svg+xml" }),
      filename,
    );
  } else if (extension === "pdf") {
    const pdf = toPdf(layout.prims, layout.width, layout.height, {
      rasterizeText,
      scale: points,
    }) as Uint8Array<ArrayBuffer>;
    download(new Blob([pdf], { type: "application/pdf" }), filename);
  } else {
    // Three times screen resolution for a graph (about 300 dpi for a page),
    // enough for print at typical sizes.
    const scale = points === 1 ? 300 / 72 : 3;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(layout.width * scale);
    canvas.height = Math.round(layout.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas available.");
    context.scale(scale, scale);
    drawPrims(context, layout.prims, scale);
    canvas.toBlob((blob) => {
      if (blob) download(blob, filename);
      else showError("Could not export", "The image could not be encoded.");
    }, "image/png");
  }
}

/** Saves a graph as .pdf, .svg or .png, chosen by the file name. */
export function exportGraph(name: string, filename: string, cursors = false): void {
  try {
    exportDrawing(exportLayout(name, null, null, cursors), filename, 0.75);
  } catch (error) {
    showError("Could not export the graph", error);
  }
}

/** Saves a page layout as .pdf (at its paper size), .svg or .png. */
export function exportPage(name: string, filename: string): void {
  try {
    exportDrawing(pageLayout(name), filename, 1);
  } catch (error) {
    showError("Could not export the page", error);
  }
}
setPageExportHandler(exportPage);
setExportHandler(exportGraph);

function pickFile(accept: string, multiple: boolean, onFiles: (files: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  input.accept = accept;
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

/** Asks for delimited text files and loads their columns as waves. */
export function loadDelimitedText(): void {
  pickFile(".csv,.tsv,.txt,.dat,text/plain,text/csv", true, (files) => void loadFiles(files));
}

/**
 * Loads several files one after another. In order, not at once: each file's
 * waves are named to avoid the ones already there, including those the file
 * before it just made.
 */
export async function loadFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) await loadFile(file);
}

/** Loads a dropped or chosen file: an experiment, an Excel workbook, or delimited text. */
export async function loadFile(file: File): Promise<void> {
  if (/\.oresme$/i.test(file.name)) await openExperimentFile(file);
  else if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) await loadExcelFile(file);
  else await loadTextFile(file);
}

/** The commands that make a wave of each column and a table showing them. */
function columnCommands(result: DelimitedResult, source: string): Command[] {
  const commands: Command[] = result.names.map((name, index) => {
    const column = result.columns[index]!;
    const loaded = {
      op: "makeWave" as const,
      name,
      note: `Loaded from ${source}`,
      ...(result.dates[index] ? { unit: DATE_UNIT } : {}),
    };
    return column instanceof Float64Array
      ? { ...loaded, data: column }
      : { ...loaded, text: column };
  });
  commands.push({ op: "edit", waves: result.names });
  return commands;
}

async function loadTextFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    // Look at the waves only now: others may have been made while the file was read.
    const { waves, timeZone: zone } = doc.getState();
    const result = parseDelimited(text, (name) => name in waves, timeZone(zone));
    if (result.names.length === 0) {
      showError("Nothing to load", `${file.name} has no columns.`);
      return;
    }
    if (runGui(columnCommands(result, file.name)) === undefined) return;
    note(`Loaded ${result.names.join(", ")} (${result.rows} points each) from ${file.name}.`);
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
  }
}

/** Asks for Excel workbooks and loads the columns of their sheets as waves. */
export function loadExcelWorkbook(): void {
  pickFile(".xlsx,.xlsm", true, (picked) => void loadFiles(picked));
}

/** Loads every sheet of a workbook that has cells: a wave per column and a table per sheet. */
async function loadExcelFile(file: File): Promise<void> {
  try {
    const sheets = readXlsx(new Uint8Array(await file.arrayBuffer()));
    if (sheets.length === 0) {
      showError("Nothing to load", `${file.name} has no cells.`);
      return;
    }
    const { waves, timeZone: zone } = doc.getState();
    // Columns of later sheets are named to avoid those of the sheets before.
    const taken = new Set<string>();
    const commands: Command[] = [];
    const lines: string[] = [];
    for (const sheet of sheets) {
      const result = columnsFromRows(
        sheet.rows,
        (name) => name in waves || taken.has(name),
        timeZone(zone),
      );
      if (result.names.length === 0) continue;
      for (const name of result.names) taken.add(name);
      commands.push(...columnCommands(result, `${file.name}, sheet ${sheet.name}`));
      lines.push(`${sheet.name}: ${result.names.join(", ")} (${result.rows} points each)`);
    }
    if (commands.length === 0) {
      showError("Nothing to load", `${file.name} has no columns.`);
      return;
    }
    if (runGui(commands) === undefined) return;
    note(`Loaded from ${file.name}:\n${lines.join("\n")}`);
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
  }
}

/** Downloads the whole experiment as one .oresme file. */
export function saveExperiment(): void {
  try {
    const bytes = zipExperiment(
      doc.getState(),
      history.getEntries(),
      files.list(),
    ) as Uint8Array<ArrayBuffer>;
    download(new Blob([bytes], { type: "application/zip" }), "experiment.oresme");
  } catch (error) {
    showError("Could not save the experiment", error);
  }
}

export function openExperiment(): void {
  pickFile(".oresme", false, (files) => {
    if (files[0]) void openExperimentFile(files[0]);
  });
}

async function openExperimentFile(file: File): Promise<void> {
  try {
    const opened = unzipExperiment(new Uint8Array(await file.arrayBuffer()));
    const current = doc.getState();
    const hasWork =
      current.waveOrder.length > 0 || current.windows.length > 0 || files.list().length > 0;
    if (hasWork && !window.confirm(`Replace the current experiment with ${file.name}?`)) return;
    // Procedures run when an experiment opens. For a file from somewhere else
    // that is code the user has not seen, so it is theirs to allow.
    const automatic = Object.values(opened.state.procedures).filter(
      (procedure) => procedure.autoRun && procedure.code.trim(),
    );
    const allowed =
      automatic.length === 0 ||
      window.confirm(
        `${file.name} has Python procedures that run when it opens (${automatic
          .map((procedure) => procedure.name)
          .join(", ")}). Run them?\n\nChoose Cancel to open the experiment without running them.`,
      );
    const procedures = allowed
      ? opened.state.procedures
      : dict(
          Object.entries(opened.state.procedures).map(([name, procedure]) => [
            name,
            { ...procedure, autoRun: false },
          ]),
        );
    doc.load({ ...opened.state, procedures });
    history.load(opened.history);
    files.load(opened.files);
    // Python's variables belong to the experiment that was open before.
    kernel.restart(`Opened ${file.name}.`);
  } catch (error) {
    showError(`Could not open ${file.name}`, error);
  }
}

/** Asks for files of any kind and puts them where Python can open them by name. */
export function addFilesForPython(): void {
  pickFile("", true, (picked) => {
    void (async () => {
      try {
        for (const file of picked) {
          files.put(file.name, new Uint8Array(await file.arrayBuffer()));
        }
        if (picked.length > 0) {
          note(`Added ${picked.map((file) => file.name).join(", ")} to the experiment's files.`);
        }
      } catch (error) {
        showError("Could not add the file", error);
      }
    })();
  });
}

/** Downloads one of the experiment's files. */
export function downloadFile(path: string): void {
  const file = files.get(path);
  if (!file) return;
  download(
    new Blob([file.bytes as Uint8Array<ArrayBuffer>]),
    path.slice(path.lastIndexOf("/") + 1),
  );
}

/** The frontmost window if it is a graph. */
export function activeGraph(): string | null {
  const window = activeWindow(doc.getState());
  return window?.kind === "graph" ? window.name : null;
}

export function autoscaleGraph(name: string): void {
  const graph = doc.getState().graphs[name];
  if (!graph) return;
  const commands: Command[] = [];
  for (const [axis, spec] of Object.entries(graph.axes)) {
    if (spec.min !== null || spec.max !== null) {
      commands.push({ op: "modifyAxis", graph: name, axis, props: { min: null, max: null } });
    }
  }
  runGui(commands);
}

/** A page layout by name; not one of Object's own properties for a name like "constructor". */
const pageNamed = (state: DocState, name: string): PageSpec | undefined =>
  Object.hasOwn(state.pages, name) ? state.pages[name] : undefined;

/**
 * The items selected on a page layout, in the order they were selected,
 * leaving out any that have since gone (removed by Python, say, or undone).
 */
export function selectedItems(
  layout: string,
  state: DocState = doc.getState(),
  selection: UiState["pageSelection"] = ui.get().pageSelection,
): string[] {
  const page = pageNamed(state, layout);
  const chosen = Object.hasOwn(selection, layout) ? selection[layout]! : [];
  return page ? chosen.filter((name) => page.items.some((item) => item.name === name)) : [];
}

export function selectItems(layout: string, items: readonly string[]): void {
  ui.set((state) => ({ pageSelection: { ...state.pageSelection, [layout]: items } }));
}

/**
 * Rearranges items on a page as one undo step, written into the history as
 * the one Python call that does the same. Returns whether it was done.
 */
export function arrangeItems(layout: string, arrangement: Arrangement): boolean {
  let commands: Command[];
  try {
    ({ commands } = arrangeLayout(doc.getState(), layout, arrangement, measureText));
  } catch (error) {
    showError("That did not work", error);
    return false;
  }
  return runGui(commands, { echo: echoArrangement(layout, arrangement) }) !== undefined;
}

/**
 * The graphs that "Arrange in Grid" places, in the order they fill the
 * cells: the selected ones as they read on the page now, or none to mean
 * every graph of the page.
 */
export function graphsToArrange(page: PageSpec, selection: readonly string[]): string[] {
  const graphs = page.items.filter(
    (item) => item.kind === "graph" && selection.includes(item.name),
  );
  return readingOrder(graphs).map((index) => graphs[index]!.name);
}

/**
 * The commands for arranging the items of a page layout, for its window's
 * context menu and for the Layout menu; each is enabled only where it applies
 * to the selection. With no page, they are all there but disabled.
 */
export function pageMenuItems(page: PageSpec | null, selection: readonly string[]): MenuItem[] {
  const layout = page?.name ?? "";
  const items = page?.items ?? [];
  const graphs = selection.filter(
    (name) => items.find((item) => item.name === name)?.kind === "graph",
  );
  const run = (label: string, disabled: boolean, arrangement: Arrangement): MenuItem => ({
    label,
    disabled,
    onSelect: () => arrangeItems(layout, arrangement),
  });
  const align = (label: string, edge: AlignEdge) =>
    run(label, selection.length === 0, { action: "align", items: selection, edge });
  const distribute = (label: string, direction: DistributeDirection) =>
    run(label, selection.length < 3, { action: "distribute", items: selection, direction });
  const match = (label: string, dimension: MatchDimension) =>
    run(label, graphs.length < 2, { action: "matchSize", items: graphs, dimension });
  return [
    {
      label: "Select All",
      shortcut: `${MOD}A`,
      disabled: items.length === 0,
      onSelect: () =>
        selectItems(
          layout,
          items.map((item) => item.name),
        ),
    },
    { separator: true },
    align("Align Left Edges", "left"),
    align("Align Right Edges", "right"),
    align("Align Top Edges", "top"),
    align("Align Bottom Edges", "bottom"),
    align("Align Horizontal Centers", "center"),
    align("Align Vertical Centers", "middle"),
    { separator: true },
    distribute("Distribute Horizontally", "horizontal"),
    distribute("Distribute Vertically", "vertical"),
    { separator: true },
    match("Make Same Width", "width"),
    match("Make Same Height", "height"),
    match("Make Same Size", "both"),
    { separator: true },
    {
      label: "Arrange in Grid…",
      disabled: !items.some((item) => item.kind === "graph"),
      onSelect: () => {
        if (!page) return;
        ui.set({
          dialog: { kind: "arrangeLayout", layout, items: graphsToArrange(page, selection) },
        });
      },
    },
  ];
}

/** Makes a new graph showing a 2-D wave as an image or as contours. */
export function newMatrixPlot(
  plot: "image" | "contour",
  wave: string,
  props: Record<string, unknown> = {},
): void {
  const state = doc.getState();
  const name = uniqueName("Graph", (candidate) =>
    state.windows.some((window) => window.name === candidate),
  );
  runGui([
    { op: "display", y: [], name },
    plot === "image"
      ? { op: "appendImage", graph: name, wave, props }
      : { op: "appendContour", graph: name, wave, props },
  ]);
}

/** Runs Python on behalf of a menu or dialog; it shows in the history like typed input. */
export function runPython(code: string): void {
  kernel.execute(code);
}

export const pyName = (wave: string): string => JSON.stringify(wave);
export { leafName };

export const EXAMPLE = `x = np.linspace(0, 10, 2000)
signal = op.make("signal", np.sin(2 * np.pi * x) * np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
envelope = op.make("envelope", np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
g = op.display(signal, envelope)
g.trace("envelope").set(color="black", line_style="dash")
g.legend()`;

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
import {
  emptyDoc,
  leafName,
  type DocState,
  type PageSpec,
  type StyleSpec,
} from "../core/doc/types";
import { unzipExperiment, zipExperiment } from "../core/io/experiment";
import { importPython, planImport, type ImportSettings } from "../core/io/importData";
import { isIgorFile, planIgorImport } from "../core/io/igorImport";
import { drawPrims } from "../core/plot/canvas";
import { cssFont, type FontStyle, type Prim } from "../core/plot/displayList";
import { toSvg } from "../core/plot/svg";
import { toPdf, type RasterText } from "../core/plot/pdf";
import { newExperimentId } from "./experiments";
import { measureText } from "./measure";
import { browserLibrary, readStyles, sameStyle, stylesText } from "./styleLibrary";
import {
  activeWindow,
  doc,
  experiment,
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
  type PendingData,
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
  style: FontStyle,
): RasterText | null {
  const scale = 4;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  const font = cssFont(size * scale, family, style);
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

export function pickFile(
  accept: string,
  multiple: boolean,
  onFiles: (files: File[]) => void,
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = multiple;
  input.accept = accept;
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

export type { PendingData as PendingFile } from "./session";

/** Asks for delimited text files and shows how each will be read. */
export function loadDelimitedText(): void {
  pickFile(".csv,.tsv,.txt,.dat,text/plain,text/csv", true, (files) => void loadFiles(files));
}

/** Asks for Excel workbooks and shows how each will be read. */
export function loadExcelWorkbook(): void {
  pickFile(".xlsx,.xlsm", true, (picked) => void loadFiles(picked));
}

/** Asks for Igor binary waves and packed experiments, and loads their waves. */
export function loadIgorFiles(): void {
  pickFile(".ibw,.pxp,.pxt", true, (picked) => void loadFiles(picked));
}

/**
 * Takes in dropped or chosen files. An experiment is opened; Igor files are
 * loaded at once (they say exactly what they hold, so there is nothing to
 * choose); other files of data (delimited text, Excel workbooks) are shown in
 * the Load Data dialog one after another, where the user sees how each is
 * read before it is.
 */
export async function loadFiles(files: Iterable<File>): Promise<void> {
  const data: PendingData[] = [];
  for (const file of files) {
    if (/\.oresme$/i.test(file.name)) {
      await openExperimentFile(file);
      continue;
    }
    try {
      const pending = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      if (isIgorFile(file.name)) await importIgorFile(pending);
      else data.push(pending);
    } catch (error) {
      showError(`Could not read ${file.name}`, error);
    }
  }
  if (data[0]) ui.set({ dialog: { kind: "importData", file: data[0], rest: data.slice(1) } });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Loads a file of data as the settings say: a wave per column, with a table
 * and a graph if asked for, as one undo step. With `keep`, the file itself
 * is put with the experiment's files and the history gets the Python that
 * loads it again; otherwise the history only notes what was loaded. Returns
 * whether anything was loaded.
 */
export async function importFile(
  file: PendingData,
  settings: ImportSettings,
  keep: boolean,
): Promise<boolean> {
  try {
    const digest = await sha256(file.bytes);
    // Planned only now: other waves may have been made while the file was hashed,
    // and the new ones are named to avoid them.
    const plan = planImport(file.bytes, file.name, settings, doc.getState(), digest);
    if (plan.commands.length === 0) {
      showError("Nothing to load", `${file.name} has no columns.`);
      return false;
    }
    let echo: string | undefined;
    if (keep) {
      try {
        files.put(file.name, file.bytes);
        echo = importPython(file.name, settings);
      } catch (error) {
        note(
          `${file.name} is not kept with the experiment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (runGui(plan.commands, { echo }) === undefined) return false;
    note(
      plan.tables.length === 1 && plan.tables[0]!.sheet === null
        ? `Loaded ${plan.summary[0]} from ${file.name}.`
        : `Loaded from ${file.name}:\n${plan.summary.join("\n")}`,
    );
    return true;
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
    return false;
  }
}

/**
 * Loads the waves of an Igor file into the experiment: the wave of a binary
 * wave, or every wave of a packed experiment under its data folders, as one
 * undo step. The history notes what was loaded and, for an experiment, what
 * was not. A file that cannot be read whole loads nothing. Returns whether
 * anything was loaded.
 */
export async function importIgorFile(file: PendingData): Promise<boolean> {
  try {
    const digest = await sha256(file.bytes);
    // Planned only now, as for text files: waves made meanwhile are avoided.
    const plan = planIgorImport(file.bytes, file.name, doc.getState(), digest);
    if (plan.commands.length === 0) {
      showError("Nothing to load", plan.summary);
      return false;
    }
    if (runGui(plan.commands) === undefined) return false;
    note(plan.summary);
    return true;
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
    return false;
  }
}

/** Shows another of the browser's experiments in this tab, saving this one first. */
export async function switchExperiment(id: string): Promise<void> {
  await experiment.flush();
  location.hash = `#e=${id}`;
  location.reload();
}

/**
 * Starts a new experiment. The one that was open stays as it is among the
 * browser's experiments; where the browser keeps none, there is only the
 * one, and it is cleared.
 */
export async function newExperiment(): Promise<void> {
  if (experiment.getState().kind !== "off") {
    await switchExperiment(newExperimentId());
    return;
  }
  if (!window.confirm("Start a new experiment? All waves, graphs and tables will be removed."))
    return;
  doc.load(emptyDoc());
  history.clear();
  files.load([]);
  kernel.restart();
}

/** Goes back to the experiment as it was when the session before the last save began. */
export async function revertExperiment(): Promise<void> {
  if (!(await experiment.hasBackup())) {
    showError("Nothing to go back to", "No earlier state of this experiment has been kept yet.");
    return;
  }
  const lost = experiment.getState().kind === "unread" ? "" : " What was done since is lost.";
  if (!window.confirm(`Go back to the experiment as it was when it was last opened?${lost}`))
    return;
  if (await experiment.revert()) {
    kernel.restart("Went back to the experiment as it was when it was last opened.");
  } else {
    showError("Could not go back", "The earlier state of the experiment could not be read either.");
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
    const name = experiment.getInfo().name.replace(/[\\/:*?"<>|]+/g, "_");
    download(new Blob([bytes], { type: "application/zip" }), `${name}.oresme`);
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

/** Saves styles to a JSON file the user downloads; one file holds them all. */
export function exportStyles(styles: readonly (readonly [string, StyleSpec])[]): void {
  if (styles.length === 0) return;
  const filename = styles.length === 1 ? `${styles[0]![0]}.json` : "styles.json";
  download(new Blob([stylesText(styles)], { type: "application/json" }), filename);
}

/** Asks for styles files and adds what they hold to the browser's library. */
export function importStyles(): void {
  pickFile(".json,application/json", true, (picked) => {
    void (async () => {
      for (const file of picked) {
        try {
          const read = readStyles(await file.text());
          const { added, present } = browserLibrary().add(read.styles);
          const parts = [
            added.length > 0 ? `added ${added.join(", ")}` : "",
            present.length > 0 ? `already had ${present.join(", ")}` : "",
          ].filter(Boolean);
          note(`Style library: ${parts.join("; ") || "nothing to add"} from ${file.name}.`);
          if (read.skipped.length > 0) {
            showError(`Some styles in ${file.name} were left out`, read.skipped.join("\n"));
          }
        } catch (error) {
          showError(`Could not import ${file.name}`, error);
        }
      }
    })();
  });
}

/**
 * The commands that copy a style of the library into the experiment, unless
 * it holds that very style already. The copy comes first so that the
 * history, which records it as op.set_style, can be run in any experiment.
 * Null when the user would rather keep the experiment's own style of that name.
 */
export function libraryStyleCommands(name: string): Command[] | null {
  const style = browserLibrary().list()[name];
  if (!style) return [];
  const own = doc.getState().styles[name];
  if (own && sameStyle(own, style)) return [];
  if (
    own &&
    !window.confirm(`The experiment has its own style ${name}. Replace it with the library's?`)
  ) {
    return null;
  }
  return [{ op: "setStyle", name, style }];
}

/** Gives graphs a style of the library, copying it into the experiment first. */
export function applyLibraryStyle(name: string, graphs: readonly string[]): void {
  const copy = libraryStyleCommands(name);
  if (copy) runGui([...copy, { op: "applyStyle", style: name, graphs }]);
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

import { type Command, uniqueName } from "../core/doc/commands";
import { DATE_UNIT, leafName } from "../core/doc/types";
import { parseDelimited } from "../core/io/delimited";
import { unzipExperiment, zipExperiment } from "../core/io/experiment";
import { drawPrims } from "../core/plot/canvas";
import { toPdf, type RasterText } from "../core/plot/pdf";
import {
  activeWindow,
  doc,
  exportLayout,
  history,
  kernel,
  note,
  renderGraphSvg,
  runGui,
  setExportHandler,
  showError,
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

/** Saves a graph as .pdf, .svg or .png, chosen by the file name. */
export function exportGraph(name: string, filename: string, cursors = false): void {
  try {
    const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    if (extension === "svg") {
      download(
        new Blob([renderGraphSvg(name, null, null, cursors)], { type: "image/svg+xml" }),
        filename,
      );
    } else if (extension === "pdf") {
      const layout = exportLayout(name, null, null, cursors);
      const pdf = toPdf(layout.prims, layout.width, layout.height, {
        rasterizeText,
      }) as Uint8Array<ArrayBuffer>;
      download(new Blob([pdf], { type: "application/pdf" }), filename);
    } else {
      // Three times screen resolution, enough for print at typical sizes.
      const scale = 3;
      const layout = exportLayout(name, null, null, cursors);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(layout.width * scale);
      canvas.height = Math.round(layout.height * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas available.");
      context.scale(scale, scale);
      drawPrims(context, layout.prims, scale);
      canvas.toBlob((blob) => {
        if (blob) download(blob, filename);
        else showError("Could not export the graph", "The image could not be encoded.");
      }, "image/png");
    }
  } catch (error) {
    showError("Could not export the graph", error);
  }
}
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
  pickFile(".csv,.tsv,.txt,.dat,text/plain,text/csv", true, (files) => {
    for (const file of files) void loadFile(file);
  });
}

/** Loads a dropped or chosen file: an experiment, or delimited text. */
export async function loadFile(file: File): Promise<void> {
  if (/\.oresme$/i.test(file.name)) await openExperimentFile(file);
  else await loadTextFile(file);
}

async function loadTextFile(file: File): Promise<void> {
  try {
    const waves = doc.getState().waves;
    const result = parseDelimited(await file.text(), (name) => name in waves);
    if (result.names.length === 0) {
      showError("Nothing to load", `${file.name} has no columns.`);
      return;
    }
    const commands: Command[] = result.names.map((name, index) => {
      const column = result.columns[index]!;
      const loaded = {
        op: "makeWave" as const,
        name,
        note: `Loaded from ${file.name}`,
        ...(result.dates[index] ? { unit: DATE_UNIT } : {}),
      };
      return column instanceof Float64Array
        ? { ...loaded, data: column }
        : { ...loaded, text: column };
    });
    commands.push({ op: "edit", waves: result.names });
    if (runGui(commands) === undefined) return;
    note(`Loaded ${result.names.join(", ")} (${result.rows} points each) from ${file.name}.`);
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
  }
}

/** Downloads the whole experiment as one .oresme file. */
export function saveExperiment(): void {
  try {
    const bytes = zipExperiment(doc.getState(), history.getEntries()) as Uint8Array<ArrayBuffer>;
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
    const { state, history: entries } = unzipExperiment(new Uint8Array(await file.arrayBuffer()));
    const current = doc.getState();
    const hasWork = current.waveOrder.length > 0 || current.windows.length > 0;
    if (hasWork && !window.confirm(`Replace the current experiment with ${file.name}?`)) return;
    doc.load(state);
    history.load(entries);
    // Python's variables belong to the experiment that was open before.
    kernel.restart(`Opened ${file.name}.`);
  } catch (error) {
    showError(`Could not open ${file.name}`, error);
  }
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

/** Makes a new graph showing a 2-D wave as an image or as contours. */
export function newMatrixPlot(
  plot: "image" | "contour",
  wave: string,
  props: Record<string, unknown> = {},
): void {
  const state = doc.getState();
  const name = uniqueName(
    "Graph",
    (candidate) => candidate in state.graphs || candidate in state.tables,
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

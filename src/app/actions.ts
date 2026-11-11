import type { Command } from "../core/doc/commands";
import { parseDelimited } from "../core/io/delimited";
import { drawPrims } from "../core/plot/canvas";
import { layoutGraph } from "../core/plot/layout";
import { measureText } from "./measure";
import {
  activeWindow,
  doc,
  note,
  renderGraphSvg,
  runGui,
  showError,
  TITLE_BAR_HEIGHT,
} from "./session";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportGraphSvg(name: string): void {
  try {
    download(
      new Blob([renderGraphSvg(name, null, null)], { type: "image/svg+xml" }),
      `${name}.svg`,
    );
  } catch (error) {
    showError("Could not export the graph", error);
  }
}

/** Exports at three times screen resolution, enough for print at typical sizes. */
export function exportGraphPng(name: string, scale = 3): void {
  const state = doc.getState();
  const graph = state.graphs[name];
  const window = state.windows.find((item) => item.name === name);
  if (!graph || !window) return;
  const width = window.w;
  const height = window.h - TITLE_BAR_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(scale, scale);
  drawPrims(context, layoutGraph(graph, state.waves, width, height, measureText).prims, scale);
  canvas.toBlob((blob) => {
    if (blob) download(blob, `${name}.png`);
    else showError("Could not export the graph", "The image could not be encoded.");
  }, "image/png");
}

/** Asks for delimited text files and loads their numeric columns as waves. */
export function loadDelimitedText(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".csv,.tsv,.txt,.dat,text/plain,text/csv";
  input.onchange = () => {
    for (const file of input.files ?? []) void loadTextFile(file);
  };
  input.click();
}

export async function loadTextFile(file: File): Promise<void> {
  try {
    const waves = doc.getState().waves;
    const result = parseDelimited(await file.text(), (name) => name in waves);
    if (result.names.length === 0) {
      showError("Nothing to load", `${file.name} has no numeric columns.`);
      return;
    }
    const commands: Command[] = result.names.map((name, index) => ({
      op: "makeWave",
      name,
      data: result.columns[index]!,
      note: `Loaded from ${file.name}`,
    }));
    commands.push({ op: "edit", waves: result.names });
    if (runGui(commands) === undefined) return;
    const skipped =
      result.skipped.length > 0 ? ` Skipped text columns: ${result.skipped.join(", ")}.` : "";
    note(
      `Loaded ${result.names.join(", ")} (${result.rows} points each) from ${file.name}.${skipped}`,
    );
  } catch (error) {
    showError(`Could not load ${file.name}`, error);
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
  const used = new Set<string>();
  for (const trace of graph.traces) {
    used.add(trace.vAxis);
    used.add(trace.hAxis);
  }
  const commands: Command[] = [];
  for (const axis of ["left", "bottom", "right", "top"] as const) {
    const spec = graph.axes[axis];
    if (used.has(axis) && (spec.min !== null || spec.max !== null)) {
      commands.push({ op: "modifyAxis", graph: name, axis, props: { min: null, max: null } });
    }
  }
  runGui(commands);
}

export const EXAMPLE = `x = np.linspace(0, 10, 2000)
signal = op.make("signal", np.sin(2 * np.pi * x) * np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
envelope = op.make("envelope", np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
g = op.display(signal, envelope)
g.trace("envelope").set(color="black", line_style="dash")
g.legend()`;

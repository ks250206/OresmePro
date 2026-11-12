import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  activeGraph,
  addFilesForPython,
  autoscaleGraph,
  EXAMPLE,
  exportGraph,
  loadDelimitedText,
  loadExcelWorkbook,
  loadFiles,
  openExperiment,
  pageMenuItems,
  saveExperiment,
  selectedItems,
  selectItems,
} from "./app/actions";
import { ensureIsolated, keepForOffline, openLaunchedFiles } from "./app/isolate";
import { autosave, restore } from "./app/persist";
import {
  activeWindow,
  doc,
  files,
  history,
  isMac,
  kernel,
  MOD,
  PYODIDE_URL,
  requestCommandLine,
  runGui,
  ui,
  useDoc,
  useKernelState,
  useUi,
  type MenuItem,
} from "./app/session";
import { emptyDoc } from "./core/doc/types";
import { CommandWindow } from "./ui/CommandWindow";
import { DataBrowser } from "./ui/DataBrowser";
import { Desktop } from "./ui/Desktop";
import { DialogHost } from "./ui/dialogs";
import { ContextMenuHost, MenuBar, type MenuDefinition } from "./ui/Menu";
import { StatusBar } from "./ui/StatusBar";

function Splitter({
  vertical,
  onDrag,
  label,
}: {
  vertical?: boolean;
  onDrag: (delta: number) => void;
  label: string;
}) {
  const last = useRef<number | null>(null);
  const coordinate = (event: ReactPointerEvent) => (vertical ? event.clientX : event.clientY);
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={`z-20 shrink-0 bg-line hover:bg-accent active:bg-accent ${
        vertical ? "-mx-px w-[3px] cursor-col-resize" : "-my-px h-[3px] cursor-row-resize"
      }`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = coordinate(event);
      }}
      onPointerMove={(event) => {
        if (last.current === null) return;
        onDrag(coordinate(event) - last.current);
        last.current = coordinate(event);
      }}
      onPointerUp={() => {
        last.current = null;
      }}
    />
  );
}

function newExperiment() {
  if (!window.confirm("Start a new experiment? All waves, graphs and tables will be removed."))
    return;
  doc.load(emptyDoc());
  history.clear();
  files.load([]);
  kernel.restart();
}

function useMenus(): MenuDefinition[] {
  const windows = useDoc((state) => state.windows);
  const graphs = useDoc((state) => state.graphs);
  const pages = useDoc((state) => state.pages);
  const pageSelection = useUi((state) => state.pageSelection);
  const top = windows.at(-1);
  const graph = top?.kind === "graph" ? top.name : null;
  const spec = graph ? graphs[graph] : undefined;
  // The Layout menu acts on the frontmost window when it is a page layout.
  const page = top?.kind === "page" && Object.hasOwn(pages, top.name) ? pages[top.name] : undefined;
  const layoutItems = pageMenuItems(
    page ?? null,
    page ? selectedItems(page.name, doc.getState(), pageSelection) : [],
  );
  const showBrowser = useUi((state) => state.showBrowser);
  const showCommand = useUi((state) => state.showCommand);
  const selected = useUi((state) => state.selectedWaves);
  const kernelState = useKernelState();
  const open = (dialog: NonNullable<ReturnType<typeof ui.get>["dialog"]>) => () =>
    ui.set({ dialog });
  const graphItem = (
    label: string,
    action: (name: string) => void,
    shortcut?: string,
  ): MenuItem => ({
    label,
    shortcut,
    disabled: !graph,
    onSelect: () => graph && action(graph),
  });
  const graphDialog = (label: string, dialog: (name: string) => NonNullable<UiDialog>): MenuItem =>
    graphItem(label, (name) => ui.set({ dialog: dialog(name) }));
  const analysis = (label: string, operation: string): MenuItem => ({
    label,
    onSelect: open({ kind: "analysis", operation }),
  });
  return [
    {
      title: "File",
      items: [
        { label: "New Experiment", onSelect: newExperiment },
        { label: "Open Experiment…", onSelect: openExperiment },
        { label: "Save Experiment As…", shortcut: `${MOD}S`, onSelect: saveExperiment },
        { separator: true },
        { label: "Load Delimited Text…", onSelect: loadDelimitedText },
        { label: "Load Excel Workbook…", onSelect: loadExcelWorkbook },
        { label: "Add Files for Python…", onSelect: addFilesForPython },
        { separator: true },
        graphItem("Save Graph as PDF", (name) => exportGraph(name, `${name}.pdf`)),
        graphItem("Save Graph as SVG", (name) => exportGraph(name, `${name}.svg`)),
        graphItem("Save Graph as PNG", (name) => exportGraph(name, `${name}.png`)),
      ],
    },
    {
      title: "Edit",
      items: [
        { label: "Undo", shortcut: `${MOD}Z`, disabled: !doc.canUndo, onSelect: () => doc.undo() },
        {
          label: "Redo",
          shortcut: isMac ? "⇧⌘Z" : "Ctrl+Y",
          disabled: !doc.canRedo,
          onSelect: () => doc.redo(),
        },
      ],
    },
    {
      title: "Data",
      items: [
        { label: "Load Delimited Text…", onSelect: loadDelimitedText },
        { label: "Load Excel Workbook…", onSelect: loadExcelWorkbook },
        { label: "New Data Folder…", onSelect: open({ kind: "newFolder", parent: "" }) },
        { label: "Time Zone for Dates…", onSelect: open({ kind: "timeZone" }) },
        { separator: true },
        {
          label: "Change Wave Scaling…",
          disabled: selected.length !== 1,
          onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave: selected[0]! } }),
        },
        {
          label: "Change Wave Type…",
          disabled: selected.length !== 1,
          onSelect: () => ui.set({ dialog: { kind: "waveType", wave: selected[0]! } }),
        },
        {
          label: "Rename or Move Wave…",
          disabled: selected.length !== 1,
          onSelect: () => ui.set({ dialog: { kind: "renameWave", wave: selected[0]! } }),
        },
        {
          label: "Kill Selected Waves",
          disabled: selected.length === 0,
          onSelect: () => runGui({ op: "killWaves", names: selected }),
        },
      ],
    },
    {
      title: "Analysis",
      items: [
        { label: "Curve Fitting…", onSelect: open({ kind: "curveFit" }) },
        analysis("Multi-peak Fit…", "fit_peaks"),
        { separator: true },
        analysis("Wave Stats…", "stats"),
        analysis("Differentiate…", "differentiate"),
        analysis("Integrate…", "integrate"),
        analysis("Smooth…", "smooth"),
        analysis("FFT…", "fft"),
        analysis("Histogram…", "histogram"),
        analysis("Interpolate…", "interpolate"),
        { separator: true },
        analysis("Filter Image…", "filter_image"),
      ],
    },
    {
      title: "Graph",
      items: [
        graphDialog("Append Traces…", (name) => ({ kind: "appendTraces", graph: name })),
        graphDialog("Append Image…", (name) => ({
          kind: "matrixPlot",
          plot: "image",
          graph: name,
        })),
        graphDialog("Append Contour…", (name) => ({
          kind: "matrixPlot",
          plot: "contour",
          graph: name,
        })),
        graphDialog("Add Axis…", (name) => ({ kind: "addAxis", graph: name })),
        { separator: true },
        graphDialog("Modify Trace Appearance…", (name) => ({ kind: "modifyTrace", graph: name })),
        graphDialog("Modify Axis…", (name) => ({ kind: "modifyAxis", graph: name })),
        graphDialog("Modify Graph…", (name) => ({ kind: "modifyGraph", graph: name })),
        { separator: true },
        graphItem("Autoscale Axes", autoscaleGraph, `${MOD}A`),
        {
          ...graphItem("Show Cursor Info", toggleInfo, `${MOD}I`),
          checked: spec?.showInfo ?? false,
        },
        graphItem("Add Legend", (name) =>
          runGui({ op: "addAnnotation", graph: name, kind: "legend" }),
        ),
        graphDialog("Add Text…", (name) => ({ kind: "addText", graph: name })),
        {
          ...graphItem("Add Color Scale", (name) =>
            runGui({ op: "addAnnotation", graph: name, kind: "colorscale" }),
          ),
          disabled: !spec || spec.images.length === 0,
        },
        { separator: true },
        // Styles can be managed with no graph open: the library, the default.
        {
          label: "Styles…",
          onSelect: () => ui.set({ dialog: { kind: "styles", graph: graph ?? undefined } }),
        },
        graphDialog("Recreation Script…", (name) => ({ kind: "graphScript", graph: name })),
      ],
    },
    { title: "Layout", items: layoutItems },
    {
      title: "Windows",
      items: [
        { label: "New Graph…", onSelect: open({ kind: "newGraph" }) },
        { label: "New Image Plot…", onSelect: open({ kind: "matrixPlot", plot: "image" }) },
        { label: "New Contour Plot…", onSelect: open({ kind: "matrixPlot", plot: "contour" }) },
        { label: "New Table…", onSelect: open({ kind: "newTable" }) },
        { label: "New Procedure", onSelect: () => runGui({ op: "newProcedure" }) },
        { label: "New Page Layout", onSelect: () => runGui({ op: "newLayout" }) },
        { separator: true },
        {
          label: "Data Browser",
          checked: showBrowser,
          onSelect: () => ui.set({ showBrowser: !showBrowser }),
        },
        {
          label: "Command Window",
          checked: showCommand,
          onSelect: () => ui.set({ showCommand: !showCommand }),
        },
        ...(windows.length > 0 ? [{ separator: true } as MenuItem] : []),
        ...[...windows]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map<MenuItem>((window) => ({
            label: window.name,
            checked: window === top,
            onSelect: () => doc.dispatch({ op: "activateWindow", name: window.name }),
          })),
      ],
    },
    {
      title: "Python",
      items: [
        {
          label: kernelState.interrupting ? "Interrupt Again (Restarts Python)" : "Interrupt",
          shortcut: "Ctrl+C",
          disabled: kernelState.status !== "busy",
          onSelect: () => kernel.interruptExecution(),
        },
        { label: "Restart Python", onSelect: () => kernel.restart() },
      ],
    },
    {
      title: "Help",
      items: [
        {
          label: "Put an Example in the Command Line",
          onSelect: () => requestCommandLine(EXAMPLE),
        },
        { label: "About OresmePro", onSelect: open({ kind: "about" }) },
      ],
    },
  ];
}

type UiDialog = ReturnType<typeof ui.get>["dialog"];

function toggleInfo(name: string) {
  const graph = doc.getState().graphs[name];
  if (graph) runGui({ op: "modifyGraph", graph: name, props: { showInfo: !graph.showInfo } });
}

/** Shortcuts that act on the document rather than on a text field. */
function onGlobalKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && key === "s") {
    // Everywhere, so the browser's own "save page" never takes over.
    event.preventDefault();
    saveExperiment();
    return;
  }
  if (!mod || typing || ui.get().dialog) return;
  if (key === "z") {
    event.preventDefault();
    if (event.shiftKey) doc.redo();
    else doc.undo();
  } else if (key === "y") {
    event.preventDefault();
    doc.redo();
  } else if (key === "a" && activeWindow(doc.getState())?.kind === "page") {
    // Select All on a page layout selects its items, not the text of the app.
    event.preventDefault();
    const { pages } = doc.getState();
    const name = activeWindow(doc.getState())!.name;
    const page = Object.hasOwn(pages, name) ? pages[name] : undefined;
    if (page)
      selectItems(
        name,
        page.items.map((item) => item.name),
      );
  } else if (key === "a" || key === "i") {
    const graph = activeGraph();
    if (graph) {
      event.preventDefault();
      if (key === "a") autoscaleGraph(graph);
      else toggleInfo(graph);
    }
  }
}

export function App() {
  const menus = useMenus();
  const showBrowser = useUi((state) => state.showBrowser);
  const showCommand = useUi((state) => state.showCommand);
  const browserWidth = useUi((state) => state.browserWidth);
  const commandHeight = useUi((state) => state.commandHeight);
  // Re-render the Edit menu's enabled state as the undo stack changes.
  useDoc((state) => state);

  useEffect(() => {
    let stopSaving: (() => void) | undefined;
    let cancelled = false;
    void ensureIsolated().then(async (proceed) => {
      if (!proceed || cancelled) return;
      await restore(doc, history, files);
      if (cancelled) return;
      stopSaving = autosave(doc, history, files);
      kernel.start();
      openLaunchedFiles((launched) => void loadFiles(launched));
      // Once Python is up, everything a start needs has been loaded: keep it for offline use.
      const stop = kernel.subscribe(() => {
        if (kernel.getState().status !== "ready") return;
        stop();
        void keepForOffline(PYODIDE_URL).then((count) => {
          Object.assign(debug, { offlineFiles: count });
        });
      });
    });
    window.addEventListener("keydown", onGlobalKey);
    return () => {
      cancelled = true;
      stopSaving?.();
      kernel.dispose();
      window.removeEventListener("keydown", onGlobalKey);
    };
  }, []);

  return (
    <div
      className="flex h-full flex-col"
      onContextMenu={(event) => {
        // The app has its own context menus; keep the browser's out of the chrome.
        if (!(event.target as HTMLElement).closest(".selectable, input, textarea"))
          event.preventDefault();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void loadFiles(event.dataTransfer.files);
      }}
    >
      <MenuBar menus={menus} />
      <div className="flex min-h-0 flex-1">
        {showBrowser ? (
          <>
            <div style={{ width: browserWidth }} className="shrink-0">
              <DataBrowser />
            </div>
            <Splitter
              vertical
              label="Resize data browser"
              onDrag={(delta) =>
                ui.set((state) => ({
                  browserWidth: Math.max(140, Math.min(480, state.browserWidth + delta)),
                }))
              }
            />
          </>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <Desktop />
          {showCommand ? (
            <>
              <Splitter
                label="Resize command window"
                onDrag={(delta) =>
                  ui.set((state) => ({
                    commandHeight: Math.max(
                      80,
                      Math.min(window.innerHeight - 160, state.commandHeight - delta),
                    ),
                  }))
                }
              />
              <div style={{ height: commandHeight }} className="shrink-0">
                <CommandWindow />
              </div>
            </>
          ) : null}
        </div>
      </div>
      <StatusBar />
      <DialogHost />
      <ContextMenuHost />
    </div>
  );
}

// Exposed for debugging from the browser console.
const debug = { doc, history, kernel, files, activeWindow };
Object.assign(globalThis, { oresme: debug });

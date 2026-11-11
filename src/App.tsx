import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  activeGraph,
  autoscaleGraph,
  EXAMPLE,
  exportGraphPng,
  exportGraphSvg,
  loadDelimitedText,
  loadTextFile,
} from "./app/actions";
import { ensureIsolated } from "./app/isolate";
import { autosave, restore } from "./app/persist";
import {
  activeWindow,
  doc,
  history,
  kernel,
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

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

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
  kernel.restart();
}

function useMenus(): MenuDefinition[] {
  const windows = useDoc((state) => state.windows);
  const top = windows.at(-1);
  const graph = top?.kind === "graph" ? top.name : null;
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
  return [
    {
      title: "File",
      items: [
        { label: "New Experiment", onSelect: newExperiment },
        { separator: true },
        { label: "Load Delimited Text…", onSelect: loadDelimitedText },
        { separator: true },
        graphItem("Save Graph as SVG", exportGraphSvg),
        graphItem("Save Graph as PNG", exportGraphPng),
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
        { separator: true },
        {
          label: "Change Wave Scaling…",
          disabled: selected.length !== 1,
          onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave: selected[0]! } }),
        },
        {
          label: "Rename Wave…",
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
      title: "Graph",
      items: [
        graphItem("Append Traces…", (name) =>
          ui.set({ dialog: { kind: "appendTraces", graph: name } }),
        ),
        graphItem("Modify Trace Appearance…", (name) =>
          ui.set({ dialog: { kind: "modifyTrace", graph: name } }),
        ),
        graphItem("Modify Axis…", (name) =>
          ui.set({ dialog: { kind: "modifyAxis", graph: name } }),
        ),
        graphItem("Modify Graph…", (name) =>
          ui.set({ dialog: { kind: "modifyGraph", graph: name } }),
        ),
        { separator: true },
        graphItem("Autoscale Axes", autoscaleGraph, `${MOD}A`),
        graphItem("Add Legend", (name) =>
          runGui({ op: "addAnnotation", graph: name, kind: "legend" }),
        ),
        graphItem("Add Text…", (name) => ui.set({ dialog: { kind: "addText", graph: name } })),
      ],
    },
    {
      title: "Windows",
      items: [
        { label: "New Graph…", onSelect: open({ kind: "newGraph" }) },
        { label: "New Table…", onSelect: open({ kind: "newTable" }) },
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
          label: "Interrupt",
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

/** Shortcuts that act on the document rather than on a text field. */
function onGlobalKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || typing || ui.get().dialog) return;
  const key = event.key.toLowerCase();
  if (key === "z") {
    event.preventDefault();
    if (event.shiftKey) doc.redo();
    else doc.undo();
  } else if (key === "y") {
    event.preventDefault();
    doc.redo();
  } else if (key === "a") {
    const graph = activeGraph();
    if (graph) {
      event.preventDefault();
      autoscaleGraph(graph);
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
      await restore(doc, history);
      if (cancelled) return;
      stopSaving = autosave(doc, history);
      kernel.start();
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
        for (const file of event.dataTransfer.files) void loadTextFile(file);
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
Object.assign(globalThis, { oresme: { doc, history, kernel, activeWindow } });

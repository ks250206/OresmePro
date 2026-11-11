import { useEffect, useRef, useState } from "react";
import { newMatrixPlot } from "../app/actions";
import { runGui, ui, useDoc, useUi, type MenuItem } from "../app/session";
import type { Command } from "../core/doc/commands";
import { leafName, parentFolder, type Wave } from "../core/doc/types";
import { renderMatrix } from "../core/plot/colorTables";
import { extentOf, tracePixels } from "../core/plot/decimate";
import { planeOf } from "../core/plot/layout";
import { makeScale } from "../core/plot/scale";
import { formatNumber } from "../core/plot/ticks";
import { openContextMenu } from "./Menu";

const DRAG_TYPE = "application/x-oresme-waves";

/** A small unlabelled picture of a wave: a curve, or an image for a matrix. */
function Preview({ wave }: { wave: Wave }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const extent = extentOf(wave.data);
    if (!Number.isFinite(extent.min)) return;
    const plane = planeOf(wave, 0, 0);
    if (plane) {
      const { nx, ny } = plane;
      const cols = Math.min(nx, canvas.width);
      const rows = Math.min(ny, canvas.height);
      if (cols === 0 || rows === 0) return;
      const rgba = renderMatrix(plane.data, nx, ny, cols, rows, {
        table: "viridis",
        zMin: extent.min,
        zMax: extent.max,
        reverse: false,
        flipX: false,
        flipY: false,
      });
      const buffer = new OffscreenCanvas(cols, rows);
      buffer.getContext("2d")?.putImageData(new ImageData(rgba, cols, rows), 0, 0);
      context.imageSmoothingEnabled = false;
      context.drawImage(buffer, 0, 0, width, height);
      return;
    }
    const count = wave.data.length;
    if (wave.shape.length !== 1 || count < 2) return;
    const pad = extent.max === extent.min ? 0.5 : 0;
    const xs = makeScale(wave.x0, wave.x0 + (count - 1) * wave.dx, false, 4, width - 4);
    const ys = makeScale(extent.min - pad, extent.max + pad, false, height - 5, 5);
    context.strokeStyle = "#ff0000";
    context.lineWidth = 1;
    context.lineJoin = "round";
    for (const run of tracePixels(wave, null, xs, ys).runs) {
      context.beginPath();
      context.moveTo(run[0]!, run[1]!);
      for (let index = 2; index < run.length; index += 2)
        context.lineTo(run[index]!, run[index + 1]!);
      context.stroke();
    }
  }, [wave]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="h-20 w-full rounded border border-line-soft bg-white"
    />
  );
}

const sizeLabel = (wave: Wave): string =>
  wave.shape.map((size) => size.toLocaleString("en-US")).join("×");

function WaveInfo({ wave }: { wave: Wave }) {
  const extent = extentOf(wave.data);
  const unit = (value: string) => (value ? ` ${value}` : "");
  const rows: [string, string][] = [[wave.text ? "Text points" : "Points", sizeLabel(wave)]];
  if (!wave.text) {
    rows.push([
      "X start, step",
      `${formatNumber(wave.x0)}, ${formatNumber(wave.dx)}${unit(wave.xUnit)}`,
    ]);
    if (wave.shape.length > 1) {
      rows.push([
        "Y start, step",
        `${formatNumber(wave.y0)}, ${formatNumber(wave.dy)}${unit(wave.yUnit)}`,
      ]);
    }
    if (Number.isFinite(extent.min)) {
      rows.push(["Min", `${formatNumber(extent.min)}${unit(wave.unit)}`]);
      rows.push(["Max", `${formatNumber(extent.max)}${unit(wave.unit)}`]);
    }
  }
  return (
    <div className="flex flex-col gap-1.5 border-t border-line p-2">
      {wave.text ? null : <Preview wave={wave} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="selectable m-0 truncate text-right font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {wave.note ? (
        <div className="selectable truncate text-[11px] text-muted" title={wave.note}>
          {wave.note}
        </div>
      ) : null}
    </div>
  );
}

function WaveIcon({ wave, active }: { wave: Wave; active: boolean }) {
  const color = active ? "#fff" : "#e00000";
  if (wave.text) {
    return (
      <span
        aria-hidden
        className={`w-3 shrink-0 text-center text-[10px] font-bold ${active ? "" : "text-muted"}`}
      >
        T
      </span>
    );
  }
  if (wave.shape.length > 1) {
    return (
      <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden className="shrink-0">
        <path
          d="M1.5 1.5h9v7h-9zM1.5 5h9M4.5 1.5v7M7.5 1.5v7"
          fill="none"
          stroke={active ? "#fff" : "#2760c4"}
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden className="shrink-0">
      <path d="M1.5 5c1.5-6 3-6 4.5 0s3 6 4.5 0" fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

/** Lists the waves of the experiment in their data folders, like Igor's Data Browser. */
export function DataBrowser() {
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const folders = useDoc((state) => state.folders);
  const collapsed = useUi((state) => state.collapsedFolders);
  const selected = useUi((state) => state.selectedWaves).filter((name) => name in waves);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const focused = selected.length === 1 ? waves[selected[0]!] : undefined;

  // The rows as shown, top to bottom, for shift-selection.
  const visible: string[] = [];
  const collect = (folder: string) => {
    for (const child of folders) {
      if (parentFolder(child) === folder && !collapsed.includes(child)) collect(child);
    }
    for (const name of order) if (parentFolder(name) === folder) visible.push(name);
  };
  collect("");

  const select = (
    name: string,
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => {
    if (event.metaKey || event.ctrlKey) {
      ui.set({
        selectedWaves: selected.includes(name)
          ? selected.filter((item) => item !== name)
          : [...selected, name],
      });
    } else if (event.shiftKey && selected.length > 0) {
      const from = visible.indexOf(selected.at(-1)!);
      const to = visible.indexOf(name);
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      ui.set({ selectedWaves: [...new Set([...selected, ...range])] });
    } else {
      ui.set({ selectedWaves: [name] });
    }
  };

  const moveInto = (folder: string, names: readonly string[]) => {
    const commands: Command[] = names
      .filter((name) => parentFolder(name) !== folder)
      .map((name) => ({
        op: "renameWave",
        name,
        newName: folder ? `${folder}:${leafName(name)}` : leafName(name),
      }));
    if (runGui(commands) !== undefined) ui.set({ selectedWaves: [] });
  };

  const dropProps = (folder: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((current) => (current === folder ? null : current)),
    onDrop: (event: React.DragEvent) => {
      const data = event.dataTransfer.getData(DRAG_TYPE);
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      moveInto(folder, JSON.parse(data) as string[]);
    },
  });

  const waveMenu = (event: React.MouseEvent, name: string) => {
    event.preventDefault();
    event.stopPropagation();
    const targets = selected.includes(name) ? selected : [name];
    if (!selected.includes(name)) ui.set({ selectedWaves: [name] });
    const single = targets.length === 1;
    const kinds = targets.map((target) => waves[target]!);
    const allCurves = kinds.every((wave) => !wave.text && wave.shape.length === 1);
    const matrix = single && !kinds[0]!.text && kinds[0]!.shape.length >= 2;
    const open = (dialog: NonNullable<ReturnType<typeof ui.get>["dialog"]>) => () =>
      ui.set({ dialog });
    const items: MenuItem[] = [];
    if (allCurves)
      items.push({ label: "Display", onSelect: () => runGui({ op: "display", y: targets }) });
    if (matrix) {
      items.push(
        {
          label: "New Image Plot",
          onSelect: () => newMatrixPlot("image", name, { colorTable: "viridis" }),
        },
        { label: "New Contour Plot", onSelect: () => newMatrixPlot("contour", name) },
      );
    }
    items.push({ label: "Edit in Table", onSelect: () => runGui({ op: "edit", waves: targets }) });
    if (single && allCurves) {
      items.push({ label: "Curve Fitting…", onSelect: open({ kind: "curveFit", wave: name }) });
    }
    items.push(
      { separator: true },
      {
        label: "Change Wave Scaling…",
        disabled: !single || Boolean(kinds[0]!.text),
        onSelect: open({ kind: "waveScaling", wave: name }),
      },
      {
        label: "Rename or Move…",
        disabled: !single,
        onSelect: open({ kind: "renameWave", wave: name }),
      },
      {
        label: "Duplicate…",
        disabled: !single,
        onSelect: open({ kind: "duplicateWave", wave: name }),
      },
      { separator: true },
      {
        label: single ? `Kill ${leafName(name)}` : `Kill ${targets.length} Waves`,
        onSelect: () => runGui({ op: "killWaves", names: targets }),
      },
    );
    openContextMenu(event, items);
  };

  const folderMenu = (event: React.MouseEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    const items: MenuItem[] = [
      {
        label: "New Data Folder…",
        onSelect: () => ui.set({ dialog: { kind: "newFolder", parent: folder } }),
      },
    ];
    if (folder) {
      items.push(
        {
          label: "Rename or Move…",
          onSelect: () => ui.set({ dialog: { kind: "renameFolder", folder } }),
        },
        { separator: true },
        {
          label: `Kill ${leafName(folder)} and Its Waves`,
          onSelect: () => runGui({ op: "killFolder", path: folder }),
        },
      );
    }
    openContextMenu(event, items);
  };

  const toggle = (folder: string) =>
    ui.set({
      collapsedFolders: collapsed.includes(folder)
        ? collapsed.filter((item) => item !== folder)
        : [...collapsed, folder],
    });

  const renderFolder = (folder: string, depth: number): React.ReactNode => {
    const indent = { paddingLeft: 8 + depth * 12 };
    const isOpen = folder === "" || !collapsed.includes(folder);
    return (
      <div key={folder || "root"} role="group" aria-label={folder || "root"}>
        <div
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={false}
          className={`flex cursor-default items-center gap-1 py-[1px] pr-2 font-medium ${
            dropTarget === folder ? "bg-accent-soft" : "hover:bg-chrome"
          } ${folder ? "" : "text-muted"}`}
          style={indent}
          onClick={() => folder && toggle(folder)}
          onContextMenu={(event) => folderMenu(event, folder)}
          {...dropProps(folder)}
        >
          <span className="w-3 text-center text-[9px] text-muted">
            {folder ? (isOpen ? "▼" : "▶") : ""}
          </span>
          <span className="truncate">{folder ? leafName(folder) : "root"}</span>
        </div>
        {isOpen ? (
          <>
            {folders
              .filter((child) => parentFolder(child) === folder && child !== folder)
              .map((child) => renderFolder(child, depth + 1))}
            {order
              .filter((name) => parentFolder(name) === folder)
              .map((name) => {
                const wave = waves[name]!;
                const active = selected.includes(name);
                return (
                  <div
                    key={name}
                    role="option"
                    aria-selected={active}
                    aria-label={name}
                    draggable
                    className={`flex cursor-default items-center gap-1.5 py-[1px] pr-2 ${
                      active ? "bg-accent text-white" : "hover:bg-chrome"
                    }`}
                    style={{ paddingLeft: 24 + depth * 12 }}
                    onPointerDown={(event) => {
                      // Keep a multi-selection intact when starting to drag it.
                      if (
                        event.button === 0 &&
                        !(
                          active &&
                          selected.length > 1 &&
                          !event.shiftKey &&
                          !event.ctrlKey &&
                          !event.metaKey
                        )
                      ) {
                        select(name, event);
                      }
                    }}
                    onClick={(event) => {
                      if (
                        active &&
                        selected.length > 1 &&
                        !event.shiftKey &&
                        !event.ctrlKey &&
                        !event.metaKey
                      ) {
                        ui.set({ selectedWaves: [name] });
                      }
                    }}
                    onDragStart={(event) => {
                      const moving = active ? selected : [name];
                      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(moving));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDoubleClick={() => runGui({ op: "edit", waves: [name] })}
                    onContextMenu={(event) => waveMenu(event, name)}
                  >
                    <WaveIcon wave={wave} active={active} />
                    <span className="min-w-0 flex-1 truncate">{leafName(name)}</span>
                    <span
                      className={`font-mono text-[10.5px] ${active ? "text-white/80" : "text-muted"}`}
                    >
                      {sizeLabel(wave)}
                    </span>
                  </div>
                );
              })}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <aside aria-label="Data Browser" className="flex h-full min-h-0 flex-col bg-chrome">
      <div className="flex h-6 shrink-0 items-center border-b border-line px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Data Browser
      </div>
      <div
        role="listbox"
        aria-label="Waves"
        aria-multiselectable
        className="min-h-0 flex-1 overflow-y-auto bg-paper py-0.5"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) ui.set({ selectedWaves: [] });
        }}
        onContextMenu={(event) => folderMenu(event, "")}
        {...dropProps("")}
      >
        {renderFolder("", 0)}
        {order.length === 0 && folders.length === 0 ? (
          <div className="px-4 py-1 leading-relaxed text-muted">
            No waves yet. Drop a CSV file here, or make one:
            <div className="font-mono text-[11px]">op.make("w", np.arange(10))</div>
          </div>
        ) : null}
      </div>
      {focused ? <WaveInfo wave={focused} /> : null}
    </aside>
  );
}

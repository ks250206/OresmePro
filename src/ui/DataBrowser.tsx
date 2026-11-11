import { useEffect, useRef } from "react";
import { runGui, ui, useDoc, useUi } from "../app/session";
import type { Wave } from "../core/doc/types";
import { extentOf, tracePixels } from "../core/plot/decimate";
import { makeScale } from "../core/plot/scale";
import { formatNumber } from "../core/plot/ticks";
import { openContextMenu } from "./Menu";

/** A small unlabelled plot of one wave. */
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
    const count = wave.data.length;
    const extent = extentOf(wave.data);
    if (count < 2 || !Number.isFinite(extent.min)) return;
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

function WaveInfo({ wave }: { wave: Wave }) {
  const extent = extentOf(wave.data);
  const rows: [string, string][] = [
    ["Points", wave.data.length.toLocaleString("en-US")],
    ["X start", `${formatNumber(wave.x0)}${wave.xUnit ? ` ${wave.xUnit}` : ""}`],
    ["X step", `${formatNumber(wave.dx)}${wave.xUnit ? ` ${wave.xUnit}` : ""}`],
  ];
  if (Number.isFinite(extent.min)) {
    rows.push(["Min", `${formatNumber(extent.min)}${wave.unit ? ` ${wave.unit}` : ""}`]);
    rows.push(["Max", `${formatNumber(extent.max)}${wave.unit ? ` ${wave.unit}` : ""}`]);
  }
  return (
    <div className="flex flex-col gap-1.5 border-t border-line p-2">
      <Preview wave={wave} />
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

/** Lists the waves of the experiment, like Igor's Data Browser. */
export function DataBrowser() {
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const selected = useUi((state) => state.selectedWaves).filter((name) => name in waves);
  const focused = selected.length === 1 ? waves[selected[0]!] : undefined;

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
      const from = order.indexOf(selected.at(-1)!);
      const to = order.indexOf(name);
      ui.set({
        selectedWaves: [
          ...new Set([...selected, ...order.slice(Math.min(from, to), Math.max(from, to) + 1)]),
        ],
      });
    } else {
      ui.set({ selectedWaves: [name] });
    }
  };

  const menu = (event: React.MouseEvent, name: string) => {
    event.preventDefault();
    const targets = selected.includes(name) ? selected : [name];
    if (!selected.includes(name)) ui.set({ selectedWaves: [name] });
    const single = targets.length === 1;
    openContextMenu(event, [
      { label: "Display", onSelect: () => runGui({ op: "display", y: targets }) },
      { label: "Edit in Table", onSelect: () => runGui({ op: "edit", waves: targets }) },
      { separator: true },
      {
        label: "Change Wave Scaling…",
        disabled: !single,
        onSelect: () => ui.set({ dialog: { kind: "waveScaling", wave: name } }),
      },
      {
        label: "Rename…",
        disabled: !single,
        onSelect: () => ui.set({ dialog: { kind: "renameWave", wave: name } }),
      },
      {
        label: "Duplicate…",
        disabled: !single,
        onSelect: () => ui.set({ dialog: { kind: "duplicateWave", wave: name } }),
      },
      { separator: true },
      {
        label: single ? `Kill ${name}` : `Kill ${targets.length} Waves`,
        onSelect: () => runGui({ op: "killWaves", names: targets }),
      },
    ]);
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
      >
        <div className="px-2 py-0.5 font-medium text-muted">root</div>
        {order.length === 0 ? (
          <div className="px-4 py-1 leading-relaxed text-muted">
            No waves yet. Drop a CSV file here, or make one:
            <div className="font-mono text-[11px]">op.make("w", np.arange(10))</div>
          </div>
        ) : null}
        {order.map((name) => {
          const active = selected.includes(name);
          return (
            <div
              key={name}
              role="option"
              aria-selected={active}
              className={`flex cursor-default items-center gap-1.5 py-[1px] pl-4 pr-2 ${
                active ? "bg-accent text-white" : "hover:bg-chrome"
              }`}
              onPointerDown={(event) => {
                if (event.button === 0) select(name, event);
              }}
              onDoubleClick={() => runGui({ op: "edit", waves: [name] })}
              onContextMenu={(event) => menu(event, name)}
            >
              <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden className="shrink-0">
                <path
                  d="M0.5 5c1.5-6 3-6 4.5 0s3 6 4.5 0"
                  transform="translate(1 0)"
                  fill="none"
                  stroke={active ? "#fff" : "#e00000"}
                  strokeWidth="1.2"
                />
              </svg>
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span
                className={`font-mono text-[10.5px] ${active ? "text-white/80" : "text-muted"}`}
              >
                {waves[name]?.data.length.toLocaleString("en-US")}
              </span>
            </div>
          );
        })}
      </div>
      {focused ? <WaveInfo wave={focused} /> : null}
    </aside>
  );
}

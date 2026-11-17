import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  beginHandleDrag,
  clickPlot,
  dragHandle,
  endHandleDrag,
  openView,
  press,
  redoView,
  setValue,
  undoView,
  viewStore,
  type ViewWindowState,
} from "../app/pluginViews";
import { useDoc } from "../app/session";
import { useStore } from "../app/store";
import { getPath, type ViewChoice, type ViewNode } from "../core/plugins/view";
import { makeScale, type Scale } from "../core/plot/scale";
import { linearTicks, logTicks } from "../core/plot/ticks";
import { Button, Checkbox, Select, TextInput } from "./controls";
import { ViewNodes } from "./ViewNodes";

/**
 * The window of a plugin's view (docs/design/plugin-views.md): the parts its
 * Python asked for, checked (src/core/plugins/view.ts), drawn with the app's
 * own controls. What is entered goes into the view's state at once and to
 * its Python as an event; buttons send commands or run the plugin's actions.
 */

const useView = <T,>(key: string, selector: (state: ViewWindowState) => T): T =>
  useStore(viewStore(key), selector);

const COLORS = [
  "#1f77b4",
  "#d62728",
  "#2ca02c",
  "#9467bd",
  "#ff7f0e",
  "#17becf",
  "#8c564b",
  "#e377c2",
];
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** A cell's value as text: text and numbers as they are, anything else as JSON. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Number(value.toPrecision(6)))
    : "";
}

export function PluginViewWindow({ viewKey }: { viewKey: string }) {
  const ui = useView(viewKey, (state) => state.ui);
  const error = useView(viewKey, (state) => state.error);
  const message = useView(viewKey, (state) => state.message);
  const busy = useView(viewKey, (state) => state.busy);
  useEffect(() => openView(viewKey), [viewKey]);
  return (
    <div
      className="flex h-full flex-col outline-none"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("input, select, textarea"))
          event.currentTarget.focus({ preventScroll: true });
      }}
      onClickCapture={(event) => {
        // A button that goes, or goes grey, when pressed (a row's ×) leaves the focus to
        // the page, and Ctrl+Z to the experiment: it comes back to the window.
        const root = event.currentTarget;
        requestAnimationFrame(() => {
          if (document.activeElement === document.body && root.isConnected)
            root.focus({ preventScroll: true });
        });
      }}
      onKeyDown={(event) => {
        const typing =
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement ||
          event.target instanceof HTMLTextAreaElement;
        const letter = event.key.toLowerCase();
        if (typing || !(event.metaKey || event.ctrlKey) || (letter !== "z" && letter !== "y"))
          return;
        event.preventDefault();
        event.stopPropagation();
        if (letter === "y" || event.shiftKey) redoView(viewKey);
        else undoView(viewKey);
      }}
    >
      <div className="min-h-0 flex-1 overflow-auto bg-paper p-2">
        {ui ? (
          <Part viewKey={viewKey} node={ui.body} />
        ) : (
          <div className="grid h-full place-items-center text-muted">
            {error ? "" : "Starting…"}
          </div>
        )}
      </div>
      <div
        role={error ? "alert" : undefined}
        className={`flex h-[22px] shrink-0 items-center gap-2 truncate border-t border-line bg-chrome px-2 text-[11px] ${error ? "text-danger" : "text-muted"}`}
        title={error ?? message ?? undefined}
      >
        {busy ? <span>Working…</span> : null}
        <span className="truncate">{error ?? message ?? ""}</span>
      </div>
    </div>
  );
}

function Part({ viewKey, node }: { viewKey: string; node: ViewNode }): ReactNode {
  switch (node.type) {
    case "column":
    case "row":
      return (
        <div
          className={`flex min-w-0 ${node.type === "row" ? "flex-row flex-wrap items-end" : "flex-col"}`}
          style={{ gap: node.gap }}
        >
          {node.children.map((child, index) => (
            <Part key={index} viewKey={viewKey} node={child} />
          ))}
        </div>
      );
    case "split":
      return (
        <div
          className={`flex min-w-0 gap-2 ${node.direction === "horizontal" ? "flex-row" : "flex-col"}`}
        >
          <div className="min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
            <Part viewKey={viewKey} node={node.children[0]} />
          </div>
          <div className="min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
            <Part viewKey={viewKey} node={node.children[1]} />
          </div>
        </div>
      );
    case "tabs":
      return <Tabs viewKey={viewKey} node={node} />;
    case "group":
      return (
        <fieldset className="min-w-0 rounded border border-line px-2 pb-2">
          {node.title ? <legend className="px-1 text-muted">{node.title}</legend> : null}
          <Part viewKey={viewKey} node={node.body} />
        </fieldset>
      );
    case "text":
      return (
        <p
          className={`selectable m-0 whitespace-pre-wrap ${node.mono ? "font-mono text-[11.5px]" : ""} ${
            node.tone === "muted"
              ? "text-muted"
              : node.tone === "danger"
                ? "text-danger"
                : node.tone === "success"
                  ? "text-[#1e7a3a]"
                  : ""
          }`}
        >
          {node.text}
        </p>
      );
    case "table":
      return <Table viewKey={viewKey} node={node} />;
    case "plot":
      return <Plot viewKey={viewKey} node={node} />;
    case "button":
      return <ViewButton viewKey={viewKey} node={node} />;
    case "nodes":
      return <ViewNodes viewKey={viewKey} node={node} />;
    default:
      return <Field viewKey={viewKey} node={node} />;
  }
}

function Tabs({ viewKey, node }: { viewKey: string; node: Extract<ViewNode, { type: "tabs" }> }) {
  const [open, setOpen] = useState(0);
  const shown = Math.min(open, node.tabs.length - 1);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex gap-0.5 border-b border-line">
        {node.tabs.map((tab, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={index === shown}
            className={`rounded-t border border-b-0 px-3 py-0.5 ${index === shown ? "border-line bg-paper font-medium" : "border-transparent text-muted hover:text-ink"}`}
            onClick={() => setOpen(index)}
          >
            {tab.title}
          </button>
        ))}
      </div>
      <div className="pt-2">
        <Part viewKey={viewKey} node={node.tabs[shown]!.body} />
      </div>
    </div>
  );
}

/** A field that commits when left or on Enter, as the app's dialogs do. */
function Draft({
  label,
  value,
  onCommit,
  className = "",
  placeholder,
  list,
  numeric,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  placeholder?: string;
  list?: string;
  numeric?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <TextInput
      aria-label={label}
      placeholder={placeholder}
      list={list}
      inputMode={numeric ? "decimal" : undefined}
      className={`${numeric ? "text-right" : ""} ${className}`}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        else if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

function choiceOf(choices: [string, ViewChoice][], value: string): ViewChoice | undefined {
  return choices.find(([, item]) => String(item) === value)?.[1];
}

function Field({
  viewKey,
  node,
}: {
  viewKey: string;
  node: Extract<ViewNode, { type: "number" | "string" | "choice" | "checkbox" | "wave" }>;
}) {
  const value = useView(viewKey, (state) => getPath(state.state, node.bind));
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const id = useMemo(() => `view-${Math.random().toString(36).slice(2)}`, []);
  const set = (next: unknown) => setValue(viewKey, node.bind, next);
  let control: ReactNode;
  switch (node.type) {
    case "number":
      control = (
        <span className="flex items-center gap-1">
          <Draft
            label={node.label || node.bind}
            value={formatNumber(value)}
            numeric
            className="w-24"
            onCommit={(text) => {
              let number = Number(text.trim());
              if (text.trim() === "" || !Number.isFinite(number)) return;
              if (node.min !== null) number = Math.max(node.min, number);
              if (node.max !== null) number = Math.min(node.max, number);
              set(number);
            }}
          />
          {node.unit ? <span className="text-muted">{node.unit}</span> : null}
        </span>
      );
      break;
    case "string":
      control = (
        <>
          <Draft
            label={node.label || node.bind}
            value={typeof value === "string" ? value : ""}
            placeholder={node.placeholder}
            list={node.suggestions.length > 0 ? id : undefined}
            className="w-56 font-mono"
            onCommit={set}
          />
          {node.suggestions.length > 0 ? (
            <datalist id={id}>
              {node.suggestions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          ) : null}
        </>
      );
      break;
    case "choice":
      control = (
        <Select
          aria-label={node.label || node.bind}
          value={value === undefined || value === null ? "" : String(value as ViewChoice)}
          onChange={(event) =>
            set(choiceOf(node.choices, event.target.value) ?? event.target.value)
          }
        >
          {node.choices.map(([title, item]) => (
            <option key={String(item)} value={String(item)}>
              {title}
            </option>
          ))}
        </Select>
      );
      break;
    case "checkbox":
      return (
        <Checkbox
          label={node.label}
          checked={value === true}
          onChange={(event) => set(event.target.checked)}
        />
      );
    default: {
      const numeric = order.filter((name) => {
        const wave = waves[name]!;
        return !wave.text && wave.shape.length === 1;
      });
      const chosen = typeof value === "string" ? value : "";
      control = (
        <Select
          aria-label={node.label || node.bind}
          value={chosen}
          onChange={(event) => set(event.target.value || null)}
        >
          <option value="">{node.optional ? "(none)" : "Choose a wave…"}</option>
          {chosen && !numeric.includes(chosen) ? (
            <option value={chosen}>{chosen} (missing)</option>
          ) : null}
          {numeric.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      );
    }
  }
  return (
    <label className="flex flex-col gap-0.5">
      {node.label ? <span className="text-[11px] text-muted">{node.label}</span> : null}
      {control}
    </label>
  );
}

function Table({ viewKey, node }: { viewKey: string; node: Extract<ViewNode, { type: "table" }> }) {
  const raw = useView(viewKey, (state) => getPath(state.state, node.bind));
  const rows = Array.isArray(raw) ? (raw as unknown[]).slice(0, 2000) : [];
  const record = (row: unknown) =>
    (row !== null && typeof row === "object" && !Array.isArray(row) ? row : {}) as Record<
      string,
      unknown
    >;
  return (
    <div className="min-w-0 overflow-auto">
      <table className="border-separate border-spacing-0 text-[11.5px]">
        <thead>
          <tr>
            {node.columns.map((column) => (
              <th
                key={column.key}
                className="border-b border-line bg-chrome px-2 py-0.5 text-left font-normal text-muted"
                style={column.width ? { width: column.width } : undefined}
              >
                {column.title}
              </th>
            ))}
            {node.remove ? <th className="border-b border-line bg-chrome" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {node.columns.map((column) => {
                const value = record(row)[column.key];
                const path = `${node.bind}.${index}.${column.key}`;
                const label = `${column.title} ${index + 1}`;
                let cell: ReactNode;
                if (!column.editable)
                  cell = (
                    <span
                      className={`selectable block px-1.5 ${column.type === "number" ? "text-right font-mono" : ""}`}
                    >
                      {column.type === "number"
                        ? formatNumber(value)
                        : column.type === "checkbox"
                          ? value
                            ? "✓"
                            : ""
                          : cellText(value)}
                    </span>
                  );
                else if (column.type === "checkbox")
                  cell = (
                    <input
                      type="checkbox"
                      aria-label={label}
                      className="accent-accent"
                      checked={value === true}
                      onChange={(event) => setValue(viewKey, path, event.target.checked)}
                    />
                  );
                else if (column.type === "choice")
                  cell = (
                    <Select
                      aria-label={label}
                      value={
                        value === undefined || value === null ? "" : String(value as ViewChoice)
                      }
                      onChange={(event) =>
                        setValue(
                          viewKey,
                          path,
                          choiceOf(column.choices, event.target.value) ?? event.target.value,
                        )
                      }
                    >
                      {column.choices.map(([title, item]) => (
                        <option key={String(item)} value={String(item)}>
                          {title}
                        </option>
                      ))}
                    </Select>
                  );
                else
                  cell = (
                    <Draft
                      label={label}
                      value={column.type === "number" ? formatNumber(value) : cellText(value)}
                      numeric={column.type === "number"}
                      className="w-full"
                      onCommit={(text) => {
                        if (column.type !== "number") return setValue(viewKey, path, text);
                        const number = Number(text.trim());
                        if (text.trim() === "") setValue(viewKey, path, null);
                        else if (Number.isFinite(number)) setValue(viewKey, path, number);
                      }}
                    />
                  );
                return (
                  <td key={column.key} className="px-0.5 py-px">
                    {cell}
                  </td>
                );
              })}
              {node.remove ? (
                <td className="px-0.5">
                  <button
                    type="button"
                    aria-label={`Remove row ${index + 1}`}
                    className="px-1 text-muted hover:text-danger"
                    onClick={() =>
                      setValue(
                        viewKey,
                        node.bind,
                        rows.filter((_, at) => at !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {node.add ? (
        <Button className="mt-1" onClick={() => setValue(viewKey, node.bind, [...rows, {}])}>
          Add Row
        </Button>
      ) : null}
    </div>
  );
}

function ViewButton({
  viewKey,
  node,
}: {
  viewKey: string;
  node: Extract<ViewNode, { type: "button" }>;
}) {
  const busy = useView(viewKey, (state) => state.busy);
  return (
    <Button
      primary={node.primary}
      disabled={node.disabled || (busy && node.action !== null)}
      title={node.action ? `Runs ${node.action}, kept in the history` : undefined}
      onClick={() => void press(viewKey, node)}
    >
      {node.label}
    </Button>
  );
}

// --- Plots --------------------------------------------------------------------------------------

const MARGIN = { left: 58, right: 12, top: 10, bottom: 34 };

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "−": "⁻",
  "-": "⁻",
};

/** A tick label's markup (10^{3}) as plain text (10³). */
const plainTick = (label: string): string =>
  label.replace(/\^\{([^}]*)\}/g, (_, power: string) =>
    power.replace(/./g, (char) => SUPERSCRIPT[char] ?? char),
  );

function extent(values: ArrayLike<number>[], log: boolean): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const list of values)
    for (let i = 0; i < list.length; i += 1) {
      const value = list[i]!;
      if (!Number.isFinite(value) || (log && !(value > 0))) continue;
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
  if (!(hi >= lo)) return null;
  if (hi === lo) return log ? [lo / 2, hi * 2] : [lo - 1, hi + 1];
  if (log) return [lo / 1.15, hi * 1.15];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

type PlotNode = Extract<ViewNode, { type: "plot" }>;

interface PlotLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The scales, or null when there is nothing to draw. */
  xs: Scale | null;
  ys: Scale | null;
}

interface DrawnSeries {
  xs: Float64Array;
  ys: Float64Array;
  mode: string;
  color: string | null;
  label: string;
}

/** Where a plot's frame is, and its scales, from what it draws. */
function plotLayout(
  node: PlotNode,
  series: DrawnSeries[],
  width: number,
  height: number,
): PlotLayout {
  const left = MARGIN.left;
  const right = width - MARGIN.right;
  const top = MARGIN.top;
  const bottom = height - MARGIN.bottom;
  // The handles count too: a range marker beyond the data is still in view.
  const hx = node.handles.flatMap((handle) => (handle.x === null ? [] : [handle.x]));
  const hy = node.handles.flatMap((handle) => (handle.y === null ? [] : [handle.y]));
  let xr = extent([...series.map((item) => item.xs), hx], node.xLog);
  let yr = extent([...series.map((item) => item.ys), hy], node.yLog);
  if (!xr || !yr) return { left, right, top, bottom, xs: null, ys: null };
  if (node.equal && !node.xLog && !node.yLog) {
    // One unit as long across as up: the range of the shorter side grows.
    const perX = (xr[1] - xr[0]) / (right - left);
    const perY = (yr[1] - yr[0]) / (bottom - top);
    if (perX > perY) {
      const grow = (perX * (bottom - top) - (yr[1] - yr[0])) / 2;
      yr = [yr[0] - grow, yr[1] + grow];
    } else {
      const grow = (perY * (right - left) - (xr[1] - xr[0])) / 2;
      xr = [xr[0] - grow, xr[1] + grow];
    }
  }
  const xs = node.xReverse
    ? makeScale(xr[1], xr[0], node.xLog, left, right)
    : makeScale(xr[0], xr[1], node.xLog, left, right);
  const ys = makeScale(yr[0], yr[1], node.yLog, bottom, top);
  return { left, right, top, bottom, xs, ys };
}

/** How near, in pixels, the pointer has to be to pick up a handle. */
const REACH = 7;

/** The handle under a point of the plot, the nearest; only those that can be dragged. */
function handleAt(node: PlotNode, layout: PlotLayout, px: number, py: number): number | null {
  const { xs, ys } = layout;
  if (!xs || !ys) return null;
  let best: number | null = null;
  let nearest = REACH;
  node.handles.forEach((handle, index) => {
    if (handle.bindX === null && handle.bindY === null) return;
    const dx = handle.x === null ? 0 : Math.abs(xs.toPixel(handle.x) - px);
    const dy = handle.y === null ? 0 : Math.abs(ys.toPixel(handle.y) - py);
    const distance = Math.hypot(dx, dy);
    if (distance <= nearest) {
      nearest = distance;
      best = index;
    }
  });
  return best;
}

/** A position moved from `from` to `to` on an axis, applied to `value`: by the difference, or the ratio on a log axis. */
const moved = (value: number, from: number, to: number, log: boolean): number =>
  log ? value * (to / from) : value + (to - from);

interface Drag {
  index: number;
  /** Where the pointer went down, in the plot's units. */
  startX: number;
  startY: number;
  /** The bound values when it was picked up. */
  valueX: number | null;
  valueY: number | null;
  /** Where the handle was when it was picked up: the view may move it before it is let go. */
  fromX: number | null;
  fromY: number | null;
  /** Where the handle is drawn while it is dragged. */
  x: number | null;
  y: number | null;
}

function Plot({ viewKey, node }: { viewKey: string; node: PlotNode }) {
  const arrays = useView(viewKey, (state) => state.arrays);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(400);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState("default");
  /** The layout kept while a handle is dragged, so the plot does not rescale under the pointer. */
  const frozen = useRef<PlotLayout | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const height = node.height;
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const series = node.series.map((item) => {
    const y = arrays[item.y] ?? new Float64Array(0);
    const x = item.x ? (arrays[item.x] ?? new Float64Array(0)) : Float64Array.from(y, (_, i) => i);
    return { ...item, xs: x, ys: y };
  });
  const layout = frozen.current ?? plotLayout(node, series, width, height);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawPlot(ctx, node, series, layout);
    drawHandles(ctx, node, layout, drag);
  });
  const local = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };
  const draggable = node.handles.some((handle) => handle.bindX !== null || handle.bindY !== null);
  const label = `Plot of ${node.series.map((item) => item.label || item.y).join(", ")}`;
  return (
    <div ref={box} className="min-w-0">
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        aria-description={
          draggable || node.onClick
            ? [
                draggable ? "Its handles can be dragged." : "",
                node.onClick ? "Click it to add at that place." : "",
              ]
                .filter(Boolean)
                .join(" ")
            : undefined
        }
        className="block touch-none rounded border border-line-soft bg-paper"
        style={{ width, height, cursor }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !layout.xs || !layout.ys) return;
          const { px, py } = local(event);
          const index = handleAt(node, layout, px, py);
          if (index === null) {
            press.current = { x: px, y: py };
            return;
          }
          const handle = node.handles[index]!;
          event.currentTarget.setPointerCapture(event.pointerId);
          const state = viewStore(viewKey).get().state;
          const value = (path: string | null) => {
            const given = path === null ? undefined : getPath(state, path);
            return typeof given === "number" && Number.isFinite(given) ? given : null;
          };
          frozen.current = layout;
          beginHandleDrag(viewKey);
          setDrag({
            index,
            startX: layout.xs.toValue(px),
            startY: layout.ys.toValue(py),
            valueX: value(handle.bindX),
            valueY: value(handle.bindY),
            fromX: handle.x,
            fromY: handle.y,
            x: handle.x,
            y: handle.y,
          });
        }}
        onPointerMove={(event) => {
          const { px, py } = local(event);
          if (!drag) {
            const index = layout.xs ? handleAt(node, layout, px, py) : null;
            const handle = index === null ? null : node.handles[index]!;
            setCursor(
              !handle
                ? node.onClick
                  ? "crosshair"
                  : "default"
                : handle.bindX !== null && handle.bindY !== null
                  ? "move"
                  : handle.bindX !== null
                    ? "ew-resize"
                    : "ns-resize",
            );
            return;
          }
          const { xs, ys } = frozen.current!;
          const handle = node.handles[drag.index]!;
          const toX = xs!.toValue(px);
          const toY = ys!.toValue(py);
          const values: Record<string, number> = {};
          let { x, y } = drag;
          if (handle.bindX !== null && drag.fromX !== null && Number.isFinite(toX)) {
            x = moved(drag.fromX, drag.startX, toX, node.xLog);
            if (drag.valueX !== null)
              values[handle.bindX] = moved(drag.valueX, drag.startX, toX, node.xLog);
          }
          if (handle.bindY !== null && drag.fromY !== null && Number.isFinite(toY)) {
            y = moved(drag.fromY, drag.startY, toY, node.yLog);
            if (drag.valueY !== null)
              values[handle.bindY] = moved(drag.valueY, drag.startY, toY, node.yLog);
          }
          setDrag({ ...drag, x, y });
          if (Object.keys(values).length > 0) dragHandle(viewKey, values);
        }}
        onPointerUp={(event) => {
          if (drag) {
            frozen.current = null;
            setDrag(null);
            endHandleDrag(viewKey);
            return;
          }
          const start = press.current;
          press.current = null;
          const { px, py } = local(event);
          const { xs, ys, left, right, top, bottom } = layout;
          if (
            !node.onClick ||
            !start ||
            !xs ||
            !ys ||
            Math.hypot(px - start.x, py - start.y) > 3 ||
            px < left ||
            px > right ||
            py < top ||
            py > bottom
          )
            return;
          clickPlot(viewKey, node.onClick, xs.toValue(px), ys.toValue(py));
        }}
        onPointerCancel={() => {
          press.current = null;
          if (!drag) return;
          frozen.current = null;
          setDrag(null);
          endHandleDrag(viewKey);
        }}
      />
    </div>
  );
}

function drawPlot(
  ctx: CanvasRenderingContext2D,
  node: PlotNode,
  series: DrawnSeries[],
  layout: PlotLayout,
): void {
  const { left, right, top, bottom, xs, ys } = layout;
  ctx.font = `11px ${FONT}`;
  ctx.strokeStyle = "#69717d";
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, right - left, bottom - top);
  if (!xs || !ys) {
    ctx.fillStyle = "#69717d";
    ctx.textAlign = "center";
    ctx.fillText("Nothing to draw yet", (left + right) / 2, (top + bottom) / 2);
    return;
  }
  const xr = [Math.min(xs.min, xs.max), Math.max(xs.min, xs.max)] as const;
  const yr = [ys.min, ys.max] as const;
  const ticks = (lo: number, hi: number, log: boolean, count: number) =>
    log ? logTicks(lo, hi, count) : linearTicks(lo, hi, count, false);
  ctx.fillStyle = "#1c2026";
  const xt = ticks(xr[0], xr[1], node.xLog, Math.max(2, (right - left) / 70));
  ctx.textAlign = "center";
  for (const tick of xt.major) {
    const px = Math.round(xs.toPixel(tick.value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, bottom);
    ctx.lineTo(px, bottom + 4);
    ctx.stroke();
    if (tick.label) ctx.fillText(plainTick(tick.label), px, bottom + 15);
  }
  const xSuffix = xt.exponent ? ` (×10^${xt.exponent})` : "";
  if (node.xLabel || xSuffix)
    ctx.fillText(`${node.xLabel}${xSuffix}`, (left + right) / 2, bottom + 29);
  const yt = ticks(yr[0], yr[1], node.yLog, Math.max(2, (bottom - top) / 36));
  ctx.textAlign = "right";
  for (const tick of yt.major) {
    const py = Math.round(ys.toPixel(tick.value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left - 4, py);
    ctx.lineTo(left, py);
    ctx.stroke();
    if (tick.label) ctx.fillText(plainTick(tick.label), left - 6, py + 3.5);
  }
  const ySuffix = yt.exponent ? ` (×10^${yt.exponent})` : "";
  if (node.yLabel || ySuffix) {
    ctx.save();
    ctx.translate(12, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(`${node.yLabel}${ySuffix}`, 0, 0);
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  series.forEach((item, index) => {
    const color = item.color ?? COLORS[index % COLORS.length]!;
    const count = Math.min(item.xs.length, item.ys.length);
    const ok = (i: number) =>
      Number.isFinite(item.xs[i]) &&
      Number.isFinite(item.ys[i]) &&
      (!node.xLog || item.xs[i]! > 0) &&
      (!node.yLog || item.ys[i]! > 0);
    if (item.mode !== "markers") {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < count; i += 1) {
        if (!ok(i)) {
          started = false;
          continue;
        }
        const px = xs.toPixel(item.xs[i]!);
        const py = ys.toPixel(item.ys[i]!);
        if (started) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        started = true;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (item.mode !== "lines") {
      ctx.fillStyle = color;
      for (let i = 0; i < count; i += 1) {
        if (!ok(i)) continue;
        ctx.beginPath();
        ctx.arc(xs.toPixel(item.xs[i]!), ys.toPixel(item.ys[i]!), 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  });
  ctx.restore();
  // A legend of the series with labels, at the top right.
  const labelled = series.map((item, index) => ({ ...item, index })).filter((item) => item.label);
  ctx.textAlign = "left";
  labelled.forEach((item, row) => {
    const y = top + 14 + row * 14;
    const x =
      right - 8 - Math.max(...labelled.map((each) => ctx.measureText(each.label).width)) - 22;
    ctx.fillStyle = item.color ?? COLORS[item.index % COLORS.length]!;
    ctx.fillRect(x, y - 5, 14, 2.5);
    ctx.fillStyle = "#1c2026";
    ctx.fillText(item.label, x + 18, y);
  });
}

/** The handles over the plot: a ring at a point, a dashed line across it with a grip. */
function drawHandles(
  ctx: CanvasRenderingContext2D,
  node: PlotNode,
  layout: PlotLayout,
  drag: Drag | null,
): void {
  const { left, right, top, bottom, xs, ys } = layout;
  if (!xs || !ys) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  ctx.font = `11px ${FONT}`;
  node.handles.forEach((handle, index) => {
    const x = drag?.index === index ? drag.x : handle.x;
    const y = drag?.index === index ? drag.y : handle.y;
    const color = handle.color ?? "#1f6fd1";
    const fixed = handle.bindX === null && handle.bindY === null;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = drag?.index === index ? 2 : 1.25;
    if (x !== null && y !== null) {
      const px = xs.toPixel(x);
      const py = ys.toPixel(y);
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
      if (handle.label) {
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(handle.label, px, py - 8);
      }
      return;
    }
    ctx.setLineDash(fixed ? [2, 3] : [5, 3]);
    ctx.beginPath();
    if (x !== null) {
      const px = Math.round(xs.toPixel(x)) + 0.5;
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!fixed) ctx.fillRect(px - 3, top, 6, 9);
      if (handle.label) {
        ctx.textAlign = "left";
        ctx.fillText(handle.label, px + 5, top + 20);
      }
    } else if (y !== null) {
      const py = Math.round(ys.toPixel(y)) + 0.5;
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!fixed) ctx.fillRect(right - 9, py - 3, 9, 6);
      if (handle.label) {
        ctx.textAlign = "right";
        ctx.fillText(handle.label, right - 12, py - 4);
      }
    }
    ctx.setLineDash([]);
  });
  ctx.restore();
}

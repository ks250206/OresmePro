import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  LETTERS,
  addItemAt,
  beginDrag,
  chooseData,
  dragSetup,
  editItem,
  editSetup,
  editorStore,
  findEditor,
  interpolate,
  redo,
  removeItem,
  requestPreview,
  runFit,
  undo,
  type EditorContext,
  type EditorPreview,
  type EditorReport,
  type EditorSetup,
  type EditorState,
} from "../app/pluginEditors";
import { pluginStore, useDoc } from "../app/session";
import { useStore } from "../app/store";
import type { JsonValue, ParamSpec } from "../core/actions";
import type { EditorField } from "../core/plugins/editor";
import { makeScale, type Scale } from "../core/plot/scale";
import { linearTicks } from "../core/plot/ticks";
import { Button, Checkbox, Select, TextInput } from "./controls";

/**
 * A plugin's model editor: a window the app draws from the plugin's
 * description of it (src/core/plugins/editor.ts), in the way of CasaXPS. The
 * data are drawn with the range fitted, its background, each item, the sum
 * and the residual, as the plugin's preview computes them; the range's ends
 * and the items are dragged on it; the items are a table with a column for
 * each (their fields, and the constraint of each). Fit runs the plugin's fit,
 * which is recorded in the history and kept among the results, and takes
 * what it finds back into the table. No code of the plugin runs here.
 */

const COLORS = [
  "#1f77b4",
  "#2ca02c",
  "#9467bd",
  "#ff7f0e",
  "#17becf",
  "#e377c2",
  "#8c564b",
  "#bcbd22",
];
const colorOf = (index: number) => COLORS[index % COLORS.length]!;
const FIT = "#d62728";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** A number as the table shows it: six significant digits, no trailing zeros. */
function formatNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toPrecision(digits)));
}

const useEditor = <T,>(key: string, selector: (state: EditorState) => T): T =>
  useStore(editorStore(key), selector);

export function PluginEditorWindow({ tool }: { tool: string }) {
  const key = tool.slice("editor:".length);
  const installed = useSyncExternalStore(pluginStore.subscribe, pluginStore.list);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the plugins installed stand for the editor
  const context = useMemo(() => findEditor(key), [key, installed]);
  const setup = useEditor(key, (state) => state.setup);
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const datas = order.filter((name) => {
    const wave = waves[name]!;
    return !wave.text && wave.shape.length === 1;
  });
  useEffect(() => {
    if (typeof context !== "string" && !editorStore(key).get().setup && datas[0])
      chooseData(context, datas[0]);
  }, [context, key, datas]);
  if (typeof context === "string")
    return (
      <div className="grid h-full place-items-center p-4 text-center text-muted">{context}</div>
    );
  if (!setup)
    return (
      <div className="grid h-full place-items-center p-4 text-center text-muted">
        Load or make the data (a 1-D wave) to fit.
      </div>
    );
  return <Editor context={context} setup={setup} datas={datas} />;
}

function Editor({
  context,
  setup,
  datas,
}: {
  context: EditorContext;
  setup: EditorSetup;
  datas: string[];
}) {
  const { key, spec } = context;
  const selected = useEditor(key, (state) => state.selected);
  const preview = useEditor(key, (state) => state.preview);
  const dataRev = useDoc((state) => state.waves[setup.data]?.rev);
  const xRev = useDoc((state) => (setup.x ? state.waves[setup.x]?.rev : undefined));
  const [tab, setTab] = useState<"items" | "settings" | "report">("items");
  // What is drawn follows the setup and the data: the plugin is asked again when either changes.
  useEffect(() => requestPreview(key), [key, setup, dataRev, xRev]);
  const deleteSelected = () => {
    if (selected < 0) return;
    editSetup(key, (current) => ({
      ...current,
      items: removeItem(current.items, selected, preview?.itemValues ?? []),
    }));
    const count = editorStore(key).get().setup?.items.length ?? 0;
    editorStore(key).set({ selected: Math.min(selected, count - 1) });
  };
  return (
    <div
      className="flex h-full flex-col outline-none"
      // Clicks on the plot or the buttons keep the keys in the window: its own undo, Delete.
      tabIndex={-1}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("input, select, textarea"))
          event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        const typing =
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement ||
          event.target instanceof HTMLTextAreaElement;
        if (typing) return;
        const mod = event.metaKey || event.ctrlKey;
        const letter = event.key.toLowerCase();
        if (mod && (letter === "z" || letter === "y")) {
          event.preventDefault();
          event.stopPropagation();
          if (letter === "y" || event.shiftKey) redo(key);
          else undo(key);
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          deleteSelected();
        }
      }}
    >
      <Toolbar context={context} setup={setup} datas={datas} />
      <Plot key={setup.data} context={context} setup={setup} selected={selected} />
      <div className="flex shrink-0 items-center gap-0.5 border-y border-line bg-chrome px-2 pt-1">
        {(
          [
            ["items", `${spec.items.title}s`],
            ["settings", "Settings"],
            ["report", "Report"],
          ] as const
        ).map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={`rounded-t border border-b-0 px-3 py-0.5 ${tab === name ? "border-line bg-paper font-medium" : "border-transparent text-muted hover:text-ink"}`}
            onClick={() => setTab(name)}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <FitButton context={context} setup={setup} />
      </div>
      <div className="h-[212px] shrink-0 overflow-auto bg-paper">
        {tab === "items" ? (
          <ItemsTab context={context} setup={setup} selected={selected} onDelete={deleteSelected} />
        ) : tab === "settings" ? (
          <SettingsTab context={context} setup={setup} />
        ) : (
          <ReportTab context={context} />
        )}
      </div>
      <StatusLine context={context} />
    </div>
  );
}

// --- Toolbar --------------------------------------------------------------------------------------

function Toolbar({
  context,
  setup,
  datas,
}: {
  context: EditorContext;
  setup: EditorSetup;
  datas: string[];
}) {
  const { key, spec, fit } = context;
  const waves = useDoc((state) => state.waves);
  const canUndo = useEditor(key, (state) => state.past.length > 0);
  const canRedo = useEditor(key, (state) => state.future.length > 0);
  const length = waves[setup.data]?.data.length ?? 0;
  const xChoices = datas.filter(
    (name) => name !== setup.data && waves[name]!.data.length === length,
  );
  const dataTitle = fit.params[spec.data]?.title ?? spec.data;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-2 py-1">
      <label className="flex items-center gap-1">
        <span className="text-muted">{dataTitle}</span>
        <Select
          aria-label={dataTitle}
          value={setup.data}
          onChange={(event) => chooseData(context, event.target.value)}
        >
          {datas.includes(setup.data) ? null : <option>{setup.data}</option>}
          {datas.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      </label>
      {spec.x ? (
        <label className="flex items-center gap-1">
          <span className="text-muted">{fit.params[spec.x]?.title ?? spec.x}</span>
          <Select
            aria-label={fit.params[spec.x]?.title ?? spec.x}
            value={setup.x ?? ""}
            onChange={(event) =>
              editSetup(key, (current) => ({
                ...current,
                x: event.target.value || null,
                range: null,
              }))
            }
          >
            <option value="">X scaling</option>
            {xChoices.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </Select>
        </label>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">
        {context.plugin.manifest.title} {context.plugin.manifest.version}
      </span>
      <Button
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={() => undo(key)}
        className="px-2"
      >
        ↶
      </Button>
      <Button
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={() => redo(key)}
        className="px-2"
      >
        ↷
      </Button>
    </div>
  );
}

function FitButton({ context, setup }: { context: EditorContext; setup: EditorSetup }) {
  const busy = useEditor(context.key, (state) => state.busy);
  return (
    <span className="flex items-center gap-1.5 pb-1">
      {busy ? <span className="text-muted">Fitting…</span> : null}
      <Button
        primary
        disabled={busy || setup.items.length === 0}
        title={`Runs ${context.fit.title}, kept in the history and among the results`}
        onClick={() => void runFit(context)}
      >
        Fit {context.spec.items.title}s
      </Button>
    </span>
  );
}

// --- Inputs that commit when left ---------------------------------------------------------------

function DraftInput({
  label,
  value,
  onCommit,
  className = "",
  invalid,
  title,
  placeholder,
  list,
  disabled,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
  className?: string;
  invalid?: boolean;
  title?: string;
  placeholder?: string;
  list?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <TextInput
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={title}
      placeholder={placeholder}
      list={list}
      disabled={disabled}
      className={`${className} ${invalid ? "border-danger! text-danger" : ""}`}
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

function NumberInput({
  label,
  value,
  onCommit,
  className,
  disabled,
  title,
  invalid,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  invalid?: boolean;
}) {
  return (
    <DraftInput
      label={label}
      value={formatNumber(value)}
      className={`text-right ${className ?? ""}`}
      disabled={disabled}
      title={title}
      invalid={invalid}
      onCommit={(text) => {
        const number = Number(text.trim());
        if (text.trim() !== "" && Number.isFinite(number)) onCommit(number);
      }}
    />
  );
}

// --- The plot --------------------------------------------------------------------------------------

type Drag =
  | { kind: "range"; end: 0 | 1 }
  | { kind: "top"; index: number; amount: number; height: number; base: number }
  | { kind: "width"; index: number; amount: number; width: number }
  | null;

interface Geometry {
  xs: Scale;
  ys: Scale;
  rs: Scale;
  left: number;
  right: number;
  top: number;
  mainTop: number;
  bottom: number;
  resBottom: number;
}

const MARGIN = { left: 60, right: 14, top: 8, bottom: 32 };

/** The ends of the range fitted, as the preview drew it. */
function rangeOf(preview: EditorPreview | null): [number, number] | null {
  if (!preview || preview.x.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of preview.x)
    if (Number.isFinite(value)) [lo, hi] = [Math.min(lo, value), Math.max(hi, value)];
  return hi > lo ? [lo, hi] : null;
}

function Plot({
  context,
  setup,
  selected,
}: {
  context: EditorContext;
  setup: EditorSetup;
  selected: number;
}) {
  const { key, spec } = context;
  const preview = useEditor(key, (state) => state.preview);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 600, height: 300 });
  const [view, setView] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<Drag>(null);
  const [dragging, setDragging] = useState<Drag>(null);
  const [frozen, setFrozen] = useState<Geometry | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const computed = useMemo((): Geometry | null => {
    if (!preview) return null;
    const xAll = preview.allX ?? preview.x;
    const yAll = preview.allY ?? preview.data ?? new Float64Array(0);
    let full: [number, number] = [Infinity, -Infinity];
    for (let i = 0; i < xAll.length; i += 1)
      if (Number.isFinite(xAll[i]) && Number.isFinite(yAll[i]))
        full = [Math.min(full[0], xAll[i]!), Math.max(full[1], xAll[i]!)];
    if (!(full[1] > full[0])) return null;
    let range: [number, number] = full;
    const fitted = rangeOf(preview);
    if (view) range = view;
    else if (fitted) {
      const pad = (fitted[1] - fitted[0]) * 0.08;
      range = [Math.max(full[0], fitted[0] - pad), Math.min(full[1], fitted[1] + pad)];
    }
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let i = 0; i < xAll.length; i += 1) {
      if (!(xAll[i]! >= range[0] && xAll[i]! <= range[1]) || !Number.isFinite(yAll[i])) continue;
      ymin = Math.min(ymin, yAll[i]!);
      ymax = Math.max(ymax, yAll[i]!);
    }
    for (const series of [preview.background, preview.fit])
      if (series)
        for (const value of series)
          if (Number.isFinite(value)) [ymin, ymax] = [Math.min(ymin, value), Math.max(ymax, value)];
    let rmax = 0;
    if (preview.residual)
      for (const value of preview.residual)
        if (Number.isFinite(value)) rmax = Math.max(rmax, Math.abs(value));
    if (!(ymax > ymin)) [ymin, ymax] = [ymin - 1, ymax + 1];
    const pad = (ymax - ymin) * 0.05;
    const left = MARGIN.left;
    const right = size.width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = size.height - MARGIN.bottom;
    const height = Math.max(40, bottom - top);
    const resBottom = top + Math.round(height * 0.18);
    const mainTop = resBottom + 8;
    rmax = rmax > 0 ? rmax * 1.15 : 1;
    return {
      xs: spec.axis.reverse
        ? makeScale(range[1], range[0], false, left, right)
        : makeScale(range[0], range[1], false, left, right),
      ys: makeScale(ymin - pad, ymax + pad, false, bottom, mainTop),
      rs: makeScale(-rmax, rmax, false, resBottom, top),
      left,
      right,
      top,
      mainTop,
      bottom,
      resBottom,
    };
  }, [preview, view, size, spec.axis.reverse]);
  // While something is dragged the scales stand still, or what is dragged would run from the mouse.
  const geometry = frozen ?? computed;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * ratio);
    element.height = Math.round(size.height * ratio);
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (geometry && preview) draw(ctx, geometry, context, setup, preview, selected, hover);
  }, [geometry, size, context, setup, preview, selected, hover]);

  const widthKey = spec.items.width;
  const tied = (index: number, field: string | null) =>
    field !== null && (preview?.itemValues[index]?.tied.includes(field) ?? false);

  /** What is under the pointer: a handle to drag, an item to select, or nothing. */
  const hitTest = (px: number, py: number): Drag | { kind: "select"; index: number } | null => {
    if (!geometry || !preview) return null;
    const { xs, ys } = geometry;
    const peaks = preview.itemValues;
    const selectedPeak = peaks[selected]?.peak;
    const selectedWidth = widthKey ? peaks[selected]?.values[widthKey] : undefined;
    if (selectedPeak && selectedWidth !== undefined) {
      const [position, topValue, base] = selectedPeak;
      const half = ys.toPixel((topValue + base) / 2);
      for (const side of [-1, 1]) {
        const hx = xs.toPixel(position + (side * selectedWidth) / 2);
        if (Math.abs(px - hx) <= 6 && Math.abs(py - half) <= 6) {
          const amount = spec.items.amount ? setup.items[selected]?.values[spec.items.amount] : 0;
          return {
            kind: "width",
            index: selected,
            amount: typeof amount === "number" ? amount : 0,
            width: selectedWidth,
          };
        }
      }
    }
    for (let index = Math.min(peaks.length, setup.items.length) - 1; index >= 0; index -= 1) {
      const peak = peaks[index]?.peak;
      if (!peak) continue;
      if (Math.abs(px - xs.toPixel(peak[0])) <= 6 && Math.abs(py - ys.toPixel(peak[1])) <= 6) {
        const amount = spec.items.amount ? setup.items[index]?.values[spec.items.amount] : 0;
        return {
          kind: "top",
          index,
          amount: typeof amount === "number" ? amount : 0,
          height: peak[1] - peak[2],
          base: peak[2],
        };
      }
    }
    const ends = spec.range ? rangeOf(preview) : null;
    if (ends) {
      for (const end of [0, 1] as const) {
        if (
          Math.abs(px - xs.toPixel(ends[end])) <= 5 &&
          py >= geometry.mainTop &&
          py <= geometry.bottom
        )
          return { kind: "range", end };
      }
    }
    const at = xs.toValue(px);
    let best = -1;
    let distance = 7;
    preview.items.forEach((part, index) => {
      if (!part) return;
      const bg = preview.background ? interpolate(preview.x, preview.background, at) : 0;
      const gap = Math.abs(ys.toPixel(bg + interpolate(preview.x, part, at)) - py);
      if (gap < distance) {
        distance = gap;
        best = index;
      }
    });
    return best >= 0 ? { kind: "select", index: best } : null;
  };

  const point = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const setItem = (index: number, change: Record<string, number>) =>
    dragSetup(key, (current) => ({
      ...current,
      items: current.items.map((item, at) =>
        at === index ? { ...item, values: { ...item.values, ...change } } : item,
      ),
    }));

  const onDragMove = (px: number, py: number) => {
    const current = drag.current;
    if (!current || !geometry || !preview) return;
    const value = geometry.xs.toValue(px);
    if (current.kind === "range") {
      const ends = rangeOf(preview);
      if (!ends) return;
      const next: [number, number] = [...ends];
      next[current.end] = value;
      dragSetup(key, (setupNow) => ({ ...setupNow, range: next }));
      return;
    }
    const { position, amount } = spec.items;
    const change: Record<string, number> = {};
    if (current.kind === "top") {
      if (!tied(current.index, position)) change[position] = value;
      if (amount && !tied(current.index, amount) && current.height > 0) {
        const height = Math.max(geometry.ys.toValue(py) - current.base, current.height * 1e-3);
        change[amount] = (current.amount * height) / current.height;
      }
    } else if (widthKey && !tied(current.index, widthKey)) {
      const centre = preview.itemValues[current.index]?.values[position];
      if (centre === undefined) return;
      const least = spec.items.fields.find((field) => field.key === widthKey)?.min ?? 0;
      const width = Math.max(least, 1e-6, 2 * Math.abs(value - centre));
      change[widthKey] = width;
      // The height stays: the amount grows with the width.
      if (amount && !tied(current.index, amount) && current.width > 0)
        change[amount] = (current.amount * width) / current.width;
    }
    if (Object.keys(change).length > 0) setItem(current.index, change);
  };

  const hovered = hover && !dragging ? hitTest(hover.x, hover.y) : null;
  const cursor =
    dragging?.kind === "top" || hovered?.kind === "top"
      ? "move"
      : dragging || hovered?.kind === "width" || hovered?.kind === "range"
        ? "ew-resize"
        : hovered?.kind === "select"
          ? "pointer"
          : "crosshair";
  const end = () => {
    // After dragging an end of the range, the plot keeps showing what it showed.
    if (drag.current?.kind === "range" && !view && frozen)
      setView([Math.min(frozen.xs.min, frozen.xs.max), Math.max(frozen.xs.min, frozen.xs.max)]);
    drag.current = null;
    setDragging(null);
    setFrozen(null);
  };

  return (
    <div ref={box} className="relative min-h-[180px] flex-1 overflow-hidden bg-paper">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${spec.title}: data and model`}
        className="block"
        style={{ width: size.width, height: size.height, cursor }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const { x, y } = point(event);
          const hit = hitTest(x, y);
          if (!hit) return;
          if (hit.kind === "select") {
            editorStore(key).set({ selected: hit.index });
            return;
          }
          if (hit.kind !== "range") editorStore(key).set({ selected: hit.index });
          event.currentTarget.setPointerCapture(event.pointerId);
          beginDrag(key);
          drag.current = hit;
          setDragging(hit);
          setFrozen(computed);
        }}
        onPointerMove={(event) => {
          const { x, y } = point(event);
          setHover({ x, y });
          onDragMove(x, y);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(event) => {
          if (!geometry) return;
          const { x, y } = point(event);
          if (y < geometry.mainTop || x < geometry.left || x > geometry.right) return;
          addItemAt(context, geometry.xs.toValue(x));
        }}
        onWheel={(event) => {
          if (!geometry) return;
          const { x } = point(event);
          const at = geometry.xs.toValue(x);
          const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
          const lo = Math.min(geometry.xs.min, geometry.xs.max);
          const hi = Math.max(geometry.xs.min, geometry.xs.max);
          setView([at - (at - lo) * factor, at + (hi - at) * factor]);
        }}
      />
      <div className="absolute right-3 top-2 flex items-center gap-1.5 text-[11px]">
        {hover && geometry && hover.y >= geometry.mainTop && hover.x >= geometry.left ? (
          <span className="rounded bg-paper/90 px-1 font-mono text-muted">
            x {formatNumber(geometry.xs.toValue(hover.x), 5)} · y{" "}
            {formatNumber(geometry.ys.toValue(hover.y), 4)}
          </span>
        ) : null}
        <button
          type="button"
          className="rounded border border-line bg-chrome/90 px-1.5 text-muted hover:text-ink"
          title="Show the range fitted (the mouse wheel zooms)"
          onClick={() => setView(null)}
        >
          Range
        </button>
        <button
          type="button"
          className="rounded border border-line bg-chrome/90 px-1.5 text-muted hover:text-ink"
          title="Show all of the data"
          onClick={() => {
            const xAll = preview?.allX ?? preview?.x;
            if (!xAll) return;
            let lo = Infinity;
            let hi = -Infinity;
            for (const value of xAll)
              if (Number.isFinite(value)) [lo, hi] = [Math.min(lo, value), Math.max(hi, value)];
            if (hi > lo) setView([lo, hi]);
          }}
        >
          All
        </button>
      </div>
      {!preview ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-muted">
          Drawing…
        </div>
      ) : null}
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  context: EditorContext,
  setup: EditorSetup,
  preview: EditorPreview,
  selected: number,
  hover: { x: number; y: number } | null,
): void {
  const { spec } = context;
  const { xs, ys, rs, left, right, top, mainTop, bottom, resBottom } = g;
  ctx.font = `11px ${FONT}`;
  const line = (
    xValues: ArrayLike<number>,
    yValues: ArrayLike<number>,
    scale: Scale,
    color: string,
    width: number,
    dash: number[] = [],
  ) => {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < xValues.length; i += 1) {
      const value = yValues[i]!;
      if (!Number.isFinite(value) || !Number.isFinite(xValues[i])) {
        started = false;
        continue;
      }
      const px = xs.toPixel(xValues[i]!);
      const py = scale.toPixel(value);
      if (started) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      started = true;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Frames, ticks and labels.
  ctx.fillStyle = "#1c2026";
  ctx.strokeStyle = "#69717d";
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, mainTop + 0.5, right - left, bottom - mainTop);
  ctx.strokeRect(left + 0.5, top + 0.5, right - left, resBottom - top);
  const xTicks = linearTicks(
    Math.min(xs.min, xs.max),
    Math.max(xs.min, xs.max),
    Math.max(2, (right - left) / 70),
    false,
  );
  ctx.textAlign = "center";
  for (const tick of xTicks.major) {
    const px = Math.round(xs.toPixel(tick.value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, bottom);
    ctx.lineTo(px, bottom + 4);
    ctx.stroke();
    ctx.fillText(String(Number(tick.value.toPrecision(8))), px, bottom + 15);
  }
  ctx.fillText(spec.axis.label, (left + right) / 2, bottom + 28);
  const yTicks = linearTicks(ys.min, ys.max, Math.max(2, (bottom - mainTop) / 40), false);
  ctx.textAlign = "right";
  for (const tick of yTicks.major) {
    const py = Math.round(ys.toPixel(tick.value)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left - 4, py);
    ctx.lineTo(left, py);
    ctx.stroke();
    ctx.fillText(tick.label, left - 6, py + 3.5);
  }
  if (yTicks.exponent !== 0) {
    ctx.textAlign = "left";
    ctx.fillText(`×10^${yTicks.exponent}`, left + 4, mainTop + 12);
  }
  ctx.textAlign = "right";
  ctx.fillStyle = "#69717d";
  ctx.fillText("Residual", left - 6, (top + resBottom) / 2 + 3.5);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();

  const x = preview.x;
  const ends = rangeOf(preview);
  if (ends) {
    ctx.fillStyle = "#f3f6fb";
    const a = xs.toPixel(ends[0]);
    const b = xs.toPixel(ends[1]);
    ctx.fillRect(Math.min(a, b), mainTop, Math.abs(b - a), bottom - mainTop);
  }
  // Each item on the background, filled.
  const bg = preview.background ?? new Float64Array(x.length);
  preview.items.forEach((part, index) => {
    if (!part || part.length !== x.length) return;
    const color = colorOf(index);
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < x.length; i += 1) {
      if (!Number.isFinite(bg[i]! + part[i]!)) continue;
      const px = xs.toPixel(x[i]!);
      const py = ys.toPixel(bg[i]! + part[i]!);
      if (first) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      first = false;
    }
    for (let i = x.length - 1; i >= 0; i -= 1)
      if (Number.isFinite(bg[i])) ctx.lineTo(xs.toPixel(x[i]!), ys.toPixel(bg[i]!));
    ctx.closePath();
    ctx.globalAlpha = index === selected ? 0.22 : 0.1;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    line(
      x,
      Float64Array.from(part, (value, i) => value + bg[i]!),
      ys,
      color,
      index === selected ? 2 : 1.2,
    );
  });
  if (preview.background) line(x, preview.background, ys, "#808080", 1.2);
  // The data: points, grey outside the range fitted.
  const xAll = preview.allX ?? x;
  const yAll = preview.allY ?? preview.data ?? new Float64Array(0);
  for (let i = 0; i < xAll.length; i += 1) {
    if (!Number.isFinite(yAll[i]) || !Number.isFinite(xAll[i])) continue;
    const px = xs.toPixel(xAll[i]!);
    if (px < left - 2 || px > right + 2) continue;
    const inside = !ends || (xAll[i]! >= ends[0] && xAll[i]! <= ends[1]);
    ctx.fillStyle = inside ? "#1c2026" : "#b4b9c2";
    ctx.beginPath();
    ctx.arc(px, ys.toPixel(yAll[i]!), 1.6, 0, 2 * Math.PI);
    ctx.fill();
  }
  if (preview.fit) line(x, preview.fit, ys, FIT, 1.6);
  ctx.strokeStyle = "#c8ccd3";
  ctx.beginPath();
  ctx.moveTo(left, Math.round(rs.toPixel(0)) + 0.5);
  ctx.lineTo(right, Math.round(rs.toPixel(0)) + 0.5);
  ctx.stroke();
  if (preview.residual) line(x, preview.residual, rs, "#69717d", 1);
  if (spec.range && ends) {
    for (const end of ends) {
      const px = Math.round(xs.toPixel(end)) + 0.5;
      line([end, end], [ys.min, ys.max], ys, "#2760c4", 1, [4, 3]);
      ctx.fillStyle = "#2760c4";
      ctx.beginPath();
      ctx.moveTo(px - 5, mainTop);
      ctx.lineTo(px + 5, mainTop);
      ctx.lineTo(px, mainTop + 7);
      ctx.closePath();
      ctx.fill();
    }
  }
  // Handles: the top of each item, and the half widths of the one selected.
  preview.itemValues.forEach((item, index) => {
    if (!item.peak || index >= setup.items.length) return;
    const [position, topValue, base] = item.peak;
    const px = xs.toPixel(position);
    const py = ys.toPixel(topValue);
    const near = hover && Math.abs(hover.x - px) <= 6 && Math.abs(hover.y - py) <= 6;
    ctx.fillStyle = index === selected || near ? colorOf(index) : "#ffffff";
    ctx.strokeStyle = colorOf(index);
    ctx.lineWidth = 1.5;
    ctx.fillRect(px - 4, py - 4, 8, 8);
    ctx.strokeRect(px - 4, py - 4, 8, 8);
    ctx.fillStyle = colorOf(index);
    ctx.textAlign = "center";
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillText(LETTERS[index]!, px, py - 8);
    const width = spec.items.width ? item.values[spec.items.width] : undefined;
    if (index === selected && width !== undefined) {
      const half = ys.toPixel((topValue + base) / 2);
      for (const side of [-1, 1]) {
        const hx = xs.toPixel(position + (side * width) / 2);
        ctx.beginPath();
        ctx.moveTo(hx, half - 5);
        ctx.lineTo(hx + 5, half);
        ctx.lineTo(hx, half + 5);
        ctx.lineTo(hx - 5, half);
        ctx.closePath();
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
  });
  ctx.restore();
  if (setup.items.length === 0) {
    ctx.fillStyle = "#69717d";
    ctx.textAlign = "center";
    ctx.font = `12px ${FONT}`;
    ctx.fillText(
      `${spec.range ? "Drag the blue dashed lines to set the range; d" : "D"}ouble-click a peak to add a ${spec.items.title.toLowerCase()} there.`,
      (left + right) / 2,
      mainTop + 22,
    );
  }
}

// --- Items -------------------------------------------------------------------------------------------

function ItemsTab({
  context,
  setup,
  selected,
  onDelete,
}: {
  context: EditorContext;
  setup: EditorSetup;
  selected: number;
  onDelete: () => void;
}) {
  const { key, spec } = context;
  const preview = useEditor(key, (state) => state.preview);
  const partner = spec.partner;
  const [offset, setOffset] = useState(1);
  const [ratio, setRatio] = useState(partner?.ratios[0]?.[1] ?? 1);
  const items = setup.items;
  const full = items.length >= spec.items.max;
  const select = (index: number) => editorStore(key).set({ selected: index });
  const errorOf = (index: number, field: string) =>
    preview?.errors.find((error) => error.item === index && error.field === field)?.message;

  const create = () => {
    if (!preview || preview.x.length === 0) return;
    // Where the data stands furthest above what the items already make.
    let at = preview.x[Math.floor(preview.x.length / 2)]!;
    let most = -Infinity;
    const reference = preview.fit ?? preview.background;
    for (let i = 0; i < preview.x.length; i += 1) {
      const gap = (preview.data?.[i] ?? NaN) - (reference?.[i] ?? 0);
      if (gap > most) {
        most = gap;
        at = preview.x[i]!;
      }
    }
    addItemAt(context, at);
  };

  const valueCell = (field: EditorField) => (item: EditorSetup["items"][number], index: number) => {
    const letter = LETTERS[index]!;
    if (field.kind === "text") {
      const error = field.constraint ? undefined : errorOf(index, field.key);
      const value = item.values[field.key];
      return (
        <DraftInput
          label={`${letter} ${field.title}`}
          value={typeof value === "string" ? value : ""}
          list={field.choices.length > 0 ? `editor-${spec.name}-${field.key}` : undefined}
          className="w-full"
          invalid={Boolean(error)}
          title={error}
          placeholder={field.key === "name" ? letter : String(field.default)}
          onCommit={(text) => editItem(key, index, { values: { [field.key]: text.trim() } })}
        />
      );
    }
    const isTied = preview?.itemValues[index]?.tied.includes(field.key) ?? false;
    const given = item.values[field.key];
    const value = isTied
      ? (preview?.itemValues[index]?.values[field.key] ?? NaN)
      : typeof given === "number"
        ? given
        : NaN;
    const error = field.constraint ? undefined : errorOf(index, field.key);
    return (
      <NumberInput
        label={`${letter} ${field.title}`}
        value={value}
        disabled={isTied}
        invalid={Boolean(error)}
        title={isTied ? `Tied: ${item.constraints[field.key]}` : error}
        className={`w-full ${isTied ? "italic" : ""}`}
        onCommit={(number) =>
          editItem(key, index, {
            values: { [field.key]: field.min === null ? number : Math.max(field.min, number) },
          })
        }
      />
    );
  };

  const rows: {
    label: string;
    cell: (item: EditorSetup["items"][number], index: number) => ReactNode;
  }[] = spec.items.fields.flatMap((field) => [
    { label: field.title, cell: valueCell(field) },
    ...(field.constraint
      ? [
          {
            label: `${field.title.replace(/\s*\(.*\)$/, "")} constraint`,
            cell: (item: EditorSetup["items"][number], index: number) => {
              const error = errorOf(index, field.key);
              return (
                <DraftInput
                  label={`${LETTERS[index]} ${field.title} constraint`}
                  value={item.constraints[field.key] ?? ""}
                  placeholder={field.hint || "free"}
                  className="w-full font-mono text-[11px]"
                  invalid={Boolean(error)}
                  title={
                    error ??
                    'Empty: free. "284, 286": limits. "fixed". "A", "A+1.5", "A*0.5": tied to item A.'
                  }
                  onCommit={(text) =>
                    editItem(key, index, { constraints: { [field.key]: text.trim() } })
                  }
                />
              );
            },
          },
        ]
      : []),
  ]);

  return (
    <div className="flex h-full">
      <div className="flex w-[118px] shrink-0 flex-col gap-1 border-r border-line bg-chrome p-1.5">
        <Button
          disabled={full || !preview}
          onClick={create}
          title={`Add a ${spec.items.title.toLowerCase()} where the data stands highest above the model`}
        >
          Create
        </Button>
        <Button
          disabled={selected < 0 || full}
          title={`A copy of the selected ${spec.items.title.toLowerCase()}, a little higher in X`}
          onClick={() => {
            const source = items[selected];
            if (!source) return;
            const position = preview?.itemValues[selected]?.values[spec.items.position];
            const copy = {
              values: {
                ...source.values,
                [spec.items.position]: (position ?? Number(source.values[spec.items.position])) + 1,
                ...(Object.hasOwn(source.values, "name") ? { name: "" } : {}),
              },
              constraints: Object.fromEntries(
                Object.keys(source.constraints).map((field) => [field, ""]),
              ),
            };
            editSetup(key, (current) => ({ ...current, items: [...current.items, copy] }));
            select(items.length);
          }}
        >
          Copy
        </Button>
        {partner ? (
          <>
            <Button
              disabled={selected < 0 || full}
              title={`A partner of the selected ${spec.items.title.toLowerCase()}, tied to it`}
              onClick={() => {
                const source = items[selected];
                if (!source) return;
                const letter = LETTERS[selected]!;
                const resolved = preview?.itemValues[selected]?.values ?? {};
                const fill = (text: string) =>
                  text
                    .replaceAll("{ref}", letter)
                    .replaceAll("{offset}", formatNumber(offset))
                    .replaceAll("{ratio}", formatNumber(ratio, 4));
                const values: Record<string, string | number> = { ...source.values };
                for (const [field, value] of Object.entries(resolved)) values[field] = value;
                values[spec.items.position] =
                  (resolved[spec.items.position] ?? Number(values[spec.items.position])) + offset;
                if (spec.items.amount)
                  values[spec.items.amount] =
                    (resolved[spec.items.amount] ?? Number(values[spec.items.amount])) * ratio;
                if (typeof source.values.name === "string" && source.values.name)
                  values.name = `${source.values.name} (2)`;
                const constraints = Object.fromEntries(
                  Object.keys(source.constraints).map((field) => [
                    field,
                    partner.ties[field] ? fill(partner.ties[field]) : "",
                  ]),
                );
                editSetup(key, (current) => ({
                  ...current,
                  items: [...current.items, { values, constraints }],
                }));
                select(items.length);
              }}
            >
              {partner.title}
            </Button>
            <span className="flex items-center gap-1" title={partner.offset}>
              <span className="shrink-0 text-[11px] text-muted">{partner.offset}</span>
              <NumberInput
                label={partner.offset}
                value={offset}
                onCommit={setOffset}
                className="w-full"
              />
            </span>
            <Select
              aria-label="Ratio"
              title={`What the partner's ${spec.items.amount ?? "amount"} is, as a part of the selected one's`}
              value={String(ratio)}
              onChange={(event) => setRatio(Number(event.target.value))}
            >
              {partner.ratios.map(([label, value]) => (
                <option key={label} value={String(value)}>
                  {label}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <Button disabled={selected < 0} onClick={onDelete}>
          Delete
        </Button>
      </div>
      {spec.items.fields
        .filter((field) => field.choices.length > 0)
        .map((field) => (
          <datalist key={field.key} id={`editor-${spec.name}-${field.key}`}>
            {field.choices.map((choice) => (
              <option key={choice} value={choice} />
            ))}
          </datalist>
        ))}
      {items.length === 0 ? (
        <div className="grid flex-1 place-items-center p-4 text-center text-muted">
          No {spec.items.title.toLowerCase()}s yet. Press Create, or double-click a peak on the
          plot.
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-[11.5px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 bg-chrome" />
                {items.map((_item, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={`sticky top-0 z-10 min-w-[104px] cursor-pointer border-b border-line px-1 py-0.5 ${index === selected ? "bg-accent-soft" : "bg-chrome"}`}
                    onClick={() => select(index)}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: colorOf(index) }}
                      />
                      {LETTERS[index]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap border-r border-line bg-chrome px-2 text-right font-normal text-muted"
                  >
                    {row.label}
                  </th>
                  {items.map((item, index) => (
                    <td
                      key={index}
                      className={`px-0.5 py-px ${index === selected ? "bg-accent-soft/60" : ""}`}
                      onFocus={() => select(index)}
                    >
                      {row.cell(item, index)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Settings --------------------------------------------------------------------------------------

function SettingControl({
  name,
  spec,
  value,
  onChange,
}: {
  name: string;
  spec: ParamSpec;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
}) {
  const label = spec.title ?? name;
  switch (spec.type) {
    case "choice":
      return (
        <Select
          aria-label={label}
          className="w-fit"
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const chosen = spec.choices?.find((item) => String(item) === event.target.value);
            onChange(chosen ?? event.target.value);
          }}
        >
          {(spec.choices ?? []).map((choice) => (
            <option key={String(choice)} value={String(choice)}>
              {String(choice)}
            </option>
          ))}
        </Select>
      );
    case "boolean":
      return (
        <Checkbox
          label=""
          aria-label={label}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "number":
    case "integer":
      return (
        <NumberInput
          label={label}
          value={typeof value === "number" ? value : NaN}
          className="w-24"
          onCommit={(number) => {
            let next = spec.type === "integer" ? Math.round(number) : number;
            if (spec.min !== undefined) next = Math.max(spec.min, next);
            if (spec.max !== undefined) next = Math.min(spec.max, next);
            onChange(next);
          }}
        />
      );
    default:
      return (
        <DraftInput
          label={label}
          value={
            value === null || value === undefined
              ? ""
              : typeof value === "string"
                ? value
                : JSON.stringify(value)
          }
          className="w-48"
          onCommit={(text) => onChange(text)}
        />
      );
  }
}

function SettingsTab({ context, setup }: { context: EditorContext; setup: EditorSetup }) {
  const { key, spec, fit } = context;
  const preview = useEditor(key, (state) => state.preview);
  const drawn = rangeOf(preview);
  const ends = setup.range ?? drawn;
  // The higher end first when the axis runs from high to low, as on the plot.
  const shown: [number, number] | null = ends
    ? spec.axis.reverse
      ? [Math.max(...ends), Math.min(...ends)]
      : [Math.min(...ends), Math.max(...ends)]
    : null;
  const setEnd = (at: 0 | 1, value: number) =>
    editSetup(key, (current) => {
      const range: [number, number] = shown ? [...shown] : [value, value];
      range[at] = value;
      return { ...current, range };
    });
  return (
    <div className="grid max-w-[620px] grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 p-3">
      {spec.range ? (
        <>
          <span className="text-right text-muted">
            {fit.params[spec.range]?.title ?? spec.range}
          </span>
          <span className="flex items-center gap-2">
            <NumberInput
              label="Range from"
              value={shown?.[0] ?? NaN}
              onCommit={(value) => setEnd(0, value)}
              className="w-24"
            />
            <span className="text-muted">to</span>
            <NumberInput
              label="Range to"
              value={shown?.[1] ?? NaN}
              onCommit={(value) => setEnd(1, value)}
              className="w-24"
            />
            <Button
              disabled={!setup.range}
              onClick={() => editSetup(key, (current) => ({ ...current, range: null }))}
            >
              All the Data
            </Button>
          </span>
        </>
      ) : null}
      {spec.settings.map((name) => {
        const param = fit.params[name]!;
        return [
          <span key={`${name}-label`} className="text-right text-muted" title={param.description}>
            {param.title ?? name}
          </span>,
          <span key={name} className="flex items-center gap-2">
            <SettingControl
              name={name}
              spec={param}
              value={setup.settings[name] ?? null}
              onChange={(value) =>
                editSetup(key, (current) => ({
                  ...current,
                  settings: { ...current.settings, [name]: value },
                }))
              }
            />
            {param.description ? (
              <span className="min-w-0 truncate text-[11px] text-muted" title={param.description}>
                {param.description}
              </span>
            ) : null}
          </span>,
        ];
      })}
      {spec.range ? (
        <>
          <span />
          <p className="text-[11px] leading-relaxed text-muted">
            Drag the blue dashed lines on the plot to move the ends of the range.
          </p>
        </>
      ) : null}
    </div>
  );
}

// --- Report ------------------------------------------------------------------------------------------

function reportText(report: EditorReport): string {
  return [report.columns, ...report.rows].map((row) => row.join("\t")).join("\n");
}

function ReportTab({ context }: { context: EditorContext }) {
  const report = useEditor(context.key, (state) => state.report);
  if (!report)
    return (
      <div className="grid h-full place-items-center p-4 text-muted">
        Fit the {context.spec.items.title.toLowerCase()}s to see their report.
      </div>
    );
  return (
    <div className="p-2">
      {report.columns.length > 0 ? (
        <table className="selectable w-full border-collapse text-[11.5px]">
          <thead className="text-muted">
            <tr className="border-b border-line">
              {report.columns.map((title, index) => (
                <th key={index} className="px-2 py-0.5 text-left font-normal">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {report.rows.map((row, index) => (
              <tr key={index} className="border-b border-line-soft">
                {row.map((cell, at) => (
                  <td
                    key={at}
                    className="px-2"
                    style={at === 0 ? { color: colorOf(index) } : undefined}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="mt-2 flex items-start gap-3 text-[11.5px]">
        <div className="selectable min-w-0 flex-1 space-y-0.5">
          {report.lines.map((text, index) => (
            <div key={index} className={index === 0 ? "" : "text-muted"}>
              {text}
            </div>
          ))}
          {report.warnings.map((warning) => (
            <div key={warning} className="text-danger">
              {warning}
            </div>
          ))}
          {report.result ? (
            <div className="text-muted">Kept as {report.result} (Analysis › Results…).</div>
          ) : null}
        </div>
        {report.columns.length > 0 ? (
          <Button onClick={() => void navigator.clipboard?.writeText(reportText(report))}>
            Copy
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StatusLine({ context }: { context: EditorContext }) {
  const error = useEditor(context.key, (state) => state.error);
  const previewError = useEditor(context.key, (state) => state.previewError);
  const preview = useEditor(context.key, (state) => state.preview);
  const first = preview?.errors[0];
  const message =
    error ??
    previewError ??
    preview?.problem ??
    (first ? `${first.item === null ? "" : `${LETTERS[first.item]}: `}${first.message}` : null);
  return (
    <div
      role={message ? "alert" : undefined}
      className={`flex h-[22px] shrink-0 items-center truncate border-t border-line bg-chrome px-2 text-[11px] ${message ? "text-danger" : "text-muted"}`}
      title={message ?? undefined}
    >
      {message ??
        "Drag a square to move it, its diamonds to widen it; double-click to add; Delete removes the selected one. Ctrl+Z undoes."}
    </div>
  );
}

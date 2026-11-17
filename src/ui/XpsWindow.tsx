import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDoc } from "../app/session";
import {
  PARAM_TITLES,
  beginDrag,
  chooseSpectrum,
  dragSetup,
  editComponent,
  editSetup,
  redoXps,
  runXpsFit,
  selectComponent,
  spectrumEnergies,
  undoXps,
  useXps,
  xps,
  type XpsReport,
  type XpsSetup,
} from "../app/xps";
import { makeScale, type Scale } from "../core/plot/scale";
import { linearTicks } from "../core/plot/ticks";
import {
  XPS_BACKGROUNDS,
  XPS_LETTERS,
  XPS_PARAMS,
  XPS_SHAPES,
  evaluateModel,
  interpolate,
  newComponent,
  removeComponent,
  type XpsComponent,
  type XpsModel,
  type XpsParam,
} from "../core/xps";
import { Button, Select, TextInput } from "./controls";

/**
 * The XPS Peak Fitting window, after CasaXPS: the spectrum with its region,
 * background and components drawn as they stand, to drag into place, and the
 * components as a table with a column for each (name, line shape, position,
 * FWHM, area and the constraint of each). Fit runs op.xps_fit and takes what
 * it finds back into the table; the history keeps each fit as Python.
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
const ENVELOPE = "#d62728";

/** A number as the table shows it: six significant digits, no trailing zeros. */
function formatNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toPrecision(digits)));
}

function withError(value: number, error: number | null): string {
  if (!Number.isFinite(value)) return "";
  if (!(error !== null && error > 0)) return formatNumber(value);
  const place = Math.floor(Math.log10(error));
  const decimals = Math.max(0, 1 - place);
  if (decimals > 12) return `${formatNumber(value)} ± ${formatNumber(error, 2)}`;
  return `${value.toFixed(decimals)} ± ${error.toFixed(decimals)}`;
}

export function XpsWindow() {
  const setup = useXps((state) => state.setup);
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const spectra = order.filter((name) => {
    const wave = waves[name]!;
    return !wave.text && wave.shape.length === 1;
  });
  useEffect(() => {
    if (!xps.get().setup && spectra[0]) chooseSpectrum(spectra[0]);
  }, [spectra]);
  if (!setup)
    return (
      <div className="grid h-full place-items-center p-4 text-center text-muted">
        Load or make a spectrum (a 1-D wave of intensities) to fit.
      </div>
    );
  return <XpsEditor setup={setup} spectra={spectra} />;
}

function XpsEditor({ setup, spectra }: { setup: XpsSetup; spectra: string[] }) {
  const spectrum = useDoc((state) => state.waves[setup.spectrum]);
  const xWave = useDoc((state) => (setup.x ? state.waves[setup.x] : undefined));
  const selected = useXps((state) => state.selected);
  const [tab, setTab] = useState<"components" | "region" | "report">("components");
  const energies = useMemo(
    () => spectrumEnergies(spectrum, xWave, setup),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only what the energies are made from
    [spectrum, xWave, setup.spectrum, setup.x, setup.energy, setup.photonEnergy, setup.shift],
  );
  const model = useMemo(() => {
    if (typeof energies === "string") return energies;
    return evaluateModel({
      be: energies.be,
      y: energies.y,
      region: setup.region,
      background: setup.background,
      average: setup.average,
      components: setup.components,
    });
  }, [energies, setup.region, setup.background, setup.average, setup.components]);

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
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === "z" && !typing) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) redoXps();
          else undoXps();
        } else if (mod && event.key.toLowerCase() === "y" && !typing) {
          event.preventDefault();
          event.stopPropagation();
          redoXps();
        } else if ((event.key === "Delete" || event.key === "Backspace") && !typing) {
          if (selected >= 0 && typeof model !== "string") {
            event.preventDefault();
            event.stopPropagation();
            deleteComponent(selected, model);
          }
        }
      }}
    >
      <Toolbar setup={setup} spectra={spectra} length={spectrum?.data.length ?? 0} />
      <XpsPlot
        key={setup.spectrum}
        setup={setup}
        model={model}
        energies={energies}
        selected={selected}
      />
      <div className="flex shrink-0 items-center gap-0.5 border-y border-line bg-chrome px-2 pt-1">
        {(
          [
            ["components", "Components"],
            ["region", "Region"],
            ["report", "Report"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`rounded-t border border-b-0 px-3 py-0.5 ${tab === key ? "border-line bg-paper font-medium" : "border-transparent text-muted hover:text-ink"}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <FitButtons setup={setup} />
      </div>
      <div className="h-[212px] shrink-0 overflow-auto bg-paper">
        {tab === "components" ? (
          <ComponentsTab setup={setup} model={model} selected={selected} />
        ) : tab === "region" ? (
          <RegionTab setup={setup} model={model} />
        ) : (
          <ReportTab />
        )}
      </div>
      <StatusLine model={model} />
    </div>
  );
}

function deleteComponent(index: number, model: XpsModel): void {
  editSetup((setup) => ({
    ...setup,
    components: removeComponent(setup.components, index, model.resolved.values),
  }));
  const count = xps.get().setup?.components.length ?? 0;
  selectComponent(Math.min(index, count - 1));
}

// --- Toolbar ----------------------------------------------------------------------------

function Toolbar({
  setup,
  spectra,
  length,
}: {
  setup: XpsSetup;
  spectra: string[];
  length: number;
}) {
  const order = useDoc((state) => state.waveOrder);
  const waves = useDoc((state) => state.waves);
  const canUndo = useXps((state) => state.past.length > 0);
  const canRedo = useXps((state) => state.future.length > 0);
  const xChoices = order.filter((name) => {
    const wave = waves[name]!;
    return (
      name !== setup.spectrum &&
      !wave.text &&
      wave.shape.length === 1 &&
      wave.data.length === length
    );
  });
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-2 py-1">
      <label className="flex items-center gap-1">
        <span className="text-muted">Spectrum</span>
        <Select
          aria-label="Spectrum"
          value={setup.spectrum}
          onChange={(event) => chooseSpectrum(event.target.value)}
        >
          {spectra.includes(setup.spectrum) ? null : <option>{setup.spectrum}</option>}
          {spectra.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-1">
        <span className="text-muted">Energy</span>
        <Select
          aria-label="Energy wave"
          value={setup.x ?? ""}
          onChange={(event) => editSetup((s) => ({ ...s, x: event.target.value || null }))}
        >
          <option value="">X scaling</option>
          {xChoices.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
        <Select
          aria-label="Energies are"
          value={setup.energy}
          onChange={(event) =>
            editSetup((s) => ({
              ...s,
              energy: event.target.value as XpsSetup["energy"],
              region: null,
            }))
          }
        >
          <option value="binding">binding</option>
          <option value="kinetic">kinetic</option>
        </Select>
      </label>
      {setup.energy === "kinetic" ? (
        <label className="flex items-center gap-1" title="Al Kα 1486.6 eV, Mg Kα 1253.6 eV">
          <span className="text-muted">hν</span>
          <NumberInput
            label="Photon energy"
            value={setup.photonEnergy}
            onCommit={(value) => editSetup((s) => ({ ...s, photonEnergy: value }))}
            className="w-16"
          />
        </label>
      ) : null}
      <label
        className="flex items-center gap-1"
        title="Added to every binding energy: −0.8 when C 1s at 285.6 eV should be at 284.8 eV"
      >
        <span className="text-muted">Shift</span>
        <NumberInput
          label="Charge correction"
          value={setup.shift}
          onCommit={(value) => editSetup((s) => ({ ...s, shift: value }))}
          className="w-14"
        />
        <span className="text-muted">eV</span>
      </label>
      <span className="flex-1" />
      <Button
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={undoXps}
        className="px-2"
      >
        ↶
      </Button>
      <Button
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={redoXps}
        className="px-2"
      >
        ↷
      </Button>
    </div>
  );
}

function FitButtons({ setup }: { setup: XpsSetup }) {
  const busy = useXps((state) => state.busy);
  const none = setup.components.length === 0;
  return (
    <span className="flex items-center gap-1.5 pb-1">
      {busy ? <span className="text-muted">Fitting…</span> : null}
      <Button
        title="Make the waves and the graph of the components as they are, without fitting"
        disabled={busy || none}
        onClick={() => void runXpsFit(false)}
      >
        Draw
      </Button>
      <Button primary disabled={busy || none} onClick={() => void runXpsFit(true)}>
        Fit Components
      </Button>
    </span>
  );
}

// --- Inputs that commit when left ----------------------------------------------------------

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
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <DraftInput
      label={label}
      value={formatNumber(value)}
      className={`text-right ${className ?? ""}`}
      disabled={disabled}
      title={title}
      onCommit={(text) => {
        const number = Number(text.trim());
        if (text.trim() !== "" && Number.isFinite(number)) onCommit(number);
      }}
    />
  );
}

// --- The plot ---------------------------------------------------------------------------------

type Energies = ReturnType<typeof spectrumEnergies>;

type Drag =
  | { kind: "region"; end: 0 | 1 }
  | { kind: "apex"; index: number; area: number; height: number }
  | { kind: "width"; index: number; area: number; fwhm: number }
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

function XpsPlot({
  setup,
  model,
  energies,
  selected,
}: {
  setup: XpsSetup;
  model: XpsModel | string;
  energies: Energies;
  selected: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 600, height: 300 });
  const [view, setView] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<Drag>(null);
  const [dragging, setDragging] = useState<Drag>(null);

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
    if (typeof energies === "string") return null;
    const { be, y } = energies;
    let full: [number, number] = [Infinity, -Infinity];
    for (let i = 0; i < be.length; i += 1)
      if (Number.isFinite(be[i]) && Number.isFinite(y[i]))
        full = [Math.min(full[0], be[i]!), Math.max(full[1], be[i]!)];
    if (!(full[1] > full[0])) return null;
    let range: [number, number] = full;
    if (view) range = view;
    else if (typeof model !== "string") {
      const lo = Math.min(model.be[0]!, model.be.at(-1)!);
      const hi = Math.max(model.be[0]!, model.be.at(-1)!);
      const pad = (hi - lo) * 0.08;
      range = [Math.max(full[0], lo - pad), Math.min(full[1], hi + pad)];
    }
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let i = 0; i < be.length; i += 1) {
      if (!(be[i]! >= range[0] && be[i]! <= range[1]) || !Number.isFinite(y[i])) continue;
      ymin = Math.min(ymin, y[i]!);
      ymax = Math.max(ymax, y[i]!);
    }
    let rmax = 0;
    if (typeof model !== "string") {
      for (const series of [model.background, model.envelope])
        if (series)
          for (const value of series) {
            ymin = Math.min(ymin, value);
            ymax = Math.max(ymax, value);
          }
      if (model.residual)
        for (const value of model.residual) rmax = Math.max(rmax, Math.abs(value));
    }
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
      xs: makeScale(range[1], range[0], false, left, right),
      ys: makeScale(ymin - pad, ymax + pad, false, bottom, mainTop),
      rs: makeScale(-rmax, rmax, false, resBottom, top),
      left,
      right,
      top,
      mainTop,
      bottom,
      resBottom,
    };
  }, [energies, model, view, size]);
  // While something is dragged the scales stand still, or what is dragged would run from the mouse.
  const [frozen, setFrozen] = useState<Geometry | null>(null);
  const geometry = frozen ?? computed;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * ratio);
    element.height = Math.round(size.height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    if (geometry && typeof energies !== "string")
      draw(context, geometry, setup, model, energies, selected, hover);
  }, [geometry, size, setup, model, energies, selected, hover]);

  const apexOf = (index: number, current: XpsModel) => {
    const values = current.resolved.values[index]!;
    const part = current.components[index]!;
    const bg = current.background
      ? interpolate(current.be, current.background, values.position)
      : 0;
    const height = interpolate(current.be, part, values.position);
    return { position: values.position, height, bg, fwhm: values.fwhm };
  };

  /** What is under the pointer: a handle to drag, a component to select, or nothing. */
  const hitTest = (px: number, py: number): Drag | { kind: "select"; index: number } | null => {
    if (!geometry || typeof model === "string") return null;
    const { xs, ys } = geometry;
    const components = setup.components;
    if (selected >= 0 && selected < components.length) {
      const apex = apexOf(selected, model);
      const half = ys.toPixel(apex.bg + apex.height / 2);
      for (const side of [-1, 1]) {
        const hx = xs.toPixel(apex.position + (side * apex.fwhm) / 2);
        if (Math.abs(px - hx) <= 6 && Math.abs(py - half) <= 6)
          return {
            kind: "width",
            index: selected,
            area: components[selected]!.area,
            fwhm: apex.fwhm,
          };
      }
    }
    for (let index = components.length - 1; index >= 0; index -= 1) {
      const apex = apexOf(index, model);
      const hx = xs.toPixel(apex.position);
      const hy = ys.toPixel(apex.bg + apex.height);
      if (Math.abs(px - hx) <= 6 && Math.abs(py - hy) <= 6)
        return { kind: "apex", index, area: components[index]!.area, height: apex.height };
    }
    const region = [model.be[0]!, model.be.at(-1)!];
    for (const end of [0, 1] as const) {
      if (
        Math.abs(px - xs.toPixel(region[end]!)) <= 5 &&
        py >= geometry.mainTop &&
        py <= geometry.bottom
      )
        return { kind: "region", end };
    }
    const at = xs.toValue(px);
    let best = -1;
    let distance = 7;
    model.components.forEach((part, index) => {
      const bg = model.background ? interpolate(model.be, model.background, at) : 0;
      const gap = Math.abs(ys.toPixel(bg + interpolate(model.be, part, at)) - py);
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

  const onDragMove = (px: number, py: number) => {
    const current = drag.current;
    if (!current || !geometry || typeof model === "string") return;
    const { xs, ys } = geometry;
    const value = xs.toValue(px);
    if (current.kind === "region") {
      const ends: [number, number] = [model.be[0]!, model.be.at(-1)!];
      ends[current.end] = value;
      dragSetup((s) => ({ ...s, region: ends }));
      return;
    }
    const component = setup.components[current.index]!;
    const constraints = component.constraints;
    const tied = (param: XpsParam) => /^[A-Za-z]\s*([-+*/].*)?$/.test(constraints[param].trim());
    if (current.kind === "apex") {
      const change: Partial<XpsComponent> = {};
      const position = tied("position") ? model.resolved.values[current.index]!.position : value;
      if (!tied("position")) change.position = value;
      if (!tied("area") && current.height > 0) {
        const bg = model.background ? interpolate(model.be, model.background, position) : 0;
        const height = Math.max(ys.toValue(py) - bg, current.height * 1e-3);
        change.area = (current.area * height) / current.height;
      }
      dragSetup((s) => ({
        ...s,
        components: s.components.map((item, at) =>
          at === current.index ? { ...item, ...change } : item,
        ),
      }));
    } else {
      if (tied("fwhm")) return;
      const position = model.resolved.values[current.index]!.position;
      const fwhm = Math.max(0.05, 2 * Math.abs(value - position));
      const change: Partial<XpsComponent> = { fwhm };
      // The height stays: the area grows with the width.
      if (!tied("area")) change.area = (current.area * fwhm) / current.fwhm;
      dragSetup((s) => ({
        ...s,
        components: s.components.map((item, at) =>
          at === current.index ? { ...item, ...change } : item,
        ),
      }));
    }
  };

  const hovered = hover ? hitTest(hover.x, hover.y) : null;
  const cursor =
    dragging?.kind === "apex" || hovered?.kind === "apex"
      ? "move"
      : dragging || hovered?.kind === "width" || hovered?.kind === "region"
        ? "ew-resize"
        : hovered?.kind === "select"
          ? "pointer"
          : "crosshair";

  return (
    <div ref={box} className="relative min-h-[180px] flex-1 overflow-hidden bg-paper">
      <canvas
        ref={canvas}
        role="img"
        aria-label="XPS spectrum and components"
        className="block"
        style={{ width: size.width, height: size.height, cursor }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const { x, y } = point(event);
          const hit = hitTest(x, y);
          if (!hit) return;
          if (hit.kind === "select") {
            selectComponent(hit.index);
            return;
          }
          if (hit.kind !== "region") selectComponent(hit.index);
          event.currentTarget.setPointerCapture(event.pointerId);
          beginDrag();
          drag.current = hit;
          setFrozen(computed);
          setDragging(hit);
        }}
        onPointerMove={(event) => {
          const { x, y } = point(event);
          setHover({ x, y });
          onDragMove(x, y);
        }}
        onPointerUp={() => {
          // The plot keeps showing what it showed, rather than jump to the new region.
          if (drag.current?.kind === "region" && !view && frozen)
            setView([
              Math.min(frozen.xs.min, frozen.xs.max),
              Math.max(frozen.xs.min, frozen.xs.max),
            ]);
          drag.current = null;
          setDragging(null);
          setFrozen(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(null);
          setFrozen(null);
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(event) => {
          if (!geometry || typeof model === "string") return;
          const { x, y } = point(event);
          if (y < geometry.mainTop || x < geometry.left || x > geometry.right) return;
          addComponentAt(geometry.xs.toValue(x), model);
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
            {formatNumber(geometry.xs.toValue(hover.x), 5)} eV ·{" "}
            {formatNumber(geometry.ys.toValue(hover.y), 4)}
          </span>
        ) : null}
        <button
          type="button"
          className="rounded border border-line bg-chrome/90 px-1.5 text-muted hover:text-ink"
          title="Show the region (the mouse wheel zooms)"
          onClick={() => setView(null)}
        >
          Region
        </button>
        <button
          type="button"
          className="rounded border border-line bg-chrome/90 px-1.5 text-muted hover:text-ink"
          title="Show the whole spectrum"
          onClick={() => {
            if (typeof energies === "string") return;
            let lo = Infinity;
            let hi = -Infinity;
            for (const value of energies.be)
              if (Number.isFinite(value)) [lo, hi] = [Math.min(lo, value), Math.max(hi, value)];
            setView([lo, hi]);
          }}
        >
          All
        </button>
      </div>
      {typeof energies === "string" ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-muted">
          {energies}
        </div>
      ) : null}
    </div>
  );
}

function addComponentAt(position: number, model: XpsModel): void {
  const setup = xps.get().setup;
  if (!setup || setup.components.length >= XPS_LETTERS.length) return;
  const shape = setup.components.at(-1)?.shape ?? "GL(30)";
  const fwhm = setup.components.at(-1)?.fwhm ?? 1.2;
  const component = newComponent(model, position, setup.components.length, shape, fwhm);
  editSetup((s) => ({ ...s, components: [...s.components, component] }));
  selectComponent(setup.components.length);
}

function draw(
  context: CanvasRenderingContext2D,
  g: Geometry,
  setup: XpsSetup,
  model: XpsModel | string,
  energies: Exclude<Energies, string>,
  selected: number,
  hover: { x: number; y: number } | null,
): void {
  const { xs, ys, rs, left, right, top, mainTop, bottom, resBottom } = g;
  context.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const line = (
    xValues: ArrayLike<number>,
    yValues: ArrayLike<number>,
    scale: Scale,
    color: string,
    width: number,
    dash: number[] = [],
  ) => {
    context.beginPath();
    let started = false;
    for (let i = 0; i < xValues.length; i += 1) {
      const value = yValues[i]!;
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const px = xs.toPixel(xValues[i]!);
      const py = scale.toPixel(value);
      if (started) context.lineTo(px, py);
      else context.moveTo(px, py);
      started = true;
    }
    context.strokeStyle = color;
    context.lineWidth = width;
    context.setLineDash(dash);
    context.stroke();
    context.setLineDash([]);
  };

  // Frames and ticks.
  context.fillStyle = "#1c2026";
  context.strokeStyle = "#69717d";
  context.lineWidth = 1;
  context.strokeRect(left + 0.5, mainTop + 0.5, right - left, bottom - mainTop);
  context.strokeRect(left + 0.5, top + 0.5, right - left, resBottom - top);
  const xTicks = linearTicks(
    Math.min(xs.min, xs.max),
    Math.max(xs.min, xs.max),
    Math.max(2, (right - left) / 70),
    false,
  );
  context.textAlign = "center";
  for (const tick of xTicks.major) {
    const px = Math.round(xs.toPixel(tick.value)) + 0.5;
    context.beginPath();
    context.moveTo(px, bottom);
    context.lineTo(px, bottom + 4);
    context.stroke();
    context.fillText(String(Number(tick.value.toPrecision(8))), px, bottom + 15);
  }
  context.fillText("Binding Energy (eV)", (left + right) / 2, bottom + 28);
  const yTicks = linearTicks(ys.min, ys.max, Math.max(2, (bottom - mainTop) / 40), false);
  context.textAlign = "right";
  for (const tick of yTicks.major) {
    const py = Math.round(ys.toPixel(tick.value)) + 0.5;
    context.beginPath();
    context.moveTo(left - 4, py);
    context.lineTo(left, py);
    context.stroke();
    context.fillText(tick.label, left - 6, py + 3.5);
  }
  if (yTicks.exponent !== 0) {
    context.textAlign = "left";
    context.fillText(`×10^${yTicks.exponent}`, left + 4, mainTop + 12);
  }
  context.save();
  context.translate(14, (mainTop + bottom) / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = "center";
  context.fillText("Intensity", 0, 0);
  context.restore();
  context.textAlign = "right";
  context.fillStyle = "#69717d";
  context.fillText("Residual", left - 6, (top + resBottom) / 2 + 3.5);

  context.save();
  context.beginPath();
  context.rect(left, top, right - left, bottom - top);
  context.clip();

  const { be, y } = energies;
  if (typeof model !== "string") {
    // The region, shaded, between its ends.
    const a = xs.toPixel(model.be[0]!);
    const b = xs.toPixel(model.be.at(-1)!);
    context.fillStyle = "#f3f6fb";
    context.fillRect(Math.min(a, b), mainTop, Math.abs(b - a), bottom - mainTop);
    // Each component on the background, filled.
    const bg = model.background ?? new Float64Array(model.be.length);
    model.components.forEach((part, index) => {
      const color = colorOf(index);
      context.beginPath();
      for (let i = 0; i < model.be.length; i += 1) {
        const px = xs.toPixel(model.be[i]!);
        const py = ys.toPixel(bg[i]! + part[i]!);
        if (i === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      for (let i = model.be.length - 1; i >= 0; i -= 1)
        context.lineTo(xs.toPixel(model.be[i]!), ys.toPixel(bg[i]!));
      context.closePath();
      context.globalAlpha = index === selected ? 0.22 : 0.1;
      context.fillStyle = color;
      context.fill();
      context.globalAlpha = 1;
      line(
        model.be,
        Float64Array.from(part, (value, i) => value + bg[i]!),
        ys,
        color,
        index === selected ? 2 : 1.2,
      );
    });
    if (model.background) line(model.be, model.background, ys, "#808080", 1.2);
  }
  // The data: points, grey outside the region.
  const first = typeof model === "string" ? 0 : model.first;
  const stop = typeof model === "string" ? be.length : model.stop;
  for (let i = 0; i < be.length; i += 1) {
    if (!Number.isFinite(y[i]) || !Number.isFinite(be[i])) continue;
    const px = xs.toPixel(be[i]!);
    if (px < left - 2 || px > right + 2) continue;
    context.fillStyle = i >= first && i < stop ? "#1c2026" : "#b4b9c2";
    context.beginPath();
    context.arc(px, ys.toPixel(y[i]!), 1.6, 0, 2 * Math.PI);
    context.fill();
  }
  if (typeof model !== "string") {
    if (model.envelope) line(model.be, model.envelope, ys, ENVELOPE, 1.6);
    // The residual, against zero.
    context.strokeStyle = "#c8ccd3";
    context.beginPath();
    context.moveTo(left, Math.round(rs.toPixel(0)) + 0.5);
    context.lineTo(right, Math.round(rs.toPixel(0)) + 0.5);
    context.stroke();
    if (model.residual) line(model.be, model.residual, rs, "#69717d", 1);
    // The ends of the region, to drag.
    for (const end of [model.be[0]!, model.be.at(-1)!]) {
      const px = Math.round(xs.toPixel(end)) + 0.5;
      line([end, end], [ys.min, ys.max], ys, "#2760c4", 1, [4, 3]);
      context.fillStyle = "#2760c4";
      context.beginPath();
      context.moveTo(px - 5, mainTop);
      context.lineTo(px + 5, mainTop);
      context.lineTo(px, mainTop + 7);
      context.closePath();
      context.fill();
    }
    // Handles: the top of each component, and the half widths of the one selected.
    const bg = (at: number) => (model.background ? interpolate(model.be, model.background, at) : 0);
    model.components.forEach((part, index) => {
      const values = model.resolved.values[index]!;
      if (!Number.isFinite(values.position)) return;
      const height = interpolate(model.be, part, values.position);
      const px = xs.toPixel(values.position);
      const py = ys.toPixel(bg(values.position) + height);
      const near = hover && Math.abs(hover.x - px) <= 6 && Math.abs(hover.y - py) <= 6;
      context.fillStyle = index === selected || near ? colorOf(index) : "#ffffff";
      context.strokeStyle = colorOf(index);
      context.lineWidth = 1.5;
      context.fillRect(px - 4, py - 4, 8, 8);
      context.strokeRect(px - 4, py - 4, 8, 8);
      context.fillStyle = colorOf(index);
      context.textAlign = "center";
      context.font = "bold 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      context.fillText(XPS_LETTERS[index]!, px, py - 8);
      if (index === selected) {
        const half = ys.toPixel(bg(values.position) + height / 2);
        for (const side of [-1, 1]) {
          const hx = xs.toPixel(values.position + (side * values.fwhm) / 2);
          context.beginPath();
          context.moveTo(hx, half - 5);
          context.lineTo(hx + 5, half);
          context.lineTo(hx, half + 5);
          context.lineTo(hx - 5, half);
          context.closePath();
          context.fillStyle = "#ffffff";
          context.fill();
          context.stroke();
        }
      }
    });
  }
  context.restore();
  if (setup.components.length === 0 && typeof model !== "string") {
    context.fillStyle = "#69717d";
    context.textAlign = "center";
    context.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    context.fillText(
      "Drag the blue dashed lines to set the region; double-click a peak to add a component there.",
      (left + right) / 2,
      mainTop + 22,
    );
  }
}

// --- Components ---------------------------------------------------------------------------

const DOUBLETS: [string, number, number][] = [
  ["p (1:2)", 0.5, 1],
  ["d (2:3)", 2 / 3, 1],
  ["f (3:4)", 0.75, 1],
];

function ComponentsTab({
  setup,
  model,
  selected,
}: {
  setup: XpsSetup;
  model: XpsModel | string;
  selected: number;
}) {
  const report = useXps((state) => state.report);
  const [splitting, setSplitting] = useState(1);
  const [ratio, setRatio] = useState(0.5);
  const components = setup.components;
  const resolved = typeof model === "string" ? null : model.resolved;
  const percent = report && report.rows.length === components.length ? report.rows : null;
  const canAdd = typeof model !== "string" && components.length < XPS_LETTERS.length;
  const tiedNote = (param: XpsParam, component: XpsComponent) =>
    /^[A-Za-z]\s*([-+*/].*)?$/.test(component.constraints[param].trim());

  const create = () => {
    if (typeof model === "string") return;
    // Where the data stands furthest above what the components already make.
    let at = model.be[Math.floor(model.be.length / 2)]!;
    let most = -Infinity;
    const bg = model.background;
    for (let i = 0; i < model.be.length; i += 1) {
      let sum = bg ? bg[i]! : 0;
      for (const part of model.components) sum += part[i]!;
      if (model.data[i]! - sum > most) {
        most = model.data[i]! - sum;
        at = model.be[i]!;
      }
    }
    addComponentAt(at, model);
  };

  const rows: { label: string; cell: (component: XpsComponent, index: number) => ReactNode }[] = [
    {
      label: "Name",
      cell: (component, index) => (
        <DraftInput
          label={`${XPS_LETTERS[index]} name`}
          value={component.name}
          className="w-full"
          onCommit={(name) => editComponent(index, { name })}
        />
      ),
    },
    {
      label: "Line shape",
      cell: (component, index) => (
        <DraftInput
          label={`${XPS_LETTERS[index]} line shape`}
          value={component.shape}
          list="xps-shapes"
          className="w-full"
          invalid={Boolean(resolved?.errors[XPS_LETTERS[index]!])}
          title={
            resolved?.errors[XPS_LETTERS[index]!] ?? "GL(m), SGL(m), GL(m)T(k), SGL(m)T(k), LA(α,β)"
          }
          onCommit={(shape) => editComponent(index, { shape: shape.trim() || "GL(30)" })}
        />
      ),
    },
    ...XPS_PARAMS.flatMap((param) => [
      {
        label: PARAM_TITLES[param] + (param === "area" ? "" : " (eV)"),
        cell: (component: XpsComponent, index: number) => {
          const tied = tiedNote(param, component);
          const value = tied ? (resolved?.values[index]?.[param] ?? NaN) : component[param];
          return (
            <NumberInput
              label={`${XPS_LETTERS[index]} ${param}`}
              value={value}
              disabled={tied}
              title={tied ? `Tied: ${component.constraints[param]}` : undefined}
              className={`w-full ${tied ? "italic" : ""}`}
              onCommit={(number) => editComponent(index, { [param]: number })}
            />
          );
        },
      },
      {
        label: `${PARAM_TITLES[param]} constraint`,
        cell: (component: XpsComponent, index: number) => {
          const error = resolved?.errors[`${XPS_LETTERS[index]}.${param}`];
          return (
            <DraftInput
              label={`${XPS_LETTERS[index]} ${param} constraint`}
              value={component.constraints[param]}
              placeholder={
                param === "position" ? "free in region" : param === "fwhm" ? "0.05, 20" : "≥ 0"
              }
              className="w-full font-mono text-[11px]"
              invalid={Boolean(error)}
              title={
                error ??
                'Empty: free. "284, 286": limits. "fixed". "A", "A+1.5", "A*0.5": tied to component A.'
              }
              onCommit={(text) =>
                editComponent(index, {
                  constraints: { ...component.constraints, [param]: text.trim() },
                })
              }
            />
          );
        },
      },
    ]),
    {
      label: "Gauss (eV)",
      cell: (component, index) => (
        <NumberInput
          label={`${XPS_LETTERS[index]} gauss`}
          value={component.gauss}
          title="FWHM of a Gaussian the line shape is convolved with (0 for none)"
          className="w-full"
          onCommit={(gauss) => editComponent(index, { gauss: Math.max(0, gauss) })}
        />
      ),
    },
    {
      label: "RSF",
      cell: (component, index) => (
        <NumberInput
          label={`${XPS_LETTERS[index]} rsf`}
          value={component.rsf}
          className="w-full"
          onCommit={(rsf) => {
            if (rsf > 0) editComponent(index, { rsf });
          }}
        />
      ),
    },
    {
      label: "% Area/RSF",
      cell: (_component, index) => (
        <span className="block px-1.5 text-right font-mono">
          {percent?.[index]?.percent != null ? percent[index]!.percent!.toFixed(2) : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="flex h-full">
      <div className="flex w-[118px] shrink-0 flex-col gap-1 border-r border-line bg-chrome p-1.5">
        <Button
          disabled={!canAdd}
          onClick={create}
          title="Add a component where the data stands highest above the fit"
        >
          Create
        </Button>
        <Button
          disabled={selected < 0 || !canAdd}
          title="A copy of the selected component, 1 eV higher"
          onClick={() => {
            const source = components[selected];
            if (!source) return;
            const copy: XpsComponent = {
              ...source,
              name: XPS_LETTERS[components.length]!,
              position: (resolved?.values[selected]?.position ?? source.position) + 1,
              constraints: { position: "", fwhm: "", area: "" },
            };
            editSetup((s) => ({ ...s, components: [...s.components, copy] }));
            selectComponent(components.length);
          }}
        >
          Copy
        </Button>
        <Button
          disabled={selected < 0 || !canAdd}
          title="A spin-orbit partner of the selected component: tied to it in position, FWHM and area"
          onClick={() => {
            const source = components[selected];
            if (!source) return;
            const letter = XPS_LETTERS[selected]!;
            const values = resolved?.values[selected];
            const partner: XpsComponent = {
              ...source,
              name: `${source.name} (2)`,
              position: (values?.position ?? source.position) + splitting,
              area: (values?.area ?? source.area) * ratio,
              constraints: {
                position: `${letter}+${formatNumber(splitting)}`,
                fwhm: letter,
                area: `${letter}*${formatNumber(ratio, 4)}`,
              },
            };
            editSetup((s) => ({ ...s, components: [...s.components, partner] }));
            selectComponent(components.length);
          }}
        >
          Doublet
        </Button>
        <span className="flex items-center gap-1" title="Spin-orbit splitting (eV)">
          <span className="text-[11px] text-muted">Δ</span>
          <NumberInput
            label="Splitting"
            value={splitting}
            onCommit={setSplitting}
            className="w-full"
          />
        </span>
        <Select
          aria-label="Area ratio"
          title="Area of the partner to that of the selected component"
          value={String(ratio)}
          onChange={(event) => setRatio(Number(event.target.value))}
        >
          {DOUBLETS.map(([label, value]) => (
            <option key={label} value={String(value)}>
              {label}
            </option>
          ))}
        </Select>
        <Button
          disabled={selected < 0 || typeof model === "string"}
          onClick={() => typeof model !== "string" && deleteComponent(selected, model)}
        >
          Delete
        </Button>
      </div>
      <datalist id="xps-shapes">
        {XPS_SHAPES.map((shape) => (
          <option key={shape} value={shape} />
        ))}
      </datalist>
      {components.length === 0 ? (
        <div className="grid flex-1 place-items-center p-4 text-center text-muted">
          No components yet. Press Create, or double-click a peak on the plot.
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-[11.5px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 bg-chrome" />
                {components.map((_component, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={`sticky top-0 z-10 min-w-[104px] cursor-pointer border-b border-line px-1 py-0.5 ${index === selected ? "bg-accent-soft" : "bg-chrome"}`}
                    onClick={() => selectComponent(index)}
                  >
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm"
                        style={{ background: colorOf(index) }}
                      />
                      {XPS_LETTERS[index]}
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
                  {components.map((component, index) => (
                    <td
                      key={index}
                      className={`px-0.5 py-px ${index === selected ? "bg-accent-soft/60" : ""}`}
                      onFocus={() => selectComponent(index)}
                    >
                      {row.cell(component, index)}
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

// --- Region -----------------------------------------------------------------------------------

function RegionTab({ setup, model }: { setup: XpsSetup; model: XpsModel | string }) {
  // Higher binding energy first, as the plot runs.
  const ends =
    setup.region ?? (typeof model === "string" ? null : [model.be[0]!, model.be.at(-1)!]);
  const shown: [number, number] | null = ends
    ? [Math.max(ends[0]!, ends[1]!), Math.min(ends[0]!, ends[1]!)]
    : null;
  const end = (at: 0 | 1, value: number) =>
    editSetup((s) => {
      const region: [number, number] = shown ? [...shown] : [value, value];
      region[at] = value;
      return { ...s, region };
    });
  return (
    <div className="grid max-w-[560px] grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 p-3">
      <span className="text-right text-muted">From (eV)</span>
      <span className="flex items-center gap-2">
        <NumberInput
          label="Region from"
          value={shown?.[0] ?? NaN}
          onCommit={(value) => end(0, value)}
          className="w-24"
        />
        <span className="text-muted">to</span>
        <NumberInput
          label="Region to"
          value={shown?.[1] ?? NaN}
          onCommit={(value) => end(1, value)}
          className="w-24"
        />
        <Button disabled={!setup.region} onClick={() => editSetup((s) => ({ ...s, region: null }))}>
          Whole Spectrum
        </Button>
      </span>
      <span className="text-right text-muted">Background</span>
      <span className="flex items-center gap-2">
        <Select
          aria-label="Background"
          value={setup.background}
          onChange={(event) =>
            editSetup((s) => ({ ...s, background: event.target.value as XpsSetup["background"] }))
          }
        >
          {XPS_BACKGROUNDS.map((name) => (
            <option key={name} value={name}>
              {name === "none" ? "None" : name[0]!.toUpperCase() + name.slice(1)}
            </option>
          ))}
        </Select>
        <span className="text-muted">ends averaged over</span>
        <NumberInput
          label="Average width"
          value={setup.average}
          onCommit={(value) =>
            editSetup((s) => ({ ...s, average: Math.max(1, Math.round(value)) }))
          }
          className="w-12"
        />
        <span className="text-muted">points</span>
      </span>
      <span className="text-right text-muted">Weighting</span>
      <Select
        aria-label="Weighting"
        className="w-fit"
        value={setup.weighting}
        onChange={(event) =>
          editSetup((s) => ({ ...s, weighting: event.target.value as XpsSetup["weighting"] }))
        }
      >
        <option value="poisson">Poisson (1/√counts)</option>
        <option value="unit">None</option>
      </Select>
      <span />
      <p className="text-[11px] leading-relaxed text-muted">
        Drag the blue dashed lines on the plot to move the ends of the region. The background is
        worked out from the data (Shirley rises with the peak area passed; Tougaard uses the
        universal cross-section with B scaled to the data) and held while the components are fitted.
      </p>
    </div>
  );
}

// --- Report -------------------------------------------------------------------------------------

function reportText(report: XpsReport): string {
  const head = [
    "",
    "Name",
    "Shape",
    "Position",
    "σ",
    "FWHM",
    "σ",
    "Width",
    "Area",
    "σ",
    "RSF",
    "%",
  ];
  const lines = report.rows.map((row) =>
    [
      row.letter,
      row.name,
      row.shape,
      row.position,
      row.position_sigma ?? "",
      row.fwhm,
      row.fwhm_sigma ?? "",
      row.width ?? "",
      row.area,
      row.area_sigma ?? "",
      row.rsf,
      row.percent ?? "",
    ].join("\t"),
  );
  return [head.join("\t"), ...lines].join("\n");
}

function ReportTab() {
  const report = useXps((state) => state.report);
  if (!report)
    return (
      <div className="grid h-full place-items-center p-4 text-muted">
        Fit the components to see their report.
      </div>
    );
  return (
    <div className="p-2">
      <table className="selectable w-full border-collapse text-[11.5px]">
        <thead className="text-muted">
          <tr className="border-b border-line">
            {[
              "",
              "Name",
              "Shape",
              "Position (eV)",
              "FWHM (eV)",
              "Width (eV)",
              "Area",
              "RSF",
              "% Area/RSF",
            ].map((title) => (
              <th key={title} className="px-2 py-0.5 text-left font-normal">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {report.rows.map((row, index) => (
            <tr key={row.letter} className="border-b border-line-soft">
              <td className="px-2" style={{ color: colorOf(index) }}>
                {row.letter}
              </td>
              <td className="px-2 font-sans">{row.name}</td>
              <td className="px-2">{row.shape}</td>
              <td className="px-2">{withError(row.position, row.position_sigma)}</td>
              <td className="px-2">{withError(row.fwhm, row.fwhm_sigma)}</td>
              <td className="px-2">{row.width === null ? "" : formatNumber(row.width, 4)}</td>
              <td className="px-2">{withError(row.area, row.area_sigma)}</td>
              <td className="px-2">{formatNumber(row.rsf)}</td>
              <td className="px-2">{row.percent === null ? "" : row.percent.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-start gap-3 text-[11.5px]">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div>
            χ² {report.chisq === null ? "—" : formatNumber(report.chisq, 5)} · reduced χ²{" "}
            {report.chisqReduced === null ? "—" : formatNumber(report.chisqReduced, 4)} ·{" "}
            {report.points} points ·{" "}
            <span className={report.converged ? "" : "text-danger"}>{report.reason}</span>
          </div>
          {report.warnings.map((warning) => (
            <div key={warning} className="text-danger">
              {warning}
            </div>
          ))}
          {report.result ? (
            <div className="text-muted">
              Kept as {report.result} (Analysis › Results…). Width is the true full width at half
              maximum.
            </div>
          ) : null}
        </div>
        <Button onClick={() => void navigator.clipboard?.writeText(reportText(report))}>
          Copy
        </Button>
      </div>
    </div>
  );
}

function StatusLine({ model }: { model: XpsModel | string }) {
  const error = useXps((state) => state.error);
  const problems =
    typeof model === "string"
      ? [model]
      : [
          ...(model.problem ? [model.problem] : []),
          ...Object.entries(model.resolved.errors).map(
            ([where, message]) => `${where}: ${message}`,
          ),
        ];
  const message = error ?? problems[0] ?? null;
  return (
    <div
      role={message ? "alert" : undefined}
      className={`flex h-[22px] shrink-0 items-center truncate border-t border-line bg-chrome px-2 text-[11px] ${message ? "text-danger" : "text-muted"}`}
      title={message ?? undefined}
    >
      {message ??
        "Drag a component's square to move it, its diamonds to widen it; Delete removes the selected one. Ctrl+Z undoes."}
    </div>
  );
}

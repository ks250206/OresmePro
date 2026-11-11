import { useState } from "react";
import { newMatrixPlot, pyName, runPython } from "../app/actions";
import { runGui, ui, useDoc, useUi, type DialogRequest } from "../app/session";
import type { Command } from "../core/doc/commands";
import {
  ANCHORS,
  AXIS_SIDES,
  COLOR_TABLES,
  DEFAULT_FONT_FAMILY,
  GRID_MODES,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  TICK_MODES,
  TRACE_COLORS,
  TRACE_MODES,
  isVerticalSide,
  leafName,
  type AxisSpec,
  type ContourSpec,
  type ErrorSource,
  type GraphSpec,
  type ImageSpec,
  type TraceStyle,
} from "../core/doc/types";
import { formatNumber } from "../core/plot/ticks";
import { Button, Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** Runs commands and closes the dialog if they were accepted. */
function submit(commands: Command | Command[]) {
  if (runGui(commands) !== undefined) close();
}

const parseNumber = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
};

const CALCULATED = "_calculated_";

/** Names of the numeric waves with the given number of dimensions. */
function useNumericWaves(dimensions: number): string[] {
  const waves = useDoc((state) => state.waves);
  const order = useDoc((state) => state.waveOrder);
  return order.filter((name) => !waves[name]!.text && waves[name]!.shape.length === dimensions);
}

function AxisSelects({
  graph,
  vAxis,
  hAxis,
  onChange,
}: {
  graph: GraphSpec;
  vAxis: string;
  hAxis: string;
  onChange: (axes: { vAxis: string; hAxis: string }) => void;
}) {
  const names = (vertical: boolean) =>
    Object.entries(graph.axes)
      .filter(([, axis]) => isVerticalSide(axis.side) === vertical)
      .map(([name]) => name);
  return (
    <Field label="Axes">
      <Select
        aria-label="Vertical axis"
        value={vAxis}
        onChange={(event) => onChange({ vAxis: event.target.value, hAxis })}
      >
        {names(true).map((name) => (
          <option key={name}>{name}</option>
        ))}
      </Select>
      <Select
        aria-label="Horizontal axis"
        value={hAxis}
        onChange={(event) => onChange({ vAxis, hAxis: event.target.value })}
      >
        {names(false).map((name) => (
          <option key={name}>{name}</option>
        ))}
      </Select>
    </Field>
  );
}

function XWaveSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const order = useNumericWaves(1);
  return (
    <Select
      aria-label="X wave"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="flex-1"
    >
      <option value={CALCULATED}>_calculated_ (from wave scaling)</option>
      {order.map((name) => (
        <option key={name}>{name}</option>
      ))}
    </Select>
  );
}

function NewGraphDialog({ append }: { append?: string }) {
  const order = useNumericWaves(1);
  const graph = useDoc((state) => (append ? state.graphs[append] : undefined));
  const preselected = useUi((state) => state.selectedWaves);
  const [y, setY] = useState<string[]>(() => preselected.filter((name) => order.includes(name)));
  const [x, setX] = useState(CALCULATED);
  const [axes, setAxes] = useState({ vAxis: "left", hAxis: "bottom" });
  const xWave = x === CALCULATED ? null : x;
  return (
    <Dialog
      title={append ? `Append Traces to ${append}` : "New Graph"}
      onClose={close}
      submitDisabled={y.length === 0}
      onSubmit={() =>
        submit(
          append
            ? { op: "appendTraces", graph: append, y, x: xWave, ...axes }
            : { op: "display", y, x: xWave },
        )
      }
    >
      <div className="text-muted">Y waves</div>
      <NameList label="Y waves" names={order} selected={y} onChange={setY} />
      <Field label="X wave">
        <XWaveSelect value={x} onChange={setX} />
      </Field>
      {graph ? <AxisSelects graph={graph} {...axes} onChange={setAxes} /> : null}
    </Dialog>
  );
}

function ColorTableSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label="Color table"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {COLOR_TABLES.map((table) => (
        <option key={table}>{table}</option>
      ))}
    </Select>
  );
}

/** New image or contour plot of a 2-D wave, in a new graph or added to one. */
function MatrixPlotDialog({
  plot,
  graph: graphName,
}: {
  plot: "image" | "contour";
  graph?: string;
}) {
  const order = useNumericWaves(2);
  const graph = useDoc((state) => (graphName ? state.graphs[graphName] : undefined));
  const preselected = useUi((state) => state.selectedWaves);
  const [wave, setWave] = useState<string[]>(() =>
    preselected.filter((name) => order.includes(name)).slice(0, 1),
  );
  const [table, setTable] = useState("viridis");
  const [levels, setLevels] = useState("10");
  const [axes, setAxes] = useState({ vAxis: "left", hAxis: "bottom" });
  const count = Number(levels);
  const validLevels = Number.isInteger(count) && count >= 1 && count <= 200;
  const props: Record<string, unknown> =
    plot === "image" ? { colorTable: table } : { levels: count };
  const what = plot === "image" ? "Image" : "Contour";
  return (
    <Dialog
      title={graphName ? `Append ${what} to ${graphName}` : `New ${what} Plot`}
      onClose={close}
      submitDisabled={wave.length !== 1 || (plot === "contour" && !validLevels)}
      onSubmit={() => {
        if (graphName) {
          submit(
            plot === "image"
              ? { op: "appendImage", graph: graphName, wave: wave[0]!, ...axes, props }
              : { op: "appendContour", graph: graphName, wave: wave[0]!, ...axes, props },
          );
        } else {
          newMatrixPlot(plot, wave[0]!, props);
          close();
        }
      }}
    >
      <div className="text-muted">2-D wave (first index along X)</div>
      <NameList
        label="2-D wave"
        names={order}
        selected={wave}
        onChange={setWave}
        multiple={false}
      />
      {plot === "image" ? (
        <Field label="Color table">
          <ColorTableSelect value={table} onChange={setTable} />
        </Field>
      ) : (
        <Field label="Levels">
          <TextInput
            aria-label="Levels"
            aria-invalid={!validLevels}
            className="w-16"
            value={levels}
            onChange={(event) => setLevels(event.target.value)}
          />
          <span className="text-muted">chosen automatically at round values</span>
        </Field>
      )}
      {graph ? <AxisSelects graph={graph} {...axes} onChange={setAxes} /> : null}
    </Dialog>
  );
}

function NewTableDialog() {
  const order = useDoc((state) => state.waveOrder);
  const preselected = useUi((state) => state.selectedWaves);
  const [waves, setWaves] = useState<string[]>(() =>
    preselected.filter((name) => order.includes(name)),
  );
  return (
    <Dialog
      title="New Table"
      onClose={close}
      submitDisabled={waves.length === 0}
      onSubmit={() => submit({ op: "edit", waves })}
    >
      <div className="text-muted">Columns</div>
      <NameList label="Columns" names={order} selected={waves} onChange={setWaves} />
    </Dialog>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <>
      <input
        type="color"
        aria-label="Color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-6 w-9 cursor-pointer rounded border border-line bg-paper p-0.5"
      />
      <span className="flex gap-1">
        {TRACE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            title={color}
            className={`h-4 w-4 rounded-sm border ${color === value ? "border-ink ring-1 ring-ink" : "border-black/20"}`}
            style={{ background: color }}
            onClick={() => onChange(color)}
          />
        ))}
      </span>
    </>
  );
}

/** Error bars: none, the same size for every point, or one size per point from a wave. */
function ErrorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ErrorSource;
  onChange: (value: ErrorSource) => void;
}) {
  const waves = useNumericWaves(1);
  const kind = value === null ? "none" : typeof value === "number" ? "constant" : "wave";
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  return (
    <Field label={label}>
      <Select
        aria-label={label}
        value={kind}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "none") onChange(null);
          else if (next === "constant") onChange(Math.max(0, Number(text) || 0));
          else onChange(waves[0] ?? null);
        }}
      >
        <option value="none">none</option>
        <option value="constant">constant</option>
        <option value="wave" disabled={waves.length === 0}>
          from wave
        </option>
      </Select>
      {kind === "constant" ? (
        <TextInput
          aria-label={`${label} size`}
          className="w-20"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const size = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(size) && size >= 0)
              onChange(size);
          }}
        />
      ) : null}
      {kind === "wave" ? (
        <Select
          aria-label={`${label} wave`}
          value={value as string}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1"
        >
          {waves.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      ) : null}
    </Field>
  );
}

function ModifyTraceDialog({ graph: graphName, trace }: { graph: string; trace?: string }) {
  const graph = useDoc((state) => state.graphs[graphName]);
  const names = graph?.traces.map((item) => item.name) ?? [];
  const [selected, setSelected] = useState<string[]>(() => [trace ?? names[0] ?? ""]);
  // Only the properties touched in the dialog are applied, to every selected trace.
  const [changes, setChanges] = useState<Partial<TraceStyle>>({});
  const [lineSize, setLineSize] = useState<string | null>(null);
  const [markerSize, setMarkerSize] = useState<string | null>(null);
  const base = graph?.traces.find((item) => item.name === selected[0]);
  if (!graph || !base) return null;
  const current = { ...base, ...changes };
  const set = (patch: Partial<TraceStyle>) => setChanges({ ...changes, ...patch });
  const hasMarkers = current.mode === "markers" || current.mode === "lines+markers";
  const hasLine = current.mode !== "markers" && current.mode !== "dots";

  const sizes: Partial<TraceStyle> = {};
  const parsedLine = lineSize === null ? undefined : parseNumber(lineSize);
  const parsedMarker = markerSize === null ? undefined : parseNumber(markerSize);
  if (typeof parsedLine === "number") sizes.lineSize = parsedLine;
  if (typeof parsedMarker === "number") sizes.markerSize = parsedMarker;
  const invalid = parsedLine === null || parsedMarker === null;
  const props = { ...changes, ...sizes };

  return (
    <Dialog
      title={`Modify Trace Appearance — ${graphName}`}
      width={520}
      onClose={close}
      submitDisabled={invalid || Object.keys(props).length === 0}
      onSubmit={() =>
        submit(
          selected.map((name) => ({ op: "modifyTrace", graph: graphName, trace: name, props })),
        )
      }
    >
      <div className="flex gap-3">
        <div className="w-36 shrink-0">
          <div className="mb-1 text-muted">Trace</div>
          <NameList
            label="Trace"
            names={names}
            selected={selected}
            onChange={setSelected}
            height={196}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-5">
          <Field label="Mode">
            <Select
              aria-label="Mode"
              value={current.mode}
              onChange={(event) => set({ mode: event.target.value as TraceStyle["mode"] })}
            >
              {TRACE_MODES.map((mode) => (
                <option key={mode}>{mode}</option>
              ))}
            </Select>
          </Field>
          <Field label="Color">
            <ColorField value={current.color} onChange={(color) => set({ color })} />
          </Field>
          <Field label="Line size">
            <TextInput
              aria-label="Line size"
              aria-invalid={parsedLine === null}
              className="w-16"
              value={lineSize ?? String(base.lineSize)}
              onChange={(event) => setLineSize(event.target.value)}
            />
            <Select
              aria-label="Line style"
              disabled={!hasLine}
              value={current.lineStyle}
              onChange={(event) =>
                set({ lineStyle: event.target.value as TraceStyle["lineStyle"] })
              }
            >
              {LINE_STYLES.map((style) => (
                <option key={style}>{style}</option>
              ))}
            </Select>
          </Field>
          <Field label="Marker">
            <Select
              aria-label="Marker"
              disabled={!hasMarkers}
              value={current.marker}
              onChange={(event) => set({ marker: event.target.value as TraceStyle["marker"] })}
            >
              {MARKER_SHAPES.map((shape) => (
                <option key={shape}>{shape}</option>
              ))}
            </Select>
            <TextInput
              aria-label="Marker size"
              aria-invalid={parsedMarker === null}
              disabled={!hasMarkers}
              className="w-14"
              value={markerSize ?? String(base.markerSize)}
              onChange={(event) => setMarkerSize(event.target.value)}
            />
            <Checkbox
              label="Filled"
              disabled={!hasMarkers}
              checked={current.markerFill}
              onChange={(event) => set({ markerFill: event.target.checked })}
            />
          </Field>
          <ErrorField
            label="Y error"
            value={current.yError}
            onChange={(yError) => set({ yError })}
          />
          <ErrorField
            label="X error"
            value={current.xError}
            onChange={(xError) => set({ xError })}
          />
          <Field label="">
            <Checkbox
              label="Hide trace"
              checked={current.hidden}
              onChange={(event) => set({ hidden: event.target.checked })}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

function ModifyAxisDialog({ graph: graphName, axis: initial }: { graph: string; axis?: string }) {
  const graph = useDoc((state) => state.graphs[graphName]);
  const used = new Set<string>(
    graph
      ? [...graph.traces, ...graph.images, ...graph.contours].flatMap((item) => [
          item.vAxis,
          item.hAxis,
        ])
      : [],
  );
  const [axis, setAxis] = useState(initial ?? "left");
  const [changes, setChanges] = useState<Partial<AxisSpec>>({});
  const [min, setMin] = useState<string | null>(null);
  const [max, setMax] = useState<string | null>(null);
  const [span, setSpan] = useState<[string, string] | null>(null);
  const base = graph?.axes[axis];
  if (!graph || !base) return null;
  const current = { ...base, ...changes };
  const set = (patch: Partial<AxisSpec>) => setChanges({ ...changes, ...patch });
  const manual = current.min !== null || current.max !== null || min !== null || max !== null;

  const show = (value: number | null) => (value === null ? "" : formatNumber(value, 10));
  const parsedMin = min === null ? undefined : min.trim() === "" ? null : parseNumber(min);
  const parsedMax = max === null ? undefined : max.trim() === "" ? null : parseNumber(max);
  const invalid =
    (min !== null && min.trim() !== "" && parsedMin === null) ||
    (max !== null && max.trim() !== "" && parsedMax === null);
  const props: Partial<AxisSpec> = { ...changes };
  if (parsedMin !== undefined) props.min = parsedMin;
  if (parsedMax !== undefined) props.max = parsedMax;
  // The span is entered in percent of the plot area.
  const spanLow = span ? parseNumber(span[0]) : null;
  const spanHigh = span ? parseNumber(span[1]) : null;
  const spanInvalid =
    span !== null &&
    (spanLow === null ||
      spanHigh === null ||
      spanLow < 0 ||
      spanHigh > 100 ||
      spanHigh - spanLow < 2);
  if (span && !spanInvalid) props.span = [spanLow! / 100, spanHigh! / 100];

  const switchAxis = (next: string) => {
    setAxis(next);
    setChanges({});
    setMin(null);
    setMax(null);
    setSpan(null);
  };

  return (
    <Dialog
      title={`Modify Axis — ${graphName}`}
      onClose={close}
      submitDisabled={invalid || spanInvalid || Object.keys(props).length === 0}
      onSubmit={() => submit({ op: "modifyAxis", graph: graphName, axis, props })}
    >
      <Field label="Axis">
        <Select aria-label="Axis" value={axis} onChange={(event) => switchAxis(event.target.value)}>
          {Object.keys(graph.axes).map((name) => (
            <option key={name} value={name}>
              {name}
              {used.has(name) ? "" : " (unused)"}
            </option>
          ))}
        </Select>
        <span className="text-muted">on the {base.side}</span>
        <Button onClick={() => ui.set({ dialog: { kind: "addAxis", graph: graphName } })}>
          New Axis…
        </Button>
      </Field>
      <Field label="Label">
        <TextInput
          aria-label="Label"
          className="flex-1"
          disabled={current.label === null}
          placeholder={current.label === null ? "automatic (from units)" : ""}
          value={current.label ?? ""}
          onChange={(event) => set({ label: event.target.value })}
        />
        <Checkbox
          label="Auto"
          checked={current.label === null}
          onChange={(event) => set({ label: event.target.checked ? null : "" })}
        />
      </Field>
      <Field label="Range">
        <TextInput
          aria-label="Minimum"
          aria-invalid={min !== null && min.trim() !== "" && parsedMin === null}
          className="w-24"
          placeholder="auto"
          value={min ?? show(current.min)}
          onChange={(event) => setMin(event.target.value)}
        />
        <span className="text-muted">to</span>
        <TextInput
          aria-label="Maximum"
          aria-invalid={max !== null && max.trim() !== "" && parsedMax === null}
          className="w-24"
          placeholder="auto"
          value={max ?? show(current.max)}
          onChange={(event) => setMax(event.target.value)}
        />
        <Button
          disabled={!manual}
          onClick={() => {
            setMin("");
            setMax("");
          }}
        >
          Autoscale
        </Button>
      </Field>
      <Field label="Scale">
        <Checkbox
          label="Logarithmic"
          checked={current.log}
          onChange={(event) => set({ log: event.target.checked })}
        />
      </Field>
      <Field label="Ticks">
        <Select
          aria-label="Ticks"
          value={current.ticks}
          onChange={(event) => set({ ticks: event.target.value as AxisSpec["ticks"] })}
        >
          {TICK_MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </Select>
        <Checkbox
          label="Minor ticks"
          checked={current.minor}
          onChange={(event) => set({ minor: event.target.checked })}
        />
      </Field>
      <Field label="Mirror">
        <Select
          aria-label="Mirror"
          value={current.mirror}
          onChange={(event) => set({ mirror: event.target.value as AxisSpec["mirror"] })}
        >
          {MIRROR_MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </Select>
        <span className="text-muted">axis on the opposite side</span>
      </Field>
      <Field label="Grid">
        <Select
          aria-label="Grid"
          value={current.grid}
          onChange={(event) => set({ grid: event.target.value as AxisSpec["grid"] })}
        >
          {GRID_MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </Select>
      </Field>
      <Field label="Draw between">
        <TextInput
          aria-label="Span start"
          aria-invalid={spanInvalid}
          className="w-14"
          value={span?.[0] ?? String(Math.round(current.span[0] * 100))}
          onChange={(event) =>
            setSpan([event.target.value, span?.[1] ?? String(Math.round(current.span[1] * 100))])
          }
        />
        <span className="text-muted">and</span>
        <TextInput
          aria-label="Span end"
          aria-invalid={spanInvalid}
          className="w-14"
          value={span?.[1] ?? String(Math.round(current.span[1] * 100))}
          onChange={(event) =>
            setSpan([span?.[0] ?? String(Math.round(current.span[0] * 100)), event.target.value])
          }
        />
        <span className="text-muted">% of the plot area</span>
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        In labels, <code>^{"{...}"}</code> is a superscript and <code>_{"{...}"}</code> a subscript.
      </div>
    </Dialog>
  );
}

function AddAxisDialog({ graph }: { graph: string }) {
  const [name, setName] = useState("L2");
  const [side, setSide] = useState("left");
  return (
    <Dialog
      title={`Add Axis — ${graph}`}
      width={340}
      onClose={close}
      submitDisabled={name.trim() === ""}
      onSubmit={() => {
        if (runGui({ op: "addAxis", graph, name: name.trim(), side }) !== undefined) {
          ui.set({ dialog: { kind: "modifyAxis", graph, axis: name.trim() } });
        }
      }}
    >
      <Field label="Name">
        <TextInput
          aria-label="Axis name"
          className="w-28"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Side">
        <Select aria-label="Side" value={side} onChange={(event) => setSide(event.target.value)}>
          {AXIS_SIDES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Select>
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        Plot against it with Append Traces. To stack plots, give each axis its own part of the plot
        area under &ldquo;Draw between&rdquo;.
      </div>
    </Dialog>
  );
}

function ModifyImageDialog({
  graph: graphName,
  image: imageName,
}: {
  graph: string;
  image: string;
}) {
  const image = useDoc((state) =>
    state.graphs[graphName]?.images.find((item) => item.name === imageName),
  );
  const [changes, setChanges] = useState<Partial<ImageSpec>>({});
  const [zMin, setZMin] = useState<string | null>(null);
  const [zMax, setZMax] = useState<string | null>(null);
  if (!image) return null;
  const current = { ...image, ...changes };
  const limit = (text: string | null) =>
    text === null ? undefined : text.trim() === "" ? null : parseNumber(text);
  const low = limit(zMin);
  const high = limit(zMax);
  const invalid = (zMin?.trim() && low === null) || (zMax?.trim() && high === null);
  const props: Record<string, unknown> = { ...changes };
  if (low !== undefined) props.zMin = low;
  if (high !== undefined) props.zMax = high;
  const show = (value: number | null) => (value === null ? "" : formatNumber(value, 10));
  return (
    <Dialog
      title={`Modify Image ${imageName} — ${graphName}`}
      onClose={close}
      submitDisabled={Boolean(invalid) || Object.keys(props).length === 0}
      onSubmit={() => submit({ op: "modifyImage", graph: graphName, image: imageName, props })}
    >
      <Field label="Color table">
        <ColorTableSelect
          value={current.colorTable}
          onChange={(colorTable) =>
            setChanges({ ...changes, colorTable: colorTable as ImageSpec["colorTable"] })
          }
        />
        <Checkbox
          label="Reverse"
          checked={current.reverse}
          onChange={(event) => setChanges({ ...changes, reverse: event.target.checked })}
        />
      </Field>
      <Field label="Z range">
        <TextInput
          aria-label="Z minimum"
          className="w-24"
          placeholder="auto"
          value={zMin ?? show(current.zMin)}
          onChange={(event) => setZMin(event.target.value)}
        />
        <span className="text-muted">to</span>
        <TextInput
          aria-label="Z maximum"
          className="w-24"
          placeholder="auto"
          value={zMax ?? show(current.zMax)}
          onChange={(event) => setZMax(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}

function ModifyContourDialog({
  graph: graphName,
  contour: contourName,
}: {
  graph: string;
  contour: string;
}) {
  const contour = useDoc((state) =>
    state.graphs[graphName]?.contours.find((item) => item.name === contourName),
  );
  const [changes, setChanges] = useState<Partial<ContourSpec>>({});
  const [levels, setLevels] = useState<string | null>(null);
  const [lineSize, setLineSize] = useState<string | null>(null);
  if (!contour) return null;
  const current = { ...contour, ...changes };
  // Levels: one number is a count; several, separated by commas, are the values.
  const parts =
    levels
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  const numbers = parts.map(Number);
  const levelsInvalid =
    levels !== null &&
    (parts.length === 0 ||
      numbers.some((value) => !Number.isFinite(value)) ||
      (parts.length === 1 &&
        (!Number.isInteger(numbers[0]) || numbers[0]! < 1 || numbers[0]! > 200)));
  const size = lineSize === null ? undefined : parseNumber(lineSize);
  const props: Record<string, unknown> = { ...changes };
  if (levels !== null && !levelsInvalid) props.levels = parts.length === 1 ? numbers[0] : numbers;
  if (typeof size === "number") props.lineSize = size;
  const shown =
    typeof current.levels === "number" ? String(current.levels) : current.levels.join(", ");
  return (
    <Dialog
      title={`Modify Contour ${contourName} — ${graphName}`}
      onClose={close}
      submitDisabled={levelsInvalid || size === null || Object.keys(props).length === 0}
      onSubmit={() =>
        submit({ op: "modifyContour", graph: graphName, contour: contourName, props })
      }
    >
      <Field label="Levels">
        <TextInput
          aria-label="Levels"
          aria-invalid={levelsInvalid}
          className="flex-1"
          value={levels ?? shown}
          onChange={(event) => setLevels(event.target.value)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        A count, or level values separated by commas.
      </div>
      <Field label="Color">
        <Select
          aria-label="Coloring"
          value={current.colorTable ?? "single"}
          onChange={(event) =>
            setChanges({
              ...changes,
              colorTable:
                event.target.value === "single"
                  ? null
                  : (event.target.value as ContourSpec["colorTable"]),
            })
          }
        >
          <option value="single">one color</option>
          {COLOR_TABLES.map((table) => (
            <option key={table}>{table}</option>
          ))}
        </Select>
        {current.colorTable === null ? (
          <ColorField
            value={current.color}
            onChange={(color) => setChanges({ ...changes, color })}
          />
        ) : null}
      </Field>
      <Field label="Line size">
        <TextInput
          aria-label="Line size"
          aria-invalid={size === null}
          className="w-16"
          value={lineSize ?? String(current.lineSize)}
          onChange={(event) => setLineSize(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}

const FONTS: [string, string][] = [
  ["Helvetica / Arial", DEFAULT_FONT_FAMILY],
  ["Times", '"Times New Roman", Times, serif'],
  ["Courier", '"Courier New", Courier, monospace'],
  ["System UI", "system-ui, sans-serif"],
];

function ModifyGraphDialog({ graph: graphName }: { graph: string }) {
  const graph = useDoc((state) => state.graphs[graphName]);
  const [size, setSize] = useState(() => String(graph?.fontSize ?? 12));
  const [family, setFamily] = useState(() => graph?.fontFamily ?? DEFAULT_FONT_FAMILY);
  if (!graph) return null;
  const fontSize = parseNumber(size);
  const props: Record<string, unknown> = {};
  if (fontSize !== null && fontSize !== graph.fontSize) props.fontSize = fontSize;
  if (family !== graph.fontFamily) props.fontFamily = family;
  return (
    <Dialog
      title={`Modify Graph — ${graphName}`}
      onClose={close}
      submitDisabled={fontSize === null || Object.keys(props).length === 0}
      onSubmit={() => submit({ op: "modifyGraph", graph: graphName, props })}
    >
      <Field label="Font">
        <Select
          aria-label="Font"
          value={family}
          onChange={(event) => setFamily(event.target.value)}
          className="flex-1"
        >
          {FONTS.some(([, value]) => value === family) ? null : (
            <option value={family}>{family}</option>
          )}
          {FONTS.map(([label, value]) => (
            <option key={label} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Font size">
        <TextInput
          aria-label="Font size"
          aria-invalid={fontSize === null}
          className="w-16"
          value={size}
          onChange={(event) => setSize(event.target.value)}
        />
        <span className="text-muted">px</span>
      </Field>
    </Dialog>
  );
}

function AddTextDialog({ graph }: { graph: string }) {
  const [text, setText] = useState("");
  const [anchor, setAnchor] = useState("RT");
  const [frame, setFrame] = useState(true);
  return (
    <Dialog
      title={`Add Text — ${graph}`}
      onClose={close}
      submitDisabled={text.trim() === ""}
      onSubmit={() => submit({ op: "addAnnotation", graph, kind: "text", text, anchor, frame })}
    >
      <textarea
        aria-label="Text"
        autoFocus
        rows={4}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
      <Field label="Position">
        <Select
          aria-label="Position"
          value={anchor}
          onChange={(event) => setAnchor(event.target.value)}
        >
          {ANCHORS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Select>
        <Checkbox
          label="Frame"
          checked={frame}
          onChange={(event) => setFrame(event.target.checked)}
        />
      </Field>
    </Dialog>
  );
}

type NameMode = "rename" | "duplicate" | "newFolder" | "renameFolder";

/** One text field: rename or duplicate a wave, make or rename a data folder. */
function NameDialog({ target, mode }: { target: string; mode: NameMode }) {
  const initial =
    mode === "duplicate"
      ? `${target}_copy`
      : mode === "newFolder"
        ? target
          ? `${target}:`
          : ""
        : target;
  const [name, setName] = useState(initial);
  const value = name.trim();
  const titles: Record<NameMode, string> = {
    rename: `Rename ${target}`,
    duplicate: `Duplicate ${target}`,
    newFolder: "New Data Folder",
    renameFolder: `Rename Data Folder ${target}`,
  };
  const command = (): Command => {
    if (mode === "rename") return { op: "renameWave", name: target, newName: value };
    if (mode === "duplicate")
      return { op: "duplicateWave", name: target, newName: value, overwrite: false };
    if (mode === "newFolder") return { op: "newFolder", path: value };
    return { op: "renameFolder", path: target, newPath: value };
  };
  return (
    <Dialog
      title={titles[mode]}
      width={340}
      onClose={close}
      submitDisabled={
        value === "" || value.endsWith(":") || (mode !== "duplicate" && value === target)
      }
      onSubmit={() => submit(command())}
    >
      <Field label={mode === "newFolder" ? "Name" : "New name"}>
        <TextInput
          aria-label="Name"
          className="flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        Use <code>folder:name</code> to put it in a data folder.
      </div>
    </Dialog>
  );
}

function WaveScalingDialog({ wave: name }: { wave: string }) {
  const wave = useDoc((state) => state.waves[name]);
  const [fields, setFields] = useState(() => ({
    x0: formatNumber(wave?.x0 ?? 0, 12),
    dx: formatNumber(wave?.dx ?? 1, 12),
    xUnit: wave?.xUnit ?? "",
    y0: formatNumber(wave?.y0 ?? 0, 12),
    dy: formatNumber(wave?.dy ?? 1, 12),
    yUnit: wave?.yUnit ?? "",
    unit: wave?.unit ?? "",
  }));
  if (!wave) return null;
  const twoD = wave.shape.length > 1;
  const x0 = parseNumber(fields.x0);
  const dx = parseNumber(fields.dx);
  const y0 = parseNumber(fields.y0);
  const dy = parseNumber(fields.dy);
  const bad = (start: number | null, step: number | null) =>
    start === null || step === null || step === 0;
  const invalid = bad(x0, dx) || (twoD && bad(y0, dy));
  const commands: Command[] = [];
  if (!invalid) {
    const scale: Extract<Command, { op: "setWaveScale" }> = { op: "setWaveScale", name };
    if (x0 !== wave.x0) scale.x0 = x0!;
    if (dx !== wave.dx) scale.dx = dx!;
    if (fields.xUnit !== wave.xUnit) scale.xUnit = fields.xUnit;
    if (twoD && y0 !== wave.y0) scale.y0 = y0!;
    if (twoD && dy !== wave.dy) scale.dy = dy!;
    if (twoD && fields.yUnit !== wave.yUnit) scale.yUnit = fields.yUnit;
    if (Object.keys(scale).length > 2) commands.push(scale);
  }
  if (fields.unit !== wave.unit) commands.push({ op: "setWaveMeta", name, unit: fields.unit });
  const input = (key: keyof typeof fields, label: string, className: string, flagged = false) => (
    <TextInput
      aria-label={label}
      aria-invalid={flagged}
      className={className}
      value={fields[key]}
      onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
    />
  );
  return (
    <Dialog
      title={`Change Wave Scaling — ${name}`}
      width={380}
      onClose={close}
      submitDisabled={invalid || commands.length === 0}
      onSubmit={() => submit(commands)}
    >
      <Field label="X start, step">
        {input("x0", "X start", "w-24", x0 === null)}
        {input("dx", "X step", "w-24", dx === null || dx === 0)}
      </Field>
      <Field label="X unit">{input("xUnit", "X unit", "w-20")}</Field>
      {twoD ? (
        <>
          <Field label="Y start, step">
            {input("y0", "Y start", "w-24", y0 === null)}
            {input("dy", "Y step", "w-24", dy === null || dy === 0)}
          </Field>
          <Field label="Y unit">{input("yUnit", "Y unit", "w-20")}</Field>
        </>
      ) : null}
      <Field label="Data unit">{input("unit", "Data unit", "w-20")}</Field>
    </Dialog>
  );
}

function AboutDialog() {
  return (
    <Dialog title="About OresmePro" onClose={close} width={460}>
      <p className="selectable m-0 leading-relaxed">
        OresmePro is named after <b>Nicole Oresme</b> (c. 1320&ndash;1382), the French scholar
        credited with drawing the first graphs: in the 1350s he plotted how a quantity varies by
        setting its intensity (<i>latitudo</i>) against its extent (<i>longitudo</i>), some three
        centuries before Descartes.
      </p>
      <div className="selectable grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
        <b>Enter</b>
        <span>Run the command line (Shift+Enter: new line)</span>
        <b>&uarr; / &darr;</b>
        <span>Earlier commands starting with what you typed</span>
        <b>Ctrl+R</b>
        <span>Search the history</span>
        <b>&rarr;</b>
        <span>Accept the greyed-out suggestion</span>
        <b>Tab</b>
        <span>Complete a Python name</span>
        <b>Ctrl+C</b>
        <span>Interrupt running Python</span>
        <b>Drag in a graph</b>
        <span>Marquee, then choose Expand or Shrink</span>
        <b>Wheel / Alt+drag</b>
        <span>Zoom and pan a graph</span>
        <b>Double-click</b>
        <span>An axis or trace, to modify it</span>
      </div>
    </Dialog>
  );
}

const FIT_FUNCTIONS: [string, string][] = [
  ["line", "a + b·x"],
  ["poly3", "K0 + K1·x + K2·x²"],
  ["poly4", "K0 + K1·x + K2·x² + K3·x³"],
  ["gauss", "y0 + A·exp(−((x−x0)/width)²)"],
  ["lor", "y0 + A/((x−x0)² + B)"],
  ["exp", "y0 + A·exp(−x/tau)"],
  ["dblexp", "y0 + A1·exp(−x/tau1) + A2·exp(−x/tau2)"],
  ["sin", "y0 + A·sin(f·x + phi)"],
  ["power", "y0 + A·x^pow"],
  ["sigmoid", "base + max/(1 + exp((xhalf−x)/rate))"],
];

/** Builds an `op.fit(...)` call; the fit itself runs in Python and reports in the history. */
function CurveFitDialog({ wave: initial }: { wave?: string }) {
  const waves = useNumericWaves(1);
  const graphs = useDoc((state) => state.graphs);
  const windows = useDoc((state) => state.windows);
  const preselected = useUi((state) => state.selectedWaves);
  const [func, setFunc] = useState("gauss");
  const [y, setY] = useState(
    initial ?? preselected.find((name) => waves.includes(name)) ?? waves[0] ?? "",
  );
  const [x, setX] = useState(CALCULATED);
  const [useCursors, setUseCursors] = useState(false);
  // The fit looks at the frontmost graph showing the wave; offer its cursors if both are set.
  const graph = [...windows]
    .reverse()
    .map((window) => graphs[window.name])
    .find((candidate) => candidate?.traces.some((trace) => trace.y === y));
  const hasCursors = Boolean(graph?.cursors.A && graph.cursors.B);
  const formula = FIT_FUNCTIONS.find(([name]) => name === func)?.[1] ?? "";
  const args = [
    pyName(func),
    pyName(y),
    ...(x === CALCULATED ? [] : [`x=${pyName(x)}`]),
    ...(useCursors && hasCursors ? ["cursors=True"] : []),
  ];
  return (
    <Dialog
      title="Curve Fitting"
      onClose={close}
      submitDisabled={y === ""}
      onSubmit={() => {
        runPython(`op.fit(${args.join(", ")})`);
        close();
      }}
    >
      <Field label="Function">
        <Select
          aria-label="Function"
          value={func}
          onChange={(event) => setFunc(event.target.value)}
        >
          {FIT_FUNCTIONS.map(([name]) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
        <span className="selectable truncate font-mono text-[11px] text-muted">{formula}</span>
      </Field>
      <Field label="Y data">
        <Select
          aria-label="Y data"
          value={y}
          onChange={(event) => setY(event.target.value)}
          className="flex-1"
        >
          {waves.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      </Field>
      <Field label="X data">
        <XWaveSelect value={x} onChange={setX} />
      </Field>
      <Field label="Range">
        <Checkbox
          label={
            hasCursors
              ? `Between cursors A and B of ${graph!.name}`
              : "Between cursors (place A and B on the graph first)"
          }
          disabled={!hasCursors}
          checked={useCursors && hasCursors}
          onChange={(event) => setUseCursors(event.target.checked)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Makes <code>fit_{leafName(y) || "wave"}</code>, <code>W_coef</code> and <code>W_sigma</code>
        , and adds the fitted curve to the graph showing the data. For your own function, call{" "}
        <code>op.fit(f, y, guess=[...])</code>.
      </div>
    </Dialog>
  );
}

const ANALYSES: Record<string, { title: string; parameter?: [string, string, string] }> = {
  stats: { title: "Wave Stats" },
  differentiate: { title: "Differentiate" },
  integrate: { title: "Integrate" },
  smooth: { title: "Smooth", parameter: ["n", "Points", "5"] },
  fft: { title: "FFT Magnitude" },
  histogram: { title: "Histogram", parameter: ["bins", "Bins", "50"] },
};

function AnalysisDialog({ operation, wave: initial }: { operation: string; wave?: string }) {
  const waves = useNumericWaves(1);
  const preselected = useUi((state) => state.selectedWaves);
  const spec = ANALYSES[operation]!;
  const [wave, setWave] = useState(
    initial ?? preselected.find((name) => waves.includes(name)) ?? waves[0] ?? "",
  );
  const [value, setValue] = useState(spec.parameter?.[2] ?? "");
  const number = Number(value);
  const invalid = spec.parameter !== undefined && (!Number.isInteger(number) || number < 1);
  const args = [pyName(wave), ...(spec.parameter ? [`${spec.parameter[0]}=${number}`] : [])];
  return (
    <Dialog
      title={spec.title}
      width={360}
      onClose={close}
      submitDisabled={wave === "" || invalid}
      onSubmit={() => {
        runPython(`op.${operation}(${args.join(", ")})`);
        close();
      }}
    >
      <Field label="Wave">
        <Select
          aria-label="Wave"
          value={wave}
          onChange={(event) => setWave(event.target.value)}
          className="flex-1"
        >
          {waves.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
      </Field>
      {spec.parameter ? (
        <Field label={spec.parameter[1]}>
          <TextInput
            aria-label={spec.parameter[1]}
            aria-invalid={invalid}
            className="w-20"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      ) : null}
    </Dialog>
  );
}

function renderDialog(dialog: DialogRequest) {
  switch (dialog.kind) {
    case "newGraph":
      return <NewGraphDialog />;
    case "appendTraces":
      return <NewGraphDialog append={dialog.graph} />;
    case "matrixPlot":
      return <MatrixPlotDialog plot={dialog.plot} graph={dialog.graph} />;
    case "newTable":
      return <NewTableDialog />;
    case "modifyTrace":
      return <ModifyTraceDialog graph={dialog.graph} trace={dialog.trace} />;
    case "modifyAxis":
      return <ModifyAxisDialog graph={dialog.graph} axis={dialog.axis} />;
    case "modifyImage":
      return <ModifyImageDialog graph={dialog.graph} image={dialog.image} />;
    case "modifyContour":
      return <ModifyContourDialog graph={dialog.graph} contour={dialog.contour} />;
    case "addAxis":
      return <AddAxisDialog graph={dialog.graph} />;
    case "modifyGraph":
      return <ModifyGraphDialog graph={dialog.graph} />;
    case "addText":
      return <AddTextDialog graph={dialog.graph} />;
    case "renameWave":
      return <NameDialog target={dialog.wave} mode="rename" />;
    case "duplicateWave":
      return <NameDialog target={dialog.wave} mode="duplicate" />;
    case "newFolder":
      return <NameDialog target={dialog.parent} mode="newFolder" />;
    case "renameFolder":
      return <NameDialog target={dialog.folder} mode="renameFolder" />;
    case "waveScaling":
      return <WaveScalingDialog wave={dialog.wave} />;
    case "curveFit":
      return <CurveFitDialog wave={dialog.wave} />;
    case "analysis":
      return <AnalysisDialog operation={dialog.operation} wave={dialog.wave} />;
    case "about":
      return <AboutDialog />;
  }
}

export function DialogHost() {
  const dialog = useUi((state) => state.dialog);
  const alert = useUi((state) => state.alert);
  return (
    <>
      {dialog ? <div key={JSON.stringify(dialog)}>{renderDialog(dialog)}</div> : null}
      {alert ? (
        <Dialog title={alert.title} width={380} onClose={() => ui.set({ alert: null })}>
          <p role="alert" className="selectable m-0 whitespace-pre-wrap leading-relaxed">
            {alert.message}
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

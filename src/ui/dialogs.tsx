import { useState, type ReactNode } from "react";
import {
  applyLibraryStyle,
  arrangeItems,
  exportStyles,
  importStyles,
  libraryStyleCommands,
  newMatrixPlot,
  pyName,
  runPython,
} from "../app/actions";
import { parseConstraints, parseHold } from "../app/fitOptions";
import {
  doc,
  graphSize,
  requestCommandLine,
  runGui,
  showError,
  ui,
  useDoc,
  useLibraryStyles,
  useUi,
  type DialogRequest,
} from "../app/session";
import { browserLibrary, sameStyle } from "../app/styleLibrary";
import { GRID_GAP, GRID_MARGIN, GRID_PRESETS, readingOrder } from "../core/doc/arrange";
import { checkName, uniqueName, type Command } from "../core/doc/commands";
import { graphScript } from "../core/doc/recreate";
import {
  ANCHORS,
  AXIS_SIDES,
  COLOR_TABLES,
  COMPLEX_PARTS,
  DEFAULT_FONT_FAMILY,
  GRID_MODES,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  TICK_MODES,
  TRACE_COLORS,
  TRACE_MODES,
  WAVE_TYPES,
  isVerticalSide,
  leafName,
  type AxisSpec,
  type ContourSpec,
  type ErrorSource,
  type GraphSpec,
  type ImageSpec,
  type StyleSpec,
  type TraceStyle,
  type WaveType,
} from "../core/doc/types";
import { formatNumber, isTimeZone, timeZone } from "../core/plot/ticks";
import { Button, Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";
import { ImportDialog } from "./ImportDialog";

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
function useNumericWaves(dimensions: 1 | 2): string[] {
  const waves = useDoc((state) => state.waves);
  const order = useDoc((state) => state.waveOrder);
  // "2" means anything that has a plane to show: two dimensions or more.
  return order.filter((name) => {
    const wave = waves[name]!;
    return !wave.text && (dimensions === 1 ? wave.shape.length === 1 : wave.shape.length >= 2);
  });
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

function XWaveSelect({
  value,
  onChange,
  categories,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Also offer text waves, which make category plots. */
  categories?: boolean;
}) {
  const numeric = useNumericWaves(1);
  const waves = useDoc((state) => state.waves);
  const order = useDoc((state) => state.waveOrder);
  const text = categories ? order.filter((name) => waves[name]!.text) : [];
  return (
    <Select
      aria-label="X wave"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="flex-1"
    >
      <option value={CALCULATED}>_calculated_ (from wave scaling)</option>
      {numeric.map((name) => (
        <option key={name}>{name}</option>
      ))}
      {text.map((name) => (
        <option key={name} value={name}>
          {name} (categories)
        </option>
      ))}
    </Select>
  );
}

/** Layer and chunk fields, shown for waves with more than two dimensions. */
function PlaneFields({
  wave,
  layer,
  chunk,
  onChange,
}: {
  wave: string;
  layer: number;
  chunk: number;
  onChange: (plane: { layer?: number; chunk?: number }) => void;
}) {
  const shape = useDoc((state) => state.waves[wave]?.shape);
  if (!shape || shape.length < 3) return null;
  const field = (label: string, value: number, count: number, set: (value: number) => void) => (
    <>
      <input
        type="number"
        aria-label={label}
        min={0}
        max={count - 1}
        value={value}
        className="h-6 w-16 rounded border border-line bg-paper px-1.5"
        onChange={(event) =>
          set(Math.max(0, Math.min(count - 1, Math.round(Number(event.target.value) || 0))))
        }
      />
      <span className="text-muted">of {count}</span>
    </>
  );
  return (
    <>
      <Field label="Layer">
        {field("Layer", layer, shape[2]!, (value) => onChange({ layer: value }))}
      </Field>
      {shape.length > 3 ? (
        <Field label="Chunk">
          {field("Chunk", chunk, shape[3]!, (value) => onChange({ chunk: value }))}
        </Field>
      ) : null}
    </>
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
        <XWaveSelect value={x} onChange={setX} categories />
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
  const [offsets, setOffsets] = useState<{ x: string | null; y: string | null }>({
    x: null,
    y: null,
  });
  const [opacity, setOpacity] = useState<string | null>(null);
  const colorWaves = useNumericWaves(1);
  const complexWaves = useDoc((state) => state.waves);
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
  const parsedX = offsets.x === null ? undefined : parseNumber(offsets.x || "0");
  const parsedY = offsets.y === null ? undefined : parseNumber(offsets.y || "0");
  if (typeof parsedX === "number") sizes.xOffset = parsedX;
  if (typeof parsedY === "number") sizes.yOffset = parsedY;
  // Opacity is entered in percent.
  const parsedOpacity = opacity === null ? undefined : parseNumber(opacity);
  const opacityInvalid =
    parsedOpacity === null ||
    (parsedOpacity !== undefined && (parsedOpacity < 0 || parsedOpacity > 100));
  if (typeof parsedOpacity === "number" && !opacityInvalid) {
    sizes.fillOpacity = parsedOpacity / 100;
  }
  const invalid =
    parsedLine === null ||
    parsedMarker === null ||
    parsedX === null ||
    parsedY === null ||
    opacityInvalid;
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
          {complexWaves[base.y]?.imag ? (
            <Field label="Complex part">
              <Select
                aria-label="Complex part"
                value={current.part}
                onChange={(event) => set({ part: event.target.value as TraceStyle["part"] })}
              >
                {COMPLEX_PARTS.map((part) => (
                  <option key={part}>{part}</option>
                ))}
              </Select>
              <span className="text-muted">of each value</span>
            </Field>
          ) : null}
          <Field label="Fill">
            <Select
              aria-label="Fill"
              value={current.fill}
              onChange={(event) => set({ fill: event.target.value as TraceStyle["fill"] })}
            >
              <option value="none">none</option>
              <option value="zero">to zero</option>
              <option value="next">to next trace</option>
            </Select>
            <TextInput
              aria-label="Fill opacity"
              aria-invalid={opacityInvalid}
              disabled={current.fill === "none"}
              className="w-12"
              value={opacity ?? String(Math.round(base.fillOpacity * 100))}
              onChange={(event) => setOpacity(event.target.value)}
            />
            <span className="text-muted">% opaque</span>
          </Field>
          <Field label="Offset">
            <span className="text-muted">X</span>
            <TextInput
              aria-label="X offset"
              aria-invalid={parsedX === null}
              className="w-20"
              value={offsets.x ?? formatNumber(base.xOffset, 10)}
              onChange={(event) => setOffsets({ ...offsets, x: event.target.value })}
            />
            <span className="text-muted">Y</span>
            <TextInput
              aria-label="Y offset"
              aria-invalid={parsedY === null}
              className="w-20"
              value={offsets.y ?? formatNumber(base.yOffset, 10)}
              onChange={(event) => setOffsets({ ...offsets, y: event.target.value })}
            />
          </Field>
          <Field label="Color by">
            <Select
              aria-label="Color by"
              className="min-w-0 flex-1"
              value={current.colorWave ?? ""}
              onChange={(event) => set({ colorWave: event.target.value || null })}
            >
              <option value="">trace color</option>
              {colorWaves.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
            {current.colorWave !== null ? (
              <ColorTableSelect
                value={current.colorTable}
                onChange={(colorTable) =>
                  set({ colorTable: colorTable as TraceStyle["colorTable"] })
                }
              />
            ) : null}
          </Field>
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
  const [step, setStep] = useState<string | null>(null);
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
  // An empty step goes back to automatic ticks.
  const parsedStep = step === null ? undefined : step.trim() === "" ? null : parseNumber(step);
  const stepInvalid = step !== null && step.trim() !== "" && !(parsedStep! > 0);
  if (parsedStep !== undefined && !stepInvalid) props.tickStep = parsedStep;
  const formats: [string, string][] = [
    ["", "Automatic"],
    [".0f", "0 decimals"],
    [".1f", "1 decimal"],
    [".2f", "2 decimals"],
    [".3f", "3 decimals"],
    [",.0f", "Thousands: 12,000"],
    [".1e", "Scientific: 1.2×10⁴"],
    ["%", "Percent"],
  ];
  if (current.tickFormat && !formats.some(([value]) => value === current.tickFormat)) {
    formats.push([current.tickFormat, current.tickFormat]);
  }

  const switchAxis = (next: string) => {
    setAxis(next);
    setChanges({});
    setMin(null);
    setMax(null);
    setSpan(null);
    setStep(null);
  };

  return (
    <Dialog
      title={`Modify Axis — ${graphName}`}
      onClose={close}
      submitDisabled={invalid || spanInvalid || stepInvalid || Object.keys(props).length === 0}
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
      <Field label="Scale" group>
        <Checkbox
          label="Logarithmic"
          checked={current.log}
          onChange={(event) => set({ log: event.target.checked })}
        />
        <Checkbox
          label="Reversed"
          checked={current.reverse}
          onChange={(event) => set({ reverse: event.target.checked })}
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
        <span className="text-muted">every</span>
        <TextInput
          aria-label="Tick step"
          aria-invalid={stepInvalid}
          className="w-16"
          placeholder="auto"
          disabled={current.log}
          value={step ?? show(current.tickStep)}
          onChange={(event) => setStep(event.target.value)}
        />
      </Field>
      <Field label="Tick labels">
        <Select
          aria-label="Tick labels"
          value={current.tickFormat ?? ""}
          onChange={(event) => set({ tickFormat: event.target.value || null })}
        >
          {formats.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
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
      <PlaneFields
        wave={image.wave}
        layer={current.layer}
        chunk={current.chunk}
        onChange={(plane) => setChanges({ ...changes, ...plane })}
      />
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
      <Field label="Labels">
        <Checkbox
          label="Write each level's value on its line"
          checked={current.labels}
          onChange={(event) => setChanges({ ...changes, labels: event.target.checked })}
        />
      </Field>
      <PlaneFields
        wave={contour.wave}
        layer={current.layer}
        chunk={current.chunk}
        onChange={(plane) => setChanges({ ...changes, ...plane })}
      />
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

/** Adds a text box, or changes a legend, text box, color scale or tag that is there. */
function AddTextDialog({ graph, annotation }: { graph: string; annotation?: string }) {
  const existing = useDoc((state) =>
    state.graphs[graph]?.annotations.find((item) => item.name === annotation),
  );
  const [text, setText] = useState(existing?.text ?? "");
  const [anchor, setAnchor] = useState<string>(existing?.anchor ?? "RT");
  const [frame, setFrame] = useState(existing?.frame ?? true);
  if (annotation && !existing) return null;
  const kind = existing?.kind ?? "text";
  const hint =
    kind === "legend"
      ? "Leave empty to list every trace. \\s(traceName) draws a trace's symbol."
      : kind === "tag"
        ? "{x}, {y} and {point} stand for the point's values. Leave empty to show x, y."
        : kind === "colorscale"
          ? ""
          : "^{...} is a superscript and _{...} a subscript.";
  const props: Record<string, unknown> = {};
  if (existing) {
    if (text !== existing.text) props.text = text;
    if (anchor !== existing.anchor) {
      // A new anchor is a new home: start from there, not from where it was dragged to.
      Object.assign(props, { anchor, x: 0, y: 0 });
    }
    if (frame !== existing.frame) props.frame = frame;
  }
  return (
    <Dialog
      title={existing ? `Modify ${existing.name} — ${graph}` : `Add Text — ${graph}`}
      onClose={close}
      submitDisabled={existing ? Object.keys(props).length === 0 : text.trim() === ""}
      onSubmit={() =>
        submit(
          existing
            ? { op: "modifyAnnotation", graph, annotation: existing.name, props }
            : { op: "addAnnotation", graph, kind: "text", text, anchor, frame },
        )
      }
    >
      {kind === "colorscale" ? null : (
        <textarea
          aria-label="Text"
          autoFocus
          rows={4}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      )}
      {hint ? <div className="text-[11px] text-muted">{hint}</div> : null}
      <Field label={kind === "tag" ? "Box" : "Position"}>
        {kind === "tag" ? null : (
          <Select
            aria-label="Position"
            value={anchor}
            onChange={(event) => setAnchor(event.target.value)}
          >
            {ANCHORS.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
        )}
        <Checkbox
          label="Frame"
          checked={frame}
          onChange={(event) => setFrame(event.target.checked)}
        />
        {existing ? (
          <Button
            onClick={() => {
              close();
              runGui({ op: "removeAnnotation", graph, annotation: existing.name });
            }}
          >
            Remove
          </Button>
        ) : null}
      </Field>
      <div className="text-[11px] text-muted">Drag it in the graph to move it.</div>
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

const TYPE_NOTES: Record<WaveType, string> = {
  float64: "double precision, 8 bytes a point",
  float32: "single precision, 4 bytes a point",
  int8: "whole numbers −128 to 127",
  uint8: "whole numbers 0 to 255",
  int16: "whole numbers −32768 to 32767",
  uint16: "whole numbers 0 to 65535",
  int32: "whole numbers to ±2.1 billion",
  uint32: "whole numbers 0 to 4.3 billion",
  complex128: "complex, double precision",
  complex64: "complex, single precision",
};

/** Changes the number type of a wave, as Igor's Redimension does. */
function WaveTypeDialog({ wave: name }: { wave: string }) {
  const wave = useDoc((state) => state.waves[name]);
  const [type, setType] = useState<string>(wave?.type ?? "float64");
  if (!wave || wave.text) return null;
  const loses =
    (wave.imag !== null && !type.startsWith("complex")) ||
    (type.includes("int") && !wave.type.includes("int")) ||
    (type.endsWith("32") && wave.type.endsWith("64")) ||
    (type === "complex64" && wave.type === "complex128");
  return (
    <Dialog
      title={`Change Wave Type — ${leafName(name)}`}
      width={400}
      onClose={close}
      submitDisabled={type === wave.type}
      onSubmit={() => submit({ op: "redimension", name, type })}
    >
      <Field label="Type">
        <Select aria-label="Type" value={type} onChange={(event) => setType(event.target.value)}>
          {WAVE_TYPES.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </Select>
        <span className="truncate text-muted">{TYPE_NOTES[type as WaveType]}</span>
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Now {wave.type}.{" "}
        {loses
          ? "Values the new type cannot hold are rounded, held at its limits, or lose their imaginary part."
          : "Every value is kept as it is."}
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

/** Shows the Python that draws a graph again, to copy or to keep in a procedure. */
function GraphScriptDialog({ graph }: { graph: string }) {
  const state = useDoc((current) => current);
  const [copied, setCopied] = useState(false);
  let script = "";
  try {
    script = graphScript(state, graph);
  } catch {
    // The graph was closed while the dialog was open.
  }
  const body = script
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const asFunction = `def recreate_${graph}():\n${body}\n    return g\n`;
  const toProcedure = () => {
    const existing = Object.values(state.procedures)[0];
    const name = existing?.name ?? runGui({ op: "newProcedure" });
    if (!name) return;
    const before = existing?.code ?? "";
    const gap = before.trim() === "" ? "" : `${before.replace(/\s+$/, "")}\n\n\n`;
    doc.dispatch({ op: "setProcedure", name, code: `${gap}${asFunction}` });
    doc.dispatch({ op: "activateWindow", name });
    close();
  };
  return (
    <Dialog title={`Recreation Script for ${graph}`} onClose={close} width={620}>
      <p className="m-0 leading-relaxed text-muted">
        Python that draws this graph again. Run as it is, it makes a new graph and leaves this one
        alone.
      </p>
      <pre
        aria-label="Script"
        className="selectable m-0 max-h-[40vh] overflow-auto rounded border border-line bg-paper p-2 font-mono text-[11.5px] leading-[1.45]"
      >
        {script}
      </pre>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(script).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          onClick={() => {
            requestCommandLine(script);
            close();
          }}
        >
          To Command Line
        </Button>
        <Button onClick={toProcedure}>Add to Procedure as a Function</Button>
      </div>
    </Dialog>
  );
}

/** What a style holds, in a few words. */
function describeStyle(style: StyleSpec): string {
  const parts: string[] = [];
  const { graph, size, axes, traces } = style;
  if (graph) {
    const family =
      graph.fontFamily === undefined
        ? ""
        : (FONTS.find(([, value]) => value === graph.fontFamily)?.[0] ?? graph.fontFamily);
    const fontSize = graph.fontSize === undefined ? "" : `${graph.fontSize} px`;
    parts.push(`font ${[fontSize, family].filter(Boolean).join(" ")}`);
  }
  if (axes) parts.push(`axes ${Object.keys(axes).join(", ")}`);
  if (traces) parts.push(`${traces.length} trace look${traces.length === 1 ? "" : "s"}`);
  if (size) parts.push(`size ${size.width} × ${size.height}`);
  return parts.join(" · ") || "nothing yet";
}

const isStyleName = (name: string): boolean => {
  try {
    checkName(name, "style");
    return true;
  } catch {
    return false;
  }
};

/** Runs something on the browser's library, telling the user if the browser would not. */
function inLibrary(action: () => void): void {
  try {
    action();
  } catch (error) {
    showError("The style library did not change", error);
  }
}

type StylePlace = "experiment" | "library";

/**
 * The styles of the experiment and of the browser's library: save a graph's
 * look as one, give it to graphs, choose the one new graphs get, and move
 * styles between the experiment, the library and files.
 */
function StylesDialog({ graph: initial }: { graph?: string }) {
  const styles = useDoc((state) => state.styles);
  const defaultStyle = useDoc((state) => state.defaultStyle);
  const windows = useDoc((state) => state.windows);
  const graph = useDoc((state) => (initial && state.graphs[initial] ? initial : null));
  const current = useDoc((state) => (graph ? state.graphs[graph]!.style : null));
  const width = useDoc((state) => (graph ? graphSize(state, graph).width : 0));
  const height = useDoc((state) => (graph ? graphSize(state, graph).height : 0));
  const library = useLibraryStyles();
  const graphNames = windows.filter((window) => window.kind === "graph").map((w) => w.name);

  const [name, setName] = useState(
    () => current ?? uniqueName("style", (taken) => taken in doc.getState().styles),
  );
  const [withSize, setWithSize] = useState(false);
  const [picked, setPicked] = useState<{ place: StylePlace; names: string[] }>(() => ({
    place: "experiment",
    names: current ? [current] : [],
  }));
  const [targets, setTargets] = useState<string[]>(graph ? [graph] : []);
  const [renaming, setRenaming] = useState<string | null>(null);

  const source = (place: StylePlace) => (place === "experiment" ? styles : library);
  const chosen = picked.names.filter((item) => item in source(picked.place));
  const one = chosen.length === 1 ? chosen[0]! : null;
  const style = one ? source(picked.place)[one] : undefined;
  const pick = (place: StylePlace) => (names: string[]) => {
    setPicked({ place, names });
    setRenaming(null);
  };

  const save = () => {
    if (!graph) return;
    if (name in styles && !window.confirm(`Replace the style ${name}?`)) return;
    const command: Command = { op: "saveStyle", name, graph, ...(withSize ? { size: true } : {}) };
    if (runGui(command) !== undefined) pick("experiment")([name]);
  };
  const apply = (list: readonly string[]) => {
    if (!one || list.length === 0) return;
    if (picked.place === "library") applyLibraryStyle(one, list);
    else runGui({ op: "applyStyle", style: one, graphs: list });
  };
  const rename = () => {
    if (!one || renaming === null) return;
    const newName = renaming.trim();
    if (picked.place === "experiment") {
      if (runGui({ op: "renameStyle", name: one, newName }) === undefined) return;
    } else {
      let done = false;
      inLibrary(() => {
        browserLibrary().rename(one, newName);
        done = true;
      });
      if (!done) return;
    }
    pick(picked.place)([newName]);
  };
  const remove = () => {
    if (picked.place === "experiment") {
      runGui(chosen.map((item): Command => ({ op: "removeStyle", name: item })));
    } else if (
      window.confirm(`Delete ${chosen.join(", ")} from the library? This cannot be undone.`)
    ) {
      inLibrary(() => {
        for (const item of chosen) browserLibrary().remove(item);
      });
    }
  };
  const toLibrary = () =>
    inLibrary(() => {
      for (const item of chosen) {
        const there = library[item];
        if (
          there &&
          !sameStyle(there, styles[item]!) &&
          !window.confirm(`The library has a style ${item} already. Replace it?`)
        ) {
          continue;
        }
        browserLibrary().put(item, styles[item]!);
      }
    });
  const toExperiment = () => {
    const commands: Command[] = [];
    for (const item of chosen) commands.push(...(libraryStyleCommands(item) ?? []));
    runGui(commands);
  };

  const list = (place: StylePlace, title: string, buttons: ReactNode) => {
    const names = Object.keys(source(place));
    const selected = picked.place === place ? chosen : [];
    const renamingHere = renaming !== null && picked.place === place && one !== null;
    return (
      <div role="group" aria-label={title} className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-muted">{title}</div>
        <NameList
          label={title}
          names={names}
          selected={selected}
          onChange={pick(place)}
          height={120}
        />
        {renamingHere ? (
          <div className="flex gap-1.5">
            <TextInput
              aria-label="New name"
              aria-invalid={!isStyleName(renaming.trim())}
              autoFocus
              className="min-w-0 flex-1"
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  rename();
                }
              }}
            />
            <Button disabled={!isStyleName(renaming.trim())} onClick={rename}>
              Rename
            </Button>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button
              disabled={selected.length !== 1}
              onClick={() => setRenaming(selected[0] ?? null)}
            >
              Rename…
            </Button>
            <Button disabled={selected.length === 0} onClick={remove}>
              Delete
            </Button>
            {buttons}
            <Button
              disabled={selected.length === 0}
              onClick={() =>
                exportStyles(selected.map((item) => [item, source(place)[item]!] as const))
              }
            >
              Export…
            </Button>
          </div>
        )}
      </div>
    );
  };

  const libraryMissing = !browserLibrary().available;
  return (
    <Dialog title="Graph Styles" onClose={close} width={660}>
      {graph ? (
        <div role="group" aria-label="Save style" className="flex flex-col gap-1.5">
          <Field label={`Save ${graph} as`} group>
            <TextInput
              aria-label="Style name"
              aria-invalid={!isStyleName(name)}
              className="w-36"
              value={name}
              onChange={(event) => setName(event.target.value.trim())}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isStyleName(name)) {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <Checkbox
              label={`Include size (${width} × ${height})`}
              checked={withSize}
              onChange={(event) => setWithSize(event.target.checked)}
            />
            <Button disabled={!isStyleName(name)} onClick={save}>
              Save
            </Button>
          </Field>
          <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
            A style keeps fonts, ticks, mirror axes, grids and each trace&apos;s color, line and
            markers; not ranges, labels or data.
          </div>
        </div>
      ) : null}
      <div className="flex gap-3 border-t border-line-soft pt-2">
        {list(
          "experiment",
          "In this experiment",
          <Button
            disabled={chosen.length === 0 || picked.place !== "experiment" || libraryMissing}
            onClick={toLibrary}
          >
            To Library
          </Button>,
        )}
        {list(
          "library",
          "Library (this browser)",
          <>
            <Button
              disabled={chosen.length === 0 || picked.place !== "library"}
              onClick={toExperiment}
            >
              To Experiment
            </Button>
            <Button disabled={libraryMissing} onClick={importStyles}>
              Import…
            </Button>
          </>,
        )}
      </div>
      {libraryMissing ? (
        <div className="text-[11px] text-muted">
          This browser keeps no library: its storage is turned off. Export styles to keep them.
        </div>
      ) : null}
      <div className="text-[11px] text-muted">
        {one && style
          ? `${one}: ${describeStyle(style)}`
          : "Select a style to see what it holds and to apply it."}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
        <Field label="New graphs get">
          <Select
            aria-label="Default style"
            value={defaultStyle ?? ""}
            onChange={(event) =>
              runGui({ op: "setDefaultStyle", name: event.target.value || null })
            }
          >
            <option value="">No style</option>
            {Object.keys(styles).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </Select>
        </Field>
        <Field label="Apply to" group>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <NameList
              label="Graphs"
              names={graphNames}
              selected={targets.filter((item) => graphNames.includes(item))}
              onChange={setTargets}
              height={84}
            />
            <div className="flex flex-wrap gap-1.5">
              {graph ? (
                <Button disabled={!one} onClick={() => apply([graph])}>
                  Apply to {graph}
                </Button>
              ) : null}
              <Button
                disabled={!one || targets.length === 0}
                onClick={() => apply(targets.filter((item) => graphNames.includes(item)))}
              >
                Apply to Selected Graphs
              </Button>
              <Button disabled={!one || graphNames.length === 0} onClick={() => apply(graphNames)}>
                Apply to All Graphs
              </Button>
            </div>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

/** Adds a block of text to a page layout, or changes one that is there. */
function PageTextDialog({ layout, item }: { layout: string; item?: string }) {
  const existing = useDoc((state) =>
    state.pages[layout]?.items.find((other) => other.name === item),
  );
  const [text, setText] = useState(existing?.text ?? "");
  const [size, setSize] = useState(String(existing?.size ?? 12));
  if (item && !existing) return null;
  const points = parseNumber(size);
  const invalid = points === null || points < 4 || points > 200;
  const props: Record<string, unknown> = {};
  if (existing) {
    if (text !== existing.text) props.text = text;
    if (!invalid && points !== existing.size) props.size = points;
  }
  return (
    <Dialog
      title={existing ? `Edit Text — ${layout}` : `Add Text — ${layout}`}
      onClose={close}
      submitDisabled={
        invalid || text.trim() === "" || (existing ? Object.keys(props).length === 0 : false)
      }
      onSubmit={() =>
        submit(
          existing
            ? { op: "modifyLayoutItem", layout, item: existing.name, props }
            : { op: "addLayoutItem", layout, kind: "text", text, size: points! },
        )
      }
    >
      <textarea
        aria-label="Text"
        autoFocus
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
      <Field label="Size">
        <TextInput
          aria-label="Size"
          aria-invalid={invalid}
          className="w-16"
          value={size}
          onChange={(event) => setSize(event.target.value)}
        />
        <span className="text-muted">points</span>
      </Field>
    </Dialog>
  );
}

/**
 * Puts graphs of a page layout in a grid of rows and columns that fills the
 * paper inside its margins: the selected graphs, or all of them.
 */
function ArrangeLayoutDialog({ layout, items }: { layout: string; items: readonly string[] }) {
  const page = useDoc((state) =>
    Object.hasOwn(state.pages, layout) ? state.pages[layout] : undefined,
  );
  const [rows, setRows] = useState("2");
  const [columns, setColumns] = useState("2");
  const [margin, setMargin] = useState(String(GRID_MARGIN));
  const [across, setAcross] = useState(String(GRID_GAP));
  const [down, setDown] = useState(String(GRID_GAP));
  if (!page) return null;
  const count = (text: string) => {
    const value = parseNumber(text);
    return value !== null && Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
  };
  const points = (text: string) => {
    const value = parseNumber(text);
    return value !== null && value >= 0 ? value : null;
  };
  const values = {
    rows: count(rows),
    columns: count(columns),
    margin: points(margin),
    across: points(across),
    down: points(down),
  };
  const valid = Object.values(values).every((value) => value !== null);
  // The order the cells are filled in, as Python would take them.
  const graphs = page.items.filter((item) => item.kind === "graph");
  const order =
    items.length > 0 ? [...items] : readingOrder(graphs).map((index) => graphs[index]!.name);
  const cells = (values.rows ?? 0) * (values.columns ?? 0);
  const leftOut = valid ? order.slice(cells) : [];
  const number = (
    label: string,
    value: string,
    set: (text: string) => void,
    invalid: boolean,
    unit?: string,
  ) => (
    <Field label={label}>
      <TextInput
        aria-label={label}
        aria-invalid={invalid}
        className="w-16"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
      {unit ? <span className="text-muted">{unit}</span> : null}
    </Field>
  );
  return (
    <Dialog
      title={`Arrange in Grid — ${layout}`}
      onClose={close}
      submitDisabled={!valid}
      onSubmit={() => {
        const done = arrangeItems(layout, {
          action: "arrange",
          items: items.length > 0 ? items : null,
          rows: values.rows!,
          columns: values.columns!,
          margin: values.margin!,
          gap: [values.across!, values.down!],
        });
        if (done) close();
      }}
    >
      <Field label="Presets" group>
        {GRID_PRESETS.map(([presetRows, presetColumns]) => (
          <Button
            key={`${presetRows}x${presetColumns}`}
            className="!px-2"
            aria-pressed={values.rows === presetRows && values.columns === presetColumns}
            onClick={() => {
              setRows(String(presetRows));
              setColumns(String(presetColumns));
            }}
          >
            {presetRows} × {presetColumns}
          </Button>
        ))}
      </Field>
      {number("Rows", rows, setRows, values.rows === null)}
      {number("Columns", columns, setColumns, values.columns === null)}
      {number("Margin", margin, setMargin, values.margin === null, "points around the grid")}
      <Field label="Gaps" group>
        <TextInput
          aria-label="Gap between columns"
          aria-invalid={values.across === null}
          className="w-16"
          value={across}
          onChange={(event) => setAcross(event.target.value)}
        />
        <span className="text-muted">across,</span>
        <TextInput
          aria-label="Gap between rows"
          aria-invalid={values.down === null}
          className="w-16"
          value={down}
          onChange={(event) => setDown(event.target.value)}
        />
        <span className="text-muted">down, in points</span>
      </Field>
      <p className="m-0 pl-[104px] text-[11px] leading-relaxed text-muted">
        {items.length > 0
          ? `The ${order.length} selected graph${order.length === 1 ? "" : "s"}`
          : `All ${order.length} graph${order.length === 1 ? "" : "s"} of the page`}{" "}
        fill the cells row by row, in the order they read on the page now. Text stays where it is.
        {leftOut.length > 0
          ? ` ${leftOut.join(", ")} ${leftOut.length === 1 ? "does" : "do"} not fit and ${
              leftOut.length === 1 ? "stays" : "stay"
            } where ${leftOut.length === 1 ? "it is" : "they are"}.`
          : ""}
      </p>
    </Dialog>
  );
}

/** Chooses the time zone dates are shown and typed in. */
function TimeZoneDialog() {
  const current = useDoc((state) => state.timeZone);
  const [choice, setChoice] = useState(
    current === "UTC" || current === "local" ? current : "other",
  );
  const [name, setName] = useState(current === "UTC" || current === "local" ? "" : current);
  const zone = choice === "other" ? name.trim() : choice;
  const valid = isTimeZone(zone);
  const here = timeZone("local").label;
  return (
    <Dialog
      title="Time Zone for Dates"
      width={400}
      onClose={close}
      submitDisabled={!valid || zone === current}
      onSubmit={() => submit({ op: "setTimeZone", zone })}
    >
      <p className="m-0 leading-relaxed text-muted">
        Date waves hold moments in time. This sets the clock they are read on: on graph axes, in
        tables, and for dates typed or loaded without an offset.
      </p>
      <Field label="Show dates in">
        <Select
          aria-label="Time zone"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="UTC">UTC</option>
          <option value="local">This computer's zone ({here})</option>
          <option value="other">Another zone…</option>
        </Select>
      </Field>
      {choice === "other" ? (
        <Field label="Zone name">
          <TextInput
            aria-label="Zone name"
            aria-invalid={name.trim() !== "" && !valid}
            className="flex-1"
            placeholder="Asia/Tokyo"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      ) : null}
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
  const [hold, setHold] = useState("");
  const [constraints, setConstraints] = useState("");
  const [weight, setWeight] = useState("");
  const [residuals, setResiduals] = useState(false);
  const [band, setBand] = useState(false);
  // The fit looks at the frontmost graph showing the wave; offer its cursors if both are set.
  const graph = [...windows]
    .reverse()
    .map((window) => graphs[window.name])
    .find((candidate) => candidate?.traces.some((trace) => trace.y === y));
  const hasCursors = Boolean(graph?.cursors.A && graph.cursors.B);
  const formula = FIT_FUNCTIONS.find(([name]) => name === func)?.[1] ?? "";
  const held = parseHold(hold);
  const limits = parseConstraints(constraints);
  const args = [
    pyName(func),
    pyName(y),
    ...(x === CALCULATED ? [] : [`x=${pyName(x)}`]),
    ...(held ? [`hold=${held}`] : []),
    ...(limits ? [`bounds=${limits}`] : []),
    ...(weight === "" ? [] : [`sigma=${pyName(weight)}`]),
    ...(useCursors && hasCursors ? ["cursors=True"] : []),
    ...(residuals ? ["residuals=True"] : []),
    ...(band ? ["band=0.95"] : []),
  ];
  return (
    <Dialog
      title="Curve Fitting"
      onClose={close}
      submitDisabled={y === "" || held === null || limits === null}
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
      <Field label="Weighting">
        <Select
          aria-label="Weighting"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
          className="flex-1"
        >
          <option value="">none</option>
          {waves
            .filter((name) => name !== y)
            .map((name) => (
              <option key={name} value={name}>
                {name} (standard deviations)
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Hold">
        <TextInput
          aria-label="Hold"
          aria-invalid={held === null}
          className="flex-1"
          placeholder="e.g. y0=0, width=1.5"
          value={hold}
          onChange={(event) => setHold(event.target.value)}
        />
      </Field>
      <Field label="Constraints">
        <TextInput
          aria-label="Constraints"
          aria-invalid={limits === null}
          className="flex-1"
          placeholder="e.g. A > 0, 2 < x0 < 5"
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
        />
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
      <Field label="Also make" group>
        <Checkbox
          label="Residuals"
          checked={residuals}
          onChange={(event) => setResiduals(event.target.checked)}
        />
        <Checkbox
          label="95% confidence band"
          checked={band}
          onChange={(event) => setBand(event.target.checked)}
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

interface AnalysisField {
  /** The keyword argument. */
  key: string;
  label: string;
  initial: string;
  /** integer and number are typed in; anything else is a list of choices. */
  kind: "integer" | "number" | readonly string[];
  /** May be left empty, which leaves the argument out. */
  optional?: boolean;
  hint?: string;
}

const ANALYSES: Record<
  string,
  { title: string; dimensions?: 1 | 2; fields?: AnalysisField[]; note?: string }
> = {
  stats: { title: "Wave Stats" },
  differentiate: { title: "Differentiate" },
  integrate: { title: "Integrate" },
  smooth: {
    title: "Smooth",
    fields: [{ key: "n", label: "Points", initial: "5", kind: "integer" }],
  },
  fft: {
    title: "FFT",
    fields: [
      { key: "output", label: "Result", initial: "magnitude", kind: ["magnitude", "complex"] },
    ],
    note: "The complex result keeps the spectrum itself, which op.ifft turns back into the signal.",
  },
  histogram: {
    title: "Histogram",
    fields: [{ key: "bins", label: "Bins", initial: "50", kind: "integer" }],
  },
  interpolate: {
    title: "Interpolate",
    fields: [
      { key: "n", label: "Points", initial: "200", kind: "integer" },
      { key: "kind", label: "Method", initial: "linear", kind: ["linear", "cubic"] },
    ],
    note: "Makes a wave with evenly spaced points over the same X range.",
  },
  fit_peaks: {
    title: "Multi-peak Fit",
    fields: [
      { key: "shape", label: "Peak shape", initial: "gauss", kind: ["gauss", "lor"] },
      {
        key: "baseline",
        label: "Baseline",
        initial: "constant",
        kind: ["constant", "linear", "None"],
      },
      {
        key: "peaks",
        label: "Peaks",
        initial: "",
        kind: "integer",
        optional: true,
        hint: "how many of the tallest; empty finds them",
      },
      {
        key: "smooth",
        label: "Smooth first",
        initial: "",
        kind: "integer",
        optional: true,
        hint: "points, for noisy data",
      },
    ],
    note: "Fits a sum of peaks and lists position, height, width and area of each.",
  },
  filter_image: {
    title: "Filter Image",
    dimensions: 2,
    fields: [
      {
        key: "kind",
        label: "Filter",
        initial: "gauss",
        kind: ["gauss", "mean", "median", "sharpen"],
      },
      {
        key: "size",
        label: "Size",
        initial: "3",
        kind: "number",
        hint: "pixels (odd, for mean and median)",
      },
    ],
  },
};

function AnalysisDialog({ operation, wave: initial }: { operation: string; wave?: string }) {
  const spec = ANALYSES[operation]!;
  const waves = useNumericWaves(spec.dimensions ?? 1);
  const preselected = useUi((state) => state.selectedWaves);
  const [wave, setWave] = useState(
    initial ?? preselected.find((name) => waves.includes(name)) ?? waves[0] ?? "",
  );
  const fields = spec.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.initial])),
  );
  const args = [pyName(wave)];
  let invalid = false;
  const bad = new Set<string>();
  for (const field of fields) {
    const text = (values[field.key] ?? "").trim();
    if (typeof field.kind !== "string") {
      // The Python None is the one choice that is not a string.
      args.push(`${field.key}=${text === "None" ? "None" : JSON.stringify(text)}`);
      continue;
    }
    if (text === "" && field.optional) continue;
    const number = Number(text);
    const ok =
      text !== "" &&
      Number.isFinite(number) &&
      number > 0 &&
      (field.kind === "number" || Number.isInteger(number));
    if (!ok) {
      invalid = true;
      bad.add(field.key);
    } else {
      args.push(`${field.key}=${number}`);
    }
  }
  return (
    <Dialog
      title={spec.title}
      width={400}
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
      {fields.map((field) => (
        <Field key={field.key} label={field.label}>
          {typeof field.kind === "string" ? (
            <TextInput
              aria-label={field.label}
              aria-invalid={bad.has(field.key)}
              className="w-20"
              value={values[field.key] ?? ""}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          ) : (
            <Select
              aria-label={field.label}
              value={values[field.key]}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            >
              {field.kind.map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </Select>
          )}
          {field.hint ? <span className="text-muted">{field.hint}</span> : null}
        </Field>
      ))}
      {spec.note ? (
        <div className="pl-[104px] text-[11px] leading-relaxed text-muted">{spec.note}</div>
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
    case "editAnnotation":
      return <AddTextDialog graph={dialog.graph} annotation={dialog.annotation} />;
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
    case "waveType":
      return <WaveTypeDialog wave={dialog.wave} />;
    case "curveFit":
      return <CurveFitDialog wave={dialog.wave} />;
    case "analysis":
      return <AnalysisDialog operation={dialog.operation} wave={dialog.wave} />;
    case "graphScript":
      return <GraphScriptDialog graph={dialog.graph} />;
    case "styles":
      return <StylesDialog graph={dialog.graph} />;
    case "timeZone":
      return <TimeZoneDialog />;
    case "pageText":
      return <PageTextDialog layout={dialog.layout} item={dialog.item} />;
    case "arrangeLayout":
      return <ArrangeLayoutDialog layout={dialog.layout} items={dialog.items} />;
    case "importData":
      // Keyed by the file: the next file starts from its own preset, not this one's choices.
      return (
        <ImportDialog
          key={`${dialog.file.name}:${dialog.rest.length}`}
          file={dialog.file}
          rest={dialog.rest}
        />
      );
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

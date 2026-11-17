/** The dialogs that change a graph: traces, axes, images, contours, the graph, drawings and text. */
import { useMemo, useRef, useState } from "react";
import { newMatrixPlot } from "../app/actions";
import { doc, exportLayout, requestCommandLine, runGui, ui, useDoc, useUi } from "../app/session";
import { graphScript } from "../core/doc/recreate";
import {
  ANCHORS,
  AXIS_LABEL_MODES,
  AXIS_SIDES,
  COLOR_TABLES,
  COMPLEX_PARTS,
  DEFAULT_FONT_FAMILY,
  GRID_MODES,
  LABEL_STYLES,
  LINE_STYLES,
  MAGNIFICATIONS,
  MARGIN_PROPS,
  MARKER_SHAPES,
  MAX_MARGIN,
  MIRROR_MODES,
  TICK_MODES,
  TRACE_MODES,
  type AxisLabelMode,
  type AxisSide,
  type AxisSpec,
  type ContourSpec,
  type DrawingSpec,
  type ImageSpec,
  type LabelStyle,
  type TraceStyle,
} from "../core/doc/types";
import { SCREEN_UNITS_PER_POINT } from "../core/plot/plotSize";
import { formatNumber } from "../core/plot/ticks";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  MarkupButtons,
  MarkupHelp,
  NameList,
  Select,
  TextInput,
} from "./controls";
import {
  PLOT_SIZE_HINT,
  PlotSideFields,
  plotSideDraft,
  plotSideOf,
  plotSizeProblem,
} from "./PlotSizeFields";
import {
  AxisSelects,
  ColorField,
  ColorTableSelect,
  ErrorField,
  PlaneFields,
  close,
  parseNumber,
  submit,
  useNumericWaves,
} from "./dialogParts";

/** New image or contour plot of a 2-D wave, in a new graph or added to one. */
export function MatrixPlotDialog({
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

export function ModifyTraceDialog({ graph: graphName, trace }: { graph: string; trace?: string }) {
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
  const labelWaves = useMemo(
    () =>
      Object.values(complexWaves)
        .filter((wave) => wave.shape.length === 1)
        .map((wave) => wave.name)
        .sort((a, b) => a.localeCompare(b)),
    [complexWaves],
  );
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
      help="guides/graphs/"
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
          <Field label="Mode" name="mode">
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
          <Field label="Color" name="color">
            <ColorField value={current.color} onChange={(color) => set({ color })} />
          </Field>
          <Field label="Line size" name="lineSize">
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
          <Field label="Marker" name="marker">
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
            <Field label="Complex part" name="part">
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
          <Field label="Fill" name="fill">
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
          <Field label="Color by" name="colorWave">
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
          <Field label="Text markers" name="textMarker">
            <Select
              aria-label="Text markers"
              className="min-w-0 flex-1"
              disabled={!hasMarkers}
              value={current.textMarker ?? ""}
              onChange={(event) => set({ textMarker: event.target.value || null })}
            >
              <option value="">none (marker shapes)</option>
              {labelWaves.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
            {current.textMarker !== null ? (
              <Select
                aria-label="Text anchor"
                title="Which point of each label sits on its data point"
                value={current.textAnchor}
                onChange={(event) =>
                  set({ textAnchor: event.target.value as TraceStyle["textAnchor"] })
                }
              >
                {ANCHORS.map((anchor) => (
                  <option key={anchor}>{anchor}</option>
                ))}
              </Select>
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

/** The margins in Igor's order, in two columns: left and bottom, then right and top. */
export const MARGIN_ORDER: readonly AxisSide[] = ["left", "bottom", "right", "top"];

/** What each choice of labels shows, beside it in Modify Axis. */
export const LABEL_MODE_HINTS: Record<AxisLabelMode, string> = {
  on: "tick labels and the axis label",
  "axis only": "the axis label, no tick labels",
  off: "no labels; the axis and ticks stay",
};

export function ModifyAxisDialog({
  graph: graphName,
  axis: initial,
}: {
  graph: string;
  axis?: string;
}) {
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
  const [labelSize, setLabelSize] = useState<string | null>(null);
  const [tickSize, setTickSize] = useState<string | null>(null);
  const [rotation, setRotation] = useState<string | null>(null);
  const labelField = useRef<HTMLInputElement>(null);
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
  // Font sizes: empty is the graph's own size.
  const fontSize = (text: string | null) =>
    text === null ? undefined : text.trim() === "" ? null : parseNumber(text);
  const sizeInvalid = (text: string | null, size: number | null | undefined) =>
    text !== null && text.trim() !== "" && !(size !== null && size! >= 4 && size! <= 96);
  const parsedLabelSize = fontSize(labelSize);
  const labelSizeInvalid = sizeInvalid(labelSize, parsedLabelSize);
  if (parsedLabelSize !== undefined && !labelSizeInvalid) props.labelSize = parsedLabelSize;
  const parsedTickSize = fontSize(tickSize);
  const tickSizeInvalid = sizeInvalid(tickSize, parsedTickSize);
  if (parsedTickSize !== undefined && !tickSizeInvalid) props.tickLabelSize = parsedTickSize;
  // The label's turn, in degrees: 180 reads the other way round.
  const parsedRotation = rotation === null ? undefined : parseNumber(rotation);
  const rotationInvalid =
    rotation !== null &&
    !(parsedRotation !== null && parsedRotation! >= -360 && parsedRotation! <= 360);
  if (parsedRotation !== undefined && parsedRotation !== null && !rotationInvalid) {
    props.labelRotation = parsedRotation;
  }
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
    setLabelSize(null);
    setTickSize(null);
    setRotation(null);
  };

  return (
    <Dialog
      title={`Modify Axis — ${graphName}`}
      help="guides/axes-and-annotations/"
      onClose={close}
      submitDisabled={
        invalid ||
        spanInvalid ||
        stepInvalid ||
        labelSizeInvalid ||
        tickSizeInvalid ||
        rotationInvalid ||
        Object.keys(props).length === 0
      }
      onSubmit={() => submit({ op: "modifyAxis", graph: graphName, axis, props })}
    >
      <Field label="Axis">
        <Select
          aria-label="Axis"
          className="min-w-0 flex-1"
          value={axis}
          onChange={(event) => switchAxis(event.target.value)}
        >
          {Object.keys(graph.axes).map((name) => (
            <option key={name} value={name}>
              {name}
              {used.has(name) ? "" : " (unused)"}
            </option>
          ))}
        </Select>
        <span className="shrink-0 whitespace-nowrap text-muted">on the {base.side}</span>
        <Button onClick={() => ui.set({ dialog: { kind: "addAxis", graph: graphName } })}>
          New Axis…
        </Button>
      </Field>
      <Field label="Label" name="label">
        <TextInput
          ref={labelField}
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
      <div className="pl-[104px]">
        <MarkupButtons
          field={labelField}
          value={current.label ?? ""}
          onChange={(label) => set({ label })}
          disabled={current.label === null}
        />
      </div>
      <Field label="Label font" name="labelSize" group>
        <TextInput
          aria-label="Label size"
          aria-invalid={labelSizeInvalid}
          className="w-14"
          placeholder={String(graph.fontSize)}
          value={labelSize ?? (current.labelSize === null ? "" : String(current.labelSize))}
          onChange={(event) => setLabelSize(event.target.value)}
        />
        <Select
          aria-label="Label style"
          value={current.labelStyle}
          onChange={(event) => set({ labelStyle: event.target.value as LabelStyle })}
        >
          {LABEL_STYLES.map((style) => (
            <option key={style}>{style}</option>
          ))}
        </Select>
        <span className="text-muted">turned</span>
        <TextInput
          aria-label="Label rotation"
          aria-invalid={rotationInvalid}
          className="w-14"
          value={rotation ?? String(current.labelRotation)}
          onChange={(event) => setRotation(event.target.value)}
        />
        <span className="text-muted">°</span>
      </Field>
      <Field label="Show labels" name="labels">
        <Select
          aria-label="Show labels"
          value={current.labels}
          onChange={(event) => set({ labels: event.target.value as AxisLabelMode })}
        >
          {AXIS_LABEL_MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </Select>
        <span className="text-muted">{LABEL_MODE_HINTS[current.labels]}</span>
      </Field>
      <Field label="">
        <Checkbox
          label="Draw the axis line"
          checked={current.line}
          onChange={(event) => set({ line: event.target.checked })}
        />
      </Field>
      <Field label="Range">
        <TextInput
          aria-label="Minimum"
          aria-invalid={min !== null && min.trim() !== "" && parsedMin === null}
          className="w-24 min-w-0"
          placeholder="auto"
          value={min ?? show(current.min)}
          onChange={(event) => setMin(event.target.value)}
        />
        <span className="text-muted">to</span>
        <TextInput
          aria-label="Maximum"
          aria-invalid={max !== null && max.trim() !== "" && parsedMax === null}
          className="w-24 min-w-0"
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
      <Field label="Ticks" name="ticks">
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
      <Field label="Tick labels" name="tickFormat">
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
        <span className="text-muted">size</span>
        <TextInput
          aria-label="Tick label size"
          aria-invalid={tickSizeInvalid}
          className="w-14"
          placeholder={String(graph.fontSize)}
          value={tickSize ?? (current.tickLabelSize === null ? "" : String(current.tickLabelSize))}
          onChange={(event) => setTickSize(event.target.value)}
        />
      </Field>
      <Field label="Mirror" name="mirror">
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
      <Field label="Grid" name="grid">
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
      <Field label="Draw between" name="span">
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
      <div className="pl-[104px]">
        <MarkupHelp />
      </div>
    </Dialog>
  );
}

export function AddAxisDialog({ graph }: { graph: string }) {
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
      <Field label="Name" name="name">
        <TextInput
          aria-label="Axis name"
          className="w-28"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Side" name="side">
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

export function ModifyImageDialog({
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
      <Field label="Color table" name="colorTable">
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

export function ModifyContourDialog({
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
      <Field label="Levels" name="levels">
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
      <Field label="Line size" name="lineSize">
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

export const FONTS: [string, string][] = [
  ["Helvetica / Arial", DEFAULT_FONT_FAMILY],
  ["Times", '"Times New Roman", Times, serif'],
  ["Courier", '"Courier New", Courier, monospace'],
  ["System UI", "system-ui, sans-serif"],
];

export function ModifyGraphDialog({ graph: graphName }: { graph: string }) {
  const graph = useDoc((state) => state.graphs[graphName]);
  const [size, setSize] = useState(() => String(graph?.fontSize ?? 12));
  const [family, setFamily] = useState(() => graph?.fontFamily ?? DEFAULT_FONT_FAMILY);
  // The plot area as it is now, to start an Absolute size from.
  const [sides, setSides] = useState(() => {
    if (!graph) return null;
    const plot = exportLayout(graphName, null, null).plot;
    return {
      width: plotSideDraft(graph, "width", plot.w),
      height: plotSideDraft(graph, "height", plot.h),
    };
  });
  // Each margin as typed, in points, or null for auto.
  const [margins, setMargins] = useState<Record<AxisSide, string | null>>(() => {
    const draft = { left: null, bottom: null, right: null, top: null } as Record<
      AxisSide,
      string | null
    >;
    for (const side of AXIS_SIDES) {
      const points = graph?.[MARGIN_PROPS[side]] ?? null;
      draft[side] = points === null ? null : formatNumber(points, 6);
    }
    return draft;
  });
  const [magnification, setMagnification] = useState(() => graph?.magnification ?? 1);
  if (!graph || !sides) return null;
  const fontSize = parseNumber(size);
  const props: Record<string, unknown> = {};
  if (fontSize !== null && fontSize !== graph.fontSize) props.fontSize = fontSize;
  if (family !== graph.fontFamily) props.fontFamily = family;
  const marginOf = (side: AxisSide): number | null | undefined => {
    const text = margins[side];
    if (text === null) return null;
    const points = parseNumber(text);
    return points !== null && points >= 0 && points <= MAX_MARGIN ? points : undefined;
  };
  const marginInvalid = AXIS_SIDES.some((side) => marginOf(side) === undefined);
  for (const side of AXIS_SIDES) {
    const points = marginOf(side);
    if (points !== undefined && points !== graph[MARGIN_PROPS[side]]) {
      props[MARGIN_PROPS[side]] = points;
    }
  }
  if (magnification !== graph.magnification) props.magnification = magnification;
  /** The margin a side has now, in points: where unticking Auto starts from. */
  const marginNow = (side: AxisSide): number => {
    const layout = exportLayout(graphName, null, null);
    const { plot } = layout;
    const units = {
      left: plot.x,
      top: plot.y,
      right: layout.width - plot.x - plot.w,
      bottom: layout.height - plot.y - plot.h,
    }[side];
    return Math.round(units / SCREEN_UNITS_PER_POINT);
  };
  const magnifications: number[] = [...MAGNIFICATIONS];
  if (!magnifications.includes(magnification)) {
    magnifications.push(magnification);
    magnifications.sort((a, b) => a - b);
  }
  const width = plotSideOf(sides.width);
  const height = plotSideOf(sides.height);
  const sizeProblem = plotSizeProblem(width, height);
  if (width && JSON.stringify(width) !== JSON.stringify(graph.width)) props.width = width;
  if (height && JSON.stringify(height) !== JSON.stringify(graph.height)) props.height = height;
  return (
    <Dialog
      title={`Modify Graph — ${graphName}`}
      help="guides/graphs/"
      onClose={close}
      width={520}
      submitDisabled={
        fontSize === null ||
        sizeProblem !== null ||
        marginInvalid ||
        Object.keys(props).length === 0
      }
      onSubmit={() => submit({ op: "modifyGraph", graph: graphName, props })}
    >
      <Field label="Font" name="fontFamily">
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
      <Field label="Font size" name="fontSize">
        <TextInput
          aria-label="Font size"
          aria-invalid={fontSize === null}
          className="w-16"
          value={size}
          onChange={(event) => setSize(event.target.value)}
        />
        <span className="text-muted">px</span>
      </Field>
      <div role="group" aria-label="Plot area" className="flex flex-col gap-2">
        <div className="mt-1 border-t border-line pt-2 font-medium">Plot area</div>
        <PlotSideFields
          graph={graph}
          side="width"
          draft={sides.width}
          onChange={(draft) => setSides({ ...sides, width: draft })}
        />
        <PlotSideFields
          graph={graph}
          side="height"
          draft={sides.height}
          onChange={(draft) => setSides({ ...sides, height: draft })}
        />
        <div className={`text-[11px] ${sizeProblem ? "text-danger" : "text-muted"}`}>
          {sizeProblem ?? PLOT_SIZE_HINT}
        </div>
      </div>
      <div role="group" aria-label="Margins" className="flex flex-col gap-2">
        <div className="mt-1 border-t border-line pt-2 font-medium">Margins</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {MARGIN_ORDER.map((side) => {
            const text = margins[side];
            const label = `${side[0]!.toUpperCase()}${side.slice(1)}`;
            return (
              <div key={side} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-right text-muted">{label}</span>
                <TextInput
                  aria-label={`${label} margin`}
                  aria-invalid={marginOf(side) === undefined}
                  className="w-16"
                  disabled={text === null}
                  placeholder={text === null ? "auto" : ""}
                  value={text ?? ""}
                  onChange={(event) => setMargins({ ...margins, [side]: event.target.value })}
                />
                <span className="text-muted">pt</span>
                <Checkbox
                  label="Auto"
                  aria-label={`${label} margin auto`}
                  checked={text === null}
                  onChange={(event) =>
                    setMargins({
                      ...margins,
                      [side]: event.target.checked ? null : String(marginNow(side)),
                    })
                  }
                />
              </div>
            );
          })}
        </div>
        <div className={`text-[11px] ${marginInvalid ? "text-danger" : "text-muted"}`}>
          {marginInvalid
            ? `A margin is a number of points from 0 to ${MAX_MARGIN}.`
            : "Auto is as wide as the axes and their labels need. A fixed margin keeps its width and may cut labels off."}
        </div>
      </div>
      <div className="border-t border-line pt-2">
        <Field label="Magnification" name="magnification">
          <Select
            aria-label="Magnification"
            value={String(magnification)}
            onChange={(event) => setMagnification(Number(event.target.value))}
          >
            {magnifications.map((factor) => (
              <option key={factor} value={String(factor)}>
                {factor === 1 ? "None" : String(factor)}
              </option>
            ))}
          </Select>
          <span className="text-muted">on screen only; exports keep the graph&apos;s size</span>
        </Field>
      </div>
    </Dialog>
  );
}

/** Adds a text box, or changes a legend, text box, color scale or tag that is there. */
/**
 * How a drawing looks: its outline, fill, arrowheads, text and layer. Only
 * what is changed is applied. Where it is (and whether it is pinned to the
 * axes) is changed on the graph, with the mouse and its right-click menu.
 */
export function ModifyDrawingDialog({ graph, drawing }: { graph: string; drawing: string }) {
  const spec = useDoc((state) =>
    state.graphs[graph]?.drawings.find((item) => item.name === drawing),
  );
  const [changes, setChanges] = useState<Partial<DrawingSpec>>({});
  const [lineSize, setLineSize] = useState<string | null>(null);
  const [opacity, setOpacity] = useState<string | null>(null);
  const [textSize, setTextSize] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  if (!spec) return null;
  const current = { ...spec, ...changes };
  const set = (patch: Partial<DrawingSpec>) => setChanges({ ...changes, ...patch });
  const isLine = spec.kind === "line" || spec.kind === "arrow";
  const isText = spec.kind === "text";
  const closedShape = !isLine && !isText && (spec.kind !== "polygon" || current.closed);

  const props: Record<string, unknown> = { ...changes };
  const parsedLine = lineSize === null ? undefined : parseNumber(lineSize);
  if (typeof parsedLine === "number") props.lineSize = parsedLine;
  const parsedOpacity = opacity === null ? undefined : parseNumber(opacity);
  const opacityBad =
    parsedOpacity === null ||
    (parsedOpacity !== undefined && (parsedOpacity < 0 || parsedOpacity > 100));
  if (typeof parsedOpacity === "number" && !opacityBad) props.fillOpacity = parsedOpacity / 100;
  const parsedText =
    textSize === null ? undefined : textSize.trim() === "" ? null : parseNumber(textSize);
  const textSizeBad =
    textSize !== null &&
    textSize.trim() !== "" &&
    (parsedText === null || parsedText! < 4 || parsedText! > 96);
  if (textSize !== null && !textSizeBad) props.textSize = parsedText;
  const invalid = parsedLine === null || opacityBad || textSizeBad;

  return (
    <Dialog
      title={`Modify ${drawing} — ${graph}`}
      help="guides/axes-and-annotations/"
      width={440}
      onClose={close}
      submitDisabled={invalid || Object.keys(props).length === 0}
      onSubmit={() => submit({ op: "modifyDrawing", graph, drawing, props })}
    >
      {isText ? (
        <>
          <textarea
            ref={field}
            aria-label="Text"
            autoFocus
            rows={3}
            spellCheck={false}
            value={current.text}
            onChange={(event) => set({ text: event.target.value })}
            className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <MarkupButtons field={field} value={current.text} onChange={(text) => set({ text })} />
          <Field label="Size" name="textSize">
            <TextInput
              aria-label="Text size"
              aria-invalid={textSizeBad}
              className="w-16"
              placeholder="graph"
              value={textSize ?? (spec.textSize === null ? "" : String(spec.textSize))}
              onChange={(event) => setTextSize(event.target.value)}
            />
            <span className="text-muted">points; empty is the graph's font size</span>
          </Field>
        </>
      ) : null}
      <Field label="Color" name="color">
        <ColorField value={current.color} onChange={(color) => set({ color })} />
      </Field>
      {isText ? null : (
        <Field label="Line" name="lineSize">
          <TextInput
            aria-label="Line size"
            aria-invalid={parsedLine === null}
            className="w-14"
            value={lineSize ?? String(spec.lineSize)}
            onChange={(event) => setLineSize(event.target.value)}
          />
          <Select
            aria-label="Line style"
            value={current.lineStyle}
            onChange={(event) => set({ lineStyle: event.target.value as DrawingSpec["lineStyle"] })}
          >
            {LINE_STYLES.map((style) => (
              <option key={style}>{style}</option>
            ))}
          </Select>
          <span className="text-muted">0 draws no outline</span>
        </Field>
      )}
      {isLine ? (
        <Field label="Arrowheads" name="arrow">
          <Select
            aria-label="Arrowheads"
            value={current.arrow}
            onChange={(event) => set({ arrow: event.target.value as DrawingSpec["arrow"] })}
          >
            <option value="none">none</option>
            <option value="end">at the end</option>
            <option value="start">at the start</option>
            <option value="both">at both ends</option>
          </Select>
        </Field>
      ) : null}
      {spec.kind === "polygon" ? (
        <Field label="">
          <Checkbox
            label="Closed (back to the first corner)"
            checked={current.closed}
            onChange={(event) => set({ closed: event.target.checked })}
          />
        </Field>
      ) : null}
      {closedShape ? (
        <Field label="Fill">
          <Checkbox
            label="Fill"
            checked={current.fill !== null}
            onChange={(event) =>
              set({ fill: event.target.checked ? (spec.fill ?? "#ffee88") : null })
            }
          />
          {current.fill !== null ? (
            <>
              <input
                type="color"
                aria-label="Fill color"
                value={current.fill}
                onChange={(event) => set({ fill: event.target.value })}
                className="h-6 w-9 cursor-pointer rounded border border-line bg-paper p-0.5"
              />
              <TextInput
                aria-label="Fill opacity"
                aria-invalid={opacityBad}
                className="w-12"
                value={opacity ?? String(Math.round(spec.fillOpacity * 100))}
                onChange={(event) => setOpacity(event.target.value)}
              />
              <span className="text-muted">% opaque</span>
            </>
          ) : null}
        </Field>
      ) : null}
      <Field label="Layer" name="layer">
        <Select
          aria-label="Layer"
          value={current.layer}
          onChange={(event) => set({ layer: event.target.value as DrawingSpec["layer"] })}
        >
          <option value="front">in front of the traces and axes</option>
          <option value="back">behind the traces</option>
        </Select>
      </Field>
      <p className="m-0 pl-[104px] text-[11px] leading-relaxed text-muted">
        {spec.coords === "axes"
          ? `Pinned to the axes ${spec.hAxis} and ${spec.vAxis}: it moves with the data.`
          : "Pinned to the plot area: it stays where it is when the graph is zoomed."}{" "}
        Move it and resize it with the mouse; its right-click menu pins it to the axes or the plot
        area.
      </p>
    </Dialog>
  );
}

/** Asks for the text to draw where the text tool was clicked. */
export function DrawTextDialog({
  graph,
  point,
  coords,
  hAxis,
  vAxis,
}: {
  graph: string;
  point: [number, number];
  coords: "plot" | "axes";
  hAxis: string;
  vAxis: string;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog
      title={`Draw Text — ${graph}`}
      onClose={close}
      submitDisabled={text.trim() === ""}
      onSubmit={() =>
        submit({
          op: "addDrawing",
          graph,
          kind: "text",
          points: point,
          props: {
            text,
            ...(coords === "axes"
              ? {
                  coords,
                  ...(hAxis !== "bottom" ? { hAxis } : {}),
                  ...(vAxis !== "left" ? { vAxis } : {}),
                }
              : {}),
          },
        })
      }
    >
      <textarea
        ref={field}
        aria-label="Text"
        autoFocus
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
      <MarkupButtons field={field} value={text} onChange={setText} />
    </Dialog>
  );
}

export function AddTextDialog({ graph, annotation }: { graph: string; annotation?: string }) {
  const existing = useDoc((state) =>
    state.graphs[graph]?.annotations.find((item) => item.name === annotation),
  );
  const [text, setText] = useState(existing?.text ?? "");
  const [anchor, setAnchor] = useState<string>(existing?.anchor ?? "RT");
  const [frame, setFrame] = useState(existing?.frame ?? true);
  const field = useRef<HTMLTextAreaElement>(null);
  if (annotation && !existing) return null;
  const kind = existing?.kind ?? "text";
  const hint =
    kind === "legend"
      ? "Leave empty to list every trace. \\s(traceName) draws a trace's symbol."
      : kind === "tag"
        ? "{x}, {y} and {point} stand for the point's values. Leave empty to show x, y."
        : "";
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
        <>
          <textarea
            ref={field}
            aria-label="Text"
            autoFocus
            rows={4}
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <MarkupButtons field={field} value={text} onChange={setText} />
          <MarkupHelp />
        </>
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

/** Shows the Python that draws a graph again, to copy or to keep in a procedure. */
export function GraphScriptDialog({ graph }: { graph: string }) {
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

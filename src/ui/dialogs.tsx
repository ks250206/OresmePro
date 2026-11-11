import { useState } from "react";
import { runGui, ui, useDoc, useUi, type DialogRequest } from "../app/session";
import type { Command } from "../core/doc/commands";
import {
  ANCHORS,
  AXIS_NAMES,
  DEFAULT_FONT_FAMILY,
  GRID_MODES,
  LINE_STYLES,
  MARKER_SHAPES,
  MIRROR_MODES,
  TICK_MODES,
  TRACE_COLORS,
  TRACE_MODES,
  type AxisName,
  type AxisSpec,
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

function XWaveSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const order = useDoc((state) => state.waveOrder);
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
  const order = useDoc((state) => state.waveOrder);
  const preselected = useUi((state) => state.selectedWaves);
  const [y, setY] = useState<string[]>(() => preselected.filter((name) => order.includes(name)));
  const [x, setX] = useState(CALCULATED);
  const [vAxis, setVAxis] = useState<"left" | "right">("left");
  const [hAxis, setHAxis] = useState<"bottom" | "top">("bottom");
  const xWave = x === CALCULATED ? null : x;
  return (
    <Dialog
      title={append ? `Append Traces to ${append}` : "New Graph"}
      onClose={close}
      submitDisabled={y.length === 0}
      onSubmit={() =>
        submit(
          append
            ? { op: "appendTraces", graph: append, y, x: xWave, vAxis, hAxis }
            : { op: "display", y, x: xWave },
        )
      }
    >
      <div className="text-muted">Y waves</div>
      <NameList label="Y waves" names={order} selected={y} onChange={setY} />
      <Field label="X wave">
        <XWaveSelect value={x} onChange={setX} />
      </Field>
      {append ? (
        <Field label="Axes">
          <Select
            aria-label="Vertical axis"
            value={vAxis}
            onChange={(event) => setVAxis(event.target.value as "left" | "right")}
          >
            <option>left</option>
            <option>right</option>
          </Select>
          <Select
            aria-label="Horizontal axis"
            value={hAxis}
            onChange={(event) => setHAxis(event.target.value as "bottom" | "top")}
          >
            <option>bottom</option>
            <option>top</option>
          </Select>
        </Field>
      ) : null}
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

function ModifyAxisDialog({ graph: graphName, axis: initial }: { graph: string; axis?: AxisName }) {
  const graph = useDoc((state) => state.graphs[graphName]);
  const used = new Set<AxisName>(graph?.traces.flatMap((trace) => [trace.vAxis, trace.hAxis]));
  const [axis, setAxis] = useState<AxisName>(initial ?? "left");
  const [changes, setChanges] = useState<Partial<AxisSpec>>({});
  const [min, setMin] = useState<string | null>(null);
  const [max, setMax] = useState<string | null>(null);
  if (!graph) return null;
  const base = graph.axes[axis];
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

  const switchAxis = (next: AxisName) => {
    setAxis(next);
    setChanges({});
    setMin(null);
    setMax(null);
  };

  return (
    <Dialog
      title={`Modify Axis — ${graphName}`}
      onClose={close}
      submitDisabled={invalid || Object.keys(props).length === 0}
      onSubmit={() => submit({ op: "modifyAxis", graph: graphName, axis, props })}
    >
      <Field label="Axis">
        <Select
          aria-label="Axis"
          value={axis}
          onChange={(event) => switchAxis(event.target.value as AxisName)}
        >
          {AXIS_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
              {used.has(name) ? "" : " (unused)"}
            </option>
          ))}
        </Select>
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
      <div className="pl-[104px] text-[11px] text-muted">
        In labels, <code>^{"{...}"}</code> is a superscript and <code>_{"{...}"}</code> a subscript.
      </div>
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

function NameDialog({ wave, mode }: { wave: string; mode: "rename" | "duplicate" }) {
  const [name, setName] = useState(mode === "rename" ? wave : `${wave}_copy`);
  return (
    <Dialog
      title={mode === "rename" ? `Rename ${wave}` : `Duplicate ${wave}`}
      width={320}
      onClose={close}
      submitDisabled={name.trim() === "" || (mode === "rename" && name === wave)}
      onSubmit={() =>
        submit(
          mode === "rename"
            ? { op: "renameWave", name: wave, newName: name.trim() }
            : { op: "duplicateWave", name: wave, newName: name.trim(), overwrite: false },
        )
      }
    >
      <Field label="New name">
        <TextInput
          aria-label="New name"
          className="flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}

function WaveScalingDialog({ wave: name }: { wave: string }) {
  const wave = useDoc((state) => state.waves[name]);
  const [x0, setX0] = useState(() => formatNumber(wave?.x0 ?? 0, 12));
  const [dx, setDx] = useState(() => formatNumber(wave?.dx ?? 1, 12));
  const [xUnit, setXUnit] = useState(wave?.xUnit ?? "");
  const [unit, setUnit] = useState(wave?.unit ?? "");
  if (!wave) return null;
  const start = parseNumber(x0);
  const step = parseNumber(dx);
  const invalid = start === null || step === null || step === 0;
  const commands: Command[] = [];
  if (!invalid && (start !== wave.x0 || step !== wave.dx || xUnit !== wave.xUnit)) {
    commands.push({ op: "setWaveScale", name, x0: start, dx: step, xUnit });
  }
  if (unit !== wave.unit) commands.push({ op: "setWaveMeta", name, unit });
  return (
    <Dialog
      title={`Change Wave Scaling — ${name}`}
      width={340}
      onClose={close}
      submitDisabled={invalid || commands.length === 0}
      onSubmit={() => submit(commands)}
    >
      <Field label="X start">
        <TextInput
          aria-label="X start"
          aria-invalid={start === null}
          className="w-28"
          value={x0}
          onChange={(event) => setX0(event.target.value)}
        />
      </Field>
      <Field label="X step">
        <TextInput
          aria-label="X step"
          aria-invalid={step === null || step === 0}
          className="w-28"
          value={dx}
          onChange={(event) => setDx(event.target.value)}
        />
      </Field>
      <Field label="X unit">
        <TextInput
          aria-label="X unit"
          className="w-20"
          value={xUnit}
          onChange={(event) => setXUnit(event.target.value)}
        />
      </Field>
      <Field label="Data unit">
        <TextInput
          aria-label="Data unit"
          className="w-20"
          value={unit}
          onChange={(event) => setUnit(event.target.value)}
        />
      </Field>
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

function renderDialog(dialog: DialogRequest) {
  switch (dialog.kind) {
    case "newGraph":
      return <NewGraphDialog />;
    case "appendTraces":
      return <NewGraphDialog append={dialog.graph} />;
    case "newTable":
      return <NewTableDialog />;
    case "modifyTrace":
      return <ModifyTraceDialog graph={dialog.graph} trace={dialog.trace} />;
    case "modifyAxis":
      return <ModifyAxisDialog graph={dialog.graph} axis={dialog.axis} />;
    case "modifyGraph":
      return <ModifyGraphDialog graph={dialog.graph} />;
    case "addText":
      return <AddTextDialog graph={dialog.graph} />;
    case "renameWave":
      return <NameDialog wave={dialog.wave} mode="rename" />;
    case "duplicateWave":
      return <NameDialog wave={dialog.wave} mode="duplicate" />;
    case "waveScaling":
      return <WaveScalingDialog wave={dialog.wave} />;
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

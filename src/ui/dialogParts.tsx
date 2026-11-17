/** Parts the dialogs share: closing, submitting, and fields for waves, axes and colors. */
import { useState } from "react";
import { runGui, ui, useDoc } from "../app/session";
import type { Command } from "../core/doc/commands";
import {
  COLOR_TABLES,
  TRACE_COLORS,
  isVerticalSide,
  type ErrorSource,
  type GraphSpec,
} from "../core/doc/types";
import { Field, Select, TextInput } from "./controls";

export const close = () => ui.set({ dialog: null });

/** Runs commands and closes the dialog if they were accepted. */
export function submit(commands: Command | Command[]) {
  if (runGui(commands) !== undefined) close();
}

export const parseNumber = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
};

export const CALCULATED = "_calculated_";

/** Names of the numeric waves with the given number of dimensions. */
export function useNumericWaves(dimensions: 1 | 2): string[] {
  const waves = useDoc((state) => state.waves);
  const order = useDoc((state) => state.waveOrder);
  // "2" means anything that has a plane to show: two dimensions or more.
  return order.filter((name) => {
    const wave = waves[name]!;
    return !wave.text && (dimensions === 1 ? wave.shape.length === 1 : wave.shape.length >= 2);
  });
}

export function AxisSelects({
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

export function XWaveSelect({
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
export function PlaneFields({
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

export function ColorTableSelect({
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

export function ColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
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
export function ErrorField({
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

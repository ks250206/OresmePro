import {
  LENGTH_UNITS,
  PLOT_SIZE_MODES,
  dependsOnOther,
  isVerticalSide,
  type GraphSpec,
  type LengthUnit,
  type PlotDimension,
  type PlotSizeMode,
} from "../core/doc/types";
import { POINTS_PER, SCREEN_UNITS_PER_POINT } from "../core/plot/plotSize";
import { Field, Select, TextInput } from "./controls";

const MODE_LABELS: Record<PlotSizeMode, string> = {
  auto: "Auto",
  absolute: "Absolute",
  aspect: "Aspect",
  plan: "Plan",
  perUnit: "Per unit",
};

/** A side of the plot area as its fields are filled in: text, so a half-typed number is kept. */
export interface PlotSideDraft {
  mode: PlotSizeMode;
  value: string;
  unit: LengthUnit;
  factor: string;
  hAxis: string;
  vAxis: string;
  axis: string;
}

/** A value offered to start from (a length the side has now, say): rounded, to read well. */
const offeredText = (value: number): string => String(Number(value.toPrecision(4)));

/**
 * A value the side holds: exactly, so that opening the dialog and pressing
 * Do It changes nothing, and a length at a limit is not rounded past it.
 */
const heldText = (value: number): string => String(value);

/**
 * The fields of a side as they start: its mode and values, and for the
 * modes it does not use, values to start from (`current` is the side's
 * length now, in layout units, offered for Absolute).
 */
export function plotSideDraft(
  graph: GraphSpec,
  side: "width" | "height",
  current: number,
): PlotSideDraft {
  const dimension = graph[side];
  const axes = Object.entries(graph.axes);
  const first = (vertical: boolean) =>
    axes.find(([, axis]) => isVerticalSide(axis.side) === vertical)?.[0] ?? "";
  const hAxis = first(false);
  const vAxis = first(true);
  const draft: PlotSideDraft = {
    mode: dimension.mode,
    value: offeredText(current / SCREEN_UNITS_PER_POINT / POINTS_PER.cm),
    unit: "cm",
    factor: "1",
    hAxis,
    vAxis,
    axis: side === "width" ? hAxis : vAxis,
  };
  switch (dimension.mode) {
    case "absolute":
      return { ...draft, value: heldText(dimension.value), unit: dimension.unit };
    case "aspect":
      return { ...draft, factor: heldText(dimension.factor) };
    case "plan":
      return {
        ...draft,
        factor: heldText(dimension.factor),
        hAxis: dimension.hAxis,
        vAxis: dimension.vAxis,
      };
    case "perUnit":
      return {
        ...draft,
        value: heldText(dimension.value),
        unit: dimension.unit,
        axis: dimension.axis,
      };
    default:
      return draft;
  }
}

const parsePositive = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) || value <= 0 ? null : value;
};

/** The side the fields describe, or null while a number in them is not one. */
export function plotSideOf(draft: PlotSideDraft): PlotDimension | null {
  const value = parsePositive(draft.value);
  const factor = parsePositive(draft.factor);
  switch (draft.mode) {
    case "auto":
      return { mode: "auto" };
    case "absolute":
      return value === null ? null : { mode: "absolute", value, unit: draft.unit };
    case "aspect":
      return factor === null ? null : { mode: "aspect", factor };
    case "plan":
      return factor === null
        ? null
        : { mode: "plan", factor, hAxis: draft.hAxis, vAxis: draft.vAxis };
    case "perUnit":
      return value === null ? null : { mode: "perUnit", value, unit: draft.unit, axis: draft.axis };
  }
}

/** Why the two sides cannot be used together, or null. */
export function plotSizeProblem(
  width: PlotDimension | null,
  height: PlotDimension | null,
): string | null {
  if (!width || !height) return "Give a number greater than 0.";
  if (dependsOnOther(width) && dependsOnOther(height)) {
    return "Width and height cannot both be Aspect or Plan.";
  }
  return null;
}

/** The fields of one side of the plot area: its mode and what that mode needs. */
export function PlotSideFields({
  graph,
  side,
  draft,
  onChange,
}: {
  graph: GraphSpec;
  side: "width" | "height";
  draft: PlotSideDraft;
  onChange: (draft: PlotSideDraft) => void;
}) {
  const name = side === "width" ? "Plot width" : "Plot height";
  const set = (change: Partial<PlotSideDraft>) => onChange({ ...draft, ...change });
  const axesOn = (vertical: boolean) =>
    Object.entries(graph.axes)
      .filter(([, axis]) => isVerticalSide(axis.side) === vertical)
      .map(([axis]) => axis);
  const axisSelect = (
    label: string,
    value: string,
    vertical: boolean,
    key: keyof PlotSideDraft,
  ) => (
    <Select
      aria-label={`${name} ${label}`}
      value={value}
      onChange={(event) => set({ [key]: event.target.value })}
    >
      {axesOn(vertical).map((axis) => (
        <option key={axis}>{axis}</option>
      ))}
    </Select>
  );
  const number = (label: string, value: string, key: "value" | "factor") => (
    <TextInput
      aria-label={`${name} ${label}`}
      aria-invalid={parsePositive(value) === null}
      className="w-16"
      value={value}
      onChange={(event) => set({ [key]: event.target.value })}
    />
  );
  const unit = (
    <Select
      aria-label={`${name} unit`}
      value={draft.unit}
      onChange={(event) => set({ unit: event.target.value as LengthUnit })}
    >
      {LENGTH_UNITS.map((item) => (
        <option key={item}>{item}</option>
      ))}
    </Select>
  );
  const other = side === "width" ? "height" : "width";
  return (
    <Field label={side === "width" ? "Width" : "Height"} group>
      <Select
        aria-label={`${name} mode`}
        value={draft.mode}
        onChange={(event) => set({ mode: event.target.value as PlotSizeMode })}
      >
        {PLOT_SIZE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {MODE_LABELS[mode]}
          </option>
        ))}
      </Select>
      {draft.mode === "absolute" ? (
        <>
          {number("value", draft.value, "value")}
          {unit}
        </>
      ) : draft.mode === "aspect" ? (
        <>
          {number("factor", draft.factor, "factor")}
          <span className="text-muted">× {other}</span>
        </>
      ) : draft.mode === "plan" ? (
        <>
          {number("factor", draft.factor, "factor")}
          <span className="text-muted">×</span>
          {axisSelect("horizontal axis", draft.hAxis, false, "hAxis")}
          {axisSelect("vertical axis", draft.vAxis, true, "vAxis")}
        </>
      ) : draft.mode === "perUnit" ? (
        <>
          {number("value", draft.value, "value")}
          {unit}
          <span className="text-muted">per</span>
          {axisSelect("axis", draft.axis, side === "height", "axis")}
        </>
      ) : null}
    </Field>
  );
}

/** What each mode means, under the fields. */
export const PLOT_SIZE_HINT =
  "Auto follows the window. Aspect: × the other side. Plan: one unit of the horizontal axis is × as long as one of the vertical axis (the height: the other way round); 1 scales both alike. Per unit: a length for each unit of the axis.";

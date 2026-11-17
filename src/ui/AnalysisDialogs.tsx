/** The analysis dialogs: curve fitting, the analyses of a graph, backgrounds and onsets. */
import { useState } from "react";
import { pyName, runPython } from "../app/actions";
import { parseConstraints, parseHold, parseSpans } from "../app/fitOptions";
import { useDoc, useUi } from "../app/session";
import { leafName, type GraphSpec } from "../core/doc/types";
import { traceX } from "../core/plot/layout";
import { Button, Checkbox, Dialog, Field, Select, TextInput } from "./controls";
import { CALCULATED, XWaveSelect, close, parseNumber, useNumericWaves } from "./dialogParts";

export const FIT_FUNCTIONS: [string, string][] = [
  ["line", "a + b·x"],
  ["poly3", "K0 + K1·x + K2·x²"],
  ["poly4", "K0 + K1·x + K2·x² + K3·x³"],
  ["gauss", "y0 + A·exp(−((x−x0)/width)²)"],
  ["lor", "y0 + A/((x−x0)² + B)"],
  ["voigt", "y0 + A·V(x−x0): Gaussian (gwidth) ∗ Lorentzian (lwidth), height A"],
  ["pseudo_voigt", "y0 + A·(eta·L + (1−eta)·G), half width at half max: width"],
  ["exp", "y0 + A·exp(−x/tau)"],
  ["dblexp", "y0 + A1·exp(−x/tau1) + A2·exp(−x/tau2)"],
  ["sin", "y0 + A·sin(f·x + phi)"],
  ["power", "y0 + A·x^pow"],
  ["sigmoid", "base + max/(1 + exp((xhalf−x)/rate))"],
];

/** Constraints a function starts with in the dialog: the range in which its parameters mean anything. */
export const FIT_CONSTRAINTS: Record<string, string> = { pseudo_voigt: "0 <= eta <= 1" };

/**
 * The frontmost graph showing a wave, which is the one Python looks at for
 * its cursors, and whether both cursors are on it.
 */
export function useGraphShowing(wave: string): {
  graph: GraphSpec | undefined;
  hasCursors: boolean;
} {
  const graphs = useDoc((state) => state.graphs);
  const windows = useDoc((state) => state.windows);
  const graph = [...windows]
    .reverse()
    .map((window) => graphs[window.name])
    .find((candidate) => candidate?.traces.some((trace) => trace.y === wave));
  return { graph, hasCursors: Boolean(graph?.cursors.A && graph.cursors.B) };
}

/** Builds an `op.fit(...)` call; the fit itself runs in Python and reports in the history. */
export function CurveFitDialog({ wave: initial }: { wave?: string }) {
  const waves = useNumericWaves(1);
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
  const [leaveOut, setLeaveOut] = useState("");
  // The fit looks at the frontmost graph showing the wave; offer its cursors if both are set.
  const { graph, hasCursors } = useGraphShowing(y);
  const formula = FIT_FUNCTIONS.find(([name]) => name === func)?.[1] ?? "";
  const held = parseHold(hold);
  const limits = parseConstraints(constraints);
  const excluded = parseSpans(leaveOut);
  const args = [
    pyName(func),
    pyName(y),
    ...(x === CALCULATED ? [] : [`x=${pyName(x)}`]),
    ...(held ? [`hold=${held}`] : []),
    ...(limits ? [`bounds=${limits}`] : []),
    ...(weight === "" ? [] : [`sigma=${pyName(weight)}`]),
    ...(useCursors && hasCursors ? ["cursors=True"] : []),
    ...(excluded ? [`exclude=${excluded}`] : []),
    ...(residuals ? ["residuals=True"] : []),
    ...(band ? ["band=0.95"] : []),
  ];
  return (
    <Dialog
      title="Curve Fitting"
      help="guides/curve-fitting/"
      onClose={close}
      submitDisabled={y === "" || held === null || limits === null || excluded === null}
      onSubmit={() => {
        runPython(`op.fit(${args.join(", ")})`);
        close();
      }}
    >
      <Field label="Function">
        <Select
          aria-label="Function"
          value={func}
          onChange={(event) => {
            const next = event.target.value;
            // The constraints a function brings go with it, unless they have been edited.
            if (constraints.trim() === "" || constraints === FIT_CONSTRAINTS[func]) {
              setConstraints(FIT_CONSTRAINTS[next] ?? "");
            }
            setFunc(next);
          }}
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
      <Field label="Leave out">
        <TextInput
          aria-label="Leave out"
          aria-invalid={excluded === null}
          className="flex-1"
          placeholder="spans of X not to fit: 5..7, 15"
          value={leaveOut}
          onChange={(event) => setLeaveOut(event.target.value)}
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

export interface AnalysisField {
  /** The keyword argument. */
  key: string;
  label: string;
  initial: string;
  /** integer and number are typed in, xwave picks an X wave; anything else is a list of choices. */
  kind: "integer" | "number" | "xwave" | readonly string[];
  /** May be left empty, which leaves the argument out. */
  optional?: boolean;
  hint?: string;
}

export const ANALYSES: Record<
  string,
  { title: string; dimensions?: 1 | 2; fields?: AnalysisField[]; note?: string }
> = {
  stats: { title: "Wave Stats" },
  differentiate: {
    title: "Differentiate",
    fields: [{ key: "x", label: "X data", initial: CALCULATED, kind: "xwave" }],
    note: "Against an X wave, the result has one point per point of the data: plot it against the same X wave.",
  },
  integrate: {
    title: "Integrate",
    fields: [{ key: "x", label: "X data", initial: CALCULATED, kind: "xwave" }],
    note: "Against an X wave, the result has one point per point of the data: plot it against the same X wave.",
  },
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
      {
        key: "shape",
        label: "Peak shape",
        initial: "gauss",
        kind: ["gauss", "lor", "voigt", "pseudo_voigt"],
      },
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

export function AnalysisDialog({ operation, wave: initial }: { operation: string; wave?: string }) {
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
    if (field.kind === "xwave") {
      if (text !== CALCULATED) args.push(`${field.key}=${pyName(text)}`);
      continue;
    }
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
      help="guides/analysis/"
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
          {field.kind === "xwave" ? (
            <XWaveSelect
              value={values[field.key] ?? CALCULATED}
              onChange={(value) => setValues({ ...values, [field.key]: value })}
            />
          ) : typeof field.kind === "string" ? (
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

/** Python's literal for a number typed into a field, or null if it is not one. */
export const pyNumber = (text: string): string | null => {
  const value = parseNumber(text);
  return value === null ? null : String(value);
};

/** Builds an `op.background(...)` call for a spectrum. */
export function BackgroundDialog({ wave: initial }: { wave?: string }) {
  const waves = useNumericWaves(1);
  const preselected = useUi((state) => state.selectedWaves);
  const [wave, setWave] = useState(
    initial ?? preselected.find((name) => waves.includes(name)) ?? waves[0] ?? "",
  );
  const [x, setX] = useState(CALCULATED);
  const [method, setMethod] = useState("shirley");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [useCursors, setUseCursors] = useState(false);
  const [average, setAverage] = useState("5");
  const [subtract, setSubtract] = useState(true);
  const { graph, hasCursors } = useGraphShowing(wave);
  const between = useCursors && hasCursors;
  const low = pyNumber(from);
  const high = pyNumber(to);
  // Both ends of the range, or neither for the whole wave.
  const rangeBad = !between && (from.trim() !== "" || to.trim() !== "") && (!low || !high);
  const count = Number(average);
  const averageBad = !(Number.isInteger(count) && count >= 1);
  const args = [
    pyName(wave),
    JSON.stringify(method),
    ...(x === CALCULATED ? [] : [`x=${pyName(x)}`]),
    ...(between ? ["cursors=True"] : low && high ? [`range=(${low}, ${high})`] : []),
    ...(count === 5 ? [] : [`average=${count}`]),
    ...(subtract ? ["subtract=True"] : []),
  ];
  return (
    <Dialog
      title="Background"
      help="guides/analysis/"
      width={420}
      onClose={close}
      submitDisabled={wave === "" || rangeBad || averageBad}
      onSubmit={() => {
        runPython(`op.background(${args.join(", ")})`);
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
      <Field label="X data">
        <XWaveSelect value={x} onChange={setX} />
      </Field>
      <Field label="Method">
        <Select
          aria-label="Method"
          value={method}
          onChange={(event) => setMethod(event.target.value)}
        >
          <option>shirley</option>
          <option>tougaard</option>
          <option>linear</option>
        </Select>
      </Field>
      <Field label="Range" group>
        <TextInput
          aria-label="From"
          aria-invalid={rangeBad}
          className="w-20"
          placeholder="from x"
          disabled={between}
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextInput
          aria-label="To"
          aria-invalid={rangeBad}
          className="w-20"
          placeholder="to x"
          disabled={between}
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
        <span className="text-muted">empty: the whole wave</span>
      </Field>
      <div className="pl-[104px]">
        <Checkbox
          label={
            hasCursors
              ? `Between cursors A and B of ${graph!.name}`
              : "Between cursors (place A and B on the graph first)"
          }
          disabled={!hasCursors}
          checked={between}
          onChange={(event) => setUseCursors(event.target.checked)}
        />
      </div>
      <Field label="Average">
        <TextInput
          aria-label="Average"
          aria-invalid={averageBad}
          className="w-20"
          value={average}
          onChange={(event) => setAverage(event.target.value)}
        />
        <span className="text-muted">points at each end, for its level</span>
      </Field>
      <Field label="Also make" group>
        <Checkbox
          label="Subtracted spectrum"
          checked={subtract}
          onChange={(event) => setSubtract(event.target.checked)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Makes <code>{leafName(wave) || "wave"}_bg</code>
        {subtract ? (
          <>
            {" "}
            and <code>{leafName(wave) || "wave"}_sub</code>
          </>
        ) : null}
        , NaN outside the range. Tougaard needs X in eV and scales its strength to meet the data at
        the far end.
      </div>
    </Dialog>
  );
}

/** The X values of cursors A and B on a graph, lower first; null unless both are set. */
export function useCursorXs(graph: GraphSpec | undefined): [number, number] | null {
  const waves = useDoc((state) => state.waves);
  if (!graph?.cursors.A || !graph.cursors.B) return null;
  const xs = [graph.cursors.A, graph.cursors.B].map((cursor) => {
    const trace = graph.traces.find((item) => item.name === cursor.trace);
    const y = trace ? waves[trace.y] : undefined;
    if (!trace || !y) return Number.NaN;
    const x = trace.x === null ? null : (waves[trace.x] ?? null);
    // Enough digits that the cursor's own point stays inside the range.
    return Number(traceX(y, x?.text ? null : x, cursor.point).toPrecision(15));
  });
  return xs.every(Number.isFinite) ? [Math.min(xs[0]!, xs[1]!), Math.max(xs[0]!, xs[1]!)] : null;
}

/** Two X values for a range, with a button that takes them from the cursors. */
export function RangeField({
  label,
  range,
  onChange,
  cursors,
  invalid,
}: {
  label: string;
  range: [string, string];
  onChange: (range: [string, string]) => void;
  cursors: [number, number] | null;
  invalid: boolean;
}) {
  return (
    <Field label={label} group>
      <TextInput
        aria-label={`${label} from`}
        aria-invalid={invalid}
        className="w-20"
        placeholder="from x"
        value={range[0]}
        onChange={(event) => onChange([event.target.value, range[1]])}
      />
      <TextInput
        aria-label={`${label} to`}
        aria-invalid={invalid}
        className="w-20"
        placeholder="to x"
        value={range[1]}
        onChange={(event) => onChange([range[0], event.target.value])}
      />
      <Button
        aria-label={`${label} from cursors`}
        disabled={!cursors}
        title={cursors ? "Take the range from cursors A and B" : "Place cursors A and B first"}
        onClick={() => cursors && onChange([String(cursors[0]), String(cursors[1])])}
      >
        A–B
      </Button>
    </Field>
  );
}

/** Builds an `op.onset(...)` call: an edge extrapolated to a baseline. */
export function OnsetDialog({ wave: initial }: { wave?: string }) {
  const waves = useNumericWaves(1);
  const preselected = useUi((state) => state.selectedWaves);
  const [wave, setWave] = useState(
    initial ?? preselected.find((name) => waves.includes(name)) ?? waves[0] ?? "",
  );
  const [x, setX] = useState(CALCULATED);
  const [edge, setEdge] = useState<[string, string]>(["", ""]);
  const [kind, setKind] = useState("range");
  const [base, setBase] = useState<[string, string]>(["", ""]);
  const [level, setLevel] = useState("0");
  const { graph } = useGraphShowing(wave);
  const [draw, setDraw] = useState(true);
  const cursors = useCursorXs(graph);
  const edgeLow = pyNumber(edge[0]);
  const edgeHigh = pyNumber(edge[1]);
  const baseLow = pyNumber(base[0]);
  const baseHigh = pyNumber(base[1]);
  const levelValue = pyNumber(level);
  const edgeBad = !edgeLow || !edgeHigh;
  const baseBad = kind === "range" && (!baseLow || !baseHigh);
  const levelBad = kind === "level" && !levelValue;
  const baseline =
    kind === "range"
      ? [`baseline=(${baseLow}, ${baseHigh})`]
      : kind === "level" && levelValue !== "0"
        ? [`baseline=${levelValue}`]
        : [];
  const args = [
    pyName(wave),
    ...(x === CALCULATED ? [] : [`x=${pyName(x)}`]),
    `edge=(${edgeLow}, ${edgeHigh})`,
    ...baseline,
    ...(draw && graph ? ["graph=True"] : []),
  ];
  return (
    <Dialog
      title="Onset"
      help="guides/analysis/"
      width={440}
      onClose={close}
      submitDisabled={wave === "" || edgeBad || baseBad || levelBad}
      onSubmit={() => {
        runPython(`op.onset(${args.join(", ")})`);
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
      <Field label="X data">
        <XWaveSelect value={x} onChange={setX} />
      </Field>
      <RangeField
        label="Edge"
        range={edge}
        onChange={setEdge}
        cursors={cursors}
        invalid={edgeBad && (edge[0] !== "" || edge[1] !== "")}
      />
      <Field label="Baseline">
        <Select
          aria-label="Baseline"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="range">a line fitted over a range</option>
          <option value="level">a constant level</option>
        </Select>
      </Field>
      {kind === "range" ? (
        <RangeField
          label="Over"
          range={base}
          onChange={setBase}
          cursors={cursors}
          invalid={baseBad && (base[0] !== "" || base[1] !== "")}
        />
      ) : (
        <Field label="Level">
          <TextInput
            aria-label="Level"
            aria-invalid={levelBad}
            className="w-20"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          />
        </Field>
      )}
      <div className="pl-[104px]">
        <Checkbox
          label={
            graph ? `Draw the lines on ${graph.name}` : "Draw the lines (no graph shows the wave)"
          }
          disabled={!graph}
          checked={draw && Boolean(graph)}
          onChange={(event) => setDraw(event.target.checked)}
        />
      </div>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Fits a straight line to the edge and another to the baseline, and reports where they cross
        with its uncertainty. Ranges are X values; A–B takes them from the cursors.
      </div>
    </Dialog>
  );
}

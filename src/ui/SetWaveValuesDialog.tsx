import { useMemo, useRef, useState } from "react";
import { requestCommandLine, runGui, ui, useDoc } from "../app/session";
import { checkPath, uniqueName, type Command } from "../core/doc/commands";
import { echoPython } from "../core/doc/echo";
import {
  checkCycle,
  evaluateFormula,
  FORMULA_FUNCTIONS,
  formulaName,
  FormulaError,
  parseFormula,
  type FormulaOutcome,
} from "../core/doc/formula";
import { DocError, type DocState } from "../core/doc/types";
import { formatNumber } from "../core/plot/ticks";
import { Button, Checkbox, Dialog, Field, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** How many points the preview shows. */
const PREVIEW_ROWS = 6;

type Preview =
  | { ok: true; outcome: FormulaOutcome }
  | { ok: false; message: string; at: number | null }
  | null;

/** What the formula would give, worked out as setting it would, without changing anything. */
function preview(state: DocState, target: string, expr: string): Preview {
  if (!expr.trim()) return null;
  try {
    const name = checkPath(target, "wave");
    // The text is read as the command will read it: without the spaces around it.
    const parsed = parseFormula(expr.trim());
    checkCycle(state, name, parsed);
    return { ok: true, outcome: evaluateFormula(state, name, parsed) };
  } catch (error) {
    if (error instanceof FormulaError) {
      const lead = expr.length - expr.trimStart().length;
      return { ok: false, message: error.detail, at: error.at + lead };
    }
    if (error instanceof DocError) return { ok: false, message: error.message, at: null };
    throw error;
  }
}

/**
 * Sets a wave's values from a formula of other waves, as Igor's Set Wave
 * Values does with `R := V / I`: the wave keeps the formula and, if asked,
 * follows its waves as they change.
 */
export function SetWaveValuesDialog({ wave: initial }: { wave?: string }) {
  const state = useDoc((current) => current);
  const [target, setTarget] = useState(
    () => initial ?? uniqueName("wave", (name) => name in state.waves),
  );
  const existingFormula = initial ? state.waves[initial]?.formula : undefined;
  const [expr, setExpr] = useState(existingFormula?.expr ?? "");
  const [auto, setAuto] = useState(existingFormula?.auto ?? true);
  const exprRef = useRef<HTMLInputElement>(null);
  const name = target.trim().replace(/^root:/, "");
  const result = useMemo(() => preview(state, name, expr), [state, name, expr]);
  const existing = state.waves[name];
  const numeric = state.waveOrder.filter((item) => {
    const wave = state.waves[item]!;
    return !wave.text && !wave.imag && wave.shape.length === 1;
  });
  const command: Command = { op: "setFormula", name, expr: expr.trim(), auto };

  const insert = (text: string) => {
    const input = exprRef.current;
    const start = input?.selectionStart ?? expr.length;
    const end = input?.selectionEnd ?? expr.length;
    const next = expr.slice(0, start) + text + expr.slice(end);
    setExpr(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  return (
    <Dialog
      title="Set Wave Values"
      width={520}
      onClose={close}
      submitDisabled={!result?.ok}
      onSubmit={() => {
        if (runGui(command) !== undefined) close();
      }}
      buttons={
        <Button
          disabled={!result?.ok}
          onClick={() => {
            requestCommandLine(echoPython(command) ?? "");
            close();
          }}
        >
          To Cmd Line
        </Button>
      }
    >
      <Field label="Wave">
        <TextInput
          aria-label="Wave"
          className="w-40"
          list="set-wave-values-waves"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <datalist id="set-wave-values-waves">
          {numeric.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <span className="truncate text-[11px] text-muted">
          {!existing
            ? "A new wave"
            : existing.formula
              ? `Now ${existing.formula.expr}`
              : "Its values are replaced"}
        </span>
      </Field>
      <Field label="= Formula">
        <TextInput
          ref={exprRef}
          data-autofocus
          aria-label="Formula"
          aria-invalid={result !== null && !result.ok}
          className="min-w-0 flex-1 font-mono"
          placeholder="V / I"
          value={expr}
          onChange={(event) => setExpr(event.target.value)}
        />
      </Field>
      <Field label="Insert">
        <Select
          aria-label="Insert a wave"
          className="w-40"
          value=""
          onChange={(event) => event.target.value && insert(formulaName(event.target.value))}
        >
          <option value="">Wave…</option>
          {numeric
            .filter((item) => item !== name)
            .map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
        </Select>
        <Select
          aria-label="Insert a function"
          className="w-32"
          value=""
          onChange={(event) => event.target.value && insert(`${event.target.value}(`)}
        >
          <option value="">Function…</option>
          {FORMULA_FUNCTIONS.map((fn) => (
            <option key={fn} value={fn}>
              {fn}
            </option>
          ))}
        </Select>
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Point by point: <code>+ - * / ^</code>, comparisons, <code>&amp;&amp; || !</code>,{" "}
        <code>a ? b : c</code>, <code>p</code> (point), <code>x</code>, <code>pi</code>,{" "}
        <code>nan</code>. Waves must have the same length and X scaling.
      </div>
      <Field label="Recalculate" group>
        <Checkbox
          label="Automatically, whenever its waves change"
          checked={auto}
          onChange={(event) => setAuto(event.target.checked)}
        />
      </Field>
      <section
        aria-label="Preview"
        className="ml-[104px] min-h-[120px] rounded border border-line-soft bg-paper p-2"
      >
        {result === null ? (
          <span className="text-muted">Type a formula to see its first values.</span>
        ) : result.ok ? (
          <PreviewTable outcome={result.outcome} />
        ) : (
          <div role="alert" className="text-danger">
            {result.at !== null ? (
              <pre className="m-0 mb-1 overflow-hidden font-mono text-[11px] text-ink">
                {expr}
                {"\n"}
                {" ".repeat(result.at)}^
              </pre>
            ) : null}
            {result.message}
          </div>
        )}
      </section>
    </Dialog>
  );
}

function PreviewTable({ outcome }: { outcome: FormulaOutcome }) {
  const { values, x0, dx, zeroDivisions } = outcome;
  const rows = Math.min(values.length, PREVIEW_ROWS);
  return (
    <div className="flex flex-col gap-1">
      <table className="w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr className="text-left text-muted">
            <th className="w-12 font-normal">p</th>
            <th className="w-32 font-normal">x</th>
            <th className="font-normal">value</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, point) => (
            <tr key={point}>
              <td className="text-muted">{point}</td>
              <td className="text-muted">{formatNumber(x0 + point * dx, 6)}</td>
              <td>{formatNumber(values[point]!, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-muted">
        {values.length} point{values.length === 1 ? "" : "s"}
        {values.length > rows ? `, the first ${rows} shown` : ""}.
        {zeroDivisions > 0 ? (
          <span className="text-danger"> {zeroDivisions} divided by zero, NaN there.</span>
        ) : null}
      </div>
    </div>
  );
}

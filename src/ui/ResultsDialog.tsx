import { useMemo, useState } from "react";
import { pyName, runPython } from "../app/actions";
import { runGui, ui, useDoc } from "../app/session";
import { changedInputs, type AnalysisResult, type Json } from "../core/doc/results";
import { Button, Dialog, NameList } from "./controls";

/** A number as a table shows it: six significant digits, no trailing zeros. */
const show = (value: number | null): string =>
  value === null ? "—" : String(Number(value.toPrecision(6)));

/** A setting as Python would write it, for the details of a result. */
function literal(value: Json): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}: ${literal(item)}`)
    .join(", ")}}`;
}

/** The settings that say something: not those left at "nothing" or "no". */
const told = (result: AnalysisResult): [string, Json][] =>
  Object.entries(result.settings).filter(
    ([, value]) =>
      value !== null &&
      value !== false &&
      !(Array.isArray(value) && value.length === 0) &&
      !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0),
  );

/** Pairs of parameters that are almost wholly correlated: neither is known by itself. */
function entangled(result: AnalysisResult): string[] {
  const pairs: string[] = [];
  const { covariance, names } = result;
  if (!covariance) return pairs;
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b, c] = [covariance[i]![i], covariance[j]![j], covariance[i]![j]];
      if (!a || !b || c === null || c === undefined) continue;
      const correlation = c / Math.sqrt(a * b);
      if (Math.abs(correlation) > 0.98) {
        pairs.push(`${names[i]} and ${names[j]} (${correlation.toFixed(3)})`);
      }
    }
  }
  return pairs;
}

function Details({ result, changed }: { result: AnalysisResult; changed: string[] }) {
  const pairs = entangled(result);
  const outputs = Object.values(result.outputs);
  return (
    <div
      className="selectable max-h-40 overflow-auto rounded border border-line bg-paper px-2 py-1.5 leading-relaxed"
      role="region"
      aria-label="Details"
    >
      <div>
        <span className="font-semibold">{result.name}</span>: {result.label},{" "}
        {new Date(result.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        {", "}
        {result.points} points, {result.freedom} degrees of freedom
      </div>
      <div className={result.converged ? "" : "text-danger"}>
        {result.converged ? "" : "Did not converge: "}
        {result.reason}
      </div>
      {changed.length > 0 ? (
        <div className="text-danger">
          The data has changed since: {changed.join(", ")}. Fit again to bring the result up to
          date.
        </div>
      ) : null}
      {pairs.length > 0 ? <div>Strongly correlated: {pairs.join(", ")}.</div> : null}
      <div className="font-mono text-[11px]">
        {told(result)
          .map(([key, value]) => `${key}=${literal(value)}`)
          .join(", ")}
      </div>
      {outputs.length > 0 ? <div className="text-muted">Made: {outputs.join(", ")}</div> : null}
    </div>
  );
}

/**
 * The analyses kept in the experiment, a row for each and a column for each
 * parameter, so that samples and conditions can be compared; from here a
 * result is fitted again, applied to other waves, or put into a table.
 */
export function ResultsDialog({ focus }: { focus?: string }) {
  const results = useDoc((state) => state.results);
  const state = useDoc((doc) => doc);
  const list = useMemo(
    () => Object.values(results).sort((a, b) => a.created - b.created),
    [results],
  );
  const [selected, setSelected] = useState<string[]>(focus ? [focus] : []);
  const [applying, setApplying] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const chosen = list.filter((result) => selected.includes(result.name));
  const shown = chosen.at(-1) ?? null;
  // Columns for every parameter of the results listed, in the order they first appear.
  const parameters = useMemo(() => {
    const names: string[] = [];
    for (const result of list) {
      for (const name of result.names) if (!names.includes(name)) names.push(name);
    }
    return names;
  }, [list]);
  const stale = useMemo(
    () => new Map(list.map((result) => [result.name, changedInputs(state, result)])),
    [list, state],
  );
  const close = () => ui.set({ dialog: null });
  const run = (code: string) => {
    runPython(code);
    close();
  };
  const names = chosen.map((result) => pyName(result.name)).join(", ");
  const waves = state.waveOrder.filter((name) => {
    const wave = state.waves[name];
    return wave && !wave.text && wave.shape.length === 1;
  });
  const cell = "border-b border-r border-line-soft px-1.5 py-0.5 whitespace-nowrap";
  return (
    <Dialog title="Analysis Results" width={940} onClose={close}>
      {list.length === 0 ? (
        <p className="m-0 text-muted">
          No results yet. Each fit (Analysis › Curve Fitting…, <code>op.fit</code>,{" "}
          <code>op.fit_peaks</code>, <code>op.fit_global</code>) is kept here with its settings.
        </p>
      ) : (
        <div
          className="max-h-[42vh] overflow-auto rounded border border-line bg-paper"
          role="region"
          aria-label="Results"
        >
          <table className="border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-10 bg-chrome">
              <tr>
                {["", "Result", "Analysis", "χ²", ...parameters].map((title, index) => (
                  <th key={index} className={`${cell} border-line font-semibold`}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((result) => {
                const picked = selected.includes(result.name);
                const changed = stale.get(result.name) ?? [];
                return (
                  <tr
                    key={result.name}
                    aria-selected={picked}
                    className={picked ? "bg-accent/10" : "hover:bg-chrome"}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).tagName === "INPUT") return;
                      setSelected([result.name]);
                    }}
                  >
                    <td className={cell}>
                      <input
                        type="checkbox"
                        className="accent-accent"
                        aria-label={`Select ${result.name}`}
                        checked={picked}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, result.name]
                              : selected.filter((name) => name !== result.name),
                          )
                        }
                      />
                    </td>
                    <td className={`${cell} font-medium`}>
                      {result.name}
                      {changed.length > 0 ? (
                        <span
                          className="ml-1 text-danger"
                          title={`Changed since the fit: ${changed.join(", ")}`}
                        >
                          (data changed)
                        </span>
                      ) : null}
                    </td>
                    <td className={`${cell} ${result.converged ? "" : "text-danger"}`}>
                      {result.label}
                      {result.converged ? "" : " (did not converge)"}
                    </td>
                    <td className={`${cell} font-mono text-[11px]`}>{show(result.chisq)}</td>
                    {parameters.map((name) => {
                      const at = result.names.indexOf(name);
                      return (
                        <td key={name} className={`${cell} font-mono text-[11px]`}>
                          {at < 0
                            ? ""
                            : result.held.includes(name)
                              ? `${show(result.coef[at]!)} (held)`
                              : `${show(result.coef[at]!)} ± ${show(result.sigma[at]!)}`}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {shown ? <Details result={shown} changed={stale.get(shown.name) ?? []} /> : null}
      {applying && shown ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted">
            Fit these waves the way {shown.name} was fitted ({shown.label}):
          </span>
          <NameList
            label="Waves to fit"
            names={waves}
            selected={targets}
            onChange={setTargets}
            height={110}
          />
          <div>
            <Button
              primary
              disabled={targets.length === 0}
              onClick={() =>
                run(`op.result(${pyName(shown.name)}).apply([${targets.map(pyName).join(", ")}])`)
              }
            >
              Fit {targets.length || ""} Wave{targets.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={chosen.length === 0}
          title="Fit again with the same settings, on the data as it is now. The new result is kept beside the old one."
          onClick={() =>
            run(chosen.map((result) => `op.result(${pyName(result.name)}).rerun()`).join("\n"))
          }
        >
          Fit Again
        </Button>
        <Button
          disabled={chosen.length !== 1 || shown?.kind === "global"}
          title="Fit other waves with the settings of this result."
          onClick={() => setApplying(!applying)}
        >
          Apply to Waves…
        </Button>
        <Button
          disabled={list.length === 0}
          title="Put the selected results (or all of them) side by side in a table of waves."
          onClick={() => run(`op.results_table(${chosen.length > 0 ? `[${names}]` : ""})`)}
        >
          Make Table
        </Button>
        <span className="flex-1" />
        <Button
          disabled={chosen.length === 0}
          onClick={() => {
            const removed = chosen.map((result) => result.name);
            if (runGui({ op: "removeResults", names: removed }) !== undefined) setSelected([]);
          }}
        >
          Delete
        </Button>
      </div>
    </Dialog>
  );
}

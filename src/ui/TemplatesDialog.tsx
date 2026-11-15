import { useMemo, useState, useSyncExternalStore } from "react";
import { doc, kernel, runGui, ui, useDoc } from "../app/session";
import { findAction, type ActionArgs } from "../core/actions";
import {
  argText,
  changedSampleInputs,
  retryable,
  runCounts,
  type AnalysisTemplate,
  type OnError,
  type RunState,
  type TemplateRun,
} from "../core/doc/analysisTemplates";
import { checkName } from "../core/doc/commands";
import { leafName, parentFolder, type DocState } from "../core/doc/types";
import { Button, Dialog, Field, NameList, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

const isTemplateName = (name: string): boolean => {
  try {
    checkName(name, "template");
    return true;
  } catch {
    return false;
  }
};

type Row = Record<string, string>;

const STATE_CLASS: Record<RunState, string> = {
  succeeded: "",
  failed: "text-danger",
  cancelled: "text-muted",
  pending: "text-muted",
};

/** The waves analyses made: fitted curves and the like, which are no samples. */
function madeWaves(state: DocState): Set<string> {
  const made = new Set<string>();
  for (const result of Object.values(state.results)) {
    for (const wave of Object.values(result.outputs)) made.add(wave);
  }
  for (const run of Object.values(state.runs)) {
    for (const sample of run.samples) for (const wave of sample.waves) made.add(wave);
  }
  return made;
}

/** The waves directly in a data folder ("" for root), but for those analyses made. */
function wavesIn(state: DocState, folder: string): string[] {
  const made = madeWaves(state);
  return state.waveOrder.filter((name) => parentFolder(name) === folder && !made.has(name));
}

/**
 * Rows for the waves of a folder, by the rule of names: for a template of
 * one input, a row for each wave in the folder; for several inputs, a row
 * for each folder at or below it that has a wave named after every input
 * (the leaf name, ignoring case), such as run1:spectrum and run1:energy.
 */
function folderRows(state: DocState, template: AnalysisTemplate, folder: string): Row[] {
  const slots = template.inputs.map((input) => input.name);
  if (slots.length === 1) return wavesIn(state, folder).map((wave) => ({ [slots[0]!]: wave }));
  const below = [folder, ...state.folders.filter((path) => isBelow(path, folder))];
  const rows: Row[] = [];
  for (const path of below) {
    const waves = wavesIn(state, path);
    const row: Row = {};
    for (const slot of slots) {
      const match = waves.find((wave) => leafName(wave).toLowerCase() === slot.toLowerCase());
      if (match) row[slot] = match;
    }
    if (Object.keys(row).length === slots.length) rows.push(row);
  }
  return rows;
}

const isBelow = (path: string, folder: string): boolean =>
  folder === "" ? path !== "" : path.startsWith(`${folder}:`);

const complete = (row: Row, template: AnalysisTemplate): boolean =>
  template.inputs.every((input) => (row[input.name] ?? "") !== "");

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The samples of a run, with how each went, what it made, and why it failed. */
function RunSamples({ run, state }: { run: TemplateRun; state: DocState }) {
  const slots = run.copy.inputs.map((input) => input.name);
  const cell = "border-b border-r border-line-soft px-1.5 py-0.5 whitespace-nowrap align-top";
  return (
    <div
      className="max-h-48 overflow-auto rounded border border-line bg-paper"
      role="region"
      aria-label="Samples of the run"
    >
      <table className="border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-chrome">
          <tr>
            {["#", ...slots, "State", "Made", "Error"].map((title) => (
              <th key={title} className={`${cell} border-line font-semibold`}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.samples.map((sample, index) => {
            const changed = changedSampleInputs(state, sample);
            return (
              <tr key={index} aria-label={`Sample ${index + 1}`}>
                <td className={`${cell} text-muted`}>{index + 1}</td>
                {slots.map((slot) => (
                  <td key={slot} className={cell}>
                    {sample.inputs[slot]}
                    {changed.includes(sample.inputs[slot]!) ? (
                      <span className="ml-1 text-danger" title="Changed since the sample was done">
                        (changed)
                      </span>
                    ) : null}
                  </td>
                ))}
                <td className={`${cell} ${STATE_CLASS[sample.state]}`}>
                  {sample.state}
                  {sample.attempts > 1 ? ` (${sample.attempts} tries)` : ""}
                </td>
                <td className={`${cell} text-muted`}>
                  {[...sample.results, ...sample.waves].join(", ")}
                </td>
                <td className={`${cell} whitespace-normal text-danger`}>{sample.error}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The analysis templates of the experiment: their steps, a grid of samples
 * to run one on (a wave for each input in each row), and the runs made, with
 * how each sample went. Runs, retries and tables are done by Python, through
 * the actions core.run_template, core.retry_run and core.run_table, so that
 * the history shows each as the Python that does it.
 */
export function TemplatesDialog({
  template: initial,
  run: initialRun,
}: {
  template?: string;
  run?: string;
}) {
  const state = useDoc((current) => current);
  const catalog = useSyncExternalStore(kernel.subscribeActions, kernel.getActions);
  const names = Object.keys(state.templates);
  const [picked, setPicked] = useState<string | null>(initial ?? names[0] ?? null);
  const name = picked !== null && picked in state.templates ? picked : null;
  const template = name === null ? undefined : state.templates[name];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => (template ? firstRows(template) : [{}]));
  const [folder, setFolder] = useState("");
  const [onError, setOnError] = useState<OnError>("continue");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const runs = useMemo(
    () => Object.values(state.runs).sort((a, b) => a.created - b.created),
    [state.runs],
  );
  const [pickedRun, setPickedRun] = useState<string | null>(
    initialRun ?? runs.findLast((run) => run.template === initial)?.name ?? null,
  );
  const run = pickedRun !== null ? state.runs[pickedRun] : undefined;

  function firstRows(chosen: AnalysisTemplate): Row[] {
    const current = doc.getState();
    const slot = chosen.inputs[0]!.name;
    const selected = ui.get().selectedWaves.filter((wave) => wave in current.waves);
    return selected.length > 0 ? selected.map((wave) => ({ [slot]: wave })) : [{}];
  }

  const pick = (next: string[]) => {
    const chosen = next[0] ?? null;
    setPicked(chosen);
    setRenaming(null);
    const found = chosen === null ? undefined : doc.getState().templates[chosen];
    if (found) setRows(firstRows(found));
  };
  const rename = () => {
    if (name === null || renaming === null) return;
    const newName = renaming.trim();
    if (runGui({ op: "renameTemplate", name, newName }) === undefined) return;
    setPicked(newName);
    setRenaming(null);
  };
  const remove = () => {
    if (name !== null) runGui({ op: "removeTemplate", name });
  };

  /** Adds rows after those that have a wave, a row's other inputs copied from the last. */
  const addRows = (added: Row[]) => {
    if (added.length === 0) return;
    setRows((current) => {
      const kept = current.filter((row) => Object.values(row).some((wave) => wave !== ""));
      const last = kept.at(-1) ?? {};
      return [...kept, ...added.map((row) => ({ ...last, ...row }))];
    });
  };
  const setCell = (index: number, slot: string, wave: string) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, [slot]: wave } : row)));

  const samples = template ? rows.filter((row) => complete(row, template)) : [];
  const incomplete = template ? rows.length - samples.length : 0;
  const problem = !template
    ? "Choose a template."
    : samples.length === 0
      ? "Give each input a wave in at least one row."
      : incomplete > 0
        ? `${incomplete} row${incomplete === 1 ? " has" : "s have"} an input without a wave.`
        : kernel.getState().status === "unavailable" || kernel.getState().status === "failed"
          ? `Python is not running: ${kernel.getState().message}`
          : null;

  /** Calls an action as the GUI does, keeping the dialog open to show the run as it goes. */
  const call = async (id: string, args: ActionArgs): Promise<unknown> => {
    setBusy(true);
    setMessage(null);
    try {
      return await kernel.invoke(id, args);
    } catch (error) {
      setMessage(errorText(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!template || name === null || problem) return;
    const before = new Set(Object.keys(doc.getState().runs));
    // The run is recorded before its first sample: show it while it goes.
    const watch = doc.subscribe(() => {
      const made = Object.keys(doc.getState().runs).find((item) => !before.has(item));
      if (made) {
        setPickedRun(made);
        watch();
      }
    });
    try {
      await call("core.run_template", {
        template: name,
        samples,
        ...(onError === "continue" ? {} : { on_error: onError }),
      });
    } finally {
      watch();
    }
  };

  const action = (step: AnalysisTemplate["steps"][number]) =>
    findAction(catalog, step.action, step.version);
  const folders = ["", ...state.folders];
  const runItems = runs.map((item) => item.name);
  const counts = run ? runCounts(run) : null;

  return (
    <Dialog
      title="Analysis Templates"
      onClose={close}
      onSubmit={() => void start()}
      submitLabel={
        busy ? "Running…" : samples.length === 1 ? "Run 1 Sample" : `Run ${samples.length} Samples`
      }
      submitDisabled={problem !== null || busy}
      width={820}
    >
      <div className="flex gap-3">
        <div role="group" aria-label="Templates" className="flex w-52 shrink-0 flex-col gap-1.5">
          <div className="text-muted">Templates</div>
          <NameList
            label="Templates"
            names={names}
            selected={name === null ? [] : [name]}
            onChange={pick}
            multiple={false}
            height={120}
          />
          {renaming !== null && name !== null ? (
            <div className="flex gap-1.5">
              <TextInput
                aria-label="New name"
                aria-invalid={!isTemplateName(renaming.trim())}
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
              <Button disabled={!isTemplateName(renaming.trim())} onClick={rename}>
                Rename
              </Button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button disabled={name === null} onClick={() => setRenaming(name)}>
                Rename…
              </Button>
              <Button disabled={name === null} onClick={remove}>
                Delete
              </Button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {template ? (
            <>
              {template.description ? <div>{template.description}</div> : null}
              <ol aria-label="Steps" className="m-0 flex list-decimal flex-col gap-0.5 pl-5">
                {template.steps.map((step) => {
                  const spec = action(step);
                  return (
                    <li key={step.id}>
                      <b>{step.id}</b>{" "}
                      <span className="text-muted">
                        {spec ? spec.title : "not registered"} ({step.action}, version{" "}
                        {step.version})
                      </span>
                      <div className="font-mono text-[11px]">
                        {Object.entries(step.args)
                          .map(([key, value]) => `${key}=${argText(value)}`)
                          .join(", ")}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="text-[11px] text-muted">
                $input is the wave given for that input; step.output is what an earlier step
                returned.
              </div>
            </>
          ) : (
            <div className="text-[11px] text-muted">
              {names.length === 0
                ? "No templates yet. Make one from results with Analysis › Results… › Make Template…, or with op.set_template."
                : "Select a template."}
            </div>
          )}
        </div>
      </div>
      {template ? (
        <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
          <div className="text-muted">
            One sample for each row. Each sample is done by itself: one that fails leaves nothing
            behind, and the others go on.
          </div>
          <div className="max-h-48 overflow-auto">
            <table aria-label="Samples" className="border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left font-normal text-muted">Sample</th>
                  {template.inputs.map((input) => (
                    <th key={input.name} className="text-left font-normal">
                      <b>{input.name}</b>
                      {input.title ? <span className="text-muted"> {input.title}</span> : null}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td className="pr-1 text-muted">{index + 1}</td>
                    {template.inputs.map((input) => (
                      <td key={input.name}>
                        <Select
                          aria-label={`${input.name} of sample ${index + 1}`}
                          className="w-40"
                          value={row[input.name] ?? ""}
                          onChange={(event) => setCell(index, input.name, event.target.value)}
                        >
                          <option value="">Choose…</option>
                          {state.waveOrder.map((wave) => (
                            <option key={wave} value={wave}>
                              {wave}
                            </option>
                          ))}
                        </Select>
                      </td>
                    ))}
                    <td>
                      <Button
                        aria-label={`Remove sample ${index + 1}`}
                        disabled={rows.length === 1}
                        onClick={() =>
                          setRows((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        ×
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* A new row starts as a copy of the last, so a wave shared by every sample is chosen once. */}
            <Button onClick={() => setRows((current) => [...current, { ...current.at(-1) }])}>
              Add Row
            </Button>
            <Button
              title="A row for each wave selected in the Data Browser, in the first input."
              disabled={ui.get().selectedWaves.length === 0}
              onClick={() =>
                addRows(
                  ui
                    .get()
                    .selectedWaves.filter((wave) => wave in state.waves)
                    .map((wave) => ({ [template.inputs[0]!.name]: wave })),
                )
              }
            >
              Add Selected Waves
            </Button>
            <span className="ml-2 text-muted">Folder</span>
            <Select
              aria-label="Folder"
              className="w-32"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            >
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path === "" ? "root" : path}
                </option>
              ))}
            </Select>
            <Button
              title={
                template.inputs.length === 1
                  ? "A row for each wave in the folder, but for the curves and other waves analyses made."
                  : "A row for each folder in it with a wave named after every input."
              }
              onClick={() => {
                const added = folderRows(state, template, folder);
                if (added.length === 0) {
                  setMessage(
                    template.inputs.length === 1
                      ? `There are no waves in ${folder || "root"}.`
                      : `No folder in ${folder || "root"} has waves named ${template.inputs.map((input) => input.name).join(" and ")}.`,
                  );
                }
                addRows(added);
              }}
            >
              Add from Folder
            </Button>
            <Button onClick={() => setRows([{}])}>Clear</Button>
            <span className="flex-1" />
            <Field label="If one fails">
              <Select
                aria-label="If a sample fails"
                value={onError}
                onChange={(event) => setOnError(event.target.value as OnError)}
              >
                <option value="continue">Go on with the others</option>
                <option value="stop">Stop the run</option>
              </Select>
            </Field>
          </div>
          {problem && !busy ? (
            <p className="m-0 text-muted" role="status" aria-label="Problem">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className="m-0 text-danger" role="alert">
          {message}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
        <div className="flex items-center gap-2">
          <span className="text-muted">Runs</span>
          <Select
            aria-label="Run"
            className="w-64"
            value={run ? run.name : ""}
            onChange={(event) => setPickedRun(event.target.value || null)}
          >
            {runItems.length === 0 ? <option value="">None yet</option> : null}
            {run ? null : runItems.length > 0 ? <option value="">Choose a run…</option> : null}
            {runs.map((item) => {
              const each = runCounts(item);
              return (
                <option key={item.name} value={item.name}>
                  {item.name}: {item.template}, {each.succeeded}/{item.samples.length} succeeded
                </option>
              );
            })}
          </Select>
          {run && counts ? (
            <span aria-label="Run summary" role="status">
              {counts.succeeded} succeeded
              {counts.failed > 0 ? `, ${counts.failed} failed` : ""}
              {counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : ""}
              {counts.pending > 0 ? `, ${counts.pending} not done` : ""}
            </span>
          ) : null}
        </div>
        {run ? (
          <>
            <div className="text-[11px] text-muted">
              Run with {run.template} as it was{" "}
              {new Date(run.created).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              : {run.copy.steps.map((step) => `${step.id} (${step.action})`).join(", ")}
              {run.onError === "stop" ? "; stops at the first failure" : ""}.
            </div>
            <RunSamples run={run} state={state} />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || retryable(run).length === 0}
                title="Do again the samples that failed, were cancelled or were not done, with the run's own copy of the template."
                onClick={() => void call("core.retry_run", { run: run.name })}
              >
                Retry Failed
              </Button>
              <Button
                disabled={busy}
                title="Put the samples in a table: their inputs, state and error, and the parameters of their results."
                onClick={() => void call("core.run_table", { run: run.name })}
              >
                Make Table
              </Button>
              <span className="flex-1" />
              <Button
                disabled={busy}
                onClick={() => {
                  if (runGui({ op: "removeRuns", names: [run.name] }) !== undefined) {
                    setPickedRun(null);
                  }
                }}
              >
                Delete Run
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

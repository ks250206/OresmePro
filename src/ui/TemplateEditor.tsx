import { useState, useSyncExternalStore } from "react";
import { actionCatalog, doc, kernel, runGui, subscribeCatalog, ui, useDoc } from "../app/session";
import { findAction, type ActionSpec, type ParamSpec } from "../core/actions";
import {
  argReference,
  checkAnalysisTemplate,
  type AnalysisTemplate,
  type TemplateStep,
} from "../core/doc/analysisTemplates";
import { checkName, uniqueName } from "../core/doc/commands";
import type { Json } from "../core/doc/results";
import { Button, Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** What a step's later steps are most often given of it, offered for its outputs. */
const COMMON_OUTPUTS = ["wave", "fit", "residuals", "background", "subtracted", "value", "result"];

/** Where an argument of a step comes from. */
type Source = "default" | "fixed" | "input" | "step";

const sourceOf = (value: Json | undefined): Source => {
  if (value === undefined) return "default";
  const reference = argReference(value);
  if (reference && "input" in reference) return "input";
  if (reference) return "step";
  return "fixed";
};

/** The value a fixed argument starts with, as its type wants it. */
function startValue(spec: ParamSpec, waves: readonly string[]): Json {
  if (spec.default !== undefined) return spec.default as Json;
  switch (spec.type) {
    case "choice":
      return spec.choices?.[0] ?? "";
    case "number":
    case "integer":
      return spec.min ?? 0;
    case "boolean":
      return false;
    case "wave":
      return waves[0] ?? "";
    case "waves":
    case "numbers":
      return [];
    case "json":
      return {};
    default:
      return "";
  }
}

/** A value that is not a list or an object, as text. */
const flatText = (value: Json): string =>
  value === null || typeof value === "object" ? "" : String(value);

/** A fixed value as typed in a text field, and back. */
const asText = (spec: ParamSpec, value: Json): string => {
  if (spec.type === "numbers" || spec.type === "waves") {
    return Array.isArray(value) ? value.map(flatText).join(", ") : "";
  }
  if (spec.type === "json") return JSON.stringify(value);
  return flatText(value);
};

/** What text typed for a fixed value stands for, or an error saying why it stands for nothing. */
function fromText(spec: ParamSpec, text: string): { value: Json } | { error: string } {
  const trimmed = text.trim();
  switch (spec.type) {
    case "number":
    case "integer": {
      const number = Number(trimmed);
      if (trimmed === "" || !Number.isFinite(number)) return { error: "Type a number." };
      if (spec.type === "integer" && !Number.isInteger(number)) {
        return { error: "Type a whole number." };
      }
      return { value: number };
    }
    case "numbers": {
      const items = trimmed === "" ? [] : trimmed.split(/[\s,]+/).map(Number);
      return items.every(Number.isFinite)
        ? { value: items }
        : { error: "Type numbers separated by commas." };
    }
    case "waves":
      return { value: trimmed === "" ? [] : trimmed.split(/\s*,\s*/) };
    case "json":
      try {
        return { value: JSON.parse(trimmed) as Json };
      } catch {
        return { error: 'Type JSON, such as {"y0": 0} or [[1, 2], [5, 6]].' };
      }
    default:
      return { value: text };
  }
}

/** A step for an action: a required wave is the first input, another required argument starts at a value. */
function newStep(
  spec: ActionSpec,
  template: AnalysisTemplate,
  waves: readonly string[],
): TemplateStep {
  const base = spec.id.split(".").at(-1) ?? "step";
  const taken = new Set(template.steps.map((step) => step.id));
  const id = taken.has(base) ? uniqueName(base, (name) => taken.has(name)) : base;
  const args: Record<string, Json> = {};
  const first = template.inputs[0]?.name;
  for (const [name, param] of Object.entries(spec.params)) {
    if (param.optional || param.default !== undefined) continue;
    if (param.type === "wave" && first) args[name] = { $input: first };
    else if (param.type !== "wave") args[name] = startValue(param, waves);
  }
  if ("quiet" in spec.params) args.quiet = true;
  return { id, action: spec.id, version: spec.version, args };
}

/** Why the template cannot be kept as it is, or null if it can. */
function templateProblem(template: AnalysisTemplate): string | null {
  try {
    checkAnalysisTemplate(template);
    return template.steps.length === 0 ? "Add a step." : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The arguments of a step its action needs and the step does not give. */
function missingArgs(step: TemplateStep, spec: ActionSpec | undefined): string[] {
  if (!spec) return [];
  return Object.entries(spec.params)
    .filter(
      ([name, param]) => !param.optional && param.default === undefined && !(name in step.args),
    )
    .map(([name]) => name);
}

/** One argument of the step being edited: where it comes from, and its value. */
function ArgRow({
  name,
  spec,
  value,
  template,
  stepIndex,
  onChange,
}: {
  name: string;
  spec: ParamSpec;
  value: Json | undefined;
  template: AnalysisTemplate;
  stepIndex: number;
  onChange: (value: Json | undefined) => void;
}) {
  const waves = useDoc((state) => state.waveOrder);
  const [text, setText] = useState<string | null>(null);
  const source = sourceOf(value);
  const earlier = template.steps.slice(0, stepIndex);
  const reference = value === undefined ? null : argReference(value);
  const label = `${name}${spec.optional || spec.default !== undefined ? "" : " *"}`;
  const typed = text === null ? null : fromText(spec, text);

  const choose = (next: Source) => {
    setText(null);
    if (next === "default") onChange(undefined);
    else if (next === "fixed") onChange(startValue(spec, waves));
    else if (next === "input") onChange({ $input: template.inputs[0]?.name ?? "" });
    else onChange({ $step: earlier.at(-1)?.id ?? "", output: COMMON_OUTPUTS[0]! });
  };

  let editor: React.ReactNode = null;
  if (source === "fixed") {
    if (spec.type === "boolean") {
      editor = (
        <Checkbox
          label={spec.title ?? name}
          aria-label={`${name} value`}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    } else if (spec.type === "choice") {
      editor = (
        <Select
          aria-label={`${name} value`}
          value={value === undefined ? "" : flatText(value)}
          onChange={(event) =>
            onChange(
              (spec.choices ?? []).find((choice) => String(choice) === event.target.value) ?? "",
            )
          }
        >
          {(spec.choices ?? []).map((choice) => (
            <option key={String(choice)} value={String(choice)}>
              {String(choice)}
            </option>
          ))}
        </Select>
      );
    } else if (spec.type === "wave") {
      editor = (
        <Select
          aria-label={`${name} value`}
          className="min-w-0 flex-1"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {waves.map((wave) => (
            <option key={wave}>{wave}</option>
          ))}
        </Select>
      );
    } else {
      editor = (
        <TextInput
          aria-label={`${name} value`}
          aria-invalid={typed !== null && "error" in typed}
          className="min-w-0 flex-1 font-mono"
          title={typed && "error" in typed ? typed.error : undefined}
          value={text ?? asText(spec, value ?? null)}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = fromText(spec, event.target.value);
            if ("value" in parsed) onChange(parsed.value);
          }}
        />
      );
    }
  } else if (source === "input") {
    editor = (
      <Select
        aria-label={`${name} input`}
        value={reference && "input" in reference ? reference.input : ""}
        onChange={(event) => onChange({ $input: event.target.value })}
      >
        {template.inputs.map((input) => (
          <option key={input.name}>{input.name}</option>
        ))}
      </Select>
    );
  } else if (source === "step" && reference && "step" in reference) {
    const list = `outputs-${stepIndex}-${name}`;
    editor = (
      <>
        <Select
          aria-label={`${name} step`}
          value={reference.step}
          onChange={(event) => onChange({ $step: event.target.value, output: reference.output })}
        >
          {earlier.map((step) => (
            <option key={step.id}>{step.id}</option>
          ))}
        </Select>
        <span className="text-muted">.</span>
        <TextInput
          aria-label={`${name} output`}
          list={list}
          className="w-28"
          value={reference.output}
          onChange={(event) => onChange({ $step: reference.step, output: event.target.value })}
        />
        <datalist id={list}>
          {COMMON_OUTPUTS.map((output) => (
            <option key={output} value={output} />
          ))}
        </datalist>
      </>
    );
  }

  return (
    <div role="group" aria-label={`Argument ${name}`} className="flex items-center gap-1.5">
      <span className="w-28 shrink-0 truncate text-right" title={spec.description ?? undefined}>
        {label}
      </span>
      <Select
        aria-label={`${name} from`}
        className="w-28 shrink-0"
        value={source}
        onChange={(event) => choose(event.target.value as Source)}
      >
        <option value="default">
          {spec.default !== undefined ? `default (${JSON.stringify(spec.default)})` : "left out"}
        </option>
        <option value="fixed">value</option>
        <option value="input" disabled={template.inputs.length === 0}>
          input
        </option>
        <option value="step" disabled={earlier.length === 0}>
          earlier step
        </option>
      </Select>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{editor}</span>
    </div>
  );
}

/**
 * Makes or changes an analysis template: its inputs, its steps in order
 * (each an action, added from the actions registered), and where each
 * argument of a step comes from — a value, an input, or what an earlier
 * step returned. It can be tried on one sample before it is run on many.
 */
export function TemplateEditorDialog({ template: initial }: { template?: string }) {
  const catalog = useSyncExternalStore(subscribeCatalog, actionCatalog);
  const templates = useDoc((state) => state.templates);
  const waves = useDoc((state) => state.waveOrder);
  const existing = initial !== undefined ? templates[initial] : undefined;
  const [name, setName] = useState(
    () => initial ?? uniqueName("template", (taken) => taken in doc.getState().templates),
  );
  const [draft, setDraft] = useState<AnalysisTemplate>(
    () =>
      existing ?? {
        description: "",
        inputs: [{ name: "y", title: "Y wave", kind: "wave" }],
        steps: [],
      },
  );
  const [selected, setSelected] = useState(0);
  const [adding, setAdding] = useState<string>("");
  const [trial, setTrial] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameProblem = (() => {
    try {
      checkName(name, "template");
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  const problem = nameProblem ?? templateProblem(draft);
  const step = draft.steps[selected];
  const spec = step ? findAction(catalog, step.action, step.version) : undefined;
  const offered = catalog.filter((action) => action.id !== "core.run_template");

  const setSteps = (steps: TemplateStep[]) => setDraft({ ...draft, steps });
  const updateStep = (index: number, change: Partial<TemplateStep>) =>
    setSteps(draft.steps.map((item, at) => (at === index ? { ...item, ...change } : item)));
  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[to]] = [steps[to]!, steps[index]!];
    setSteps(steps);
    setSelected(to);
  };
  const save = (): boolean => {
    if (problem) return false;
    return runGui({ op: "setTemplate", name, template: draft }) !== undefined;
  };
  const tryOne = async () => {
    const sample = Object.fromEntries(
      draft.inputs.map((input) => [input.name, trial[input.name] ?? ""]),
    );
    if (!save()) return;
    setBusy(true);
    setMessage(null);
    const before = new Set(Object.keys(doc.getState().runs));
    try {
      await kernel.invoke("core.run_template", { template: name, samples: [sample] });
      const run = Object.values(doc.getState().runs).find((item) => !before.has(item.name));
      const done = run?.samples[0];
      setMessage(
        !run || !done
          ? "Tried."
          : done.state === "succeeded"
            ? `Tried on one sample (${run.name}): made ${[...done.results, ...done.waves].join(", ") || "nothing"}.`
            : `The sample ${done.state}: ${done.error}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const trialReady = draft.inputs.every((input) => (trial[input.name] ?? "") !== "");

  return (
    <Dialog
      title={existing ? `Edit Template — ${initial}` : "New Template"}
      help="guides/curve-fitting/"
      width={880}
      onClose={close}
      submitLabel="Save"
      submitDisabled={problem !== null || busy}
      onSubmit={() => {
        if (save()) ui.set({ dialog: { kind: "templates", template: name } });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Field label="Name">
          <TextInput
            aria-label="Template name"
            aria-invalid={nameProblem !== null}
            className="w-44"
            disabled={existing !== undefined}
            value={name}
            onChange={(event) => setName(event.target.value.trim())}
          />
        </Field>
        <TextInput
          aria-label="Description"
          placeholder="What it does, for whoever runs it"
          className="min-w-0 flex-1"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      <div role="group" aria-label="Inputs" className="flex flex-wrap items-center gap-1.5">
        <span className="w-[104px] shrink-0 text-right text-muted">Inputs</span>
        {draft.inputs.map((input, index) => (
          <span
            key={index}
            className="flex items-center gap-1 rounded border border-line px-1 py-0.5"
          >
            <TextInput
              aria-label={`Input ${index + 1} name`}
              className="w-20"
              value={input.name}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  inputs: draft.inputs.map((item, at) =>
                    at === index ? { ...item, name: event.target.value.trim() } : item,
                  ),
                })
              }
            />
            <TextInput
              aria-label={`Input ${index + 1} title`}
              placeholder="title"
              className="w-24"
              value={input.title}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  inputs: draft.inputs.map((item, at) =>
                    at === index ? { ...item, title: event.target.value } : item,
                  ),
                })
              }
            />
            <Button
              aria-label={`Remove input ${input.name}`}
              disabled={draft.inputs.length === 1}
              onClick={() =>
                setDraft({ ...draft, inputs: draft.inputs.filter((_, at) => at !== index) })
              }
            >
              ×
            </Button>
          </span>
        ))}
        <Button
          onClick={() => {
            const taken = new Set(draft.inputs.map((input) => input.name));
            const fresh = uniqueName("x", (item) => taken.has(item));
            setDraft({
              ...draft,
              inputs: [...draft.inputs, { name: fresh, title: "", kind: "wave" }],
            });
          }}
        >
          Add Input
        </Button>
      </div>
      <div className="flex min-h-[260px] gap-3">
        <div role="group" aria-label="Steps" className="flex w-60 shrink-0 flex-col gap-1.5">
          <div className="text-muted">Steps, in order</div>
          <NameList
            label="Steps"
            names={draft.steps.map((item, index) => `${index + 1}. ${item.id}`)}
            selected={step ? [`${selected + 1}. ${step.id}`] : []}
            onChange={(picked) => {
              const at = draft.steps.findIndex(
                (item, index) => `${index + 1}. ${item.id}` === picked[0],
              );
              if (at >= 0) setSelected(at);
            }}
            multiple={false}
            height={150}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              aria-label="Move step up"
              disabled={!step || selected === 0}
              onClick={() => move(selected, -1)}
            >
              ↑
            </Button>
            <Button
              aria-label="Move step down"
              disabled={!step || selected >= draft.steps.length - 1}
              onClick={() => move(selected, 1)}
            >
              ↓
            </Button>
            <Button
              disabled={!step}
              onClick={() => {
                setSteps(draft.steps.filter((_, at) => at !== selected));
                setSelected(Math.max(0, selected - 1));
              }}
            >
              Remove Step
            </Button>
          </div>
          <div className="flex gap-1.5">
            <Select
              aria-label="Action to add"
              className="min-w-0 flex-1"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
            >
              <option value="">Choose an action…</option>
              {offered.map((action) => (
                <option key={`${action.id}@${action.version}`} value={action.id}>
                  {action.title} ({action.id})
                </option>
              ))}
            </Select>
            <Button
              disabled={!adding}
              onClick={() => {
                const action = findAction(catalog, adding);
                if (!action) return;
                setSteps([...draft.steps, newStep(action, draft, waves)]);
                setSelected(draft.steps.length);
                setAdding("");
              }}
            >
              Add Step
            </Button>
          </div>
        </div>
        <div
          role="group"
          aria-label="Step settings"
          className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto rounded border border-line bg-paper p-2"
          style={{ maxHeight: 340 }}
        >
          {step ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-28 shrink-0 text-right text-muted">Step id</span>
                <TextInput
                  aria-label="Step id"
                  className="w-32"
                  value={step.id}
                  onChange={(event) => updateStep(selected, { id: event.target.value.trim() })}
                />
                <span className="text-muted">
                  {spec ? spec.title : "not registered"} ({step.action}, version {step.version})
                </span>
              </div>
              {spec?.description ? (
                <div className="pl-[124px] text-muted">{spec.description}</div>
              ) : null}
              {spec ? (
                Object.entries(spec.params).map(([param, paramSpec]) => (
                  <ArgRow
                    key={`${selected}:${param}`}
                    name={param}
                    spec={paramSpec}
                    value={step.args[param] as Json | undefined}
                    template={draft}
                    stepIndex={selected}
                    onChange={(value) => {
                      const args = { ...step.args };
                      if (value === undefined) delete args[param];
                      else args[param] = value;
                      updateStep(selected, { args });
                    }}
                  />
                ))
              ) : (
                <div className="text-danger">
                  No action {step.action} is registered: its arguments cannot be edited here.
                </div>
              )}
              {missingArgs(step, spec).length > 0 ? (
                <div className="text-[11px] text-danger">
                  Needs {missingArgs(step, spec).join(", ")}.
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-muted">Add a step: choose an action and press Add Step.</div>
          )}
        </div>
      </div>
      <div
        role="group"
        aria-label="Try"
        className="flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2"
      >
        <span className="text-muted">Try on one sample:</span>
        {draft.inputs.map((input) => (
          <Select
            key={input.name}
            aria-label={`Try ${input.name}`}
            className="w-40"
            value={trial[input.name] ?? ""}
            onChange={(event) => setTrial({ ...trial, [input.name]: event.target.value })}
          >
            <option value="">{input.name}…</option>
            {waves.map((wave) => (
              <option key={wave}>{wave}</option>
            ))}
          </Select>
        ))}
        <Button disabled={problem !== null || !trialReady || busy} onClick={() => void tryOne()}>
          {busy ? "Trying…" : "Save and Try"}
        </Button>
      </div>
      <div
        className={`text-[11px] ${problem || message?.startsWith("The sample") ? "text-danger" : "text-muted"}`}
      >
        {problem ??
          message ??
          "Arguments marked * are needed. A value is the same for every sample."}
      </div>
    </Dialog>
  );
}

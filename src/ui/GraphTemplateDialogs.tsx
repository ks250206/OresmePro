import { useMemo, useState, type ReactNode } from "react";
import { exportTemplates, importTemplates, libraryTemplateCommands } from "../app/actions";
import { doc, runGui, showError, ui, useDoc, useLibraryTemplates } from "../app/session";
import { sameEntry, templateLibrary } from "../app/styleLibrary";
import { applyCommand, checkName, uniqueName, type Command } from "../core/doc/commands";
import { withEntry } from "../core/doc/dict";
import {
  captureTemplate,
  requiredSlots,
  templateSources,
  templateWarnings,
} from "../core/doc/graphTemplates";
import { formatNumber } from "../core/plot/ticks";
import {
  type DocState,
  type GraphTemplate,
  type SlotRole,
  type TemplateSlot,
  type Wave,
} from "../core/doc/types";
import { Button, Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

const isTemplateName = (name: string): boolean => {
  try {
    checkName(name, "graph template");
    return true;
  } catch {
    return false;
  }
};

/** Runs something on the browser's library, telling the user if the browser would not. */
function inLibrary(action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    showError("The graph template library did not change", error);
    return false;
  }
}

const ROLE_TEXT: Record<SlotRole, string> = {
  y: "Y wave",
  x: "X wave",
  yError: "Y error",
  xError: "X error",
  color: "color wave",
  text: "labels",
  z: "image",
};

const unitText = (unit: string | null): string => (unit ? ` (${unit})` : "");

/** How an axis's range reads: what it is set to, or "automatic". */
function rangeText(min: number | null, max: number | null): string {
  if (min === null && max === null) return "automatic";
  const show = (value: number | null) => (value === null ? "auto" : formatNumber(value));
  return `${show(min)} to ${show(max)}`;
}

/**
 * Keeps a graph as a template: its name, which axes keep their ranges, and
 * whether to put it in the browser's library too. It shows the slots the
 * graph's waves become, so the user knows what to give each new graph.
 */
export function SaveGraphTemplateDialog({ graph: graphName }: { graph: string }) {
  const state = useDoc((current) => current);
  const graph = state.graphs[graphName];
  const [name, setName] = useState(() =>
    uniqueName("template", (taken) => taken in doc.getState().graphTemplates),
  );
  const [fixed, setFixed] = useState<string[]>([]);
  const [toLibrary, setToLibrary] = useState(false);
  const preview = useMemo(() => {
    try {
      return graph ? captureTemplate(state, graphName) : null;
    } catch {
      return null;
    }
  }, [state, graph, graphName]);
  if (!graph) return null;

  const sources = templateSources(state, graphName);

  const save = () => {
    if (!isTemplateName(name)) return;
    if (name in state.graphTemplates && !window.confirm(`Replace the graph template ${name}?`)) {
      return;
    }
    const command: Command = {
      op: "saveGraphTemplate",
      name,
      graph: graphName,
      ...(fixed.length > 0 ? { fixed } : {}),
    };
    if (runGui(command) === undefined) return;
    const template = doc.getState().graphTemplates[name];
    if (toLibrary && template) {
      const there = templateLibrary().list()[name];
      const replace =
        !there ||
        sameEntry(there, template) ||
        window.confirm(`The library has a graph template ${name} already. Replace it?`);
      if (replace && !inLibrary(() => templateLibrary().put(name, template))) return;
    }
    close();
  };

  return (
    <Dialog
      title="Save Graph as Template"
      onClose={close}
      onSubmit={save}
      submitLabel="Save"
      submitDisabled={!isTemplateName(name)}
      width={460}
    >
      <Field label="Name">
        <TextInput
          aria-label="Template name"
          aria-invalid={!isTemplateName(name)}
          className="w-40"
          value={name}
          onChange={(event) => setName(event.target.value.trim())}
        />
      </Field>
      <Field label="Slots" group>
        <ul aria-label="Slots" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {(preview?.slots ?? []).map((slot) => (
            <li key={slot.name}>
              <b>{slot.name}</b>
              <span className="text-muted">
                {" "}
                {ROLE_TEXT[slot.role]}, from {sources.get(slot.name)}
                {unitText(slot.unit)}
              </span>
            </li>
          ))}
          {preview && preview.slots.length === 0 ? (
            <li className="text-muted">None: the graph plots nothing.</li>
          ) : null}
        </ul>
      </Field>
      <Field label="Axis ranges" group>
        <div className="flex flex-col gap-1">
          {Object.entries(graph.axes).map(([axis, spec]) => {
            const set = spec.min !== null || spec.max !== null;
            return (
              <Checkbox
                key={axis}
                label={`Keep ${axis} at ${rangeText(spec.min, spec.max)}`}
                disabled={!set}
                checked={fixed.includes(axis)}
                onChange={(event) =>
                  setFixed((list) =>
                    event.target.checked ? [...list, axis] : list.filter((item) => item !== axis),
                  )
                }
              />
            );
          })}
        </div>
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Ranges not kept follow the data of each new graph. Text that names these waves will name the
        waves each graph is made of: {"{y.name}"} and {"{y.unit}"} can also be typed into labels and
        annotations.
      </div>
      <Field label="Also" group>
        <Checkbox
          label="Keep in this browser's library"
          disabled={!templateLibrary().available}
          checked={toLibrary}
          onChange={(event) => setToLibrary(event.target.checked)}
        />
      </Field>
    </Dialog>
  );
}

/** Whether a wave can go in a slot, by what the slot is for. */
function fits(wave: Wave, role: SlotRole): boolean {
  if (role === "z") return !wave.text && wave.shape.length >= 2;
  if (wave.shape.length !== 1) return false;
  // A text wave is X for a category plot, or the labels of text markers.
  return role === "x" || role === "text" || !wave.text;
}

type Row = Record<string, string>;

/** A row to start with: what the selected waves give the first required slot, by position. */
function firstRows(template: GraphTemplate, state: DocState, selected: readonly string[]): Row[] {
  const required = [...requiredSlots(template)];
  const first = template.slots.find((slot) => slot.name === required[0]);
  const picked = first
    ? selected.filter((name) => state.waves[name] && fits(state.waves[name], first.role))
    : [];
  if (!first || picked.length === 0) return [{}];
  return picked.map((name) => ({ [first.name]: name }));
}

type TemplatePlace = "experiment" | "library";

/**
 * The graph templates of the experiment and of the browser's library, and
 * graphs made from one: a row of waves for each graph, a wave for each slot.
 * Units that differ from the template's are warned of, and a row that cannot
 * be made says why before anything is made.
 */
export function GraphTemplatesDialog({ template: initial }: { template?: string }) {
  const state = useDoc((current) => current);
  const library = useLibraryTemplates();
  const own = state.graphTemplates;
  const [picked, setPicked] = useState<{ place: TemplatePlace; name: string | null }>(() => ({
    place: initial && !(initial in own) && initial in library ? "library" : "experiment",
    name: initial ?? Object.keys(own)[0] ?? Object.keys(library)[0] ?? null,
  }));
  const [renaming, setRenaming] = useState<string | null>(null);
  const source = (place: TemplatePlace) => (place === "experiment" ? own : library);
  const name = picked.name !== null && picked.name in source(picked.place) ? picked.name : null;
  const template = name === null ? undefined : source(picked.place)[name];

  const selectedWaves = ui.get().selectedWaves;
  const [rows, setRows] = useState<Row[]>(() =>
    template ? firstRows(template, state, selectedWaves) : [{}],
  );
  const pick = (place: TemplatePlace) => (names: string[]) => {
    const next = names[0] ?? null;
    setPicked({ place, name: next });
    setRenaming(null);
    const chosen = next === null ? undefined : source(place)[next];
    if (chosen) setRows(firstRows(chosen, doc.getState(), ui.get().selectedWaves));
  };

  const samples = useMemo(
    () =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, wave]) => wave !== ""))),
    [rows],
  );
  const graphCount = rows.length;
  // Tried on the side first: the reducer says what is wrong in the same words it would refuse in.
  const problem = useMemo(() => {
    if (!template || name === null) return "Choose a template.";
    const trial = { ...state, graphTemplates: withEntry(state.graphTemplates, name, template) };
    try {
      applyCommand(trial, { op: "makeGraphs", template: name, samples });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [state, template, name, samples]);
  const warnings = useMemo(
    () => (template ? templateWarnings(state, template, samples) : []),
    [state, template, samples],
  );

  const make = () => {
    if (!template || name === null || problem) return;
    const copy = picked.place === "library" ? libraryTemplateCommands(name) : [];
    if (!copy) return;
    if (runGui([...copy, { op: "makeGraphs", template: name, samples }]) !== undefined) close();
  };
  const rename = () => {
    if (name === null || renaming === null) return;
    const newName = renaming.trim();
    if (picked.place === "experiment") {
      if (runGui({ op: "renameGraphTemplate", name, newName }) === undefined) return;
    } else if (!inLibrary(() => templateLibrary().rename(name, newName))) {
      return;
    }
    setPicked({ place: picked.place, name: newName });
    setRenaming(null);
  };
  const remove = () => {
    if (name === null) return;
    if (picked.place === "experiment") {
      runGui({ op: "removeGraphTemplate", name });
    } else if (window.confirm(`Delete ${name} from the library? This cannot be undone.`)) {
      inLibrary(() => templateLibrary().remove(name));
    }
  };
  const toLibrary = () => {
    if (name === null || !own[name]) return;
    const there = library[name];
    if (
      there &&
      !sameEntry(there, own[name]) &&
      !window.confirm(`The library has a graph template ${name} already. Replace it?`)
    ) {
      return;
    }
    inLibrary(() => templateLibrary().put(name, own[name]!));
  };
  const toExperiment = () => {
    if (name === null) return;
    const copy = libraryTemplateCommands(name);
    if (copy && copy.length > 0 && runGui(copy) !== undefined) {
      setPicked({ place: "experiment", name });
    }
  };

  const list = (place: TemplatePlace, title: string, buttons: ReactNode) => {
    const names = Object.keys(source(place));
    const selected = picked.place === place && name !== null ? [name] : [];
    const renamingHere = renaming !== null && picked.place === place && name !== null;
    return (
      <div role="group" aria-label={title} className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-muted">{title}</div>
        <NameList
          label={title}
          names={names}
          selected={selected}
          onChange={pick(place)}
          multiple={false}
          height={96}
        />
        {renamingHere ? (
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
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button disabled={selected.length === 0} onClick={() => setRenaming(name)}>
              Rename…
            </Button>
            <Button disabled={selected.length === 0} onClick={remove}>
              Delete
            </Button>
            {buttons}
            <Button
              disabled={selected.length === 0}
              onClick={() => exportTemplates(selected.map((item) => [item, source(place)[item]!]))}
            >
              Export…
            </Button>
          </div>
        )}
      </div>
    );
  };

  const libraryMissing = !templateLibrary().available;
  const required = template ? requiredSlots(template) : new Set<string>();
  const choices = (slot: TemplateSlot) =>
    state.waveOrder.filter((wave) => fits(state.waves[wave]!, slot.role));
  const setCell = (index: number, slot: string, wave: string) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, [slot]: wave } : row)));

  return (
    <Dialog
      title="Make Graphs from Template"
      onClose={close}
      onSubmit={make}
      submitLabel={graphCount === 1 ? "Make Graph" : `Make ${graphCount} Graphs`}
      submitDisabled={problem !== null}
      width={680}
    >
      <div className="flex gap-3">
        {list(
          "experiment",
          "In this experiment",
          <Button
            disabled={picked.place !== "experiment" || name === null || libraryMissing}
            onClick={toLibrary}
          >
            To Library
          </Button>,
        )}
        {list(
          "library",
          "Library (this browser)",
          <>
            <Button disabled={picked.place !== "library" || name === null} onClick={toExperiment}>
              To Experiment
            </Button>
            <Button disabled={libraryMissing} onClick={importTemplates}>
              Import…
            </Button>
          </>,
        )}
      </div>
      {libraryMissing ? (
        <div className="text-[11px] text-muted">
          This browser keeps no library: its storage is turned off. Export templates to keep them.
        </div>
      ) : null}
      {template ? (
        <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
          <div className="text-muted">
            One graph for each row. Slots marked * are plotted and need a wave; the others may be
            left empty.
          </div>
          <div className="overflow-auto">
            <table aria-label="Waves for each graph" className="border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left font-normal text-muted">Graph</th>
                  {template.slots.map((slot) => (
                    <th key={slot.name} className="text-left font-normal">
                      <b>
                        {slot.name}
                        {required.has(slot.name) ? "*" : ""}
                      </b>
                      <span className="text-muted">
                        {" "}
                        {ROLE_TEXT[slot.role]}
                        {unitText(slot.unit)}
                      </span>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td className="pr-1 text-muted">{index + 1}</td>
                    {template.slots.map((slot) => (
                      <td key={slot.name}>
                        <Select
                          aria-label={`${slot.name} of graph ${index + 1}`}
                          className="w-36"
                          value={row[slot.name] ?? ""}
                          onChange={(event) => setCell(index, slot.name, event.target.value)}
                        >
                          <option value="">{required.has(slot.name) ? "Choose…" : "None"}</option>
                          {choices(slot).map((wave) => (
                            <option key={wave} value={wave}>
                              {wave}
                            </option>
                          ))}
                        </Select>
                      </td>
                    ))}
                    <td>
                      <Button
                        aria-label={`Remove graph ${index + 1}`}
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
          <div className="flex gap-1.5">
            {/* A new row starts as a copy of the last, so a wave shared by every graph is chosen once. */}
            <Button onClick={() => setRows((current) => [...current, { ...current.at(-1) }])}>
              Add Row
            </Button>
          </div>
          {problem ? (
            <p className="m-0 text-muted" role="status" aria-label="Problem">
              {problem}
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <ul
              aria-label="Warnings"
              className="m-0 list-none rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800"
            >
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="text-[11px] text-muted">
          {Object.keys(own).length + Object.keys(library).length === 0
            ? "No templates yet: save one from a graph with Graph › Save as Template…"
            : "Select a template to make graphs from it."}
        </div>
      )}
    </Dialog>
  );
}

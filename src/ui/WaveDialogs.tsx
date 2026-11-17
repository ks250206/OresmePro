/** The dialogs that make and change waves and tables. */
import { useState } from "react";
import { windowNameProblem } from "../app/newGraph";
import { doc, runGui, showError, useDoc, useUi } from "../app/session";
import { uniqueName, windowTaken, type Command } from "../core/doc/commands";
import {
  nameProblems,
  parseShape,
  planMakeWaves,
  splitNames,
  wavePath,
} from "../core/doc/makeWaves";
import { WAVE_TYPES, leafName, type WaveType } from "../core/doc/types";
import { formatNumber } from "../core/plot/ticks";
import { Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";
import { close, parseNumber, submit } from "./dialogParts";

export function NewTableDialog() {
  const order = useDoc((state) => state.waveOrder);
  const preselected = useUi((state) => state.selectedWaves);
  const [waves, setWaves] = useState<string[]>(() =>
    preselected.filter((name) => order.includes(name)),
  );
  const [name, setName] = useState("");
  const tableName = name.trim();
  const fallback = useDoc((state) => uniqueName("Table", windowTaken(state)));
  const problem = useDoc((state) => windowNameProblem(state, tableName, "table"));
  return (
    <Dialog
      title="New Table"
      onClose={close}
      submitDisabled={waves.length === 0 || problem !== null}
      onSubmit={() => submit({ op: "edit", waves, ...(tableName ? { name: tableName } : {}) })}
    >
      <Field label="Name">
        <TextInput
          aria-label="Table name"
          aria-invalid={problem !== null}
          className="w-40"
          placeholder={fallback}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {problem ? <span className="text-[11px] text-danger">{problem}</span> : null}
      </Field>
      <div className="text-muted">Columns</div>
      <NameList label="Columns" names={order} selected={waves} onChange={setWaves} />
    </Dialog>
  );
}

/**
 * Adds waves to a table as columns, or takes some of its columns out (the
 * waves stay), as Igor's AppendToTable and RemoveFromTable do.
 */
export function TableColumnsDialog({ table, mode }: { table: string; mode: "append" | "remove" }) {
  const columns = useDoc((state) => state.tables[table]?.columns);
  const order = useDoc((state) => state.waveOrder);
  const preselected = useUi((state) => state.selectedWaves);
  const choices =
    mode === "remove" ? [...(columns ?? [])] : order.filter((name) => !columns?.includes(name));
  const [waves, setWaves] = useState<string[]>(() =>
    mode === "append" ? preselected.filter((name) => choices.includes(name)) : [],
  );
  if (!columns) return null;
  const picked = waves.filter((name) => choices.includes(name));
  return (
    <Dialog
      title={mode === "append" ? `Append Columns to ${table}` : `Remove Columns from ${table}`}
      help="guides/tables/"
      onClose={close}
      submitLabel={mode === "append" ? "Append" : "Remove"}
      submitDisabled={picked.length === 0}
      onSubmit={() =>
        submit(
          mode === "append"
            ? { op: "appendToTable", table, waves: picked }
            : { op: "removeFromTable", table, waves: picked },
        )
      }
    >
      <div className="text-muted">
        {mode === "append"
          ? "Waves to add as columns"
          : "Columns to take out of the table (the waves stay)"}
      </div>
      <NameList label="Columns" names={choices} selected={picked} onChange={setWaves} />
    </Dialog>
  );
}

export const DIMENSIONS = ["Rows", "Columns", "Layers", "Chunks"] as const;

/** Makes empty waves, several alike at once, as Igor's Make Waves dialog does. */
export function MakeWavesDialog({ folder: requested = "" }: { folder?: string }) {
  const state = useDoc((current) => current);
  const [fields, setFields] = useState(() => {
    const folder = state.folders.includes(requested) ? requested : "";
    return {
      folder,
      names: uniqueName("wave", (name) => wavePath(folder, name) in state.waves),
      sizes: ["128", "", "", ""],
      type: "float64" as WaveType,
      x0: "0",
      dx: "1",
      xUnit: "",
      unit: "",
      overwrite: false,
      edit: false,
    };
  });
  const set = (change: Partial<typeof fields>) => setFields({ ...fields, ...change });
  const names = splitNames(fields.names);
  const nameIssues = nameProblems(state, names, fields.folder, fields.overwrite);
  const shape = parseShape(fields.sizes);
  const x0 = parseNumber(fields.x0);
  const dx = parseNumber(fields.dx);
  const problems = [
    ...nameIssues.filter((problem): problem is string => problem !== null),
    ...(typeof shape === "string" ? [shape] : []),
    ...(x0 === null ? ["X start must be a number."] : []),
    ...(dx === null || dx === 0 ? ["X step must be a number other than 0."] : []),
  ];
  const make = () => {
    let plan: ReturnType<typeof planMakeWaves>;
    try {
      plan = planMakeWaves(doc.getState(), {
        names,
        folder: fields.folder,
        shape: shape as readonly number[],
        type: fields.type,
        x0: x0!,
        dx: dx!,
        xUnit: fields.xUnit,
        unit: fields.unit,
        overwrite: fields.overwrite,
        edit: fields.edit,
      });
    } catch (error) {
      showError("The waves were not made", error);
      return;
    }
    if (runGui(plan.commands, { echo: plan.echo }) !== undefined) close();
  };
  return (
    <Dialog
      title="Make Waves"
      help="guides/waves/"
      width={440}
      onClose={close}
      submitDisabled={names.length === 0 || problems.length > 0}
      onSubmit={make}
    >
      <Field label="Names">
        <TextInput
          aria-label="Names"
          aria-invalid={nameIssues.some((problem) => problem !== null)}
          className="flex-1"
          value={fields.names}
          onChange={(event) => set({ names: event.target.value })}
        />
      </Field>
      <div className="-mt-1 pl-[104px] text-[11px] text-muted">
        Several at once: separate them with commas or spaces.
      </div>
      <Field label="Points" group>
        {DIMENSIONS.map((label, index) => (
          <label key={label} className="flex flex-col items-center gap-0.5">
            <TextInput
              aria-label={label}
              aria-invalid={typeof shape === "string" && shape.startsWith(label)}
              className="w-[60px] text-right"
              placeholder={index === 0 ? "" : "0"}
              value={fields.sizes[index]}
              onChange={(event) =>
                set({
                  sizes: fields.sizes.map((size, at) => (at === index ? event.target.value : size)),
                })
              }
            />
            <span className="text-[10.5px] text-muted">{label}</span>
          </label>
        ))}
      </Field>
      <Field label="Type">
        <Select
          aria-label="Type"
          value={fields.type}
          onChange={(event) => set({ type: event.target.value as WaveType })}
        >
          {WAVE_TYPES.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </Select>
        <span className="truncate text-muted">{TYPE_NOTES[fields.type]}</span>
      </Field>
      <Field label="X start, step">
        <TextInput
          aria-label="X start"
          aria-invalid={x0 === null}
          className="w-24"
          value={fields.x0}
          onChange={(event) => set({ x0: event.target.value })}
        />
        <TextInput
          aria-label="X step"
          aria-invalid={dx === null || dx === 0}
          className="w-24"
          value={fields.dx}
          onChange={(event) => set({ dx: event.target.value })}
        />
      </Field>
      <Field label="X unit">
        <TextInput
          aria-label="X unit"
          className="w-20"
          value={fields.xUnit}
          onChange={(event) => set({ xUnit: event.target.value })}
        />
      </Field>
      <Field label="Data unit">
        <TextInput
          aria-label="Data unit"
          className="w-20"
          value={fields.unit}
          onChange={(event) => set({ unit: event.target.value })}
        />
      </Field>
      <Field label="Data folder">
        <Select
          aria-label="Data folder"
          value={fields.folder}
          onChange={(event) => set({ folder: event.target.value })}
        >
          <option value="">root</option>
          {state.folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-col gap-1 pl-[104px]">
        <Checkbox
          label="Overwrite existing waves"
          checked={fields.overwrite}
          onChange={(event) => set({ overwrite: event.target.checked })}
        />
        <Checkbox
          label="Edit in a table"
          checked={fields.edit}
          onChange={(event) => set({ edit: event.target.checked })}
        />
      </div>
      {problems.length > 0 ? (
        <ul
          role="status"
          aria-label="Problems"
          className="m-0 list-none p-0 pl-[104px] text-danger"
        >
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

export type NameMode = "rename" | "duplicate" | "newFolder" | "renameFolder";

/** One text field: rename or duplicate a wave, make or rename a data folder. */
export function NameDialog({ target, mode }: { target: string; mode: NameMode }) {
  const initial =
    mode === "duplicate"
      ? `${target}_copy`
      : mode === "newFolder"
        ? target
          ? `${target}:`
          : ""
        : target;
  const [name, setName] = useState(initial);
  const value = name.trim();
  const titles: Record<NameMode, string> = {
    rename: `Rename ${target}`,
    duplicate: `Duplicate ${target}`,
    newFolder: "New Data Folder",
    renameFolder: `Rename Data Folder ${target}`,
  };
  const command = (): Command => {
    if (mode === "rename") return { op: "renameWave", name: target, newName: value };
    if (mode === "duplicate")
      return { op: "duplicateWave", name: target, newName: value, overwrite: false };
    if (mode === "newFolder") return { op: "newFolder", path: value };
    return { op: "renameFolder", path: target, newPath: value };
  };
  return (
    <Dialog
      title={titles[mode]}
      width={340}
      onClose={close}
      submitDisabled={
        value === "" || value.endsWith(":") || (mode !== "duplicate" && value === target)
      }
      onSubmit={() => submit(command())}
    >
      <Field label={mode === "newFolder" ? "Name" : "New name"}>
        <TextInput
          aria-label="Name"
          className="flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <div className="pl-[104px] text-[11px] text-muted">
        Use <code>folder:name</code> to put it in a data folder.
      </div>
    </Dialog>
  );
}

export const TYPE_NOTES: Record<WaveType, string> = {
  float64: "double precision, 8 bytes a point",
  float32: "single precision, 4 bytes a point",
  int8: "whole numbers −128 to 127",
  uint8: "whole numbers 0 to 255",
  int16: "whole numbers −32768 to 32767",
  uint16: "whole numbers 0 to 65535",
  int32: "whole numbers to ±2.1 billion",
  uint32: "whole numbers 0 to 4.3 billion",
  complex128: "complex, double precision",
  complex64: "complex, single precision",
};

/** Changes the number type of a wave, as Igor's Redimension does. */
export function WaveTypeDialog({ wave: name }: { wave: string }) {
  const wave = useDoc((state) => state.waves[name]);
  const [type, setType] = useState<string>(wave?.type ?? "float64");
  if (!wave || wave.text) return null;
  const loses =
    (wave.imag !== null && !type.startsWith("complex")) ||
    (type.includes("int") && !wave.type.includes("int")) ||
    (type.endsWith("32") && wave.type.endsWith("64")) ||
    (type === "complex64" && wave.type === "complex128");
  return (
    <Dialog
      title={`Change Wave Type — ${leafName(name)}`}
      width={400}
      onClose={close}
      submitDisabled={type === wave.type}
      onSubmit={() => submit({ op: "redimension", name, type })}
    >
      <Field label="Type">
        <Select aria-label="Type" value={type} onChange={(event) => setType(event.target.value)}>
          {WAVE_TYPES.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </Select>
        <span className="truncate text-muted">{TYPE_NOTES[type as WaveType]}</span>
      </Field>
      <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
        Now {wave.type}.{" "}
        {loses
          ? "Values the new type cannot hold are rounded, held at its limits, or lose their imaginary part."
          : "Every value is kept as it is."}
      </div>
    </Dialog>
  );
}

export function WaveScalingDialog({ wave: name }: { wave: string }) {
  const wave = useDoc((state) => state.waves[name]);
  const [fields, setFields] = useState(() => ({
    x0: formatNumber(wave?.x0 ?? 0, 12),
    dx: formatNumber(wave?.dx ?? 1, 12),
    xUnit: wave?.xUnit ?? "",
    y0: formatNumber(wave?.y0 ?? 0, 12),
    dy: formatNumber(wave?.dy ?? 1, 12),
    yUnit: wave?.yUnit ?? "",
    unit: wave?.unit ?? "",
  }));
  if (!wave) return null;
  const twoD = wave.shape.length > 1;
  const x0 = parseNumber(fields.x0);
  const dx = parseNumber(fields.dx);
  const y0 = parseNumber(fields.y0);
  const dy = parseNumber(fields.dy);
  const bad = (start: number | null, step: number | null) =>
    start === null || step === null || step === 0;
  const invalid = bad(x0, dx) || (twoD && bad(y0, dy));
  const commands: Command[] = [];
  if (!invalid) {
    const scale: Extract<Command, { op: "setWaveScale" }> = { op: "setWaveScale", name };
    if (x0 !== wave.x0) scale.x0 = x0!;
    if (dx !== wave.dx) scale.dx = dx!;
    if (fields.xUnit !== wave.xUnit) scale.xUnit = fields.xUnit;
    if (twoD && y0 !== wave.y0) scale.y0 = y0!;
    if (twoD && dy !== wave.dy) scale.dy = dy!;
    if (twoD && fields.yUnit !== wave.yUnit) scale.yUnit = fields.yUnit;
    if (Object.keys(scale).length > 2) commands.push(scale);
  }
  if (fields.unit !== wave.unit) commands.push({ op: "setWaveMeta", name, unit: fields.unit });
  const input = (key: keyof typeof fields, label: string, className: string, flagged = false) => (
    <TextInput
      aria-label={label}
      aria-invalid={flagged}
      className={className}
      value={fields[key]}
      onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
    />
  );
  return (
    <Dialog
      title={`Change Wave Scaling — ${name}`}
      width={380}
      onClose={close}
      submitDisabled={invalid || commands.length === 0}
      onSubmit={() => submit(commands)}
    >
      <Field label="X start, step">
        {input("x0", "X start", "w-24", x0 === null)}
        {input("dx", "X step", "w-24", dx === null || dx === 0)}
      </Field>
      <Field label="X unit" name="xUnit">
        {input("xUnit", "X unit", "w-20")}
      </Field>
      {twoD ? (
        <>
          <Field label="Y start, step">
            {input("y0", "Y start", "w-24", y0 === null)}
            {input("dy", "Y step", "w-24", dy === null || dy === 0)}
          </Field>
          <Field label="Y unit" name="yUnit">
            {input("yUnit", "Y unit", "w-20")}
          </Field>
        </>
      ) : null}
      <Field label="Data unit" name="unit">
        {input("unit", "Data unit", "w-20")}
      </Field>
    </Dialog>
  );
}

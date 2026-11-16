import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  buttonKey,
  exportPanel,
  pressButton,
  selectControl,
  setEditing,
  useCatalog,
  usePanelRuntime,
} from "../app/panels";
import { doc, runGui, runGuiCoalesced, showError, useDoc, type MenuItem } from "../app/session";
import { findAction, type JsonValue, type ParamSpec } from "../core/actions";
import { uniqueName, type Command } from "../core/doc/commands";
import { dict } from "../core/doc/dict";
import { echoPython } from "../core/doc/echo";
import {
  codeActions,
  controlForParam,
  isControlRef,
  panelTrust,
  pickerWaves,
} from "../core/doc/panels";
import {
  hasValue,
  type ControlArg,
  type ControlKind,
  type PanelControl,
  type PanelSpec,
} from "../core/doc/types";
import { Button, Checkbox, Select, TextInput } from "./controls";
import { keepFocus, openContextMenu } from "./Menu";

type ControlOf<K extends ControlKind> = Extract<PanelControl, { kind: K }>;

/** The kinds of control the Add menu offers, with the name and label a new one starts with. */
const ADDABLE: readonly { kind: ControlKind; title: string; base: string; label: string }[] = [
  { kind: "heading", title: "Heading", base: "heading", label: "Heading" },
  { kind: "text", title: "Text", base: "text", label: "Text" },
  { kind: "wave", title: "Wave Picker", base: "wave", label: "Wave" },
  { kind: "choice", title: "Choice", base: "choice", label: "Choice" },
  { kind: "number", title: "Number", base: "number", label: "Number" },
  { kind: "string", title: "Text Field", base: "field", label: "Text" },
  { kind: "checkbox", title: "Checkbox", base: "check", label: "Check" },
  { kind: "button", title: "Button", base: "button", label: "Button" },
];

const KIND_TITLES: Record<ControlKind, string> = Object.fromEntries(
  ADDABLE.map((item) => [item.kind, item.title]),
) as Record<ControlKind, string>;

let typingSessions = 0;

/** Sets a control's value from typing: applied at once, one undo step and one history line per edit of the field. */
function typeValue(panel: string, control: string, session: number, value: number | string): void {
  const command: Command = { op: "setControlValue", panel, control, value };
  runGuiCoalesced(`panel:${panel}:${control}:${session}`, [command], () => {
    const now = doc.getState().panels[panel]?.controls.find((item) => item.name === control);
    return now && hasValue(now) ? (echoPython({ ...command, value: now.value }) ?? "") : "";
  });
}

const setValue = (panel: string, control: string, value: unknown) =>
  runGui({ op: "setControlValue", panel, control, value });

/** What is wrong with a number typed into a field, or null. */
function numberProblem(control: ControlOf<"number">, text: string): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) return "Type a number.";
  if (control.min !== null && value < control.min) return `At least ${control.min}.`;
  if (control.max !== null && value > control.max) return `At most ${control.max}.`;
  return null;
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      {label ? <span className="shrink-0">{label}</span> : null}
      {children}
    </label>
  );
}

function NumberField({ panel, control }: { panel: string; control: ControlOf<"number"> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const session = useRef(0);
  const text = draft ?? String(control.value);
  const problem = draft === null ? null : numberProblem(control, draft);
  return (
    <Labelled label={control.label}>
      <TextInput
        type="number"
        className={`w-24 ${problem ? "!border-danger" : ""}`}
        value={text}
        min={control.min ?? undefined}
        max={control.max ?? undefined}
        step={control.step ?? "any"}
        aria-invalid={problem !== null || undefined}
        title={problem ?? undefined}
        onFocus={() => {
          typingSessions += 1;
          session.current = typingSessions;
        }}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          const typed = event.target.value;
          setDraft(typed);
          if (numberProblem(control, typed) === null) {
            typeValue(panel, control.name, session.current, Number(typed));
          }
        }}
      />
    </Labelled>
  );
}

function StringField({ panel, control }: { panel: string; control: ControlOf<"string"> }) {
  const session = useRef(0);
  return (
    <Labelled label={control.label}>
      <TextInput
        className="w-40"
        value={control.value}
        onFocus={() => {
          typingSessions += 1;
          session.current = typingSessions;
        }}
        onChange={(event) => typeValue(panel, control.name, session.current, event.target.value)}
      />
    </Labelled>
  );
}

/** A choice's value as the text of a select's option, and back: options may be numbers. */
const optionKey = (options: readonly (string | number)[], value: string | number | null) =>
  value === null ? "" : String(options.indexOf(value));

function ChoiceField({ panel, control }: { panel: string; control: ControlOf<"choice"> }) {
  return (
    <Labelled label={control.label}>
      <Select
        value={optionKey(control.options, control.value)}
        disabled={control.options.length === 0}
        onChange={(event) =>
          setValue(panel, control.name, control.options[Number(event.target.value)])
        }
      >
        {control.options.length === 0 ? <option value="">(no options)</option> : null}
        {control.options.map((item, index) => (
          <option key={index} value={index}>
            {String(item)}
          </option>
        ))}
      </Select>
    </Labelled>
  );
}

function WaveField({ panel, control }: { panel: string; control: ControlOf<"wave"> }) {
  const waves = useDoc((state) => state.waves);
  const waveOrder = useDoc((state) => state.waveOrder);
  const names = pickerWaves({ waves, waveOrder }, control);
  const value = control.value;
  const missing = value !== null && !(value in waves);
  return (
    <Labelled label={control.label}>
      <Select
        className={`max-w-[14rem] ${missing ? "!border-danger" : ""}`}
        value={value ?? ""}
        aria-invalid={missing || undefined}
        title={missing ? `There is no wave ${value}.` : undefined}
        onChange={(event) => setValue(panel, control.name, event.target.value || null)}
      >
        <option value="">(none)</option>
        {value !== null && !names.includes(value) ? (
          <option value={value}>{missing ? `${value} (missing)` : value}</option>
        ) : null}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
      {missing ? <span className="text-[11px] text-danger">missing</span> : null}
    </Labelled>
  );
}

function ButtonField({ panel, control }: { panel: string; control: ControlOf<"button"> }) {
  const busy = usePanelRuntime((state) =>
    Object.hasOwn(state.busy, panel) ? state.busy[panel] : undefined,
  );
  const error = usePanelRuntime((state) => {
    const key = buttonKey(panel, control.name);
    return Object.hasOwn(state.errors, key) ? state.errors[key] : undefined;
  });
  const running = busy === control.name;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="flex items-center gap-2">
        <Button
          primary
          disabled={busy !== undefined}
          aria-busy={running || undefined}
          title={control.action ? `Calls ${control.action}` : "Calls no action yet"}
          onClick={() => void pressButton(panel, control.name)}
        >
          {control.label || control.name}
        </Button>
        {running ? <span className="text-[11px] text-muted">Running…</span> : null}
      </span>
      {error ? (
        <span role="alert" className="max-w-[22rem] whitespace-pre-wrap text-[11px] text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function ControlBody({ panel, control }: { panel: string; control: PanelControl }) {
  switch (control.kind) {
    case "heading":
      return <div className="text-[13px] font-semibold">{control.label}</div>;
    case "text":
      return <p className="max-w-[28rem] whitespace-pre-wrap text-muted">{control.label}</p>;
    case "number":
      return <NumberField panel={panel} control={control} />;
    case "string":
      return <StringField panel={panel} control={control} />;
    case "checkbox":
      return (
        <Checkbox
          label={control.label}
          checked={control.value}
          onChange={(event) => setValue(panel, control.name, event.target.checked)}
        />
      );
    case "choice":
      return <ChoiceField panel={panel} control={control} />;
    case "wave":
      return <WaveField panel={panel} control={control} />;
    case "button":
      return <ButtonField panel={panel} control={control} />;
  }
}

/** The controls in their lines: each on a line of its own unless it sits beside the one before. */
function rowsOf(controls: readonly PanelControl[]): PanelControl[][] {
  const rows: PanelControl[][] = [];
  for (const control of controls) {
    const last = rows.at(-1);
    if (control.inline && last) last.push(control);
    else rows.push([control]);
  }
  return rows;
}

const modifyControl = (panel: string, control: string, props: Record<string, unknown>) =>
  runGui({ op: "modifyControl", panel, control, props });

function moveSelected(panel: PanelSpec, control: string, by: number): void {
  const at = panel.controls.findIndex((item) => item.name === control);
  const to = at + by;
  if (at < 0 || to < 0 || to >= panel.controls.length) return;
  runGui({ op: "moveControl", panel: panel.name, control, to });
}

function removeSelected(panel: PanelSpec, control: string): void {
  if (runGui({ op: "removeControl", panel: panel.name, control }) !== undefined) {
    selectControl(panel.name, null);
  }
}

/** Adds a control of a kind, after the one selected if there is one, and selects it. */
function addControl(panel: PanelSpec, kind: ControlKind, selected: string | null): void {
  const { base, label } = ADDABLE.find((item) => item.kind === kind)!;
  const name = uniqueName(base, (taken) => panel.controls.some((item) => item.name === taken));
  const commands: Command[] = [
    { op: "addControl", panel: panel.name, kind, name, props: { label } },
  ];
  const at = panel.controls.findIndex((item) => item.name === selected);
  if (at >= 0 && at < panel.controls.length - 1) {
    commands.push({ op: "moveControl", panel: panel.name, control: name, to: at + 1 });
  }
  if (runGui(commands) !== undefined) selectControl(panel.name, name);
}

function controlItems(panel: PanelSpec, control: string): MenuItem[] {
  const at = panel.controls.findIndex((item) => item.name === control);
  return [
    { label: "Move Up", disabled: at <= 0, onSelect: () => moveSelected(panel, control, -1) },
    {
      label: "Move Down",
      disabled: at < 0 || at >= panel.controls.length - 1,
      onSelect: () => moveSelected(panel, control, 1),
    },
    { label: "Delete", onSelect: () => removeSelected(panel, control) },
  ];
}

function TrustBadge({ panel }: { panel: PanelSpec }) {
  const code = codeActions(panel);
  return panelTrust(panel) === "data" ? (
    <span
      className="rounded border border-line px-1.5 text-muted"
      title="Its buttons call only the application's actions (core.*) and plugins' (plugin.*)."
    >
      Data only
    </span>
  ) : (
    <span
      className="rounded border border-danger px-1.5 text-danger"
      title={`Its buttons call ${code.join(", ")}: actions of procedures, which run this experiment's Python.`}
    >
      Contains code
    </span>
  );
}

function EditBar({ panel, selected }: { panel: PanelSpec; selected: string | null }) {
  const at = panel.controls.findIndex((item) => item.name === selected);
  const small = "!h-5 !px-2";
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-chrome px-2 text-[11.5px]">
      <Button
        className={small}
        aria-haspopup="menu"
        onMouseDown={keepFocus}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          openContextMenu(
            { clientX: box.left, clientY: box.bottom + 2 },
            ADDABLE.map((item) => ({
              label: item.title,
              onSelect: () => addControl(panel, item.kind, selected),
            })),
          );
        }}
      >
        Add ▾
      </Button>
      <Button
        className={small}
        aria-label="Move Up"
        title="Move Up"
        disabled={at <= 0}
        onClick={() => moveSelected(panel, selected!, -1)}
      >
        ↑
      </Button>
      <Button
        className={small}
        aria-label="Move Down"
        title="Move Down"
        disabled={at < 0 || at >= panel.controls.length - 1}
        onClick={() => moveSelected(panel, selected!, 1)}
      >
        ↓
      </Button>
      <Button className={small} disabled={at < 0} onClick={() => removeSelected(panel, selected!)}>
        Delete
      </Button>
      <TrustBadge panel={panel} />
      <span className="flex-1" />
      <Button className={small} onClick={() => exportPanel(panel.name)}>
        Export…
      </Button>
      <Button className={small} onClick={() => setEditing(panel.name, false)}>
        Done
      </Button>
    </div>
  );
}

/** A labelled line of the property form. */
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="w-[4.5rem] shrink-0 text-right text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1">{children}</span>
    </label>
  );
}

/** A text field that changes something when it is left or Return is pressed; Escape puts it back. */
function CommitText({
  label,
  value,
  onCommit,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setDraft(null);
    }
  };
  const props = {
    "aria-label": label,
    value: draft ?? value,
    placeholder,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown,
  };
  return (
    <Prop label={label}>
      {multiline ? (
        <textarea
          {...props}
          rows={3}
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-line bg-paper px-1.5 py-0.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      ) : (
        <TextInput {...props} className="min-w-0 flex-1" />
      )}
    </Prop>
  );
}

const numberText = (value: number | null): string => (value === null ? "" : String(value));
const numberOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text));

/** The value a fixed argument starts with when it is first given. */
function startingValue(param: ParamSpec, waves: readonly string[]): JsonValue {
  if (param.default !== undefined) return param.default;
  switch (param.type) {
    case "choice":
      return param.choices?.[0] ?? "";
    case "number":
    case "integer":
      return param.min ?? 0;
    case "boolean":
      return false;
    case "wave":
      return waves[0] ?? "";
    case "waves":
    case "numbers":
    case "samples":
      return [];
    case "json":
      return {};
    case "string":
      return "";
  }
}

/** The types of argument {@link ArgValue} has an editor of its own for. */
const EDITED_TYPES = [
  "boolean",
  "choice",
  "wave",
  "string",
  "number",
  "integer",
  "waves",
  "numbers",
] as const;

/** An editor for the fixed value of an argument, as its type wants it. */
function ArgValue({
  name,
  param,
  value,
  onChange,
}: {
  name: string;
  param: ParamSpec;
  value: ControlArg;
  onChange: (value: ControlArg) => void;
}) {
  const waveOrder = useDoc((state) => state.waveOrder);
  const label = `${name} value`;
  const flat = (item: ControlArg) => item === null || typeof item !== "object";
  // A type this form does not know (one added since), or a value with lists or dicts
  // inside, is written as JSON.
  if (
    !(EDITED_TYPES as readonly string[]).includes(param.type) ||
    !(flat(value) || (Array.isArray(value) && value.every(flat)))
  ) {
    return (
      <InlineCommit
        label={label}
        value={JSON.stringify(value)}
        onCommit={(typed) => {
          try {
            onChange(JSON.parse(typed) as ControlArg);
          } catch {
            showError(
              "That is not JSON",
              `${name} is written as JSON here, such as [1, 2] or {"a": 1}.`,
            );
          }
        }}
      />
    );
  }
  switch (param.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          aria-label={label}
          className="accent-accent"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "choice": {
      const choices = param.choices ?? [];
      return (
        <Select
          aria-label={label}
          className="min-w-0 flex-1"
          value={String(choices.indexOf(value as string | number))}
          onChange={(event) => onChange(choices[Number(event.target.value)] ?? "")}
        >
          {choices.map((item, index) => (
            <option key={index} value={index}>
              {String(item)}
            </option>
          ))}
        </Select>
      );
    }
    case "wave":
      return (
        <Select
          aria-label={label}
          className="min-w-0 flex-1"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {typeof value === "string" && !waveOrder.includes(value) ? (
            <option value={value}>{value || "(none)"}</option>
          ) : null}
          {waveOrder.map((wave) => (
            <option key={wave}>{wave}</option>
          ))}
        </Select>
      );
    default: {
      const list = param.type === "waves" || param.type === "numbers";
      const numeric = param.type !== "string" && param.type !== "waves";
      // Only flat values reach here (see above).
      const show = (item: ControlArg) => (typeof item === "object" ? "" : String(item));
      const text = Array.isArray(value) ? value.map(show).join(", ") : show(value);
      return (
        <InlineCommit
          label={label}
          value={text}
          onCommit={(typed) => {
            const parse = (item: string) => (numeric ? Number(item) : item);
            onChange(
              list
                ? typed
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .map(parse)
                : parse(typed),
            );
          }}
        />
      );
    }
  }
}

/** A text field without a caption that commits like {@link CommitText}. */
function InlineCommit({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <TextInput
      aria-label={label}
      className="min-w-0 flex-1"
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

/** One argument of a button's action: left out, a fixed value, or the value of a control. */
function ArgRow({
  panel,
  control,
  name,
  param,
}: {
  panel: PanelSpec;
  control: ControlOf<"button">;
  name: string;
  param: ParamSpec;
}) {
  const waveOrder = useDoc((state) => state.waveOrder);
  const current = Object.hasOwn(control.args, name) ? control.args[name] : undefined;
  const mode = current === undefined ? "omit" : isControlRef(current) ? "control" : "value";
  const sources = panel.controls.filter(hasValue);
  const made = controlForParam(name, param);
  const setArg = (value: ControlArg | undefined, before: Command[] = []) => {
    const args = dict(Object.entries(control.args).filter(([key]) => key !== name));
    if (value !== undefined) args[name] = value;
    runGui([
      ...before,
      { op: "modifyControl", panel: panel.name, control: control.name, props: { args } },
    ]);
  };
  const changeMode = (next: string) => {
    if (next === "omit") setArg(undefined);
    else if (next === "value") setArg(startingValue(param, waveOrder));
    else if (next === "control") {
      const fits = sources.find((item) => item.kind === made?.kind) ?? sources[0];
      if (fits) setArg({ $control: fits.name });
    } else if (next === "new" && made) {
      // A control made for the argument, bound to it in the same step.
      const taken = (candidate: string) => panel.controls.some((item) => item.name === candidate);
      const fresh = taken(name) ? uniqueName(`${name}_`, taken) : name;
      setArg({ $control: fresh }, [
        { op: "addControl", panel: panel.name, kind: made.kind, name: fresh, props: made.props },
      ]);
    }
  };
  const title = param.title ? `${param.title} (${name})` : name;
  return (
    <div className="flex flex-col gap-1 border-t border-line-soft pt-1" data-arg={name}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate" title={param.description ?? title}>
          {title}
          {param.optional ? "" : " *"}
        </span>
        <Select
          aria-label={`${name} from`}
          className="!h-5 w-[6.5rem] shrink-0"
          value={mode}
          onChange={(event) => changeMode(event.target.value)}
        >
          {param.optional || mode === "omit" ? <option value="omit">Leave out</option> : null}
          <option value="value">Fixed value</option>
          <option value="control" disabled={sources.length === 0}>
            Control
          </option>
          {made ? <option value="new">New control</option> : null}
        </Select>
      </div>
      {mode === "value" ? (
        <div className="flex items-center gap-1 pl-3">
          <ArgValue
            name={name}
            param={param}
            value={current!}
            onChange={(value) => setArg(value)}
          />
        </div>
      ) : mode === "control" && isControlRef(current) ? (
        <div className="flex items-center gap-1 pl-3">
          <Select
            aria-label={`${name} control`}
            className="min-w-0 flex-1"
            value={current.$control}
            onChange={(event) => setArg({ $control: event.target.value })}
          >
            {!sources.some((item) => item.name === current.$control) ? (
              <option value={current.$control}>{current.$control} (missing)</option>
            ) : null}
            {sources.map((item) => (
              <option key={item.name} value={item.name}>
                {item.label && item.label !== item.name
                  ? `${item.label} (${item.name})`
                  : item.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function ButtonForm({ panel, control }: { panel: PanelSpec; control: ControlOf<"button"> }) {
  const catalog = useCatalog();
  const spec = control.action
    ? findAction(catalog, control.action, control.version ?? undefined)
    : undefined;
  const ids = [...new Set(catalog.map((item) => item.id))].sort();
  const versions = catalog
    .filter((item) => item.id === control.action)
    .map((item) => item.version)
    .sort((a, b) => a - b);
  const titles = new Map(catalog.map((item) => [item.id, item.title]));
  const modify = (props: Record<string, unknown>) => modifyControl(panel.name, control.name, props);
  const unknown = Object.keys(control.args).filter(
    (name) => spec && !Object.hasOwn(spec.params, name),
  );
  return (
    <>
      <Prop label="Action">
        <Select
          aria-label="Action"
          className="min-w-0 flex-1"
          value={control.action}
          onChange={(event) => {
            const id = event.target.value;
            const next = findAction(catalog, id);
            // Arguments the new action also takes are kept.
            const args = dict(
              Object.entries(control.args).filter(
                ([name]) => next !== undefined && Object.hasOwn(next.params, name),
              ),
            );
            modify({ action: id, version: null, args });
          }}
        >
          <option value="">(none)</option>
          {control.action && !ids.includes(control.action) ? (
            <option value={control.action}>{control.action} (not registered)</option>
          ) : null}
          {ids.map((id) => (
            <option key={id} value={id}>
              {titles.get(id)} — {id}
            </option>
          ))}
        </Select>
      </Prop>
      {versions.length > 1 ? (
        <Prop label="Version">
          <Select
            aria-label="Version"
            value={control.version === null ? "" : String(control.version)}
            onChange={(event) =>
              modify({ version: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">Latest</option>
            {versions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </Select>
        </Prop>
      ) : null}
      {control.action && !spec ? (
        <p className="text-[11px] text-muted">
          {catalog.length === 0
            ? "Python is not up yet, so the action's arguments are not known."
            : `${control.action} is not registered: run the procedure that registers it.`}
        </p>
      ) : null}
      {spec?.description ? <p className="text-[11px] text-muted">{spec.description}</p> : null}
      {spec
        ? Object.entries(spec.params).map(([name, param]) => (
            <ArgRow key={name} panel={panel} control={control} name={name} param={param} />
          ))
        : null}
      {unknown.map((name) => (
        <div key={name} className="flex items-center gap-1.5 border-t border-line-soft pt-1">
          <span className="min-w-0 flex-1 truncate text-danger">{name} (not an argument)</span>
          <Button
            className="!h-5 !px-2"
            onClick={() =>
              modify({
                args: dict(Object.entries(control.args).filter(([key]) => key !== name)),
              })
            }
          >
            Remove
          </Button>
        </div>
      ))}
    </>
  );
}

/** The properties of the control selected, to change. */
function ControlForm({ panel, control }: { panel: PanelSpec; control: PanelControl }) {
  const modify = (props: Record<string, unknown>) => modifyControl(panel.name, control.name, props);
  const words = control.kind === "heading" || control.kind === "text";
  return (
    <div className="flex flex-col gap-1.5" aria-label={`${control.name} properties`} role="group">
      <div className="font-semibold">{KIND_TITLES[control.kind]}</div>
      <CommitText
        label="Name"
        value={control.name}
        onCommit={(name) => {
          if (modify({ name }) !== undefined) selectControl(panel.name, name);
        }}
      />
      <CommitText
        label={words ? "Text" : control.kind === "button" ? "Caption" : "Label"}
        value={control.label}
        multiline={control.kind === "text"}
        onCommit={(label) => modify({ label })}
      />
      <Prop label="">
        <Checkbox
          label="On the line before"
          checked={control.inline}
          onChange={(event) => modify({ inline: event.target.checked })}
        />
      </Prop>
      {control.kind === "number" ? (
        <>
          <CommitText
            label="Min"
            value={numberText(control.min)}
            onCommit={(text) => modify({ min: numberOrNull(text) })}
          />
          <CommitText
            label="Max"
            value={numberText(control.max)}
            onCommit={(text) => modify({ max: numberOrNull(text) })}
          />
          <CommitText
            label="Step"
            value={numberText(control.step)}
            onCommit={(text) => modify({ step: numberOrNull(text) })}
          />
        </>
      ) : null}
      {control.kind === "choice" ? (
        <CommitText
          label="Options"
          multiline
          placeholder="One on each line"
          value={control.options.map(String).join("\n")}
          onCommit={(text) =>
            modify({
              options: text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                // An option that was a number stays one.
                .map((line) => control.options.find((item) => String(item) === line) ?? line),
            })
          }
        />
      ) : null}
      {control.kind === "wave" ? (
        <>
          <Prop label="Dimensions">
            <Select
              aria-label="Dimensions"
              value={control.dims === null ? "" : String(control.dims)}
              onChange={(event) =>
                modify({ dims: event.target.value ? Number(event.target.value) : null })
              }
            >
              <option value="">Any</option>
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
          </Prop>
          <CommitText
            label="Filter"
            placeholder="Text, or a pattern like *_I"
            value={control.filter}
            onCommit={(filter) => modify({ filter })}
          />
        </>
      ) : null}
      {control.kind === "button" ? <ButtonForm panel={panel} control={control} /> : null}
    </div>
  );
}

/** The properties of the panel itself, when no control is selected. */
function PanelForm({ panel }: { panel: PanelSpec }) {
  const code = codeActions(panel);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-semibold">Panel</div>
      <CommitText
        label="Title"
        value={panel.title}
        placeholder={panel.name}
        onCommit={(title) => runGui({ op: "modifyPanel", panel: panel.name, props: { title } })}
      />
      <p className="text-[11px] text-muted">
        Add controls with <b>Add ▾</b> and click one to change it. A button calls an action with
        fixed values and the values of controls.
      </p>
      <p className={`text-[11px] ${code.length > 0 ? "text-danger" : "text-muted"}`}>
        {code.length > 0
          ? `Contains code: its buttons call ${code.join(", ")}, actions registered by procedures, which run this experiment's Python.`
          : "Data only: its buttons call only the application's actions (core.*) and plugins' (plugin.*)."}
      </p>
    </div>
  );
}

/**
 * A panel window: its controls, which hold values and run actions; in edit
 * mode, the same controls to select, move and delete, with the properties
 * of the one selected beside them.
 */
export function PanelWindow({ name }: { name: string }) {
  const panel = useDoc((state) =>
    Object.hasOwn(state.panels, name) ? state.panels[name] : undefined,
  );
  const editing = usePanelRuntime((state) => state.editing[name] === true);
  const chosen = usePanelRuntime((state) =>
    Object.hasOwn(state.selected, name) ? state.selected[name] : undefined,
  );
  if (!panel) return null;
  const selected = panel.controls.find((item) => item.name === chosen) ?? null;
  const selectedName = selected?.name ?? null;

  const onContextMenu = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-control]")?.dataset
      .control;
    if (editing && target) selectControl(name, target);
    openContextMenu(event, [
      ...(editing && target ? [...controlItems(panel, target), { separator: true }] : []),
      { label: "Edit Panel", checked: editing, onSelect: () => setEditing(name, !editing) },
      { label: "Export Panel…", onSelect: () => exportPanel(name) },
    ]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing || !selectedName || event.target !== event.currentTarget) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelected(panel, selectedName);
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveSelected(panel, selectedName, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Escape") {
      selectControl(name, null);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-chrome" onContextMenu={onContextMenu}>
      {editing ? <EditBar panel={panel} selected={selectedName} /> : null}
      <div className="flex min-h-0 flex-1">
        <div
          role="group"
          aria-label={`${name} controls`}
          tabIndex={editing ? 0 : undefined}
          className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto p-3 outline-none"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (editing && event.target === event.currentTarget) selectControl(name, null);
          }}
        >
          {panel.controls.length === 0 ? (
            <div className="m-auto max-w-[18rem] text-center text-muted">
              This panel has no controls yet.
              {editing ? (
                " Add some with Add ▾."
              ) : (
                <div className="mt-2">
                  <Button onClick={() => setEditing(name, true)}>Edit Panel</Button>
                </div>
              )}
            </div>
          ) : null}
          {rowsOf(panel.controls).map((row) => (
            <div key={row[0]!.name} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {row.map((control) =>
                editing ? (
                  <div
                    key={control.name}
                    data-control={control.name}
                    aria-label={`${KIND_TITLES[control.kind]} ${control.name}`}
                    aria-pressed={control === selected}
                    role="button"
                    className={`cursor-default rounded px-1 py-0.5 outline-1 ${
                      control === selected
                        ? "bg-accent-soft outline outline-accent"
                        : "outline-dashed outline-line hover:bg-paper/60"
                    }`}
                    onPointerDown={(event) => {
                      event.currentTarget.parentElement?.parentElement?.focus();
                      selectControl(name, control.name);
                    }}
                  >
                    <div inert>
                      <ControlBody panel={name} control={control} />
                    </div>
                  </div>
                ) : (
                  <div key={control.name} data-control={control.name}>
                    <ControlBody panel={name} control={control} />
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        {editing ? (
          <aside className="w-[17rem] shrink-0 overflow-auto border-l border-line bg-chrome p-2 text-[11.5px]">
            {selected ? (
              <ControlForm key={selected.name} panel={panel} control={selected} />
            ) : (
              <PanelForm panel={panel} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

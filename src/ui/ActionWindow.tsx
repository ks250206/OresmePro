import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  closeActionWindow,
  moveActionWindow,
  raiseActionWindow,
  useActionWindows,
  type ActionWindowState,
} from "../app/actionWindows";
import { invokeAction, pluginStore, useDoc } from "../app/session";
import type { ActionArgs, JsonValue, ParamSpec } from "../core/actions";
import { pluginActionId, type PluginAction, type PluginManifest } from "../core/plugins/manifest";
import { errorField, isCancelled } from "../core/doc/types";
import { PHASE_TITLES, pluginPhase, type PluginPhase } from "../core/sandbox/validate";
import {
  Button,
  Checkbox,
  Field,
  InvalidFieldContext,
  ListBox,
  Select,
  TextInput,
} from "./controls";

/** A plain value as a form shows it. */
const shown = (value: JsonValue | undefined): string =>
  value === undefined || value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** The value a control of the action's form starts with. */
function initialValue(spec: ParamSpec): JsonValue | undefined {
  if (spec.default !== undefined) return spec.default;
  if (spec.type === "choice") return spec.choices?.[0] ?? null;
  if (spec.type === "boolean") return false;
  return undefined;
}

/** A form for an action's arguments, made from their descriptions. */
export function ActionForm({
  manifest,
  action,
}: {
  manifest: PluginManifest;
  action: PluginAction;
}) {
  // The selector must return what the document holds, not a new list each time it is asked.
  const state = useDoc((current) => current);
  const numeric = useMemo(
    () => state.waveOrder.filter((name) => !state.waves[name]?.text),
    [state.waveOrder, state.waves],
  );
  // An argument that takes text waves lists them too.
  const wavesFor = (spec: { text?: boolean }) => (spec.text ? state.waveOrder : numeric);
  const [values, setValues] = useState<Record<string, JsonValue | undefined>>(() =>
    Object.fromEntries(
      Object.entries(action.params).map(([name, spec]) => [name, initialValue(spec)]),
    ),
  );
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{
    message: string;
    phase: PluginPhase | null;
    field: string | null;
  } | null>(null);
  const set = (name: string, value: JsonValue | undefined) =>
    setValues((current) => ({ ...current, [name]: value }));

  const run = () => {
    const args: ActionArgs = {};
    for (const [name, spec] of Object.entries(action.params)) {
      let value = values[name];
      if (spec.type === "number" || spec.type === "integer") {
        const typed = text[name];
        if (typed !== undefined && typed.trim() !== "") value = Number(typed);
        else if (typed !== undefined) value = undefined;
      }
      if (spec.type === "json" && text[name] !== undefined) {
        // JSON if it reads as JSON; otherwise the text itself (a table written out, say).
        const typed = text[name]!.trim();
        try {
          value = typed === "" ? undefined : (JSON.parse(typed) as JsonValue);
        } catch {
          value = typed;
        }
      }
      if (spec.type === "numbers" && text[name] !== undefined) {
        value = text[name]!.split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
      }
      if (value !== undefined && value !== "") args[name] = value as JsonValue;
    }
    setBusy(true);
    setProblem(null);
    invokeAction(pluginActionId(manifest.name, action.name), args).then(
      () => setBusy(false),
      (error: unknown) => {
        setBusy(false);
        // Stopped is not a failure: the history says so, and there is nothing to put right.
        if (isCancelled(error)) return;
        setProblem({
          message: error instanceof Error ? error.message : String(error),
          phase: pluginPhase(error),
          field: errorField(error),
        });
      },
    );
  };

  return (
    <InvalidFieldContext.Provider value={problem?.field ?? null}>
      <div
        className="flex flex-col gap-1.5"
        // Changing a value takes the mark off the argument that was refused.
        onInput={() =>
          setProblem((current) => (current?.field ? { ...current, field: null } : current))
        }
      >
        {action.description ? <p className="m-0 text-muted">{action.description}</p> : null}
        {Object.entries(action.params).map(([name, spec]) => {
          const label = spec.title ?? name;
          switch (spec.type) {
            case "wave":
              return (
                <Field key={name} name={name} label={label}>
                  <Select
                    value={typeof values[name] === "string" ? (values[name] as string) : ""}
                    onChange={(event) => set(name, event.target.value || undefined)}
                  >
                    <option value="">{spec.optional ? "(none)" : "Choose a wave"}</option>
                    {wavesFor(spec).map((wave) => (
                      <option key={wave} value={wave}>
                        {wave}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            case "waves":
              return (
                <Field key={name} name={name} label={label} group>
                  <ListBox
                    label={label}
                    items={wavesFor(spec).map((wave) => ({ key: wave, text: wave }))}
                    selected={Array.isArray(values[name]) ? (values[name] as string[]) : []}
                    onChange={(selected) => set(name, selected)}
                    style={{ height: 96 }}
                  />
                </Field>
              );
            case "boolean":
              return (
                <Field key={name} name={name} label="" group>
                  <Checkbox
                    label={label}
                    checked={values[name] === true}
                    onChange={(event) => set(name, event.target.checked)}
                  />
                </Field>
              );
            case "choice":
              return (
                <Field key={name} name={name} label={label}>
                  <Select
                    value={shown(values[name])}
                    onChange={(event) => {
                      const chosen = (spec.choices ?? []).find(
                        (item) => String(item) === event.target.value,
                      );
                      set(name, chosen ?? null);
                    }}
                  >
                    {(spec.choices ?? []).map((choice) => (
                      <option key={String(choice)} value={String(choice)}>
                        {String(choice)}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            case "string":
              return (
                <Field key={name} name={name} label={label}>
                  <TextInput
                    value={typeof values[name] === "string" ? (values[name] as string) : ""}
                    onChange={(event) => set(name, event.target.value)}
                  />
                </Field>
              );
            default:
              return (
                <Field key={name} name={name} label={label}>
                  <TextInput
                    inputMode="decimal"
                    placeholder={spec.optional ? "default" : ""}
                    value={text[name] ?? shown(values[name])}
                    onChange={(event) =>
                      setText((current) => ({ ...current, [name]: event.target.value }))
                    }
                  />
                </Field>
              );
          }
        })}
        <div className="flex items-center gap-2">
          <Button primary disabled={busy} onClick={run}>
            {busy ? "Running…" : "Run"}
          </Button>
          {problem ? (
            <span role="alert" className="text-red-700">
              {problem.phase ? (
                <span className="mr-1 font-medium">Failed at {PHASE_TITLES[problem.phase]}:</span>
              ) : null}
              {problem.message}
            </span>
          ) : null}
        </div>
      </div>
    </InvalidFieldContext.Provider>
  );
}

/** The window of a plugin's action: a title bar to drag it by and close it, and its form. */
function ActionWindow({
  window,
  front,
  z,
}: {
  window: ActionWindowState;
  front: boolean;
  z: number;
}) {
  const installed = useSyncExternalStore(pluginStore.subscribe, pluginStore.list);
  const plugin = installed.find((item) => item.manifest.name === window.plugin);
  const action = plugin?.manifest.actions.find((item) => item.name === window.action);
  const drag = useRef<{ x: number; y: number; from: ActionWindowState } | null>(null);
  const title = action ? action.title : window.action;
  const close = () => closeActionWindow(window.plugin, window.action);
  return (
    <section
      role="dialog"
      aria-label={title}
      data-floating
      className={`pointer-events-auto absolute flex w-[340px] max-w-[calc(100%-1rem)] flex-col rounded-md border bg-chrome ${
        front ? "border-[#8d95a1] shadow-[0_8px_28px_rgb(0_0_0/0.22)]" : "border-line shadow-md"
      }`}
      style={{ left: window.x, top: window.y, zIndex: z }}
      onPointerDownCapture={() => raiseActionWindow(window.plugin, window.action)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header
        className={`flex h-[22px] shrink-0 cursor-default items-center gap-2 rounded-t-md border-b px-2 ${
          front ? "border-line bg-chrome-2" : "border-line-soft bg-chrome text-muted"
        }`}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, from: window };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          moveActionWindow(
            window.plugin,
            window.action,
            Math.max(80 - 340, start.from.x + event.clientX - start.x),
            start.from.y + event.clientY - start.y,
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <button
          type="button"
          aria-label={`Close ${title}`}
          title="Close"
          className={`grid h-3 w-3 place-items-center rounded-full text-[9px] leading-none text-transparent hover:text-black/70 ${
            front ? "bg-[#e5665e]" : "bg-line"
          }`}
          onClick={close}
        >
          {"×"}
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[11.5px] font-medium">
          <span>{title}</span>
          {plugin ? (
            <span className="font-normal text-muted"> · {plugin.manifest.title}</span>
          ) : null}
        </span>
        <span className="w-3" />
      </header>
      <div className="max-h-[70vh] overflow-auto p-3">
        {plugin && action && plugin.enabled ? (
          <ActionForm
            key={`${plugin.lock.digest}:${action.name}`}
            manifest={plugin.manifest}
            action={action}
          />
        ) : (
          <p className="m-0 text-muted">
            {!plugin
              ? `The plugin ${window.plugin} is not installed.`
              : !plugin.enabled
                ? `${plugin.manifest.title} is turned off (Python › Plugins…).`
                : `${plugin.manifest.title} no longer has the action ${window.action}.`}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The windows of plugins' actions, over the experiment's windows (at `z`)
 * and under dialogs. They are not modal: the rest of the app goes on
 * working while they are open.
 */
export function ActionWindows({ z }: { z: number }) {
  const windows = useActionWindows();
  if (windows.length === 0) return null;
  const key = (window: ActionWindowState) => `${window.plugin}.${window.action}`;
  // In a stable order, so that bringing one to the front does not move it in the page (and lose
  // the focus); the order they are stacked in is their z.
  const ordered = [...windows].sort((a, b) => key(a).localeCompare(key(b)));
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: z }}>
      {ordered.map((window) => (
        <ActionWindow
          key={key(window)}
          window={window}
          front={window === windows.at(-1)}
          z={windows.indexOf(window) + 1}
        />
      ))}
    </div>
  );
}

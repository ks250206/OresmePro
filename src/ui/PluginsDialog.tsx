import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { contributionCommands } from "../app/plugins/contributions";
import { fetchFromGitHub, readLocalPackage } from "../app/plugins/sources";
import type { InstalledPlugin } from "../app/plugins/store";
import { doc, invokeAction, pluginStore, runGui, showError, ui, useDoc } from "../app/session";
import type { ActionArgs, JsonValue, ParamSpec } from "../core/actions";
import {
  CONTRIBUTION_KINDS,
  describeSource,
  parseGitHubSource,
  pluginActionId,
  type ContributionKind,
  type PluginAction,
  type PluginManifest,
} from "../core/plugins/manifest";
import type { VerifiedPackage } from "../core/plugins/package";
import { Button, Checkbox, Dialog, Field, ListBox, Select, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

const short = (commit: string | null) => (commit ? commit.slice(0, 12) : "");

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** What installing a package lets it do, in the words shown before it is installed. */
function PackageSummary({ pkg, previous }: { pkg: VerifiedPackage; previous?: InstalledPlugin }) {
  const { manifest, lock } = pkg;
  const total = lock.files.reduce((sum, file) => sum + file.size, 0);
  const before = new Set(previous?.manifest.actions.map((action) => action.name) ?? []);
  const after = new Set(manifest.actions.map((action) => action.name));
  const added = manifest.actions.filter((action) => !before.has(action.name));
  const removed = [...before].filter((name) => !after.has(name));
  const contributes = Object.entries(manifest.contributes).filter(([, paths]) => paths.length > 0);
  return (
    <div className="selectable flex flex-col gap-2 leading-relaxed">
      <div>
        <div className="text-base font-medium">
          {manifest.title} <span className="text-muted">{manifest.version}</span>
        </div>
        <div className="text-muted">
          {describeSource(lock.source)}
          {lock.commit ? ` at ${short(lock.commit)}` : ""}
          {manifest.license ? ` · ${manifest.license}` : ""}
        </div>
        {previous ? (
          <div className="text-muted">
            Replaces {previous.manifest.version}
            {previous.lock.commit ? ` (${short(previous.lock.commit)})` : ""}.
          </div>
        ) : null}
      </div>
      {manifest.description ? (
        <p className="m-0 whitespace-pre-wrap">{manifest.description}</p>
      ) : null}
      {manifest.python ? (
        <div className="rounded border border-line bg-chrome p-2">
          <div className="font-medium">This plugin has Python code.</div>
          <div>
            It runs apart from the app, in a sandbox of its own: it is given only the waves you
            choose for an action and hands back new waves and numbers. It cannot read your
            experiments or other data in this browser, and it cannot use the network.
          </div>
          {manifest.python.packages.length > 0 ? (
            <div className="text-muted">Python packages: {manifest.python.packages.join(", ")}</div>
          ) : null}
        </div>
      ) : (
        <div className="rounded border border-line bg-chrome p-2">
          This plugin has no code: only data (panels, templates, styles).
        </div>
      )}
      {manifest.actions.length > 0 ? (
        <div>
          <div className="font-medium">Actions</div>
          <ul className="m-0 pl-5">
            {manifest.actions.map((action) => (
              <li key={action.name}>
                {action.title}{" "}
                <span className="text-muted">({pluginActionId(manifest.name, action.name)})</span>
                {previous && added.includes(action) ? (
                  <span className="text-accent"> new</span>
                ) : null}
              </li>
            ))}
          </ul>
          {removed.length > 0 ? (
            <div className="text-muted">No longer has: {removed.join(", ")}</div>
          ) : null}
        </div>
      ) : null}
      {contributes.length > 0 ? (
        <div>
          <div className="font-medium">Brings</div>
          <ul className="m-0 pl-5">
            {contributes.map(([kind, paths]) => (
              <li key={kind}>
                {paths.length} {kind === "graphTemplates" ? "graph templates" : kind}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="text-muted">
        {lock.files.length} files, {sizeText(total)}. SHA-256 {lock.digest.slice(0, 16)}…
      </div>
    </div>
  );
}

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
function ActionForm({ manifest, action }: { manifest: PluginManifest; action: PluginAction }) {
  // The selector must return what the document holds, not a new list each time it is asked.
  const state = useDoc((current) => current);
  const waves = useMemo(
    () => state.waveOrder.filter((name) => !state.waves[name]?.text),
    [state.waveOrder, state.waves],
  );
  const [values, setValues] = useState<Record<string, JsonValue | undefined>>(() =>
    Object.fromEntries(
      Object.entries(action.params).map(([name, spec]) => [name, initialValue(spec)]),
    ),
  );
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
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
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {action.description ? <p className="m-0 text-muted">{action.description}</p> : null}
      {Object.entries(action.params).map(([name, spec]) => {
        const label = spec.title ?? name;
        switch (spec.type) {
          case "wave":
            return (
              <Field key={name} label={label}>
                <Select
                  value={typeof values[name] === "string" ? (values[name] as string) : ""}
                  onChange={(event) => set(name, event.target.value || undefined)}
                >
                  <option value="">{spec.optional ? "(none)" : "Choose a wave"}</option>
                  {waves.map((wave) => (
                    <option key={wave} value={wave}>
                      {wave}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          case "waves":
            return (
              <Field key={name} label={label} group>
                <ListBox
                  label={label}
                  items={waves.map((wave) => ({ key: wave, text: wave }))}
                  selected={Array.isArray(values[name]) ? (values[name] as string[]) : []}
                  onChange={(selected) => set(name, selected)}
                  style={{ height: 96 }}
                />
              </Field>
            );
          case "boolean":
            return (
              <Field key={name} label="" group>
                <Checkbox
                  label={label}
                  checked={values[name] === true}
                  onChange={(event) => set(name, event.target.checked)}
                />
              </Field>
            );
          case "choice":
            return (
              <Field key={name} label={label}>
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
              <Field key={name} label={label}>
                <TextInput
                  value={typeof values[name] === "string" ? (values[name] as string) : ""}
                  onChange={(event) => set(name, event.target.value)}
                />
              </Field>
            );
          default:
            return (
              <Field key={name} label={label}>
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
            {problem}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** What a plugin brings as data, put into the experiment on request. */
function Contributions({ plugin }: { plugin: InstalledPlugin }) {
  const { contributes } = plugin.manifest;
  const add = async (kind: ContributionKind) => {
    try {
      const files = await pluginStore.files(plugin);
      const state = doc.getState();
      // Names given to earlier files of this batch count as taken too.
      const chosen = new Set<string>();
      const commands = contributes[kind].flatMap((path) =>
        contributionCommands(kind, path, files.get(path)!, state, chosen),
      );
      runGui(commands);
    } catch (error) {
      showError("Could not add it", error);
    }
  };
  const labels: Record<ContributionKind, string> = {
    panels: "Add Panels to Experiment",
    templates: "Add Templates to Experiment",
    graphTemplates: "Add Graph Templates to Experiment",
    styles: "Add Styles to Experiment",
  };
  const kinds = CONTRIBUTION_KINDS.filter((kind) => contributes[kind].length > 0);
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {kinds.map((kind) => (
        <Button key={kind} onClick={() => void add(kind)}>
          {labels[kind]}
        </Button>
      ))}
    </div>
  );
}

type Step =
  | { kind: "list" }
  | { kind: "github" }
  | { kind: "approve"; pkg: VerifiedPackage; previous?: InstalledPlugin }
  | { kind: "busy"; message: string };

/**
 * Plugins: installing them from GitHub or from files, turning them on and
 * off, updating and removing them, and running their actions.
 */
export function PluginsDialog() {
  const installed = useSyncExternalStore(pluginStore.subscribe, pluginStore.list);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [selected, setSelected] = useState<string | null>(installed[0]?.manifest.name ?? null);
  const [address, setAddress] = useState("");
  const [ref, setRef] = useState("");
  const [folder, setFolder] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [actionName, setActionName] = useState<string>("");
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const plugin = installed.find((item) => item.manifest.name === selected) ?? null;
  const action = useMemo(
    () =>
      plugin?.manifest.actions.find((item) => item.name === actionName) ??
      plugin?.manifest.actions[0] ??
      null,
    [plugin, actionName],
  );

  const fail = (error: unknown, back: Step) => {
    setProblem(error instanceof Error ? error.message : String(error));
    setStep(back);
  };

  const fetchGitHub = () => {
    let source;
    try {
      source = parseGitHubSource(address, ref, folder || undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    setProblem(null);
    setStep({ kind: "busy", message: `Fetching ${source.owner}/${source.repo}…` });
    fetchFromGitHub(source).then(
      (pkg) => setStep({ kind: "approve", pkg, previous: pluginStore.find(pkg.manifest.name) }),
      (error: unknown) => fail(error, { kind: "github" }),
    );
  };

  const readPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked = [...list].map((file) => ({
      path: file.webkitRelativePath || file.name,
      bytes: async () => new Uint8Array(await file.arrayBuffer()),
    }));
    setProblem(null);
    setStep({ kind: "busy", message: "Reading the files…" });
    readLocalPackage(picked).then(
      (pkg) => setStep({ kind: "approve", pkg, previous: pluginStore.find(pkg.manifest.name) }),
      (error: unknown) => fail(error, { kind: "list" }),
    );
  };

  const install = (pkg: VerifiedPackage) => {
    setStep({ kind: "busy", message: "Installing…" });
    pluginStore.install(pkg).then(
      (done) => {
        setSelected(done.manifest.name);
        setStep({ kind: "list" });
      },
      (error: unknown) => fail(error, { kind: "list" }),
    );
  };

  const update = (current: InstalledPlugin) => {
    const { source } = current.lock;
    if (source.kind !== "github") {
      setProblem("A plugin installed from files is updated by installing its new files.");
      return;
    }
    setProblem(null);
    setStep({ kind: "busy", message: `Looking for a newer ${current.manifest.title}…` });
    fetchFromGitHub(source).then(
      (pkg) => {
        if (pkg.lock.digest === current.lock.digest) {
          setProblem(`${current.manifest.title} is up to date.`);
          setStep({ kind: "list" });
        } else {
          setStep({ kind: "approve", pkg, previous: current });
        }
      },
      (error: unknown) => fail(error, { kind: "list" }),
    );
  };

  const remove = (current: InstalledPlugin) => {
    if (
      !window.confirm(
        `Remove ${current.manifest.title}? Waves, graphs and results it made stay in your experiments; running its actions again will need it.`,
      )
    ) {
      return;
    }
    pluginStore
      .remove(current.manifest.name)
      .catch((error: unknown) => fail(error, { kind: "list" }));
  };

  if (step.kind === "busy") {
    return (
      <Dialog title="Plugins" onClose={close} width={460}>
        <p className="m-0">{step.message}</p>
      </Dialog>
    );
  }

  if (step.kind === "approve") {
    return (
      <Dialog
        title={step.previous ? "Update Plugin" : "Install Plugin"}
        onClose={() => setStep({ kind: "list" })}
        onSubmit={() => install(step.pkg)}
        submitLabel={step.previous ? "Update" : "Install"}
        width={520}
      >
        <PackageSummary pkg={step.pkg} previous={step.previous} />
      </Dialog>
    );
  }

  if (step.kind === "github") {
    return (
      <Dialog
        title="Install Plugin from GitHub"
        onClose={() => setStep({ kind: "list" })}
        onSubmit={fetchGitHub}
        submitLabel="Fetch"
        submitDisabled={!address.trim()}
        width={520}
      >
        <div className="flex flex-col gap-1.5">
          <Field label="Repository">
            <TextInput
              className="flex-1"
              placeholder="https://github.com/owner/repository"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <Field label="Branch or tag">
            <TextInput
              className="flex-1"
              placeholder="from the address, or the default branch"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            />
          </Field>
          <Field label="Folder">
            <TextInput
              className="flex-1"
              placeholder="from the address, or the top"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
          </Field>
          <p className="m-0 text-muted">
            The branch or tag is fixed to the commit it points at now: what is installed does not
            change when the repository does. Nothing of the plugin runs until you have seen what it
            does and installed it.
          </p>
          {problem ? (
            <p role="alert" className="m-0 text-red-700">
              {problem}
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Plugins"
      onClose={close}
      width={720}
      buttons={
        <>
          <Button onClick={() => setStep({ kind: "github" })}>Install from GitHub…</Button>
          <Button onClick={() => folderInput.current?.click()}>Install from Folder…</Button>
          <Button onClick={() => zipInput.current?.click()}>Install from Zip…</Button>
        </>
      }
    >
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        aria-label="Plugin folder"
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => {
          readPicked(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip"
        className="hidden"
        aria-label="Plugin zip"
        onChange={(event) => {
          readPicked(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="flex gap-3" style={{ minHeight: 320 }}>
        <ListBox
          label="Installed plugins"
          multiple={false}
          style={{ width: 200 }}
          empty="No plugins installed yet."
          items={installed.map((item) => ({
            key: item.manifest.name,
            text: item.manifest.title,
            label: `${item.manifest.title}${item.enabled ? "" : " (off)"}`,
            muted: !item.enabled,
          }))}
          selected={selected ? [selected] : []}
          onChange={(chosen) => setSelected(chosen[0] ?? null)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {problem ? (
            <p role="alert" className="m-0 text-red-700">
              {problem}
            </p>
          ) : null}
          {plugin ? (
            <>
              <div className="selectable">
                <div className="text-base font-medium">
                  {plugin.manifest.title}{" "}
                  <span className="text-muted">{plugin.manifest.version}</span>
                </div>
                <div className="text-muted">
                  {describeSource(plugin.lock.source)}
                  {plugin.lock.commit ? ` at ${short(plugin.lock.commit)}` : ""}
                  {plugin.manifest.python ? " · Python, in a sandbox" : " · data only"}
                </div>
                {plugin.manifest.description ? (
                  <p className="m-0 mt-1 whitespace-pre-wrap">{plugin.manifest.description}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    void pluginStore
                      .setEnabled(plugin.manifest.name, !plugin.enabled)
                      .catch((error: unknown) => fail(error, { kind: "list" }))
                  }
                >
                  {plugin.enabled ? "Turn Off" : "Turn On"}
                </Button>
                <Button
                  disabled={plugin.lock.source.kind !== "github"}
                  onClick={() => update(plugin)}
                >
                  Update…
                </Button>
                <Button onClick={() => remove(plugin)}>Remove…</Button>
              </div>
              <Contributions plugin={plugin} />
              {plugin.enabled && plugin.manifest.actions.length > 0 && action ? (
                <div className="flex flex-col gap-1.5 border-t border-line pt-2">
                  <Field label="Action">
                    <Select
                      value={action.name}
                      onChange={(event) => setActionName(event.target.value)}
                    >
                      {plugin.manifest.actions.map((item) => (
                        <option key={item.name} value={item.name}>
                          {item.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <ActionForm
                    key={`${plugin.lock.digest}:${action.name}`}
                    manifest={plugin.manifest}
                    action={action}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="m-0 text-muted">
              Plugins add analyses, panels and templates. Install one from a GitHub repository, or
              from a folder or zip that holds an oresme-plugin.json.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

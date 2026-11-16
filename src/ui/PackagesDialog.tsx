import { useState } from "react";
import { runPython } from "../app/actions";
import {
  kernel,
  pythonPackages,
  RESTORE_PACKAGES,
  ui,
  useDoc,
  useKernelState,
  useUi,
} from "../app/session";
import { useStore } from "../app/store";
import {
  normalizePackageName,
  requirementsText,
  type PythonEnv,
  type PythonPackage,
} from "../core/doc/pythonEnv";
import type { PackagesStatus } from "../kernel/rpc";
import { Button, Checkbox, Dialog, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** Packages worth having for spectra, fits, impedance and statistics, and where each comes from. */
export const SUGGESTED: readonly { name: string; from: "Pyodide" | "PyPI"; use: string }[] = [
  { name: "pybaselines", from: "PyPI", use: "Baselines of spectra: AsLS, arPLS, SNIP and more" },
  { name: "impedance", from: "PyPI", use: "Equivalent circuits for impedance (EIS)" },
  { name: "statsmodels", from: "Pyodide", use: "Statistical models, regression, time series" },
  { name: "pywavelets", from: "Pyodide", use: "Wavelet transforms and denoising (import pywt)" },
  { name: "uncertainties", from: "Pyodide", use: "Numbers with uncertainties carried through" },
  { name: "emcee", from: "PyPI", use: "MCMC: distributions of fitted parameters" },
  { name: "iminuit", from: "Pyodide", use: "Minuit minimizer and its error estimates" },
  { name: "pint", from: "PyPI", use: "Physical units and their conversion" },
  { name: "sympy", from: "Pyodide", use: "Symbolic mathematics" },
  { name: "xarray", from: "Pyodide", use: "Labelled arrays of several dimensions" },
  { name: "scikit-image", from: "Pyodide", use: "Image processing and segmentation" },
  { name: "polars", from: "Pyodide", use: "Fast data frames" },
];

/** How a recorded package stands in the Python that is running. */
export function packageState(item: PythonPackage, status: PackagesStatus | null): string {
  if (!status) return "Python has not said";
  const version = status.installed[item.name];
  if (version === undefined) return "not installed";
  if (version !== item.version) return `installed ${version}, ${item.version} recorded`;
  return status.imported.includes(item.name) ? "imported" : "installed";
}

/** A package Python has now, for the table of everything in Python. */
export interface InstalledRow {
  name: string;
  version: string;
  /** Python started with it; the experiment records it; or neither (micropip, say). */
  kind: "pre-installed" | "experiment" | "other";
  imported: boolean;
}

/** Every package Python has, imported ones first, then by name; with `importedOnly`, those imported. */
export function installedRows(
  status: PackagesStatus,
  env: PythonEnv,
  importedOnly: boolean,
): InstalledRow[] {
  const recorded = new Set(env.packages.map((item) => item.name));
  const imported = new Set(status.imported);
  return Object.entries(status.installed)
    .map(([name, version]): InstalledRow => ({
      name,
      version,
      kind: status.base.includes(name)
        ? "pre-installed"
        : recorded.has(name)
          ? "experiment"
          : "other",
      imported: imported.has(name),
    }))
    .filter((row) => !importedOnly || row.imported)
    .sort((a, b) => Number(b.imported) - Number(a.imported) || a.name.localeCompare(b.name));
}

/** The packages asked for, each with what it brought, as lines of a tree. */
export function packageTree(env: PythonEnv): { depth: number; item: PythonPackage }[] {
  const byName = new Map(env.packages.map((item) => [item.name, item]));
  const lines: { depth: number; item: PythonPackage }[] = [];
  const walk = (item: PythonPackage, depth: number, seen: Set<string>) => {
    lines.push({ depth, item });
    for (const name of item.depends) {
      const next = byName.get(name);
      if (next && !seen.has(name)) walk(next, depth + 1, new Set([...seen, name]));
    }
  };
  for (const item of env.packages.filter((entry) => entry.requested)) {
    walk(item, 0, new Set([item.name]));
  }
  return lines;
}

/**
 * The Python packages of the experiment: what it records and how each stands
 * in the Python that is running, a tree of what each brought, installing by
 * name or from a list of suggestions, and taking out. Every change runs as
 * the %pip line it is, so the history has it.
 */
export function PackagesDialog() {
  const env = useDoc((state) => state.python);
  const held = useUi((state) => state.packagesHeld);
  const status = useStore(pythonPackages, (state) => state.status);
  const kernelState = useKernelState();
  const [typed, setTyped] = useState("");
  const [importedOnly, setImportedOnly] = useState(true);
  const recorded = new Set(env.packages.map((item) => item.name));
  const ready = kernelState.status !== "unavailable" && kernelState.status !== "failed";
  const pip = (line: string) => {
    runPython(line);
  };
  const rows = status ? installedRows(status, env, importedOnly) : [];
  const cell = "border-b border-r border-line-soft px-1.5 py-0.5 whitespace-nowrap";

  return (
    <Dialog title="Python Packages" help="guides/python/" width={760} onClose={close}>
      {held ? (
        <div className="flex items-center gap-2 rounded border border-danger/40 bg-danger/5 px-2 py-1">
          <span className="flex-1">
            This experiment came from a file and its packages from PyPI were not installed.
          </span>
          <Button
            onClick={() => {
              ui.set({ packagesHeld: false });
              kernel.execute(RESTORE_PACKAGES, "user");
            }}
          >
            Install Them
          </Button>
        </div>
      ) : null}
      <div role="region" aria-label="Packages of the experiment" className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">This experiment</span>
          <span className="text-[11px] text-muted">
            {env.packages.length === 0
              ? "uses no packages beyond those Python starts with."
              : `installed under Pyodide ${env.pyodide ?? "?"}; they are installed again whenever it opens.`}
          </span>
        </div>
        {env.packages.length > 0 ? (
          <div className="max-h-56 overflow-auto rounded border border-line bg-paper">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead className="sticky top-0 bg-chrome">
                <tr>
                  {["Package", "Version", "From", "In Python", ""].map((title) => (
                    <th key={title} className={`${cell} border-line font-semibold`}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {packageTree(env).map(({ depth, item }, index) => (
                  <tr key={`${item.name}:${index}`} aria-label={`Package ${item.name}`}>
                    <td className={cell} style={{ paddingLeft: 6 + depth * 16 }}>
                      {depth > 0 ? <span className="text-muted">└ </span> : null}
                      <span className={item.requested ? "font-medium" : "text-muted"}>
                        {item.name}
                      </span>
                    </td>
                    <td className={`${cell} font-mono text-[11px]`}>{item.version}</td>
                    <td className={cell}>{item.source === "pyodide" ? "Pyodide" : "PyPI"}</td>
                    <td className={cell}>{packageState(item, status)}</td>
                    <td className={cell}>
                      {depth === 0 ? (
                        <Button
                          aria-label={`Remove ${item.name}`}
                          disabled={!ready}
                          onClick={() => pip(`%pip uninstall ${item.name}`)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {env.packages.length > 0 ? (
          <div className="flex gap-1.5">
            <Button
              onClick={() => void navigator.clipboard?.writeText(requirementsText(env))}
              title="name==version for each package asked for"
            >
              Copy Requirements
            </Button>
            <Button disabled={!ready} onClick={() => pip("%pip list")}>
              List Everything in Python
            </Button>
          </div>
        ) : null}
      </div>
      <div
        role="group"
        aria-label="Install"
        className="flex flex-col gap-1.5 border-t border-line-soft pt-2"
      >
        <div className="flex items-center gap-1.5">
          <TextInput
            aria-label="Package to install"
            placeholder="A name from PyPI or Pyodide: pint, emcee==3.1.6"
            className="min-w-0 flex-1"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && typed.trim()) {
                event.preventDefault();
                pip(`%pip install ${typed.trim()}`);
                setTyped("");
              }
            }}
          />
          <Button
            primary
            disabled={!typed.trim() || !ready}
            onClick={() => {
              pip(`%pip install ${typed.trim()}`);
              setTyped("");
            }}
          >
            Install
          </Button>
        </div>
        <div className="text-[11px] text-muted">
          Pure Python packages from PyPI install, and so do the packages of the Pyodide
          distribution; one with compiled code of its own that Pyodide does not ship cannot run in
          the browser. Installing needs the network the first time; the browser keeps the files.
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {SUGGESTED.map((item) => {
            const have = recorded.has(normalizePackageName(item.name));
            return (
              <div key={item.name} className="flex items-center gap-1.5">
                <Button
                  aria-label={`Install ${item.name}`}
                  disabled={have || !ready}
                  onClick={() => pip(`%pip install ${item.name}`)}
                >
                  {have ? "Installed" : "Install"}
                </Button>
                <span className="whitespace-nowrap font-medium">{item.name}</span>
                <span className="truncate text-[11px] text-muted" title={item.use}>
                  {item.from} · {item.use}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div
        role="region"
        aria-label="In Python now"
        className="flex flex-col gap-1 border-t border-line-soft pt-2"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">In Python now</span>
          <span className="text-[11px] text-muted">
            {status
              ? `Python ${status.python} · Pyodide ${status.pyodide}`
              : "Python has not said yet."}
          </span>
          <span className="flex-1" />
          <Checkbox
            label="Imported only"
            checked={importedOnly}
            onChange={(event) => setImportedOnly(event.target.checked)}
          />
        </div>
        {status ? (
          <div className="max-h-48 overflow-auto rounded border border-line bg-paper">
            <table
              aria-label="Packages in Python"
              className="w-full border-separate border-spacing-0 text-left"
            >
              <thead className="sticky top-0 bg-chrome">
                <tr>
                  {["Package", "Version", "Installed as", "Imported"].map((title) => (
                    <th key={title} className={`${cell} border-line font-semibold`}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} aria-label={`In Python ${row.name}`}>
                    <td className={cell}>{row.name}</td>
                    <td className={`${cell} font-mono text-[11px]`}>{row.version}</td>
                    <td className={`${cell} text-muted`}>
                      {row.kind === "pre-installed"
                        ? "pre-installed"
                        : row.kind === "experiment"
                          ? "this experiment"
                          : "other"}
                    </td>
                    <td className={cell}>{row.imported ? "yes" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {status ? (
          <div className="text-[11px] text-muted">
            {rows.length} of {Object.keys(status.installed).length} packages shown. Pre-installed
            ones load with Python; the others of the Pyodide distribution load when imported.
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

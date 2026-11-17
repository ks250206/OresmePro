import type { ActionArgs, JsonValue } from "../core/actions";
import type { AnalysisResult } from "../core/doc/results";
import type { DocState, Wave } from "../core/doc/types";
import {
  XPS_BACKGROUNDS,
  XPS_LETTERS,
  XPS_PARAMS,
  bindingEnergies,
  componentsArg,
  type XpsBackground,
  type XpsComponent,
} from "../core/xps";
import { doc, kernel } from "./session";
import { createStore, useStore } from "./store";
import { openTool } from "./toolWindows";

/**
 * The XPS Peak Fitting window's state: what is being fitted (the spectrum,
 * its energies, the region, the background and the components), and what the
 * last fit said. Like the other tool windows it is not part of the
 * experiment: each fit is, as an op.xps_fit call in the history and an XPS
 * result, which the window reads back when it opens on that spectrum again.
 */
export interface XpsSetup {
  spectrum: string;
  /** An X wave of energies, or null for the spectrum's X scaling. */
  x: string | null;
  energy: "binding" | "kinetic";
  photonEnergy: number;
  shift: number;
  /** Binding energies from and to; null for the whole spectrum. */
  region: [number, number] | null;
  background: XpsBackground;
  average: number;
  weighting: "poisson" | "unit";
  components: XpsComponent[];
}

export interface XpsReportRow {
  letter: string;
  name: string;
  shape: string;
  position: number;
  position_sigma: number | null;
  fwhm: number;
  fwhm_sigma: number | null;
  width: number | null;
  area: number;
  area_sigma: number | null;
  rsf: number;
  percent: number | null;
}

export interface XpsReport {
  /** The result it was kept as (XPS0, ...), if it was. */
  result: string | null;
  rows: XpsReportRow[];
  chisq: number | null;
  chisqReduced: number | null;
  points: number;
  converged: boolean;
  reason: string;
  warnings: string[];
}

interface XpsState {
  setup: XpsSetup | null;
  /** The component selected in the table and on the plot, or -1. */
  selected: number;
  report: XpsReport | null;
  busy: boolean;
  error: string | null;
  past: XpsSetup[];
  future: XpsSetup[];
  /** What was being done to other spectra this session, to come back to. */
  kept: Record<string, { setup: XpsSetup; report: XpsReport | null }>;
}

const LIMIT = 100;

export const xps = createStore<XpsState>({
  setup: null,
  selected: -1,
  report: null,
  busy: false,
  error: null,
  past: [],
  future: [],
  kept: {},
});

export const useXps = <T>(selector: (state: XpsState) => T): T => useStore(xps, selector);

export const AL_KA = 1486.6;

function plainSetup(spectrum: string): XpsSetup {
  return {
    spectrum,
    x: null,
    energy: "binding",
    photonEnergy: AL_KA,
    shift: 0,
    region: null,
    background: "shirley",
    average: 5,
    weighting: "poisson",
    components: [],
  };
}

/** The last XPS result of a spectrum, if there is one. */
export function latestResult(state: DocState, spectrum: string): AnalysisResult | null {
  let latest: AnalysisResult | null = null;
  for (const result of Object.values(state.results)) {
    if (result.kind !== "xps" || result.settings.y !== spectrum) continue;
    if (!latest || result.created >= latest.created) latest = result;
  }
  return latest;
}

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The setup and report a kept result was made with, its fitted values as the components' values. */
export function fromResult(result: AnalysisResult): { setup: XpsSetup; report: XpsReport } {
  const settings = result.settings;
  const coef = (name: string) => {
    const index = result.names.indexOf(name);
    return index < 0 ? null : result.coef[index]!;
  };
  const sigma = (name: string) => {
    const index = result.names.indexOf(name);
    return index < 0 ? null : result.sigma[index]!;
  };
  const given = Array.isArray(settings.components) ? settings.components : [];
  const components: XpsComponent[] = given.map((item, index) => {
    const raw = (item && typeof item === "object" && !Array.isArray(item) ? item : {}) as Record<
      string,
      unknown
    >;
    const letter = XPS_LETTERS[index]!;
    const constraints = (raw.constraints ?? {}) as Record<string, unknown>;
    return {
      name: text(raw.name, letter),
      shape: text(raw.shape, "GL(30)"),
      position: num(coef(`${letter}_position`), num(raw.position, 0)),
      fwhm: num(coef(`${letter}_fwhm`), num(raw.fwhm, 1.5)),
      area: num(coef(`${letter}_area`), num(raw.area, 0)),
      rsf: num(raw.rsf, 1),
      gauss: num(raw.gauss, 0),
      constraints: {
        position: text(constraints.position, ""),
        fwhm: text(constraints.fwhm, ""),
        area: text(constraints.area, ""),
      },
    };
  });
  const region = Array.isArray(settings.region) ? settings.region : null;
  const background = XPS_BACKGROUNDS.find((item) => item === settings.background) ?? "shirley";
  const setup: XpsSetup = {
    spectrum: text(settings.y, ""),
    x: typeof settings.x === "string" ? settings.x : null,
    energy: settings.energy === "kinetic" ? "kinetic" : "binding",
    photonEnergy: num(settings.photon_energy, AL_KA),
    shift: num(settings.shift, 0),
    region: region && region.length === 2 ? [num(region[0], 0), num(region[1], 0)] : null,
    background,
    average: num(settings.average, 5),
    weighting: settings.weighting === "unit" ? "unit" : "poisson",
    components,
  };
  const rows = components.map((component, index): XpsReportRow => {
    const letter = XPS_LETTERS[index]!;
    return {
      letter,
      name: component.name,
      shape: component.shape,
      position: component.position,
      position_sigma: sigma(`${letter}_position`),
      fwhm: component.fwhm,
      fwhm_sigma: sigma(`${letter}_fwhm`),
      width: null,
      area: component.area,
      area_sigma: sigma(`${letter}_area`),
      rsf: component.rsf,
      percent: coef(`${letter}_percent`),
    };
  });
  return {
    setup,
    report: {
      result: result.name,
      rows,
      chisq: result.chisq,
      chisqReduced:
        result.chisq !== null && result.freedom > 0 ? result.chisq / result.freedom : null,
      points: result.points,
      converged: result.converged,
      reason: result.reason,
      warnings: [],
    },
  };
}

/** Starts work on a spectrum: where it was left this session, else its last fit, else afresh. */
export function chooseSpectrum(spectrum: string): void {
  const now = xps.get();
  if (now.setup?.spectrum === spectrum) return;
  const kept = { ...now.kept };
  if (now.setup) kept[now.setup.spectrum] = { setup: now.setup, report: now.report };
  const earlier = kept[spectrum];
  const result = earlier ? null : latestResult(doc.getState(), spectrum);
  const restored =
    earlier ?? (result ? fromResult(result) : { setup: plainSetup(spectrum), report: null });
  xps.set({
    setup: restored.setup,
    report: restored.report,
    selected: restored.setup.components.length > 0 ? 0 : -1,
    error: null,
    past: [],
    future: [],
    kept,
  });
}

/** Opens the window, on the spectrum given if there is one. */
export function openXps(spectrum?: string): void {
  openTool("xps");
  const state = doc.getState();
  const fallback =
    xps.get().setup?.spectrum ??
    state.waveOrder.find((name) => {
      const wave = state.waves[name]!;
      return !wave.text && wave.shape.length === 1;
    });
  const name = spectrum ?? fallback;
  if (name) chooseSpectrum(name);
}

/** A change that can be undone: the setup before it goes on the undo list. */
export function editSetup(change: (setup: XpsSetup) => XpsSetup): void {
  const { setup, past } = xps.get();
  if (!setup) return;
  const next = change(setup);
  if (next === setup) return;
  xps.set({ setup: next, past: [...past, setup].slice(-LIMIT), future: [], error: null });
}

/** The first step of a drag: undoable as one, however many live changes follow. */
export function beginDrag(): void {
  const { setup, past } = xps.get();
  if (setup) xps.set({ past: [...past, setup].slice(-LIMIT), future: [] });
}

/** A change while dragging, which the undo of beginDrag takes back. */
export function dragSetup(change: (setup: XpsSetup) => XpsSetup): void {
  const { setup } = xps.get();
  if (setup) xps.set({ setup: change(setup) });
}

export function undoXps(): void {
  const { setup, past, future } = xps.get();
  if (!setup || past.length === 0) return;
  xps.set({ setup: past.at(-1)!, past: past.slice(0, -1), future: [setup, ...future] });
  clampSelection();
}

export function redoXps(): void {
  const { setup, past, future } = xps.get();
  if (!setup || future.length === 0) return;
  xps.set({ setup: future[0]!, past: [...past, setup], future: future.slice(1) });
  clampSelection();
}

function clampSelection(): void {
  const { setup, selected } = xps.get();
  const count = setup?.components.length ?? 0;
  if (selected >= count) xps.set({ selected: count - 1 });
}

export const selectComponent = (index: number): void => xps.set({ selected: index });

/** Edits one component. */
export function editComponent(index: number, change: Partial<XpsComponent>): void {
  editSetup((setup) => ({
    ...setup,
    components: setup.components.map((component, at) =>
      at === index ? { ...component, ...change } : component,
    ),
  }));
}

/** The spectrum's energies as the setup reads them: binding energies, the shift included. */
export function spectrumEnergies(
  wave: Wave | undefined,
  xWave: Wave | undefined,
  setup: XpsSetup,
): { be: Float64Array; y: Wave["data"] } | string {
  if (!wave) return `There is no wave ${setup.spectrum}.`;
  if (wave.text || wave.shape.length !== 1) return `${setup.spectrum} is not a 1-D numeric wave.`;
  const count = wave.data.length;
  let x: ArrayLike<number>;
  if (setup.x) {
    if (!xWave) return `There is no wave ${setup.x}.`;
    if (xWave.data.length !== count)
      return `${setup.x} has ${xWave.data.length} points and ${setup.spectrum} ${count}.`;
    x = xWave.data;
  } else {
    x = Float64Array.from({ length: count }, (_, i) => wave.x0 + i * wave.dx);
  }
  return { be: bindingEnergies(x, setup.energy, setup.photonEnergy, setup.shift), y: wave.data };
}

/** The arguments of op.xps_fit for a setup, leaving out those as by default. */
export function fitArgs(setup: XpsSetup, fit = true): ActionArgs {
  const args: ActionArgs = {
    y: setup.spectrum,
    components: componentsArg(setup.components) as JsonValue,
  };
  if (setup.x) args.x = setup.x;
  if (setup.region) args.region = [...setup.region].sort((a, b) => a - b);
  if (setup.background !== "shirley") args.background = setup.background;
  if (setup.average !== 5) args.average = setup.average;
  if (setup.energy !== "binding") {
    args.energy = setup.energy;
    args.photon_energy = setup.photonEnergy;
  }
  if (setup.shift !== 0) args.shift = setup.shift;
  if (setup.weighting !== "poisson") args.weighting = setup.weighting;
  // Drawn without fitting, the components are not a result worth keeping.
  if (!fit) {
    args.fit = false;
    args.record = false;
  }
  return args;
}

interface FitReply {
  result: string | null;
  components: XpsReportRow[];
  chisq: number | null;
  chisq_reduced: number | null;
  points: number;
  converged: boolean;
  reason: string;
  warnings: string[];
}

/**
 * Fits the components as they stand (or, with `fit` false, only makes the
 * waves and graph of them), as op.xps_fit, and takes the values it found as
 * the components' values. A fit can be undone in the window like an edit.
 */
export async function runXpsFit(fit = true): Promise<void> {
  const { setup, busy } = xps.get();
  if (!setup || busy) return;
  if (setup.components.length === 0) {
    xps.set({ error: "Add a component first: Create, or double-click the plot." });
    return;
  }
  xps.set({ busy: true, error: null });
  try {
    const reply = (await kernel.invoke("core.xps_fit", fitArgs(setup, fit))) as FitReply;
    const now = xps.get().setup;
    // The setup may have been changed meanwhile; the values found are for the one sent.
    const base = now && now.spectrum === setup.spectrum ? now : setup;
    const components = base.components.map((component, index) => {
      const row = reply.components[index];
      if (!row || index >= setup.components.length) return component;
      return { ...component, position: row.position, fwhm: row.fwhm, area: row.area };
    });
    const { past } = xps.get();
    xps.set({
      setup: { ...base, components },
      past: [...past, base].slice(-LIMIT),
      future: [],
      busy: false,
      report: {
        result: reply.result,
        rows: reply.components,
        chisq: reply.chisq,
        chisqReduced: reply.chisq_reduced,
        points: reply.points,
        converged: reply.converged,
        reason: reply.reason,
        warnings: reply.warnings,
      },
    });
  } catch (error) {
    xps.set({ busy: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Every parameter is one of these: what the table shows it as. */
export const PARAM_TITLES: Record<(typeof XPS_PARAMS)[number], string> = {
  position: "Position",
  fwhm: "FWHM",
  area: "Area",
};

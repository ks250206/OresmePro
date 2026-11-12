// Takes the screenshots shown in README.md from the built app.
//
//   pnpm build
//   pnpm preview --port 4173 --strictPort &
//   node scripts/readme-screenshots.mjs
//
// Set PLAYWRIGHT_CHROMIUM_PATH to use a Chromium that is already installed, and
// pass the name of a scene (workspace, import, editor, layout) to take only that one.

import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const APP = process.env.ORESME_URL ?? "http://localhost:4173/";
const OUT = new URL("../.github/readme/", import.meta.url);
const only = process.argv[2];

const DECAY = `x = np.linspace(0, 10, 2000)
signal = op.make("signal", np.sin(2 * np.pi * x) * np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
envelope = op.make("envelope", np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
g = op.display(signal, envelope, name="Decay")
g.trace("envelope").set(color="black", line_style="dash")
g.axis("bottom").label = r"Time (\\u)"
g.axis("left").label = r"Amplitude (\\u)"
g.legend()`;

const SPECTRUM = `rng = np.random.default_rng(7)
x = np.linspace(280, 296, 640)
shape = lambda c, w: np.exp(-((x - c) / w) ** 2)
counts = 4200 * shape(284.8, 0.55) + 1500 * shape(286.4, 0.7) + 900 * shape(288.9, 0.8) + 300 + 12 * (296 - x)
spectrum = op.make("spectrum", rng.poisson(counts).astype(float), x0=x[0], dx=x[1] - x[0], x_unit="eV", unit="counts")
g = op.display(spectrum, name="C1s")
g.trace("spectrum").set(mode="markers", marker_size=2.5, color="gray")
g.axis("bottom").label = r"Binding energy (\\u)"
g.axis("left").label = r"Intensity (\\u)"`;

const FIT = `peaks = op.fit_peaks(spectrum, peaks=3, baseline="linear", graph="C1s")`;

const PROCEDURE = `import math

import numpy as np
import oresme as op


def decay(x, A, tau, y0):
    """An exponential decay towards y0."""
    return A * np.exp(-x / tau) + y0


def fit_envelope(name="envelope"):
    wave = op.wave(name)
    result = op.fit(decay, wave, guess=[1, 2, 0])
    print(reslt.params)
    return result


fit_envelope()
`;

/** A file as a measuring instrument writes it: a few lines about the run, then the table. */
function instrumentFile() {
  const rows = [];
  for (let i = 0; i <= 14; i++) {
    const voltage = i * 0.05;
    const current = 0.0021 * (Math.exp(voltage / 0.09) - 1);
    const temperature = 295.1 + 0.03 * i;
    const comment = i === 0 ? "start" : i === 9 ? "range change" : "";
    rows.push(`${voltage.toFixed(2)},${current.toFixed(4)},${temperature.toFixed(2)},${comment}`);
  }
  return [
    "Instrument,IV Tracer 200",
    "Sample,diode-B7",
    "Date,2026-11-10 14:32",
    "",
    "Voltage (V),Current (mA),Temperature (K),Comment",
    ...rows,
  ].join("\n");
}

async function open(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(APP);
  await idle(page);
  return page;
}

const idle = (page) =>
  page.waitForFunction(() => globalThis.oresme?.kernel.getState().status === "ready", null, {
    timeout: 120_000,
  });

async function run(page, code) {
  await page.evaluate((text) => globalThis.oresme.kernel.execute(text), code);
  await idle(page);
}

const place = (page, name, x, y, w, h) =>
  page.evaluate((command) => globalThis.oresme.doc.dispatch(command), {
    op: "moveWindow",
    name,
    x,
    y,
    w,
    h,
  });

async function save(page, name) {
  // Lets the graphs draw at their new sizes.
  await page.waitForTimeout(800);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, OUT)) });
  await page.context().close();
}

const scenes = {
  async workspace(browser) {
    const page = await open(browser, { width: 1440, height: 900 });
    await run(page, SPECTRUM);
    await run(page, FIT);
    await run(
      page,
      `g.legend()\nop.edit(spectrum, "fit_spectrum", name="Data")\nop.edit("W_peaks", name="Peaks")`,
    );
    await place(page, "C1s", 20, 16, 690, 570);
    await place(page, "Data", 730, 16, 470, 300);
    await place(page, "Peaks", 730, 336, 470, 250);
    await save(page, "workspace");
  },

  async import(browser) {
    const page = await open(browser, { width: 1280, height: 800 });
    await page.evaluate((body) => {
      const data = new DataTransfer();
      data.items.add(new File([body], "diode-B7.csv"));
      document
        .querySelector("[data-desktop]")
        .dispatchEvent(
          new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    }, instrumentFile());
    const dialog = page.getByRole("dialog", { name: "Load Data: diode-B7.csv" });
    await dialog.waitFor();
    await dialog
      .locator("select")
      .filter({ hasText: "X for the graph" })
      .first()
      .selectOption({ label: "X for the graph" });
    await dialog.getByRole("checkbox", { name: "Make a graph" }).check();
    await save(page, "import");
  },

  async editor(browser) {
    const page = await open(browser, { width: 1280, height: 800 });
    await run(page, DECAY);
    await run(page, `p = op.new_procedure("Fits")`);
    await place(page, "Decay", 20, 16, 440, 300);
    await place(page, "Fits", 480, 16, 560, 470);
    const text = page.getByRole("textbox", { name: "Fits.py" });
    await text.click();
    await page.keyboard.insertText(PROCEDURE);
    // The linter starts after a pause in typing, and loads on its first use.
    await page.locator(".cm-lintRange").first().waitFor({ timeout: 60_000 });
    await text.click({ button: "right", position: { x: 250, y: 330 } });
    await save(page, "editor");
  },

  async layout(browser) {
    const page = await open(browser, { width: 1440, height: 900 });
    await run(page, SPECTRUM);
    await run(page, FIT);
    await run(page, DECAY);
    await run(
      page,
      `fig = op.new_layout("Figure1", size="A4", landscape=True)
fig.add_text("Figure 1", x=50, y=50, size=18)
fig.add_graph("C1s", x=50, y=90, w=360, h=340)
fig.add_graph("Decay", x=430, y=90, w=360, h=340)
fig.add_text("(a) C 1s spectrum and a fit of three peaks", x=50, y=445, size=11)
fig.add_text("(b) Damped oscillation and its envelope", x=430, y=445, size=11)`,
    );
    await place(page, "C1s", 20, 16, 380, 270);
    await place(page, "Decay", 20, 306, 380, 270);
    await place(page, "Figure1", 420, 12, 780, 586);
    await save(page, "layout");
  },
};

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
    : {},
);
try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (only && only !== name) continue;
    await scene(browser);
    console.log(`.github/readme/${name}.png`);
  }
} finally {
  await browser.close();
}

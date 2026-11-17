import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin electrochem, whose view eis builds its window of the app's parts. */
const ELECTROCHEM = fileURLToPath(new URL("../examples/plugins/electrochem", import.meta.url));

test.describe("a plugin's view", () => {
  test.describe.configure({ timeout: 240_000 });

  test("draws what its Python builds, follows edits, fits with the plugin's action, and starts again from the fit", async ({
    app,
    page,
  }) => {
    // R0 + R1 ∥ CPE1 (10 Ω, 100 Ω, Q 1e-5, n 0.9), 1 % noise.
    await app.run(
      [
        "import numpy as np",
        "f = np.logspace(-1, 5, 50)",
        "Z = 10 + 1 / (1 / 100 + 1e-5 * (2j * np.pi * f) ** 0.9)",
        "Z = Z * (1 + 0.01 * np.random.default_rng(3).normal(size=f.size))",
        "op.make('freq', f); op.make('zre', Z.real); op.make('zim', -Z.imag)",
      ].join("\n"),
    );
    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(ELECTROCHEM);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("EIS Circuit Fitting");
    await expect(approval).toContainText("as the plugin's Python builds it");
    await approval.getByRole("button", { name: "Install" }).click();
    await page
      .getByRole("dialog", { name: "Plugins" })
      .getByRole("button", { name: "Close", exact: true })
      .click();

    await app.menu("Analysis", "EIS Circuit Fitting…");
    const win = page.getByRole("dialog", { name: "EIS Circuit Fitting" });
    // The plugin's sandbox starts and its Python builds the window.
    await expect(win.getByLabel("Frequency (Hz)")).toBeVisible({ timeout: 120_000 });
    await win.getByLabel("Frequency (Hz)").selectOption("freq");
    await win.getByLabel("Z′ (Ω)").selectOption("zre");
    await win.getByLabel("Z″ or −Z″ (Ω)").selectOption("zim");
    // Its parameters, guessed from the spectrum, in the table.
    const value = (row: number) => win.getByLabel(`Value ${row}`, { exact: true });
    await expect.poll(async () => Number(await value(2).inputValue())).toBeGreaterThan(50);
    expect(await win.getByRole("cell", { name: "Q1" }).count()).toBe(1);
    await expect(win.getByRole("img", { name: /Plot of Data/ }).first()).toBeVisible();

    // An edit goes into the state at once, and is undone in the window.
    await value(1).fill("30");
    await value(1).press("Enter");
    await expect(value(1)).toHaveValue("30");
    await win
      .getByRole("img", { name: /Plot of Data/ })
      .first()
      .click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => Number(await value(1).inputValue())).not.toBe(30);

    // A circuit changed: the rows follow it, keeping the values of the same names.
    const r1 = await value(2).inputValue();
    await win.getByLabel("Circuit", { exact: true }).fill("R0-p(R1,C1)");
    await win.getByLabel("Circuit", { exact: true }).press("Enter");
    await expect(win.getByRole("cell", { name: "C1", exact: true })).toBeVisible();
    await expect(value(2)).toHaveValue(r1);
    await win.getByLabel("Circuit", { exact: true }).fill("R0-p(R1,CPE1)");
    await win.getByLabel("Circuit", { exact: true }).press("Enter");
    await expect(win.getByRole("cell", { name: "n1" })).toBeVisible();

    // Fit: the plugin's action, recorded and kept; what it found comes back into the table.
    await win.getByRole("button", { name: "Fit", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)), {
        timeout: 60_000,
      })
      .toEqual(["Plugin0"]);
    await expect.poll(async () => Number(await value(2).inputValue())).toBeCloseTo(100, 0);
    expect(Number(await value(4).inputValue())).toBeCloseTo(0.9, 1);
    await expect(win.getByText(/Fitted \(Plugin0\)/)).toBeVisible();
    const entry = await app.lastEntry();
    expect(entry.code).toMatch(
      /^op\.invoke\("plugin\.electrochem\.eis_circuit", \{"frequency": "freq", "zre": "zre", "zim": "zim", "circuit": "R0-p\(R1,CPE1\)".*, replace=True\)$/,
    );
    // Fitted again: the same waves, made again in place.
    await win.getByRole("button", { name: "Fit", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)))
      .toEqual(["Plugin0", "Plugin1"]);
    const order = (await app.doc()).order;
    expect(order.filter((name) => name.startsWith("freq_zre_fit"))).toEqual(["freq_zre_fit"]);

    // Opened after a reload, it starts from the last fit kept.
    await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme?.doc.getState().results ?? {})))
      .toEqual(["Plugin0", "Plugin1"]);
    await app.menu("Analysis", "EIS Circuit Fitting…");
    await expect(win.getByLabel("Frequency (Hz)")).toHaveValue("freq", { timeout: 120_000 });
    await expect.poll(async () => Number(await value(2).inputValue())).toBeCloseTo(100, 0);
  });
});

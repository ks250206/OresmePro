import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin xps, whose view quant works out atomic % from regions of spectra. */
const XPS = fileURLToPath(new URL("../examples/plugins/xps", import.meta.url));

test.describe("the XPS quantification window", () => {
  test.describe.configure({ timeout: 240_000 });

  test("adds a region where the spectrum is clicked, moves it by its bounds, and quantifies", async ({
    app,
    page,
  }) => {
    // C 1s, N 1s and O 1s of areas 1 : 1 : 2.93 on a flat background, 270–550 eV by 0.5 eV.
    await app.run(
      [
        "import numpy as np",
        "be = 270 + 0.5 * np.arange(561)",
        "peak = lambda c, a: a / (1.2 * np.sqrt(2 * np.pi)) * np.exp(-0.5 * ((be - c) / 1.2) ** 2)",
        "y = 200 + peak(285, 1000) + peak(400, 1800) + peak(532, 2930)",
        'op.make("survey", y, x0=270, dx=0.5, x_unit="eV")',
      ].join("\n"),
    );
    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(XPS);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("XPS Quantification");
    await approval.getByRole("button", { name: "Install" }).click();
    await page
      .getByRole("dialog", { name: "Plugins" })
      .getByRole("button", { name: "Close", exact: true })
      .click();

    await app.menu("Analysis", "XPS Quantification…");
    const win = page.getByRole("dialog", { name: "XPS Quantification" });
    await expect(win.getByLabel("Spectrum 1")).toBeVisible({ timeout: 120_000 });
    await win.getByLabel("Spectrum 1").selectOption("survey");
    const plot = win.getByRole("img", { name: /Plot of Spectrum/ });
    await expect(win.getByText(/Click the spectrum to add a region/)).toBeVisible();

    // The plot's binding energy axis runs from right to left over 270–549.5 eV, padded by 5 %.
    const box = (await plot.boundingBox())!;
    const [lo, hi] = [270 - 0.05 * 279.5, 549.5 + 0.05 * 279.5];
    const left = box.x + 58;
    const right = box.x + box.width - 12;
    const pixel = (energy: number) => left + ((hi - energy) / (hi - lo)) * (right - left);
    const middle = box.y + box.height / 2;
    await page.mouse.click(pixel(285), middle);
    const cell = (column: string, row: number) =>
      win.getByLabel(`${column} ${row}`, { exact: true });
    await expect(cell("Region", 1)).toHaveValue("Region 1");
    expect(Math.abs(Number(await cell("From (eV)", 1).inputValue()) - 281)).toBeLessThan(1.5);

    // Named, widened by dragging its upper bound to the left (a higher binding energy).
    await cell("Region", 1).fill("C 1s");
    await cell("Region", 1).press("Enter");
    const upper = Number(await cell("To (eV)", 1).inputValue());
    await page.mouse.move(pixel(upper), middle);
    await page.mouse.down();
    await page.mouse.move(pixel(upper + 4), middle, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Number(await cell("To (eV)", 1).inputValue()))
      .toBeGreaterThan(upper + 3);
    // Undone in the window as one step.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => Number(await cell("To (eV)", 1).inputValue())).toBe(upper);
    await cell("From (eV)", 1).fill("277");
    await cell("From (eV)", 1).press("Enter");
    await cell("To (eV)", 1).fill("293");
    await cell("To (eV)", 1).press("Enter");

    // Two more in the table: O 1s takes its sensitivity factor from its name.
    for (const [row, name, from, to, rsf] of [
      [2, "N 1s", "392", "408", "1.8"],
      [3, "O 1s", "524", "540", ""],
    ] as const) {
      await win.getByRole("button", { name: "Add Row" }).click();
      await cell("Region", row).fill(name);
      await cell("Region", row).press("Enter");
      await cell("From (eV)", row).fill(from);
      await cell("From (eV)", row).press("Enter");
      await cell("To (eV)", row).fill(to);
      await cell("To (eV)", row).press("Enter");
      if (rsf) {
        await cell("RSF", row).fill(rsf);
        await cell("RSF", row).press("Enter");
      }
    }
    await win.getByLabel("Background", { exact: true }).selectOption("Linear");
    await expect(cell("RSF", 3)).toHaveValue("2.93");
    const percent = async (row: number) =>
      Number(await win.getByRole("row").nth(row).getByRole("cell").nth(5).innerText());
    for (const row of [1, 2, 3]) await expect.poll(() => percent(row)).toBeCloseTo(33.33, 0);

    // Quantify: the plugin's action, recorded and kept.
    await win.getByRole("button", { name: "Quantify", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)), {
        timeout: 60_000,
      })
      .toEqual(["Plugin0"]);
    await expect(win.getByText(/Quantified \(Plugin0\)/)).toBeVisible();
    const entry = await app.lastEntry();
    expect(entry.code).toMatch(
      /^op\.invoke\("plugin\.xps\.quantify", \{"spectra": \["survey"\], "regions": "C 1s: 277 293 rsf=1; N 1s: 392 408 rsf=1\.8; O 1s: 524 540 rsf=2\.93".*, replace=True\)$/,
    );
  });
});

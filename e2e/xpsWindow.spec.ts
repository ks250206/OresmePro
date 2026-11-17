import { expect, test } from "./fixtures";

/** Analysis › XPS Peak Fitting…: the window that fits components in the way of CasaXPS. */
test.describe("the XPS Peak Fitting window", () => {
  test.describe.configure({ timeout: 180_000 });

  test("builds components on the plot and in the table, fits them, and comes back to them", async ({
    app,
    page,
  }) => {
    // Two GL(30) peaks 1.5 eV apart on a step, binding energies 280–294 eV by 0.05 eV.
    await app.run(
      [
        "import numpy as np",
        "be = 280 + 0.05 * np.arange(281)",
        "gl = lambda u: np.exp(-4 * np.log(2) * 0.7 * u**2) / (1 + 1.2 * u**2)",
        "y = 1000 + 600 / (1 + np.exp(-(be - 285.5) / 0.4)) + 3000 * gl((be - 284.8) / 1.1) + 900 * gl((be - 286.3) / 1.1)",
        'op.make("c1s", y, x0=280, dx=0.05, x_unit="eV")',
      ].join("\n"),
    );
    await app.menu("Analysis", "XPS Peak Fitting…");
    const win = page.getByRole("dialog", { name: "XPS Peak Fitting" });
    await expect(win.getByRole("combobox", { name: "Spectrum" })).toHaveValue("c1s");
    const field = (label: string) => win.getByLabel(label, { exact: true });

    // The region, typed in; then a component where the data stands highest.
    await win.getByRole("tab", { name: "Region" }).click();
    await field("Region from").fill("292");
    await field("Region from").press("Enter");
    await field("Region to").fill("281");
    await field("Region to").press("Enter");
    await win.getByRole("tab", { name: "Components" }).click();
    await win.getByRole("button", { name: "Create" }).click();
    await expect(field("A position")).toHaveValue("284.8");

    // A second one double-clicked at about 286.3 eV: the axis runs from high to low.
    const canvas = win.getByRole("img", { name: "XPS spectrum and components" });
    const box = (await canvas.boundingBox())!;
    const at = async (energy: number) => {
      for (let x = box.x + 62; x < box.x + box.width - 16; x += 1) {
        await page.mouse.move(x, box.y + box.height - 60);
        const shown = await win.getByText(/ eV · /).textContent();
        if (Number.parseFloat(shown!) <= energy) return x;
      }
      throw new Error(`No pixel for ${energy} eV`);
    };
    await page.mouse.dblclick(await at(286.3), box.y + box.height - 80);
    await expect(field("B position")).toBeVisible();
    // Tied to A as C-O is to C-C.
    await field("B position constraint").fill("A+1.5");
    await field("B position constraint").press("Enter");
    await field("B fwhm constraint").fill("A");
    await field("B fwhm constraint").press("Enter");
    await expect(field("B position")).toHaveValue("286.3");
    await expect(field("B position")).toBeDisabled();

    await win.getByRole("button", { name: "Fit Components" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)), {
        timeout: 60_000,
      })
      .toEqual(["XPS0"]);
    // The values found are the table's now (the step under the peaks is not quite a Shirley background).
    await expect
      .poll(async () => Number(await field("A position").inputValue()))
      .toBeCloseTo(284.8, 1);
    expect(Number(await field("A fwhm").inputValue())).toBeCloseTo(1.1, 1);
    expect(
      Number(await field("B area").inputValue()) / Number(await field("A area").inputValue()),
    ).toBeCloseTo(0.3, 1);
    const entry = await app.lastEntry();
    expect(entry.code).toMatch(
      /^op\.xps_fit\(op\.wave\("c1s"\), \[\{"name": "A", "shape": "GL\(30\)"/,
    );
    expect(entry.code).toContain('"constraints": {"position": "A+1.5", "fwhm": "A"}');
    expect(entry.code).toContain("region=[281.0, 292.0]");
    expect(entry.output).toContain("XPS fit of c1s: 2 components over 281 to 292 eV");
    const state = await app.doc();
    expect(state.graphs.XPS_c1s!.axes.bottom!.reverse).toBe(true);
    expect(state.order).toEqual(
      expect.arrayContaining(["fit_c1s", "fit_c1s_bg", "fit_c1s_A", "fit_c1s_B", "fit_c1s_res"]),
    );
    await win.getByRole("tab", { name: "Report" }).click();
    await expect(win.getByText("Kept as XPS0")).toBeVisible();
    await win.getByRole("tab", { name: "Components" }).click();

    // Dragging A's square moves it; the window's own undo takes it back, not the experiment's.
    const position = Number(await field("A position").inputValue());
    const x = await at(position);
    let top = 0;
    for (let y = box.y + 40; y < box.y + box.height - 30; y += 1) {
      await page.mouse.move(x, y);
      if ((await canvas.evaluate((element) => element.style.cursor)) === "move") {
        top = y + 1;
        break;
      }
    }
    expect(top).toBeGreaterThan(0);
    await page.mouse.down();
    await page.mouse.move(x - 30, top + 20, { steps: 4 });
    await page.mouse.up();
    expect(Number(await field("A position").inputValue())).toBeGreaterThan(position + 0.2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => Number(await field("A position").inputValue()))
      .toBeCloseTo(position, 5);
    expect((await app.doc()).order).toContain("fit_c1s");

    // After the page is opened again, the window comes back to the fit kept in the experiment.
    await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme?.doc.getState().results ?? {})))
      .toEqual(["XPS0"]);
    await app.menu("Analysis", "XPS Peak Fitting…");
    await expect(field("B position constraint")).toHaveValue("A+1.5");
  });
});

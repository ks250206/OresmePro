import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin of the repository, with its model editor. */
const XPS = fileURLToPath(new URL("../examples/plugins/xps", import.meta.url));

/** A plugin's model editor: the xps plugin's XPS Peak Fitting, drawn by the app. */
test.describe("a plugin's model editor", () => {
  test.describe.configure({ timeout: 240_000 });

  test("builds components on the plot and in the table, fits them again in place, and comes back to them", async ({
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
    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(XPS);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("XPS Peak Fitting 0.2.0");
    await expect(approval).toContainText("it calls xps_preview and xps_fit");
    await approval.getByRole("button", { name: "Install" }).click();
    await page
      .getByRole("dialog", { name: "Plugins" })
      .getByRole("button", { name: "Close", exact: true })
      .click();

    // In the Analysis menu once installed.
    await app.menu("Analysis", "XPS Peak Fitting…");
    const win = page.getByRole("dialog", { name: "XPS Peak Fitting" });
    await expect(win.getByRole("combobox", { name: "Spectrum" })).toHaveValue("c1s");
    const field = (label: string) => win.getByLabel(label, { exact: true });
    const canvas = win.getByRole("img", { name: "XPS Peak Fitting: data and model" });
    // The plugin's sandbox starts and draws the data.
    await expect(win.getByText("Drawing…")).toHaveCount(0, { timeout: 120_000 });

    // The region, typed in; then a component where the data stands highest.
    await win.getByRole("tab", { name: "Settings" }).click();
    await field("Range from").fill("292");
    await field("Range from").press("Enter");
    await field("Range to").fill("281");
    await field("Range to").press("Enter");
    await win.getByRole("tab", { name: "Components" }).click();
    const create = win.getByRole("button", { name: "Create" });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(field("A Position (eV)")).toHaveValue("284.8");

    // A second one double-clicked at about 286.3 eV: the axis runs from high to low.
    const box = (await canvas.boundingBox())!;
    const at = async (energy: number) => {
      for (let x = box.x + 62; x < box.x + box.width - 16; x += 1) {
        await page.mouse.move(x, box.y + box.height - 60);
        const shown = await win.getByText(/^x .* · y /).textContent();
        if (Number.parseFloat(shown!.slice(2)) <= energy) return x;
      }
      throw new Error(`No pixel for ${energy} eV`);
    };
    await page.mouse.dblclick(await at(286.3), box.y + box.height - 80);
    await expect(field("B Position (eV)")).toBeVisible();
    // Tied to A as C-O is to C-C; the plugin works out what that gives.
    await field("B Position (eV) constraint").fill("A+1.5");
    await field("B Position (eV) constraint").press("Enter");
    await field("B FWHM (eV) constraint").fill("A");
    await field("B FWHM (eV) constraint").press("Enter");
    await expect(field("B Position (eV)")).toHaveValue("286.3");
    await expect(field("B Position (eV)")).toBeDisabled();

    const results = () =>
      page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results));
    await win.getByRole("button", { name: "Fit Components" }).click();
    await expect.poll(results, { timeout: 60_000 }).toEqual(["Plugin0"]);
    // The values found are the table's now (the step under the peaks is not quite a Shirley background).
    await expect
      .poll(async () => Number(await field("A Position (eV)").inputValue()))
      .toBeCloseTo(284.8, 1);
    expect(Number(await field("A FWHM (eV)").inputValue())).toBeCloseTo(1.1, 1);
    const entry = await app.lastEntry();
    expect(entry.code).toMatch(
      /^op\.invoke\("plugin\.xps\.xps_fit", \{"spectrum": "c1s", "region": \[281, 292\]/,
    );
    expect(entry.code).toContain('"constraints": {"position": "A+1.5", "fwhm": "A"}');
    expect(entry.code).toMatch(/, replace=True\)$/);
    await win.getByRole("tab", { name: "Report" }).click();
    await expect(win.getByText("Kept as Plugin0")).toBeVisible();
    await win.getByRole("tab", { name: "Components" }).click();
    const made = await app.doc();
    expect(Object.keys(made.graphs)).toEqual(["XPSFit0"]);
    expect(made.order).toEqual(
      expect.arrayContaining(["c1s_region", "c1s_envelope", "c1s_comp_A", "c1s_comp_B"]),
    );

    // Dragging A's square moves it; the window's own undo takes it back, not the experiment's.
    const position = Number(await field("A Position (eV)").inputValue());
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
    expect(Number(await field("A Position (eV)").inputValue())).toBeGreaterThan(position + 0.2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => Number(await field("A Position (eV)").inputValue()))
      .toBeCloseTo(position, 5);
    expect((await app.doc()).order).toContain("c1s_envelope");

    // Fitted again with one component: the same waves and graph, made again in place.
    await win.getByRole("columnheader", { name: "B" }).click();
    await win.getByRole("button", { name: "Delete" }).click();
    await expect(field("B Position (eV)")).toHaveCount(0);
    await win.getByRole("button", { name: "Fit Components" }).click();
    await expect.poll(results, { timeout: 60_000 }).toEqual(["Plugin0", "Plugin1"]);
    const again = await app.doc();
    expect(Object.keys(again.graphs)).toEqual(["XPSFit0"]);
    expect(again.order).not.toContain("c1s_comp_B");
    expect(again.order.filter((name) => name.startsWith("c1s_envelope"))).toEqual(["c1s_envelope"]);
    expect(again.graphs.XPSFit0!.traces.map((trace) => trace.y)).not.toContain("c1s_comp_B");

    // After the page is opened again, the window comes back to the fit kept in the experiment.
    await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme?.doc.getState().results ?? {})))
      .toEqual(["Plugin0", "Plugin1"]);
    await app.menu("Analysis", "XPS Peak Fitting…");
    await expect(field("A Position (eV)")).toHaveValue(/^284\.8/);
    await expect(field("B Position (eV)")).toHaveCount(0);
  });
});

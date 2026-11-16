import { expect, test } from "./fixtures";

test.describe("editing an analysis template", () => {
  test("a template is made step by step, its fit held as told, and tried on one sample", async ({
    app,
    page,
  }) => {
    await app.run(`tx = np.linspace(-5, 5, 101)
op.make("peakA", 1 + 3 * np.exp(-((tx - 0.5) / 0.9) ** 2), x0=-5, dx=0.1)
op.make("peakB", 1 + 2 * np.exp(-((tx + 0.4) / 1.1) ** 2), x0=-5, dx=0.1)`);
    await app.menu("Analysis", "Templates…");
    await page
      .getByRole("dialog", { name: "Analysis Templates" })
      .getByRole("button", { name: "New…" })
      .click();
    const editor = page.getByRole("dialog", { name: "New Template" });
    await editor.getByLabel("Template name").fill("HeldPeak");
    await expect(editor.getByText("A template needs at least one step.")).toBeVisible();

    await editor.getByLabel("Action to add").selectOption("core.fit");
    await editor.getByRole("button", { name: "Add Step" }).click();
    const settings = editor.getByRole("group", { name: "Step settings" });
    // The wave it needs comes from the first input, and it is quiet.
    await expect(settings.getByLabel("y from")).toHaveValue("input");
    await settings.getByLabel("function value").selectOption("gauss");
    await settings.getByLabel("hold from").selectOption("fixed");
    await settings.getByLabel("hold value").fill('{"y0": 1}');
    await settings.getByLabel("bounds from").selectOption("fixed");
    await settings.getByLabel("bounds value").fill('{"width": [0.1, 3]}');

    await editor.getByLabel("Try y").selectOption("peakB");
    await editor.getByRole("button", { name: "Save and Try" }).click();
    await expect(editor.getByText(/Tried on one sample/)).toBeVisible({ timeout: 30_000 });
    const template = (await app.doc()).templates.HeldPeak!;
    expect(template.steps).toEqual([
      {
        id: "fit",
        action: "core.fit",
        version: 1,
        args: {
          function: "gauss",
          y: { $input: "y" },
          quiet: true,
          hold: { y0: 1 },
          bounds: { width: [0.1, 3] },
        },
      },
    ]);
    const results = Object.values((await app.doc()).results);
    const tried = results.at(-1)!;
    expect(tried.settings).toMatchObject({ y: "peakB", hold: { y0: 1 } });
    expect(tried.coef[0]).toBe(1);

    // A second step takes what the first returned.
    await editor.getByLabel("Action to add").selectOption("core.stats");
    await editor.getByRole("button", { name: "Add Step" }).click();
    await settings.getByLabel("wave from").selectOption("step");
    await expect(settings.getByLabel("wave step")).toHaveValue("fit");
    await settings.getByLabel("wave output").fill("residuals");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Analysis Templates" })).toBeVisible();
    expect((await app.doc()).templates.HeldPeak!.steps[1]!.args.wave).toEqual({
      $step: "fit",
      output: "residuals",
    });
    expect((await app.lastEntry()).code).toMatch(/^op\.set_template\("HeldPeak"/);
  });
});

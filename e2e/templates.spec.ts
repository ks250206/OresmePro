import { expect, test, type App } from "./fixtures";

/** The runs of the experiment: each sample's state, by run. */
function runStates(app: App) {
  return app.page.evaluate(() =>
    Object.fromEntries(
      Object.values(globalThis.oresme.doc.getState().runs).map((run) => [
        run.name,
        run.samples.map((sample) => sample.state),
      ]),
    ),
  );
}

test.describe("analysis templates", () => {
  test("a fit kept as a template is run on a folder of samples, and the failed ones retried", async ({
    app,
    page,
  }) => {
    // Six spectra in a folder, two of which no fit can be made of.
    await app.run(`xb = np.linspace(-5, 5, 101)
op.new_folder("batch")
for i in range(6):
    op.make(f"batch:s{i}", 1 + (2 + i / 4) * np.exp(-(((xb - 0.5) / 1.2) ** 2)), x0=-5, dx=0.1)
op.make("batch:s2", np.full(101, np.nan), x0=-5, dx=0.1)
op.make("batch:s4", np.full(101, np.nan), x0=-5, dx=0.1)
op.fit("gauss", op.wave("batch:s0"), quiet=True)`);

    // The fit, kept as a template from the Results dialog.
    await app.menu("Analysis", "Results…");
    const results = page.getByRole("dialog", { name: "Analysis Results" });
    await results.getByRole("region", { name: "Results" }).locator("tbody tr").nth(0).click();
    await results.getByRole("button", { name: "Make Template…" }).click();
    await results.getByLabel("Template name").fill("Peak");
    await results.getByRole("button", { name: "Make Template", exact: true }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.make_template("Peak", ["Fit0"])');

    const dialog = page.getByRole("dialog", { name: "Analysis Templates" });
    await expect(
      dialog.getByRole("listbox", { name: "Templates" }).getByRole("option", { name: "Peak" }),
    ).toHaveAttribute("aria-selected", "true");
    const steps = dialog.getByRole("list", { name: "Steps" });
    await expect(steps).toContainText("fit Curve Fit (core.fit, version 1)");
    await expect(steps).toContainText('function="gauss", y=$y, quiet=true');

    // A row for each wave of the folder.
    await expect(dialog.getByRole("status", { name: "Problem" })).toHaveText(
      "Give each input a wave in at least one row.",
    );
    await dialog.getByLabel("Folder").selectOption("batch");
    await dialog.getByRole("button", { name: "Add from Folder" }).click();
    await expect(dialog.getByLabel("y of sample 6")).toHaveValue("batch:s5");
    await dialog.getByRole("button", { name: "Run 6 Samples" }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe(
      'op.template("Peak").run(["batch:s0", "batch:s1", "batch:s2", "batch:s3", "batch:s4", "batch:s5"])',
    );
    await expect(dialog.getByRole("status", { name: "Run summary" })).toHaveText(
      "4 succeeded, 2 failed",
    );
    const samples = dialog.getByRole("region", { name: "Samples of the run" });
    await expect(samples.getByRole("row", { name: "Sample 3" })).toContainText("failed");
    await expect(samples.getByRole("row", { name: "Sample 3" })).toContainText(
      "No points are left to fit",
    );
    // The earlier fit of s0 is kept: this run's curve has a name of its own.
    await expect(samples.getByRole("row", { name: "Sample 1" })).toContainText("batch:fit_s0_1");
    expect(await runStates(app)).toEqual({
      Run0: ["succeeded", "succeeded", "failed", "succeeded", "failed", "succeeded"],
    });

    // The two are mended, and only they are done again.
    await app.run(`op.make("batch:s2", 1 + 2 * np.exp(-(((xb - 0.5) / 1.2) ** 2)), x0=-5, dx=0.1)
op.make("batch:s4", 1 + 3 * np.exp(-(((xb - 0.5) / 1.2) ** 2)), x0=-5, dx=0.1)`);
    await dialog.getByRole("button", { name: "Retry Failed" }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.run("Run0").retry()');
    await expect(dialog.getByRole("status", { name: "Run summary" })).toHaveText("6 succeeded");
    await expect(samples.getByRole("row", { name: "Sample 3" })).toContainText(
      "succeeded (2 tries)",
    );
    await expect(dialog.getByRole("button", { name: "Retry Failed" })).toBeDisabled();

    await dialog.getByRole("button", { name: "Make Table" }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.run("Run0").table()');
    expect((await app.doc()).tables.Run0!.columns).toContain("Run0_state");

    // Renaming the template is written as Python; the run keeps the name it was made with.
    await dialog.getByRole("button", { name: "Rename…" }).click();
    await dialog.getByLabel("New name").fill("Gauss");
    await dialog.getByLabel("New name").press("Enter");
    expect((await app.lastEntry()).code).toBe('op.template("Peak").rename("Gauss")');
    await expect(dialog.getByRole("combobox", { name: "Run", exact: true })).toContainText(
      "Run0: Peak, 6/6 succeeded",
    );
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await app.lastEntry()).code).toBe('op.template("Gauss").remove()');
    await expect(dialog.getByRole("region", { name: "Samples of the run" })).toBeVisible();
  });
});

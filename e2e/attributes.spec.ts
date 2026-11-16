import { expect, test } from "./fixtures";

test.describe("sample attributes", () => {
  test("typed in a table, shown with results, and plotted against", async ({ app, page }) => {
    await app.run(`sx = np.linspace(-4, 4, 81)
for i, height in enumerate([2.0, 3.0, 4.0], 1):
    op.new_folder(f"s{i}")
    op.make(f"s{i}:spectrum", 0.5 + height * np.exp(-sx**2), x0=-4, dx=0.1)
    op.fit("gauss", op.wave(f"s{i}:spectrum"), quiet=True)`);
    await app.menu("Data", "Sample Attributes…");
    const dialog = page.getByRole("dialog", { name: "Sample Attributes" });
    await expect(dialog.getByRole("row")).toHaveCount(4);
    await dialog.getByLabel("New attribute").fill("thickness");
    await dialog.getByRole("button", { name: "Add Column" }).click();
    for (const [index, value] of ["10", "20", "30"].entries()) {
      const cell = dialog.getByLabel(`thickness of s${index + 1}:`);
      await cell.fill(value);
      await cell.press("Enter");
    }
    expect((await app.lastEntry()).code).toBe('op.set_attributes("s3:", {"thickness": 30})');
    await dialog.getByLabel("thickness of s1:").fill("XPS");
    await dialog.getByLabel("thickness of s1:").press("Enter");
    expect((await app.run('print(op.folder("s1").attributes)')).output).toBe(
      "{'thickness': 'XPS'}\n",
    );
    await dialog.getByLabel("thickness of s1:").fill("10");
    await dialog.getByLabel("thickness of s1:").press("Enter");
    await dialog.getByRole("button", { name: "Close" }).click();

    // The wave shows its sample's attributes.
    await page.getByRole("option", { name: "s2:spectrum" }).click();
    await expect(page.getByRole("complementary", { name: "Data Browser" })).toContainText(
      "thickness",
    );

    await app.menu("Analysis", "Results…");
    const results = page.getByRole("dialog", { name: "Analysis Results" });
    await expect(results.getByRole("columnheader", { name: "thickness" })).toBeVisible();
    await results.getByRole("button", { name: "Plot…" }).click();
    await results.getByLabel("Plot parameter").selectOption("A");
    await expect(results.getByLabel("Plot against")).toHaveValue("thickness");
    await results.getByRole("button", { name: "Plot", exact: true }).click();
    expect((await app.lastEntry()).code).toBe('op.plot_results("A", "thickness")');
    expect(
      (
        await app.run(
          'print(op.wave("ResultsPlot_x").data.tolist(), np.round(op.wave("ResultsPlot_y").data, 3).tolist())',
        )
      ).output,
    ).toBe("[10.0, 20.0, 30.0] [2.0, 3.0, 4.0]\n");
  });
});

import { expect, test } from "./fixtures";

test.describe("formulas", () => {
  test("Set Wave Values previews a formula, sets it and keeps it up to date", async ({
    app,
    page,
  }) => {
    await app.run(
      'op.make("V", [2.0, 4.0, 6.0]); op.make("I", [1.0, 2.0, 0.0]); op.make("R", n=3); t = op.edit("V", "I", "R")',
    );
    const grid = page.getByRole("grid", { name: "Table0" });
    await grid.getByRole("columnheader", { name: "R" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set Wave Values…" }).click();
    const dialog = page.getByRole("dialog", { name: "Set Wave Values" });
    await expect(dialog.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue("R");
    const formula = dialog.getByRole("textbox", { name: "Formula" });
    await expect(formula).toBeFocused();

    // A mistake is shown with where it is, and nothing can be done with it.
    await page.keyboard.type("V / ");
    const preview = dialog.getByRole("region", { name: "Preview" });
    await expect(preview.getByRole("alert")).toContainText(
      "The formula ends where a value is expected",
    );
    await expect(preview.getByRole("alert")).toContainText("V / \n    ^");
    await expect(dialog.getByRole("button", { name: "Do It" })).toBeDisabled();
    await page.keyboard.type("I.x");
    await expect(preview.getByRole("alert")).toContainText('"." has no meaning in a formula');

    // A wave can be put in from the list.
    await formula.fill("V / ");
    await dialog.getByRole("combobox", { name: "Insert a wave" }).selectOption("I");
    await expect(formula).toHaveValue("V / I");
    await expect(preview).toContainText("3 points.");
    await expect(preview).toContainText("1 divided by zero");
    await expect(preview.getByRole("row").nth(1)).toContainText("2");
    await app.doIt();
    await expect(dialog).toBeHidden();
    expect((await app.wave("R"))!.data).toEqual([2, 2, NaN]);
    expect((await app.lastEntry()).code).toBe('op.set_formula("R", "V / I")');

    // An edit of an input recomputes R in the same undo step.
    await grid.getByRole("gridcell").nth(7).click();
    await page.keyboard.type("4");
    await page.keyboard.press("Enter");
    expect((await app.wave("R"))!.data).toEqual([2, 2, 1.5]);
    await page.getByRole("option", { name: "R" }).click();
    await expect(
      page.getByRole("listbox", { name: "Waves" }).getByRole("img", { name: "formula" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Undo/ }).click();
    await expect.poll(async () => (await app.wave("R"))!.data).toEqual([2, 2, NaN]);
  });

  test("a manual formula is marked out of date and recalculated from the Data Browser", async ({
    app,
    page,
  }) => {
    await app.run('op.make("A", [1.0, 2.0])');
    await app.menu("Data", "Set Wave Values…");
    const dialog = page.getByRole("dialog", { name: "Set Wave Values" });
    await dialog.getByRole("combobox", { name: "Wave", exact: true }).fill("B");
    await dialog.getByRole("textbox", { name: "Formula" }).fill("A * 10");
    await dialog.getByRole("checkbox", { name: /Automatically/ }).uncheck();
    await expect(dialog.getByText("A new wave")).toBeVisible();
    await app.doIt();
    expect((await app.wave("B"))!.data).toEqual([10, 20]);
    expect((await app.lastEntry()).code).toBe('op.set_formula("B", "A * 10", auto=False)');

    await app.run("op.wave('A')[0] = 5");
    const browser = page.getByRole("listbox", { name: "Waves" });
    await expect(browser.getByRole("img", { name: "formula out of date" })).toBeVisible();
    expect((await app.wave("B"))!.data).toEqual([10, 20]);
    await browser.getByRole("option", { name: "B" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Recalculate" }).click();
    expect((await app.wave("B"))!.data).toEqual([50, 20]);
    await expect(browser.getByRole("img", { name: "formula" })).toBeVisible();
    expect((await app.lastEntry()).code).toBe('op.recalculate(["B"])');

    // Deleting the input leaves B as it was, marked.
    await app.run('op.kill("A")');
    await expect(browser.getByRole("img", { name: "formula input missing" })).toBeVisible();
  });
});

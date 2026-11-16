import { expect, test } from "./fixtures";

test.describe("Python packages", () => {
  test("installed from the dialog, recorded, and installed again after a reload", async ({
    app,
    page,
  }) => {
    await app.menu("Python", "Packages…");
    const dialog = page.getByRole("dialog", { name: "Python Packages" });
    await expect(dialog).toContainText("uses no packages beyond those Python starts with");
    await expect(dialog.getByRole("link", { name: "Packages in Pyodide" })).toHaveAttribute(
      "href",
      "https://pyodide.org/en/stable/usage/packages-in-pyodide.html",
    );
    // Everything in Python, pre-installed too: NumPy is imported when Python starts.
    const inPython = dialog.getByRole("table", { name: "Packages in Python" });
    await expect(inPython.getByRole("row", { name: "In Python numpy" })).toContainText(
      /numpy\s*\d+\.\d+.*pre-installed\s*yes/,
    );
    await expect(dialog).toContainText(/Python 3\.\d+\.\d+ · Pyodide \d+/);
    await expect(inPython.getByRole("row", { name: "In Python scipy" })).toHaveCount(0);
    await dialog.getByLabel("Imported only").uncheck();
    await expect(inPython.getByRole("row", { name: "In Python ipython" })).toBeVisible();
    await dialog.getByLabel("Imported only").check();
    // One of the distribution's that the app serves itself, so no network is needed.
    await dialog.getByRole("button", { name: "Install uncertainties" }).click();
    await expect
      .poll(async () =>
        (await app.entries()).some((entry) => entry.code === "%pip install uncertainties"),
      )
      .toBe(true);
    await app.idle();
    await expect(dialog.getByRole("row", { name: "Package uncertainties" })).toContainText(
      "installed",
    );
    await expect(dialog.getByRole("button", { name: "Install uncertainties" })).toHaveText(
      "Installed",
    );

    expect(
      (await app.run("import uncertainties; print(uncertainties.ufloat(1, 0.1) * 2)")).output,
    ).toBe("2.00+/-0.20\n");
    await expect(dialog.getByRole("row", { name: "Package uncertainties" })).toContainText(
      "imported",
    );
    await expect(inPython.getByRole("row", { name: "In Python uncertainties" })).toContainText(
      "this experiment",
    );

    await expect(page.getByRole("group", { name: "Saving" })).toHaveText(/^Saved \d/);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await app.idle();
    // Put in again before anything else runs.
    expect((await app.entries()).some((entry) => entry.code === "await op.install()")).toBe(true);
    expect((await app.run("import uncertainties; print(uncertainties.__name__)")).output).toBe(
      "uncertainties\n",
    );

    await app.menu("Python", "Packages…");
    await page
      .getByRole("dialog", { name: "Python Packages" })
      .getByRole("button", { name: "Remove uncertainties" })
      .click();
    await expect.poll(async () => (await app.doc()).python?.packages.length).toBe(0);
  });
});

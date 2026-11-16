import { expect, test } from "./fixtures";

test.describe("closing, killing and renaming windows", () => {
  test.beforeEach(async ({ app }) => {
    await app.run(`y = op.make("y", [1.0, 3.0, 2.0])
g = op.display(y)
op.edit(y)`);
    await app.place("Graph0", 20, 16, 420, 280);
    await app.place("Table0", 470, 16, 300, 280);
  });

  test("the close button asks: Close keeps the graph to reopen, Kill removes it", async ({
    app,
    page,
  }) => {
    await page.getByRole("button", { name: "Close Graph0" }).click();
    const dialog = page.getByRole("dialog", { name: "Close Graph0" });
    await expect(dialog).toContainText("reopen it from Windows › Graphs");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    expect((await app.lastEntry()).code).toBe('op.close_window("Graph0")');
    await expect(app.window("Graph0")).toHaveCount(0);
    expect((await app.doc()).graphs.Graph0).toBeDefined();

    // The Windows menu lists windows by kind; a closed one reopens from there.
    await page.getByRole("menuitem", { name: "Windows", exact: true }).click();
    await page.getByRole("menuitem", { name: "Graphs (1)" }).hover();
    await page.getByRole("menuitem", { name: "Graph0 (closed)" }).click();
    expect((await app.lastEntry()).code).toBe('op.reopen_window("Graph0")');
    await expect(app.window("Graph0").locator("canvas")).toBeVisible();

    // Alt-click kills at once.
    await page.getByRole("button", { name: "Close Table0" }).click({ modifiers: ["Alt"] });
    expect((await app.lastEntry()).code).toBe('op.kill_window("Table0")');
    expect((await app.doc()).tables).toEqual({});

    await page.getByRole("button", { name: "Close Graph0" }).click();
    await page
      .getByRole("dialog", { name: "Close Graph0" })
      .getByRole("button", { name: "Kill" })
      .click();
    expect((await app.doc()).graphs).toEqual({});
    await page.keyboard.press("Control+z");
    expect((await app.doc()).graphs.Graph0).toBeDefined();
  });

  test("double-clicking the title renames the window", async ({ app, page }) => {
    await app.window("Graph0").getByText("Graph0: y").dblclick();
    const dialog = page.getByRole("dialog", { name: "Rename Graph0" });
    await dialog.getByLabel("New name").fill("Table0");
    await expect(dialog.getByText("A window named Table0 already exists.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();
    await dialog.getByLabel("New name").fill("Spectrum");
    await dialog.getByRole("button", { name: "Rename" }).click();
    expect((await app.lastEntry()).code).toBe('op.rename_window("Graph0", "Spectrum")');
    await expect(app.window("Spectrum").getByText("Spectrum: y")).toBeVisible();
    expect((await app.run("print(op.graph().name)")).output).toBe("Spectrum\n");
  });

  test("New Table takes a name", async ({ app, page }) => {
    await app.menu("Windows", "New Table…");
    const dialog = page.getByRole("dialog", { name: "New Table" });
    await expect(dialog.getByLabel("Table name")).toHaveAttribute("placeholder", "Table1");
    await dialog.getByLabel("Table name").fill("Raw");
    await dialog.getByRole("option", { name: "y" }).click();
    await app.doIt();
    expect((await app.lastEntry()).code).toContain('name="Raw"');
    await expect(app.window("Raw")).toBeVisible();
  });
});

test.describe("menus", () => {
  test("loading is in Data, Plugins in Python", async ({ app, page }) => {
    await page.getByRole("menuitem", { name: "File", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Add Files for Python…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Load Delimited Text…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("menuitem", { name: "Analysis", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Curve Fitting…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Plugins…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await app.menu("Python", "Plugins…");
    await expect(page.getByRole("dialog", { name: /Plugins/ })).toBeVisible();
  });
});

test.describe("procedures and experiments as files", () => {
  test("a procedure is exported as .py and imported without running", async ({ app, page }) => {
    await app.menu("Windows", "New Procedure…");
    const dialog = page.getByRole("dialog", { name: "New Procedure" });
    await dialog.getByLabel("Procedure name").fill("my tools");
    await expect(
      dialog.getByText(/only ASCII letters|starts with a letter|not a valid/),
    ).toBeVisible();
    await dialog.getByLabel("Procedure name").fill("tools");
    await app.doIt();
    await app.run('op.procedure("tools").code = "ran = True\\n"');

    await app.window("tools").getByRole("textbox", { name: "tools.py" }).click({ button: "right" });
    const exported = await app.download(() =>
      page.getByRole("menuitem", { name: "Export as tools.py" }).click(),
    );
    expect(exported.file.suggestedFilename()).toBe("tools.py");
    expect(exported.bytes.toString()).toBe("ran = True\n");

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      app.menu("Windows", "Import Procedure…"),
    ]);
    await chooser.setFiles({
      name: "tools.py",
      mimeType: "text/x-python",
      buffer: Buffer.from("imported = 1\n"),
    });
    await expect
      .poll(async () => (await app.doc()).procedures.tools_0?.code)
      .toBe("imported = 1\n");
    expect((await app.doc()).procedures.tools_0!.autoRun).toBe(false);
    expect((await app.run("print('imported' in globals())")).output).toBe("False\n");
  });

  test("Save Experiment As saves under the name typed", async ({ app }) => {
    await app.run('op.make("kept", [1, 2])');
    const saved = await app.saveExperiment("run 2");
    expect(saved.file.suggestedFilename()).toBe("run 2.oresme");
    expect(saved.bytes.subarray(0, 2).toString()).toBe("PK");
  });
});

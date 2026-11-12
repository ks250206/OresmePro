import { expect, test } from "./fixtures";

test.describe("tables", () => {
  test("cells are edited in place and each edit is echoed", async ({ app, page }) => {
    await app.run(
      'op.make("noise", [0.5, 1.5, 2.5]); op.make("labels", ["a", "b"]); t = op.edit("noise", "labels")',
    );
    const cells = page.getByRole("grid", { name: "Table0" }).getByRole("gridcell");
    // Third row of the first column.
    await cells.nth(4).click();
    await page.keyboard.type("42.5");
    await page.keyboard.press("Enter");
    expect((await app.wave("noise"))!.data).toEqual([0.5, 1.5, 42.5]);
    expect((await app.lastEntry()).code).toBe('op.wave("noise")[2] = 42.5');
    // Enter moved down to the free row: typing there appends a point.
    await page.keyboard.type("7");
    await page.keyboard.press("Enter");
    expect((await app.wave("noise"))!.data).toEqual([0.5, 1.5, 42.5, 7]);

    await cells.nth(1).dblclick();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("gamma");
    await page.keyboard.press("Enter");
    expect((await app.wave("labels"))!.text).toEqual(["gamma", "b"]);
    expect((await app.lastEntry()).code).toBe('op.wave("labels")[0] = "gamma"');
  });

  test("a block pasted into a matrix keeps every cell", async ({ app, page }) => {
    await app.run('m = op.make("m", np.zeros((2, 2))); t = op.edit(m)');
    await page.getByRole("grid", { name: "Table0" }).getByRole("gridcell").first().click();
    await app.paste("1\t2\n3\t4\n");
    expect((await app.wave("m"))!.data).toEqual([1, 2, 3, 4]);
    expect((await app.lastEntry()).code).toBe('op.wave("m").flat[0:4] = [1, 2, 3, 4]');
  });

  test("a 3-D wave is shown and edited one layer at a time", async ({ app, page }) => {
    await app.run('c = op.make("c", np.arange(8.0).reshape(2, 2, 2)); t = op.edit(c)');
    const first = page.getByRole("grid", { name: "Table0" }).getByRole("gridcell").first();
    await expect(first).toHaveText("0");
    await app.window("Table0").getByLabel("Layer").fill("1");
    await expect(first).toHaveText("1");
    await first.click();
    await page.keyboard.type("9");
    await page.keyboard.press("Enter");
    expect((await app.wave("c"))!.data).toEqual([0, 9, 2, 3, 4, 5, 6, 7]);
    expect((await app.lastEntry()).code).toBe('op.wave("c")[0, 0, 1] = 9');
  });

  test("a range of cells is selected, copied and cleared", async ({ app, page }) => {
    await app.run(
      'op.make("a", [1, 2, 3, 4]); op.make("b", [0.1, 0.2, 0.3, 0.4]); t = op.edit("a", "b")',
    );
    const grid = page.getByRole("grid", { name: "Table0" });
    const cells = grid.getByRole("gridcell");
    // From row 1 of "a" to row 2 of "b".
    await cells.nth(2).click();
    await cells.nth(5).click({ modifiers: ["Shift"] });
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(4);
    expect(await app.copy()).toBe("2\t0.2\n3\t0.3");

    // Shift+arrows move the far corner of the selection.
    await page.keyboard.press("Shift+ArrowDown");
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(6);
    await page.keyboard.press("Shift+ArrowUp");

    await page.keyboard.press("Delete");
    expect((await app.wave("a"))!.data).toEqual([1, NaN, NaN, 4]);
    expect((await app.wave("b"))!.data).toEqual([0.1, NaN, NaN, 0.4]);
    expect((await app.lastEntry()).code).toBe(
      'op.wave("a")[1:3] = float("nan")\nop.wave("b")[1:3] = float("nan")',
    );
    // One undo step for the whole range.
    await page.keyboard.press("Control+z");
    expect((await app.wave("b"))!.data).toEqual([0.1, 0.2, 0.3, 0.4]);

    // Dragging selects too, and a cut copies and clears.
    await cells.nth(0).hover();
    await page.mouse.down();
    await cells.nth(3).hover();
    await page.mouse.up();
    await expect(grid.locator('[aria-selected="true"]')).toHaveCount(4);
    expect(await app.copy("cut")).toBe("1\t0.1\n2\t0.2");
    expect((await app.wave("a"))!.data).toEqual([NaN, NaN, 3, 4]);

    // A paste lands at the top-left corner of the selection.
    await cells.nth(4).click();
    await cells.nth(7).click({ modifiers: ["Shift"] });
    await app.paste("7\t8\n9\t10");
    expect((await app.wave("a"))!.data).toEqual([NaN, NaN, 7, 9]);
    expect((await app.wave("b"))!.data).toEqual([NaN, NaN, 8, 10]);
  });

  test("text cells copied from a table paste back unchanged", async ({ app, page }) => {
    await app.run(
      'op.make("labels", ["Li,Mg", "a\\tb", "say \\"hi\\""]); op.make("other", ["x", "y", "z"]); t = op.edit("labels", "other")',
    );
    const cells = page.getByRole("grid", { name: "Table0" }).getByRole("gridcell");
    // A single cell with a comma: nothing on the clipboard says the comma is not a separator.
    await cells.nth(0).click();
    expect(await app.copy()).toBe("Li,Mg");
    await cells.nth(1).click();
    await app.paste("Li,Mg");
    expect((await app.wave("other"))!.text).toEqual(["Li,Mg", "y", "z"]);

    // A tab in a cell is quoted, as spreadsheets do.
    await cells.nth(2).click();
    await cells.nth(4).click({ modifiers: ["Shift"] });
    expect(await app.copy()).toBe('"a\tb"\nsay "hi"');
    await cells.nth(3).click();
    await app.paste('"a\tb"\r\nsay "hi"\r\n');
    expect((await app.wave("other"))!.text).toEqual(["Li,Mg", "a\tb", 'say "hi"']);

    // Text with commas from elsewhere stays in one cell.
    await cells.nth(1).click();
    await app.paste("Mg,Ca");
    expect((await app.wave("other"))!.text).toEqual(["Mg,Ca", "a\tb", 'say "hi"']);
  });

  test("rows and columns are selected by their headers and points deleted", async ({
    app,
    page,
  }) => {
    await app.run(
      'op.make("a", [1, 2, 3, 4, 5]); op.make("b", [10, 20, 30]); t = op.edit("a", "b")',
    );
    const grid = page.getByRole("grid", { name: "Table0" });
    await grid.getByRole("columnheader", { name: "b" }).click();
    expect(await app.copy()).toBe("10\n20\n30");

    const rows = grid.getByRole("rowheader");
    await rows.nth(1).click();
    await rows.nth(2).click({ modifiers: ["Shift"] });
    expect(await app.copy()).toBe("2\t20\n3\t30");
    await grid.getByRole("gridcell").nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete 2 Points" }).click();
    expect((await app.wave("a"))!.data).toEqual([1, 4, 5]);
    expect((await app.wave("b"))!.data).toEqual([10]);
    expect((await app.lastEntry()).code).toBe(
      'op.wave("a").delete_points(1, 2)\nop.wave("b").delete_points(1, 2)',
    );

    await grid.getByRole("gridcell").nth(0).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Insert Point" }).click();
    expect((await app.wave("a"))!.data).toEqual([NaN, 1, 4, 5]);

    await page.keyboard.press("Control+a");
    expect(await app.copy()).toBe("NaN\t10\n1\t\n4\t\n5\t");
  });

  test("a matrix with thousands of columns scrolls sideways", async ({ app, page }) => {
    await app.run('wide = op.make("wide", np.arange(8000.0).reshape(4, 2000)); t = op.edit(wide)');
    await app.place("Table0", 20, 20, 700, 300);
    const grid = page.getByRole("grid", { name: "Table0" });
    await expect(grid.getByRole("columnheader", { name: "wide[][0]" })).toBeVisible();
    // Only the columns in view exist.
    expect(await grid.getByRole("columnheader").count()).toBeLessThan(40);

    await grid.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
    await expect(grid.getByRole("columnheader", { name: "wide[][1999]" })).toBeVisible();
    await grid.getByRole("gridcell", { name: "7999" }).click();
    await page.keyboard.type("-1");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => globalThis.oresme.doc.getState().waves.wide!.data[7999]))
      .toBe(-1);
    expect((await app.lastEntry()).code).toBe('op.wave("wide")[3, 1999] = -1');
  });

  test("the active cell stays in view when moved with the keyboard", async ({ app, page }) => {
    await app.run('big = op.make("big", np.arange(6000.0).reshape(200, 30)); t = op.edit(big)');
    await app.place("Table0", 20, 20, 500, 300);
    const grid = page.getByRole("grid", { name: "Table0" });
    await grid.getByRole("gridcell").first().click();
    /** Whether the cell showing `text` is clear of the header, the point column and the edges. */
    const inView = async (text: string) => {
      const cell = (await grid.getByRole("gridcell", { name: text, exact: true }).boundingBox())!;
      const frame = (await grid.boundingBox())!;
      const corner = (await grid.getByRole("columnheader", { name: "Point" }).boundingBox())!;
      return (
        cell.y >= corner.y + corner.height - 1 &&
        cell.x >= corner.x + corner.width - 1 &&
        cell.y + cell.height <= frame.y + frame.height + 1 &&
        cell.x + cell.width <= frame.x + frame.width + 1
      );
    };
    for (let step = 0; step < 40; step += 1) await page.keyboard.press("ArrowDown");
    for (let step = 0; step < 12; step += 1) await page.keyboard.press("ArrowRight");
    // Row 40, column 12.
    await expect(app.window("Table0").getByLabel("Cell value")).toHaveText("1212");
    await expect.poll(() => inView("1212")).toBe(true);
    for (let step = 0; step < 30; step += 1) await page.keyboard.press("ArrowUp");
    for (let step = 0; step < 11; step += 1) await page.keyboard.press("ArrowLeft");
    await expect(app.window("Table0").getByLabel("Cell value")).toHaveText("301");
    await expect.poll(() => inView("301")).toBe(true);
  });

  test("digits and column widths belong to the table", async ({ app, page }) => {
    await app.run('op.make("pi", [np.pi, 2 * np.pi]); t = op.edit("pi")');
    const table = app.window("Table0");
    const grid = page.getByRole("grid", { name: "Table0" });
    const first = grid.getByRole("gridcell").first();
    await expect(first).toHaveText("3.1415927");
    await first.click();
    // The entry line always shows the whole number.
    await expect(table.getByLabel("Cell value")).toHaveText("3.141592653589793");

    await table.getByLabel("Digits").selectOption("4");
    await expect(first).toHaveText("3.142");
    expect((await app.lastEntry()).code).toBe('op.table("Table0").set(digits=4)');
    // Opening a cell and leaving it does not round the stored value.
    await first.dblclick();
    await page.keyboard.press("Enter");
    expect((await app.wave("pi"))!.data[0]).toBe(Math.PI);

    const header = grid.getByRole("columnheader", { name: "pi" });
    const box = (await header.boundingBox())!;
    await page.mouse.move(box.x + box.width, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await app.doc()).tables.Table0!.widths.pi).toBe(156);
    expect(Math.round((await header.boundingBox())!.width)).toBe(156);
    // Widths are view state: they are not written to the history.
    expect((await app.lastEntry()).code).toBe('op.table("Table0").set(digits=4)');
  });
});

test.describe("data browser", () => {
  test("a wave is dragged into a new data folder", async ({ app, page }) => {
    await app.run('op.make("labels", ["a", "b"]); t = op.edit("labels")');
    await app.menu("Data", "New Data Folder…");
    await page.getByLabel("Name", { exact: true }).fill("raw");
    await app.doIt();
    expect((await app.doc()).folders).toEqual(["raw"]);

    await page
      .getByRole("option", { name: "labels", exact: true })
      .dragTo(page.getByRole("treeitem").filter({ hasText: "raw" }));
    const doc = await app.doc();
    expect(doc.order).toEqual(["raw:labels"]);
    // The table follows the wave to its new place.
    expect(doc.tables.Table0!.columns).toEqual(["raw:labels"]);
    expect((await app.lastEntry()).code).toBe('op.wave("labels").rename("raw:labels")');
  });
});

test.describe("loading delimited text", () => {
  test("files dropped together get separate waves", async ({ app }) => {
    await app.drop([
      { name: "a.csv", content: "x,y\n1,10\n2,10\n" },
      { name: "b.csv", content: "x,y\n1,20\n2,20\n" },
    ]);
    await expect.poll(async () => (await app.doc()).order).toEqual(["x", "y", "x_1", "y_1"]);
    expect((await app.wave("y"))!.data).toEqual([10, 10]);
    expect((await app.wave("y_1"))!.data).toEqual([20, 20]);
  });

  test("quoted fields, text columns and dates are understood", async ({ app, page }) => {
    await app.drop([
      {
        name: "log.csv",
        content:
          'when,reading,site\n2026-11-11 09:00,1.5,"north, upper"\n2026-11-11 09:30,2.5,"south"\n',
      },
    ]);
    await expect.poll(async () => (await app.doc()).order).toEqual(["when", "reading", "site"]);
    const when = (await app.wave("when"))!;
    expect(when.unit).toBe("dat");
    expect(when.data[1]! - when.data[0]!).toBe(1800);
    expect((await app.wave("site"))!.text).toEqual(["north, upper", "south"]);
    // The table that opens shows the dates as dates.
    const first = page.getByRole("grid", { name: "Table0" }).getByRole("gridcell").first();
    await expect(first).toHaveText("2026-11-11 09:00:00");
    await first.dblclick();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("2026-11-11 08:45");
    await page.keyboard.press("Enter");
    const edited = (await app.wave("when"))!;
    expect(edited.data[1]! - edited.data[0]!).toBe(2700);
  });

  test("a file with 200,000 rows loads", async ({ app }) => {
    const rows = 200_000;
    const content = `v\n${Array.from({ length: rows }, (_, index) => index).join("\n")}\n`;
    await app.drop([{ name: "big.csv", content }]);
    await expect.poll(async () => (await app.wave("v"))?.length, { timeout: 20_000 }).toBe(rows);
  });
});

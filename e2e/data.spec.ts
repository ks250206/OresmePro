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
    expect((await app.lastEntry()).code).toBe('op.wave("m")[0:4] = [1, 2, 3, 4]');
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

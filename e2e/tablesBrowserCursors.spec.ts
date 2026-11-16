import { expect, test } from "./fixtures";

test.describe("tables, the data browser and cursors", () => {
  test("the Table menu appends columns to the frontmost table and removes them", async ({
    app,
    page,
  }) => {
    await app.run(`op.make("a", [1.0, 2])
op.make("b", [3.0, 4])
op.make("c", [5.0, 6])
op.edit("a", name="T")`);
    await app.menu("Table", "Append Columns to Table…");
    const append = page.getByRole("dialog", { name: "Append Columns to T" });
    // Only waves that are not columns yet are offered.
    await expect(append.getByRole("option", { name: "a", exact: true })).toHaveCount(0);
    await append.getByRole("option", { name: "b", exact: true }).click();
    await append.getByRole("option", { name: "c", exact: true }).click({ modifiers: ["Shift"] });
    await append.getByRole("button", { name: "Append" }).click();
    expect((await app.doc()).tables.T!.columns).toEqual(["a", "b", "c"]);
    expect((await app.lastEntry()).code).toBe('op.table("T").append("b", "c")');

    await app.menu("Table", "Remove Columns from Table…");
    const remove = page.getByRole("dialog", { name: "Remove Columns from T" });
    await remove.getByRole("option", { name: "a", exact: true }).click();
    await remove.getByRole("button", { name: "Remove" }).click();
    expect((await app.doc()).tables.T!.columns).toEqual(["b", "c"]);
    // The wave stays.
    expect(await app.wave("a")).not.toBeNull();
  });

  test("the data browser appends waves to a table and copies their full paths", async ({
    app,
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await app.run(`op.new_folder("run1")
op.make("run1:signal", [1.0, 2])
op.make("x", [0.0, 1])
op.edit("x", name="T")`);
    const row = page.getByRole("option").filter({ hasText: "signal" });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Append to Table" }).hover();
    await page.getByRole("menuitem", { name: "T", exact: true }).click();
    expect((await app.doc()).tables.T!.columns).toEqual(["x", "run1:signal"]);

    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy Full Path" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("root:run1:signal");
    await page.getByRole("treeitem").filter({ hasText: "run1" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy Full Path" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("root:run1:");
  });

  test("a cursor is put on another wave from its readout, and on a point typed there", async ({
    app,
    page,
  }) => {
    await app.run(`op.make("one", [0.0, 1, 2, 3, 4])
op.make("two", [10.0, 11, 12])
g = op.display("one")
g.append("two")
g.cursor("A", "one", 1)
g.show_info = True`);
    const info = page.getByRole("status", { name: "Cursor info" });
    await info.getByLabel("Cursor A point").fill("3");
    await info.getByLabel("Cursor A point").press("Enter");
    expect((await app.doc()).graphs.Graph0!.cursors.A).toEqual({ trace: "one", point: 3 });

    // Right-click the wave name: the traces, and the cursor keeps its point where it can.
    await info.getByLabel("Cursor A wave").click({ button: "right" });
    await page.getByRole("menuitem", { name: "two", exact: true }).click();
    expect((await app.doc()).graphs.Graph0!.cursors.A).toEqual({ trace: "two", point: 2 });
    await expect(info.getByLabel("Cursor A point")).toHaveValue("2");

    // A point past the end goes to the last one; one that is not a number is left alone.
    await info.getByLabel("Cursor A point").fill("99");
    await info.getByLabel("Cursor A point").press("Enter");
    expect((await app.doc()).graphs.Graph0!.cursors.A!.point).toBe(2);
    await info.getByLabel("Cursor A point").fill("abc");
    await info.getByLabel("Cursor A point").press("Enter");
    expect((await app.doc()).graphs.Graph0!.cursors.A!.point).toBe(2);

    // B is placed from its readout too.
    await info.getByLabel("Cursor B wave").click();
    await page.getByRole("menuitem", { name: "one", exact: true }).click();
    expect((await app.doc()).graphs.Graph0!.cursors.B).toEqual({ trace: "one", point: 0 });
  });
});

import { expect, test } from "./fixtures";

test.describe("the Procedure Browser", () => {
  test("lists procedures and what they define, opens them at a line, and exports and runs them", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        "code = '''def area(r, *, pi=3.14):",
        "    def square(x):",
        "        return x * x",
        "    return pi * square(r)",
        "",
        "class Fit:",
        "    def run(self, n=2):",
        "        return n",
        "'''",
        'op.new_procedure("tools", code)',
        'op.new_procedure("other", "VALUE = 7\\n", auto_run=False)',
        'op.close_window("tools")',
      ].join("\n"),
    );
    await app.menu("Python", "Procedure Browser");
    const browser = page.getByRole("dialog", { name: "Procedure Browser" });
    const tree = browser.getByRole("tree", { name: "Procedures" });
    await expect(tree.getByRole("treeitem", { name: "other.py" })).toContainText(
      "not run at opening",
    );
    await expect(tree.getByRole("treeitem", { name: "tools.py" })).toContainText("(closed)");
    await expect(tree.getByRole("treeitem", { name: "area in tools" })).toContainText(
      "area(r, *, pi=3.14)",
    );
    await expect(tree.getByRole("treeitem", { name: "run in tools" })).toContainText(
      "run(self, n=2)",
    );
    // Without signatures, the names alone.
    await browser.getByLabel("Signatures").uncheck();
    await expect(tree.getByRole("treeitem", { name: "area in tools" })).toHaveText("ƒarea");

    // A definition opens its procedure, reopening it, with the cursor on its line.
    await tree.getByRole("treeitem", { name: "square in tools" }).click();
    const editor = app.window("tools");
    await expect(editor).toBeVisible();
    await expect(editor.locator(".cm-activeLine")).toHaveText("    def square(x):");

    // Export and Run act on the procedure selected.
    await tree.getByRole("treeitem", { name: "other.py" }).click();
    const { file, bytes } = await app.download(() =>
      browser.getByRole("button", { name: "Export" }).click(),
    );
    expect(file.suggestedFilename()).toBe("other.py");
    expect(bytes.toString("utf8")).toBe("VALUE = 7\n");
    await browser.getByRole("button", { name: "Run", exact: true }).click();
    await app.idle();
    expect((await app.run("print(VALUE)")).output).toBe("7\n");
  });
});

test.describe("the Variables window", () => {
  test("lists the user's variables after each input and drops them", async ({ app, page }) => {
    await app.run(`ra = np.zeros((2, 3))
rb = "hello"
rc = [1, 2, 3]`);
    await app.menu("Python", "Variables");
    const window = page.getByRole("dialog", { name: "Variables" });
    const table = window.getByRole("table", { name: "Variables" });
    await expect(table.getByRole("row", { name: /ra ndarray 2×3 float64/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /rb str 'hello'/ })).toBeVisible();
    // np and op are Python's, not the user's: never listed, so never dropped.
    await expect(table.getByRole("row", { name: /^np / })).toHaveCount(0);

    await window.getByLabel("Pick ra").check();
    await window.getByLabel("Pick rb").check();
    await window.getByRole("button", { name: "Drop 2" }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe("del ra, rb");
    await expect(table.getByRole("row", { name: /^ra / })).toHaveCount(0);
    await expect(table.getByRole("row", { name: /rc list/ })).toBeVisible();

    // A new variable appears after the input that makes it; Drop All asks first.
    await app.run("rd = 4.5");
    await expect(table.getByRole("row", { name: /rd float 4.5/ })).toBeVisible();
    await window.getByRole("button", { name: "Drop All…" }).click();
    await window.getByRole("button", { name: /^Drop All \d+$/ }).click();
    await app.idle();
    await expect(window.getByText("No variables yet")).toBeVisible();
    expect((await app.run("print(np.pi > 3, op.waves() == [])")).output).toBe("True True\n");
  });
});

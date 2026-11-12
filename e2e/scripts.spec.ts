import { stripAnsi } from "../src/core/history/ansi";
import { type App, expect, test } from "./fixtures";

test.describe("procedure windows", () => {
  test("a procedure is typed, run, and there again after a reload", async ({ app, page }) => {
    await app.menu("Windows", "New Procedure");
    expect((await app.lastEntry()).code).toBe("op.new_procedure()");
    const editor = app.window("Procedure").getByRole("textbox", { name: "Procedure.py" });
    await editor.click();
    await page.keyboard.type("def area(r):\nreturn 3 * r * r\n");
    // The editor indented the body; Backspace goes back to the margin.
    await page.keyboard.press("Backspace");
    await page.keyboard.type("LOADED = 'yes'");
    expect((await app.doc()).procedures.Procedure!.code).toBe(
      "def area(r):\n    return 3 * r * r\nLOADED = 'yes'",
    );

    await page.keyboard.press("Control+Enter");
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.procedure("Procedure").run()');
    expect((await app.run("print(area(2), LOADED)")).output).toBe("12 yes\n");

    // Shift+Enter runs just the line the cursor is on.
    await page.keyboard.press("Enter");
    await page.keyboard.type("print('one line')");
    await page.keyboard.press("Shift+Enter");
    await app.idle();
    expect(await app.lastEntry()).toMatchObject({
      code: "print('one line')",
      output: "one line\n",
    });

    // Other code can import it, and sees edits made since.
    expect((await app.run("import Procedure; print(Procedure.area(1))")).output).toBe(
      "one line\n3\n",
    );

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await app.idle();
    // It ran by itself when Python started: what it defines is there.
    await expect(
      app.window("Procedure").getByRole("textbox", { name: "Procedure.py" }),
    ).toContainText("def area(r):");
    expect((await app.run("print(area(1), LOADED)")).output).toBe("3 yes\n");
    const entries = await app.entries();
    expect(entries.filter((entry) => entry.code.includes(".run()")).at(-1)).toMatchObject({
      source: "gui",
      status: "ok",
    });
  });

  test("an error in a procedure names the file and the line", async ({ app, page }) => {
    await app.run(
      'p = op.new_procedure("Fits", "import math\\n\\ndef bad():\\n    return math.nope\\n\\nbad()\\n")',
    );
    await expect(app.window("Fits").getByRole("textbox", { name: "Fits.py" })).toContainText(
      "return math.nope",
    );
    await app.window("Fits").getByRole("button", { name: "Run" }).click();
    await app.idle();
    const entry = await app.lastEntry();
    expect(entry.status).toBe("error");
    // Without the colors the traceback is written in.
    const plain = stripAnsi(entry.output);
    expect(plain).toContain("File /experiment/Fits.py:4, in bad()");
    expect(plain).toContain("return math.nope");
    expect(plain).toContain("AttributeError: module 'math' has no attribute 'nope'");

    // Not run at start-up when the box is cleared.
    await app.window("Fits").getByLabel("Run when the experiment opens").uncheck();
    expect((await app.doc()).procedures.Fits!.autoRun).toBe(false);
    const before = (await app.entries()).length;
    await app.menu("Python", "Restart Python");
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await app.idle();
    const after = await app.entries();
    expect(after.slice(before).filter((item) => item.code.includes(".run()"))).toEqual([]);

    // Closing the window can be undone, text and all.
    await page.getByRole("button", { name: "Close Fits" }).click();
    expect((await app.doc()).procedures).toEqual({});
    await page.keyboard.press("Control+z");
    expect((await app.doc()).procedures.Fits!.code).toContain("def bad()");
  });
});

test.describe("the procedure editor", () => {
  /** A procedure holding `code`, its editor focused at the end of the text. */
  async function procedure(app: App, code: string) {
    await app.run(`p = op.new_procedure("Edit", ${JSON.stringify(code)})`);
    await app.place("Edit", 20, 20, 600, 380);
    const editor = app.window("Edit").getByRole("textbox", { name: "Edit.py" });
    await editor.click();
    await app.page.keyboard.press("Control+End");
    return editor;
  }
  const code = async (app: App) => (await app.doc()).procedures.Edit!.code;
  const status = (app: App) => app.window("Edit").locator("[data-editor-status]");

  test("right-clicking gives the app's menu, which acts on the selection", async ({
    app,
    page,
  }) => {
    await procedure(app, "a = 1\nb = 2\n");
    await page.evaluate(() => {
      window.addEventListener("contextmenu", (event) => {
        Object.assign(globalThis, { browserMenuShown: !event.defaultPrevented });
      });
    });
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "b = 2" }).click({
      button: "right",
    });
    expect(
      await page.evaluate(() => (globalThis as { browserMenuShown?: boolean }).browserMenuShown),
    ).toBe(false);
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: /Run When the Experiment Opens$/ }),
    ).toBeVisible();
    // Nothing is selected and nothing has been typed.
    await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: /^Undo/ })).toBeDisabled();
    await menu.getByRole("menuitem", { name: /^Select All/ }).click();
    await expect(menu).toBeHidden();

    await page.locator('[data-window="Edit"] .cm-line', { hasText: "a = 1" }).click({
      button: "right",
    });
    await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeEnabled();
    await menu.getByRole("menuitem", { name: /^Comment\/Uncomment Lines/ }).click();
    expect(await code(app)).toBe("# a = 1\n# b = 2\n");

    // Undo in the editor undoes the edit, not something in the document.
    await page.keyboard.press("Control+z");
    expect(await code(app)).toBe("a = 1\nb = 2\n");
    expect((await app.doc()).windows.map((window) => window.name)).toEqual(["Edit"]);
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "a = 1" }).click({
      button: "right",
    });
    await menu.getByRole("menuitem", { name: /^Redo/ }).click();
    expect(await code(app)).toBe("# a = 1\n# b = 2\n");

    // The command line has a menu of its own.
    await app.commandLine.click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: /^Search History/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Run Procedure/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("Ruff marks undefined names, but not np and op", async ({ app, page }) => {
    await procedure(app, "x = np.linspace(0, 1, 5)\nop.make('w', x * scale)\n");
    const marks = app.window("Edit").locator(".cm-lintRange-warning");
    await expect(marks).toHaveText(["scale"], { timeout: 30_000 });
    await expect(status(app)).toContainText("1 problem");
    await expect(app.window("Edit").locator(".cm-lint-marker-warning")).toHaveCount(1);

    // The problems are listed, and one defined elsewhere can be said to be.
    await status(app).getByRole("button", { name: "1 problem" }).click();
    const panel = app.window("Edit").locator(".cm-panel-lint");
    await expect(panel).toContainText("Undefined name `scale`");
    await panel.getByRole("button", { name: "Defined elsewhere" }).click();
    await expect
      .poll(() => code(app))
      .toBe("# defined elsewhere: scale\nx = np.linspace(0, 1, 5)\nop.make('w', x * scale)\n");
    await expect(status(app)).toContainText("0 problems");
    await expect(marks).toHaveCount(0);

    // A syntax error is an error.
    await app.window("Edit").getByRole("textbox", { name: "Edit.py" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("def broken(:");
    await expect(app.window("Edit").locator(".cm-lint-marker-error")).toHaveCount(1);
  });

  test("Format Document formats the text, as one step that Ctrl+Z takes back", async ({
    app,
    page,
  }) => {
    const messy = "x=[1,2 ,3]\ndef  area( r ):\n  return 3*r*r\n";
    await procedure(app, messy);
    await page.keyboard.press("Shift+Alt+F");
    const formatted = "x = [1, 2, 3]\n\n\ndef area(r):\n    return 3 * r * r\n";
    await expect.poll(() => code(app), { timeout: 30_000 }).toBe(formatted);
    await expect(app.window("Edit").getByRole("textbox")).toContainText("def area(r):");
    await page.keyboard.press("Control+z");
    expect(await code(app)).toBe(messy);
    await page.keyboard.press("Control+Shift+z");
    expect(await code(app)).toBe(formatted);

    // From the menu; a syntax error is reported and the text left alone.
    await page.keyboard.type("y = 1 +");
    const broken = await code(app);
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "def area" }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: /^Format Document/ }).click();
    await expect(status(app)).toContainText("Not formatted. Syntax error on line");
    expect(await code(app)).toBe(broken);
  });

  test("Run Selection runs the selected line, which goes into the history", async ({
    app,
    page,
  }) => {
    await procedure(app, "x = 21\n    print(x * 2)\nprint('not this')\n");
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "x = 21" }).click();
    await page.keyboard.press("Shift+Enter");
    await app.idle();
    expect((await app.lastEntry()).code).toBe("x = 21");

    // A line selected from the keyboard, run from the menu, without its indentation.
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "print(x * 2)" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "print(x * 2)" }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: /^Run Selection/ }).click();
    await app.idle();
    expect(await app.lastEntry()).toMatchObject({
      code: "print(x * 2)",
      output: "42\n",
      source: "user",
    });
    await expect(app.window("Edit").locator("[data-editor-status]")).toContainText("Not run yet");

    // Run Procedure, from the menu, and the status line follows edits after it.
    await page.locator('[data-window="Edit"] .cm-line', { hasText: "x = 21" }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: /^Run Procedure/ }).click();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.procedure("Edit").run()');
    await expect(status(app)).toContainText("Unchanged since run");
    await page.keyboard.type("#");
    await expect(status(app)).toContainText("Edited since run");
  });

  test("find and replace, and go to line", async ({ app, page }) => {
    await procedure(app, "old = 1\nprint(old)\nOLD_NAME = 2\n");
    await page.keyboard.press("Control+f");
    const panel = app.window("Edit").locator(".cm-search");
    await panel.getByRole("textbox", { name: "Find" }).fill("old");
    await panel.getByRole("textbox", { name: "Replace" }).fill("new");
    await panel.getByRole("button", { name: "Replace All" }).click();
    // Matching case is off by default; with it on, OLD_NAME is not touched.
    expect(await code(app)).toBe("new = 1\nprint(new)\nnew_NAME = 2\n");
    await page.keyboard.press("Control+z");
    await panel.getByLabel("Match case").check();
    await panel.getByRole("button", { name: "Replace All" }).click();
    expect(await code(app)).toBe("new = 1\nprint(new)\nOLD_NAME = 2\n");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await page.keyboard.press("Control+g");
    await app.window("Edit").locator('.cm-panel [name="line"]').fill("3");
    await page.keyboard.press("Enter");
    await expect(status(app)).toContainText("Ln 3, Col 1");
  });

  test("a procedure made again under the same name has a new editor", async ({ app, page }) => {
    const editor = await procedure(app, "first = 1\n");
    await page.keyboard.type("x = 2");
    await app.run('op.kill_window("Edit")');
    await app.run('p = op.new_procedure("Edit", "second = 1\\n")');
    await expect(editor).toContainText("second = 1");
    await editor.click();
    await page.keyboard.press("Control+z");
    // Nothing of the old editor's history: there is nothing to undo.
    expect(await code(app)).toBe("second = 1\n");
  });
});

test.describe("opening an experiment with procedures", () => {
  test("asks before running them, and opens without running if refused", async ({ app, page }) => {
    await app.run('p = op.new_procedure(code="FROM_FILE = 42\\n")');
    const saved = await app.download(() => page.keyboard.press("Control+s"));

    const open = async (answer: "accept" | "dismiss") => {
      const messages: string[] = [];
      const onDialog = (dialog: import("@playwright/test").Dialog) => {
        messages.push(dialog.message());
        // The first question is about replacing the experiment; the second about the procedures.
        void (messages.length === 1 || answer === "accept" ? dialog.accept() : dialog.dismiss());
      };
      page.on("dialog", onDialog);
      await app.drop([{ name: "saved.oresme", content: [...saved.bytes] }]);
      await expect.poll(() => messages.length).toBe(2);
      page.off("dialog", onDialog);
      expect(messages[1]).toContain("procedures that run when it opens (Procedure)");
      await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
      await app.idle();
    };

    await open("dismiss");
    expect((await app.doc()).procedures.Procedure).toMatchObject({ autoRun: false });
    expect((await app.run("print('FROM_FILE' in globals())")).output).toBe("False\n");

    await open("accept");
    expect((await app.doc()).procedures.Procedure).toMatchObject({ autoRun: true });
    expect((await app.run("print(FROM_FILE)")).output).toBe("42\n");
  });
});

test.describe("the experiment's files", () => {
  test("files Python writes are listed, kept over a reload, and saved in the experiment", async ({
    app,
    page,
  }) => {
    await app.run(
      'import os\nos.makedirs("out", exist_ok=True)\nnp.savetxt("out/fit.csv", np.arange(6.0).reshape(3, 2), delimiter=",", fmt="%g")\nopen("notes.txt", "w").write("caf\\u00e9")',
    );
    expect(await app.files()).toEqual({ "notes.txt": "café", "out/fit.csv": "0,1\n2,3\n4,5\n" });
    const list = page.getByRole("region", { name: "Files" });
    await expect(list.getByRole("listitem")).toHaveText(["notes.txt5 B", "out/fit.csv12 B"]);

    const downloaded = await app.download(() => list.getByText("out/fit.csv").dblclick());
    expect(downloaded.file.suggestedFilename()).toBe("fit.csv");
    expect(downloaded.bytes.toString()).toBe("0,1\n2,3\n4,5\n");

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect(
      (
        await app.run(
          'print(open("notes.txt").read(), np.loadtxt("out/fit.csv", delimiter=",").sum())',
        )
      ).output,
    ).toBe("café 15.0\n");

    // Deleted in the list, the file is gone for Python too.
    await list.getByText("notes.txt").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    expect((await app.run('import os; print(os.path.exists("notes.txt"))')).output).toBe("False\n");

    const saved = await app.download(() => page.keyboard.press("Control+s"));
    // A new experiment opens in the tab; the old one stays among the browser's experiments.
    await app.menu("File", "New Experiment");
    await expect(page).toHaveTitle("Untitled — OresmePro");
    await expect.poll(() => app.files()).toEqual({});
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.run("import os; print(os.listdir())")).output).toBe("[]\n");

    await app.drop([{ name: "saved.oresme", content: [...saved.bytes] }]);
    await expect.poll(() => app.files()).toEqual({ "out/fit.csv": "0,1\n2,3\n4,5\n" });
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.run('print(open("out/fit.csv").read())')).output).toBe("0,1\n2,3\n4,5\n\n");
  });

  test("a file added from the menu can be opened by Python, bytes intact", async ({
    app,
    page,
  }) => {
    // Bit patterns that would not survive being treated as numbers.
    const bytes = [1, 0, 0, 0, 0, 0, 0xf0, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 9];
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      app.menu("File", "Add Files for Python…"),
    ]);
    await chooser.setFiles({
      name: "raw.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(bytes),
    });
    await expect(page.getByRole("region", { name: "Files" })).toContainText("raw.bin");
    expect((await app.run('print(list(open("raw.bin", "rb").read()))')).output).toBe(
      `[${bytes.join(", ")}]\n`,
    );
    // And back: Python's copy with one byte more.
    await app.run(
      'data = open("raw.bin", "rb").read()\nopen("copy.bin", "wb").write(data + b"\\x80")',
    );
    const copy = await page.evaluate(() =>
      Array.from(globalThis.oresme.files.get("copy.bin")!.bytes),
    );
    expect(copy).toEqual([...bytes, 0x80]);
  });
});

test.describe("graph recreation", () => {
  test("the script of a graph draws it again from a procedure", async ({ app, page }) => {
    await app.run(
      [
        'x = op.make("x", np.linspace(0, 1, 50)); y = op.make("y", x.data ** 2)',
        "g = op.display(y, x=x)",
        'g.trace("y").set(mode="markers", color="#0000ff")',
        'g.left.set(label="Squared", grid="major")',
        "g.legend()",
      ].join("\n"),
    );
    await app.menu("Graph", "Recreation Script…");
    const dialog = page.getByRole("dialog", { name: "Recreation Script for Graph0" });
    await expect(dialog.getByLabel("Script")).toHaveText(
      [
        'g = op.display("y", x="x")',
        'g.trace("y").set(mode="markers", color="#0000ff")',
        'g.axis("left").set(label="Squared", grid="major")',
        'g.legend(anchor="RT", frame=True)',
      ].join("\n"),
    );
    await dialog.getByRole("button", { name: "Add to Procedure as a Function" }).click();
    const code = (await app.doc()).procedures.Procedure!.code;
    expect(code).toContain("def recreate_Graph0():\n    g = op.display(");
    await expect(
      app.window("Procedure").getByRole("textbox", { name: "Procedure.py" }),
    ).toContainText("def recreate_Graph0():");

    await app.window("Procedure").getByRole("button", { name: "Run" }).click();
    await app.idle();
    expect((await app.run("print(recreate_Graph0().name)")).output).toBe("Graph1\n");
    const { graphs } = await app.doc();
    expect({ ...graphs.Graph1, name: "Graph0" }).toEqual(graphs.Graph0);

    // The same text from Python.
    expect((await app.run("print(op.graph('Graph0').script() == g.script())")).output).toBe(
      "True\n",
    );
  });
});

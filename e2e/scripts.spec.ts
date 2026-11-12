import { stripAnsi } from "../src/core/history/ansi";
import { expect, test } from "./fixtures";

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

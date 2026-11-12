import { expect, test } from "./fixtures";

test.describe("command line", () => {
  test("Enter runs a complete statement and waits for a block to end", async ({ app, page }) => {
    await app.type('a = op.make("a", np.arange(10.0))', "Enter");
    await app.idle();
    expect((await app.doc()).order).toEqual(["a"]);
    expect(await app.typed()).toBe("");

    await app.type("for i in range(3):", "Enter");
    await page.keyboard.type("print(i)");
    await page.keyboard.press("Enter");
    // Still inside the block: nothing has run yet.
    expect(await app.entries()).toHaveLength(1);
    await page.keyboard.press("Enter");
    await app.idle();
    expect((await app.lastEntry()).output).toBe("0\n1\n2\n");
  });

  test("Up and Down recall history by prefix and restore the draft", async ({ app, page }) => {
    await app.run("alpha = 1");
    await app.run("for i in range(2):\n    pass");
    await app.run("beta = 2");

    await app.commandLine.click();
    await page.keyboard.press("ArrowUp");
    expect(await app.typed()).toBe("beta = 2");
    await page.keyboard.press("ArrowUp");
    expect(await app.typed()).toContain("for i in range(2):");
    // Still recalling, so Up steps past the multi-line entry instead of moving inside it.
    await page.keyboard.press("ArrowUp");
    expect(await app.typed()).toBe("alpha = 1");
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowDown");
    expect(await app.typed()).toBe("");

    await page.keyboard.type("al");
    await page.keyboard.press("ArrowUp");
    expect(await app.typed()).toBe("alpha = 1");
    await page.keyboard.press("ArrowDown");
    expect(await app.typed()).toBe("al");
  });

  test("the latest matching command is suggested and can be accepted", async ({ app, page }) => {
    await app.run('alpha = op.make("alpha", [1, 2, 3])');
    await app.type("alp");
    await expect.poll(() => app.suggestion()).toBe('ha = op.make("alpha", [1, 2, 3])');
    await page.keyboard.press("Alt+ArrowRight");
    expect(await app.typed()).toBe("alpha = ");
    await page.keyboard.press("ArrowRight");
    expect(await app.typed()).toBe('alpha = op.make("alpha", [1, 2, 3])');
  });

  test("Tab completes Python names", async ({ app, page }) => {
    await app.type("op.dis", "Tab");
    await expect(page.locator(".cm-tooltip-autocomplete li")).toHaveText(["display"]);
    // Enter right away must not run the half-typed line: with the list open it
    // only ever picks from it. (The list ignores keys for an instant after it
    // opens, so the first Enter may do nothing at all.)
    await page.keyboard.press("Enter");
    expect(await app.entries()).toEqual([]);
    await expect(async () => {
      if ((await app.typed()) !== "op.display") await page.keyboard.press("Enter");
      expect(await app.typed()).toBe("op.display");
    }).toPass();
    expect(await app.entries()).toEqual([]);
  });

  test("Ctrl+R searches the history", async ({ app, page }) => {
    await app.run("first = 1");
    await app.run("second = [n for n in range(3)]");
    await app.commandLine.click();
    await page.keyboard.press("Control+r");
    await page.keyboard.type("range");
    const matches = page.getByRole("listbox", { name: "Matching commands" }).getByRole("option");
    await expect(matches).toHaveText(["second = [n for n in range(3)]"]);
    await page.keyboard.press("Enter");
    expect(await app.typed()).toBe("second = [n for n in range(3)]");
    await expect(app.commandLine).toBeFocused();
  });

  test("the history survives a reload", async ({ app, page }) => {
    await app.run('print("kept")');
    // Saving is debounced; give it time to reach storage.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    const entries = await app.entries();
    expect(entries[0]).toMatchObject({ code: 'print("kept")', output: "kept\n" });
    await app.commandLine.click();
    await page.keyboard.press("ArrowUp");
    expect(await app.typed()).toBe('print("kept")');
  });
});

test.describe("running Python", () => {
  const interrupted = async (app: import("./fixtures").App, code: string) => {
    await app.page.evaluate((text) => globalThis.oresme.kernel.execute(text), code);
    await expect.poll(async () => (await app.lastEntry()).status).toBe("running");
    await app.page.waitForTimeout(300);
    await app.page.evaluate(() => globalThis.oresme.kernel.interruptExecution());
    await app.idle();
    return app.lastEntry();
  };

  test("Ctrl+C interrupts a busy loop and a sleeping loop", async ({ app }) => {
    expect(await interrupted(app, "while True: pass")).toMatchObject({ status: "error" });
    const sleeping = await interrupted(app, "import time\nwhile True: time.sleep(0.01)");
    expect(sleeping.output).toContain("KeyboardInterrupt");
    // Python is still usable afterwards.
    expect((await app.run("print(6 * 7)")).output).toBe("42\n");
  });

  test("an interrupt that is swallowed is sent again, and does not reach the next input", async ({
    app,
    page,
  }) => {
    // The first signal lands in a handler that goes on, as one that arrives during
    // the preparation before the user's code would; the loop after it must still stop.
    const swallowed = await interrupted(
      app,
      "try:\n    while True: pass\nexcept KeyboardInterrupt:\n    print('caught')\nwhile True: pass",
    );
    expect(swallowed.status).toBe("error");
    expect(swallowed.output).toContain("caught");
    expect(swallowed.output).toContain("KeyboardInterrupt");
    // Nothing is left over to hit what runs next, even well after the last repeat.
    await page.evaluate(() =>
      globalThis.oresme.kernel.execute("import time\ntime.sleep(4.5)\nprint('slept')"),
    );
    await app.idle();
    const next = await app.lastEntry();
    expect([next.status, next.output]).toEqual(["ok", "slept\n"]);
    await expect(page.getByText("Python ready")).toBeVisible();
  });

  test("an interrupt sent the moment code is submitted is not lost", async ({ app, page }) => {
    await page.evaluate(() => {
      globalThis.oresme.kernel.execute("while True: pass");
      globalThis.oresme.kernel.interruptExecution();
    });
    await app.idle();
    expect((await app.lastEntry()).status).toBe("error");
    expect((await app.run("print('next')")).output).toBe("next\n");
  });

  test("Ctrl+C cancels code waiting on await", async ({ app }) => {
    const entry = await interrupted(app, "import asyncio\nwhile True: await asyncio.sleep(0.05)");
    expect(entry.status).toBe("error");
    expect((await app.run("print('alive')")).output).toBe("alive\n");
  });

  test("input() reads a line from the command line", async ({ app, page }) => {
    await page.evaluate(() =>
      globalThis.oresme.kernel.execute('name = input("Your name? ")\nprint("hello", name)'),
    );
    await expect(page.getByText("Python is waiting for input")).toBeVisible();
    await app.type("Oresme", "Enter");
    await app.idle();
    expect((await app.lastEntry()).output).toBe("Your name? Oresme\nhello Oresme\n");

    await page.evaluate(() => globalThis.oresme.kernel.execute('input("again? ")'));
    await expect(page.getByText("Python is waiting for input")).toBeVisible();
    await page.evaluate(() => globalThis.oresme.kernel.interruptExecution());
    await app.idle();
    expect((await app.lastEntry()).output).toContain("KeyboardInterrupt");
  });

  test("a second interrupt restarts Python and keeps the document", async ({ app, page }) => {
    await app.run('op.make("kept", [1, 2, 3]); g = op.display("kept")');
    // One long call into compiled code cannot be interrupted from outside.
    await page.evaluate(() =>
      globalThis.oresme.kernel.execute(
        "big = np.random.rand(3000, 3000)\nfor _ in range(50): big @ big",
      ),
    );
    await page.waitForTimeout(1000);
    await page.evaluate(() => globalThis.oresme.kernel.interruptExecution());
    await expect(page.getByText("interrupt again to restart Python")).toBeVisible();
    await page.evaluate(() => globalThis.oresme.kernel.interruptExecution());
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    const doc = await app.doc();
    expect(doc.order).toEqual(["kept"]);
    expect(Object.keys(doc.graphs)).toEqual(["Graph0"]);
    expect((await app.run('print(op.wave("kept").data.sum())')).output).toBe("6.0\n");
  });
});

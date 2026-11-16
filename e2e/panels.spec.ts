import { App, expect, test } from "./fixtures";

const PEAK =
  "x = np.linspace(-5, 5, 201)\n" +
  'op.make("sig", 1 + 3 * np.exp(-((x - 1) / 0.8) ** 2), x0=-5, dx=0.05)\n' +
  'op.make("sig2", 2 + np.exp(-((x + 1) / 0.5) ** 2), x0=-5, dx=0.05)';

/** The values of a panel's controls, by name; null while there is no such panel (after a reload, before the experiment is back). */
const values = (app: App, panel: string) =>
  app.page.evaluate((name) => {
    const spec = globalThis.oresme.doc.getState().panels[name];
    return spec
      ? Object.fromEntries(
          spec.controls.map((control) => [control.name, "value" in control ? control.value : null]),
        )
      : null;
  }, panel);

test.describe("panels", () => {
  test("a panel built in its window with a wave picker, a choice and a Fit button runs the fit", async ({
    app,
    page,
  }) => {
    await app.run(PEAK);
    await app.menu("Windows", "New Panel");
    const panel = app.window("Panel0");
    await expect(panel.getByRole("button", { name: "Edit Panel0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(panel.getByText("Data only", { exact: true })).toBeVisible();

    await panel.getByRole("button", { name: "Add ▾" }).click();
    await page.getByRole("menuitem", { name: "Wave Picker" }).click();
    const picker = panel.getByRole("group", { name: "wave0 properties" });
    await picker.getByLabel("Label").fill("Spectrum");
    await picker.getByLabel("Label").press("Enter");
    await picker.getByLabel("Dimensions").selectOption("1");

    await panel.getByRole("button", { name: "Add ▾" }).click();
    await page.getByRole("menuitem", { name: "Button" }).click();
    const button = panel.getByRole("group", { name: "button0 properties" });
    await button.getByLabel("Caption").fill("Fit");
    await button.getByLabel("Caption").press("Enter");
    await button.getByLabel("Action", { exact: true }).selectOption("core.fit");
    // A new control made for the argument: a menu of the fit functions, bound to it.
    await button.getByLabel("function from").selectOption("new");
    await button.getByLabel("y from").selectOption("control");
    await expect(button.getByLabel("y control")).toHaveValue("wave0");
    expect((await app.entries()).map((entry) => entry.code)).toContain(
      'op.panel("Panel0").wave("wave0", label="Wave")',
    );
    await panel.getByRole("button", { name: "Done" }).click();

    // Pressed with no wave chosen, the button says so and calls nothing.
    const before = (await app.entries()).length;
    await panel.getByRole("button", { name: "Fit" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Choose a wave for Spectrum.");
    expect((await app.entries()).length).toBe(before);

    await panel.getByLabel("Spectrum").selectOption("sig");
    await panel.getByLabel("Function").selectOption({ label: "gauss" });
    await panel.getByRole("button", { name: "Fit" }).click();
    await app.idle();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(await app.wave("fit_sig")).not.toBeNull();
    const fit = (await app.entries()).find((entry) => entry.code.startsWith("op.fit("));
    expect(fit).toMatchObject({ code: 'op.fit("gauss", op.wave("sig"))', status: "ok" });
  });

  test("values set in a panel come back when the experiment is opened again", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        PEAK,
        'p = op.panel("qf", title="Quick Fit")',
        'p.wave("target", label="Spectrum")',
        'p.choice("model", ["gauss", "lor"], label="Model")',
        'p.number("n", "Points", value=3, min=1)',
      ].join("\n"),
    );
    const panel = app.window("qf");
    await expect(panel.locator("header")).toContainText("Quick Fit");
    await panel.getByLabel("Spectrum").selectOption("sig2");
    await panel.getByLabel("Model").selectOption({ label: "lor" });
    // Typing is one undo step and one line of history for the whole edit of the field.
    const points = panel.getByLabel("Points");
    await points.fill("");
    await points.pressSequentially("12");
    await expect.poll(() => values(app, "qf")).toEqual({ target: "sig2", model: "lor", n: 12 });
    await expect.poll(async () => (await app.lastEntry()).code).toBe('op.panel("qf")["n"] = 12');
    await page.evaluate(() => globalThis.oresme.doc.undo());
    expect((await values(app, "qf"))?.n).toBe(3);
    await page.evaluate(() => globalThis.oresme.doc.redo());
    await points.blur();

    await expect(page.getByRole("group", { name: "Saving" })).toHaveText(/^Saved \d/);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => values(app, "qf")).toEqual({ target: "sig2", model: "lor", n: 12 });
    await expect(panel.getByLabel("Spectrum")).toHaveValue("sig2");
    await expect(panel.getByLabel("Points")).toHaveValue("12");
  });

  test("a double-click calls once, with the values of the moment it was pressed", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        '@op.action("lab.slow", title="Slow", params={"n": {"type": "number"}})',
        "def slow(n):",
        "    import time",
        "    time.sleep(0.8)",
        '    print("called with", n)',
        'p = op.panel("slow")',
        'p.number("n", "N", value=1)',
        'p.button("go", "Go", action="lab.slow", args={"n": op.control("n")})',
      ].join("\n"),
    );
    const panel = app.window("slow");
    const go = panel.getByRole("button", { name: "Go" });
    await go.dblclick();
    await expect(go).toBeDisabled();
    await page.evaluate(() =>
      globalThis.oresme.doc.dispatch({
        op: "setControlValue",
        panel: "slow",
        control: "n",
        value: 2,
      }),
    );
    await app.idle();
    await expect(go).toBeEnabled();
    const calls = (await app.entries()).filter((entry) => entry.code.includes("lab.slow"));
    expect(calls).toHaveLength(2);
    // The registration, then the one call.
    expect(calls[1]!.code).toMatch(/^op\.invoke\("lab\.slow", \{"n": 1(\.0)?\}, version=1\)$/);
    expect(calls[1]!.status).toBe("ok");
    expect(calls[1]!.output).toContain("called with 1");

    // It calls an action of a procedure: the panel holds code, and says so.
    await panel.getByRole("button", { name: "Edit slow" }).click();
    await expect(panel.getByText("Contains code", { exact: true })).toBeVisible();
  });

  test("controls are dragged to a place of their own, sized, colored and stacked, and undone in one step", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        PEAK,
        'g = op.display(op.wave("sig"), name="G0")',
        'p = op.panel("free", title="Free")',
        'p.heading("top", "Spectra")',
        'p.list("ws", "Waves", dims=1)',
        'p.button("go", "Go", action="core.fit")',
      ].join("\n"),
    );
    const control = (name: string) =>
      page.evaluate(
        (control) =>
          globalThis.oresme.doc
            .getState()
            .panels.free!.controls.find((item) => item.name === control) as unknown as Record<
            string,
            unknown
          >,
        name,
      );
    const panel = app.window("free");
    // The wave list lists the 1D waves, and a click selects them as its value.
    await panel.getByRole("option", { name: "sig2" }).click();
    await expect.poll(() => values(app, "free")).toMatchObject({ ws: ["sig2"] });

    await panel.getByRole("button", { name: "Edit free" }).click();
    const go = panel.getByRole("button", { name: "Button go" });
    const area = (await panel.getByRole("group", { name: "free controls" }).boundingBox())!;
    const from = (await go.boundingBox())!;
    await go.hover();
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 });
    await page.mouse.move(area.x + 200 + from.width / 2, area.y + 150 + from.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    // A drag is one change: the button has a place of its own, out of its line.
    await expect
      .poll(async () => [(await control("go")).x, (await control("go")).y])
      .toEqual([expect.any(Number), expect.any(Number)]);
    const placed = await control("go");
    expect(Math.abs((placed.x as number) - 200)).toBeLessThan(6);
    expect(Math.abs((placed.y as number) - 150)).toBeLessThan(6);
    await expect
      .poll(async () => (await app.lastEntry()).code)
      .toMatch(/^op\.panel\("free"\)\.control\("go"\)\.set\(x=\d+, y=\d+\)$/);
    // The arrow keys move it a pixel, Shift ten.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect
      .poll(async () => [(await control("go")).x, (await control("go")).y])
      .toEqual([(placed.x as number) + 1, (placed.y as number) + 10]);

    // Its colors and size, from the form.
    const form = panel.getByRole("group", { name: "go properties" });
    await form.getByLabel("Width").fill("120");
    await form.getByLabel("Width").press("Enter");
    await form.getByLabel("Background", { exact: true }).fill("#ff8800");
    await expect.poll(async () => (await control("go")).background).toBe("#ff8800");
    expect((await control("go")).w).toBe(120);
    // Sent behind the others, then brought in front again.
    await panel.getByRole("button", { name: "Back", exact: true }).click();
    expect((await control("go")).z).toBe(-1);
    await panel.getByRole("button", { name: "Front", exact: true }).click();
    expect((await control("go")).z).toBe(1);

    // A plot, made with the waves of the frontmost graph.
    await panel.getByRole("button", { name: "Add ▾" }).click();
    await page.getByRole("menuitem", { name: "Plot", exact: true }).click();
    expect((await control("plot0")).traces).toEqual([{ y: "sig", x: null }]);
    await panel.getByRole("button", { name: "Done" }).click();
    await expect(panel.getByRole("img", { name: "plot0 plot" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Go" })).toHaveCSS(
      "background-color",
      "rgb(255, 136, 0)",
    );

    // Undo takes the plot back, then the stacking, one step at a time.
    await page.evaluate(() => globalThis.oresme.doc.undo());
    expect(await control("plot0")).toBeUndefined();
    await page.evaluate(() => globalThis.oresme.doc.undo());
    expect((await control("go")).z).toBe(-1);

    // What was placed comes back when the experiment is opened again.
    await expect(page.getByRole("group", { name: "Saving" })).toHaveText(/^Saved \d/);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await control("go"))?.background).toBe("#ff8800");
    expect(await control("go")).toMatchObject({ w: 120, x: (placed.x as number) + 1 });
  });
});

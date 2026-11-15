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
});
